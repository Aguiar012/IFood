import json, time, logging, random, os, smtplib, requests, re, base64, unicodedata
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import psycopg


# === Config geral ===
URL_HOME    = 'http://200.133.203.133/home'
ARQUIVO     = 'redes.json'
JITTER_MAX  = 120
TENTATIVAS  = 2
RETRY_SEC   = 30
TIMEOUT_SEC = 10

EMAIL_USER   = os.getenv('EMAIL_USER')
EMAIL_PASS   = os.getenv('EMAIL_PASS')
SMTP_SERVER  = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT    = int(os.getenv('SMTP_PORT', 587))
TO_ADDRESS   = os.getenv('TO_ADDRESS')

# Garante que admins está definido para evitar erros
ADMINS_E164  = os.getenv('ADMINS_E164', '')

DATABASE_URL = os.getenv('DATABASE_URL')

# Fuso oficial do campus + horário de virada do SICA
TZ = ZoneInfo('America/Sao_Paulo')
CUTOFF_HOUR = 13
CUTOFF_MIN  = 15

logging.basicConfig(format='%(asctime)s %(levelname)s: %(message)s',
                    level=logging.INFO)

# ---------------------- Utilitários de tempo ----------------------
WEEKDAY_PT = {1:'seg',2:'ter',3:'qua',4:'qui',5:'sex',6:'sab',7:'dom'}

def compute_target_date(now: datetime | None = None):
    """
    Regra para o PEDIDO (mantida a lógica original para o fluxo de pedir):
    - Antes de 13:15 -> D+1
    - Depois de 13:15 -> D+2
    - Se cair em sábado ou domingo, empurra até segunda.
    """
    if now is None:
        now = datetime.now(TZ)

    cutoff = now.replace(hour=CUTOFF_HOUR, minute=CUTOFF_MIN, second=0, microsecond=0)
    days_ahead = 1 if now < cutoff else 2

    target = (now + timedelta(days=days_ahead)).date()

    while target.isoweekday() in (6, 7):
        target += timedelta(days=1)

    return target

# --------------------------- E-mail --------------------------------
def send_email(subject: str, body: str):
    if not EMAIL_USER or not TO_ADDRESS:
        return
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = EMAIL_USER, TO_ADDRESS, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(EMAIL_USER, EMAIL_PASS)
            smtp.send_message(msg)
    except Exception as e:
        logging.error(f"Falha ao enviar email: {e}")

# --------------------------- Dados ---------------------------------
def load_alunos_para_dia(target_dow: int):
    if not DATABASE_URL:
        raise RuntimeError("Faltou DATABASE_URL")
    out = []
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                select distinct a.id, a.prontuario
                  from aluno a
                  join preferencia_dia p on p.aluno_id = a.id
                 where a.ativo = true
                   and p.dia_semana = %s
                 order by a.prontuario;
            """, (target_dow,))
            for (aluno_id, prontuario) in cur.fetchall():
                out.append({'id': aluno_id, 'prontuario': prontuario})
    return out


def get_bloqueios_por_prontuario(pront: str) -> list[str]:
    if not DATABASE_URL:
        return []
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                select pb.nome
                  from prato_bloqueado pb
                  join aluno a on a.id = pb.aluno_id
                 where a.prontuario = %s
                 order by pb.nome;
            """, (pront,))
            return [r[0] for r in cur.fetchall()]

def registrar_pedido(aluno_id: int, dia_pedido, motivo: str):
    if not DATABASE_URL:
        return
    motivo = (motivo or "")[:800]
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into pedido (aluno_id, dia_pedido, motivo)
                values (%s, %s, %s)
                """,
                (aluno_id, dia_pedido, motivo)
            )
        conn.commit()

# === NOVA FUNÇÃO: ATUALIZAR PRÓXIMO PRATO ===
def atualizar_proximo_prato(sess):
    """
    Lógica de extração:
    1. Define data alvo (Hoje < 13:15, Amanhã > 13:15, Sexta tarde/FDS -> Segunda).
    2. Varre o HTML procurando o bloco correspondente à data alvo.
    3. Se encontrar 'não cadastrado', salva isso.
    4. Se encontrar 'Prato Principal', extrai apenas a 'Opção 1'.
    5. Salva na tabela proximo_prato.
    """
    if not DATABASE_URL:
        return "(banco off)"

    now = datetime.now(TZ)
    cutoff = now.replace(hour=CUTOFF_HOUR, minute=CUTOFF_MIN, second=0, microsecond=0)

    # Regra de Horário e Dias:
    if now <= cutoff:
        # Antes das 13:15: Queremos o almoço de HOJE
        target_date = now.date()
    else:
        # Depois das 13:15: Queremos o almoço de AMANHÃ
        target_date = (now + timedelta(days=1)).date()

    # Ajuste Fim de Semana:
    # Se o alvo cair Sábado (6) ou Domingo (7), joga para Segunda.
    # Ex: Sexta 14:00 -> Alvo inicial Sábado -> Corrige para Segunda.
    while target_date.isoweekday() in (6, 7):
        target_date += timedelta(days=1)

    logging.info(f"Buscando cardápio no site. Data alvo para extração: {target_date}")

    prato_encontrado = None

    try:
        r = sess.get(URL_HOME, timeout=TIMEOUT_SEC)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, 'html.parser')

        meses = {
            'Janeiro': 1, 'Fevereiro': 2, 'Março': 3, 'Abril': 4, 'Maio': 5, 'Junho': 6,
            'Julho': 7, 'Agosto': 8, 'Setembro': 9, 'Outubro': 10, 'Novembro': 11, 'Dezembro': 12
        }

        # O site usa "jumbotron" para o dia atual e "jumbotron sub" para os próximos.
        # Pegamos todos para procurar a data correta.
        all_jumbotrons = soup.select('.jumbotron')

        target_container = None

        # 1. Encontrar o container da Data Alvo
        for jumbo in all_jumbotrons:
            title_tag = jumbo.find('h2', class_='display-3')
            if not title_tag:
                continue
            
            txt = title_tag.get_text(" ", strip=True)
            # Ex: "Cardápio - 24 de Novembro de 2025" ou "25 de Novembro de 2025"
            match = re.search(r'(\d{1,2})\s+de\s+([A-Za-zçÇ]+)\s+de\s+(\d{4})', txt, re.IGNORECASE)
            
            if match:
                d, m_name, y = match.groups()
                m = meses.get(m_name.capitalize())
                if m:
                    card_date = datetime(int(y), m, int(d)).date()
                    if card_date == target_date:
                        target_container = jumbo
                        break
        
        # 2. Extrair a Opção 1 desse container
        if target_container:
            container_text = target_container.get_text(" ", strip=True)
            
            # Caso 1: Cardápio não cadastrado (caixa vermelha)
            if "não cadastrado" in container_text.lower():
                prato_encontrado = "Cardápio não cadastrado"
            else:
                # Caso 2: Tenta achar "Prato Principal: Opção 1: XXXXX Opção 2:"
                # O find_all('p') ajuda a isolar linhas
                paragraphs = target_container.find_all('p')
                for p in paragraphs:
                    p_text = p.get_text(" ", strip=True)
                    if "Prato Principal" in p_text:
                        # Regex para pegar tudo entre "Opção 1:" e "Opção 2:" (ou fim da linha)
                        # Ignora case, pega o grupo 1
                        match_prato = re.search(r'Opção 1:\s*(.*?)(?:\s+Opção 2:|$)', p_text, re.IGNORECASE)
                        if match_prato:
                            prato_encontrado = match_prato.group(1).strip()
                        else:
                            # Fallback: se não achar o padrão exato, pega o texto todo do paragrafo
                            prato_encontrado = p_text.replace("Prato Principal:", "").strip()
                        break
                
                if not prato_encontrado:
                    prato_encontrado = "Prato não identificado no texto"
        else:
            prato_encontrado = "Data não encontrada no site"

        # 3. Salvar no Banco (Upsert)
        logging.info(f"Salvando no banco -> Data: {target_date} | Prato: {prato_encontrado}")
        
        with psycopg.connect(DATABASE_URL) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO proximo_prato (dia_referente, prato_nome, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (dia_referente) 
                    DO UPDATE SET prato_nome = EXCLUDED.prato_nome, updated_at = NOW();
                """, (target_date, prato_encontrado))
            conn.commit()
            
        return prato_encontrado

    except Exception as e:
        logging.error(f"Erro ao atualizar cardápio: {e}")
        return "(erro na atualização)"


# --------------------- HTTP / parsing do site ----------------------
def get_csrf_token(sess):
    resp = sess.get(URL_HOME, timeout=TIMEOUT_SEC)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, 'html.parser')
    token_input = soup.find('input', {'name': 'csrfmiddlewaretoken'})
    if not token_input:
        raise RuntimeError('CSRF token não encontrado na página')
    return token_input['value']

def enviar_prontuario(sess, prontuario: str):
    token = get_csrf_token(sess)
    payload = {'csrfmiddlewaretoken': token, 'prontuario': prontuario, 'tipo': '1'}
    headers = {'Referer': URL_HOME}
    return sess.post(URL_HOME, data=payload, headers=headers, timeout=TIMEOUT_SEC)

def parse_feedback(html: str):
    soup = BeautifulSoup(html, 'html.parser')
    erro_div = soup.select_one('.alert.alert-danger.alert-dismissable.fade.in')
    if erro_div:
        msg = erro_div.get_text(" ", strip=True)
        return False, msg
    ok_div = soup.select_one('.alert.alert-success.alert-dismissable.fade.in')
    if ok_div:
        msg = ok_div.get_text(" ", strip=True)
        return True, msg
    return False, 'Nenhum alerta de sucesso/erro encontrado'

# ----------------- Normalização & preferências ---------------------
def _norm(txt: str) -> str:
    if not txt:
        return ""
    t = unicodedata.normalize('NFKD', txt)
    t = ''.join(ch for ch in t if not unicodedata.combining(ch))
    return t.lower()

def should_skip(prato_texto: str, bloqueios: list[str]) -> tuple[bool, str]:
    base = _norm(prato_texto)
    hits = []
    for b in bloqueios:
        b2 = _norm(b)
        if b2 and b2 in base:
            hits.append(b)
    return (len(hits) > 0, ", ".join(hits))

# ------------------- Erros irrelevantes p/ alerta ------------------
IGNORE_PATTERNS = [
    r'Gerado anteriormente',
    r'Ticket Gerado',
    r'PULOU_PREF',
    r'Pulou por prefer.ncia',
    r'SKIP_DIA',
]

def is_relevant_error(msg: str) -> bool:
    if not msg:
        return False
    for pat in IGNORE_PATTERNS:
        if re.search(pat, msg, re.IGNORECASE):
            return False
    return True

# ----------------------- Execução principal ------------------------
def main():
    now = datetime.now(TZ)
    sess = requests.Session()

    # 1. Atualiza a tabela proximo_prato com a Opção 1 da data correta
    prato_do_dia_texto = atualizar_proximo_prato(sess)
    
    # 2. Lógica de Pedidos (Target Date pode diferir dependendo da hora que o script roda)
    # O script de pedido geralmente roda em horarios especificos, mas usamos a mesma logica base
    # Se o prato salvo for "não cadastrado", ele vai tentar pedir mas deve cair no bloqueio se você tiver bloqueio de nome vazio, ou segue normal.
    
    target_date_pedido = compute_target_date(now)
    target_dow  = target_date_pedido.isoweekday()

    logging.info("Data alvo do pedido: %s (%s)", target_date_pedido.isoformat(), WEEKDAY_PT[target_dow])
    logging.info("Texto usado para checar bloqueios: %s", prato_do_dia_texto)

    detalhes = []
    alunos = load_alunos_para_dia(target_dow)

    for aluno in alunos:
        aluno_id = aluno['id']
        pront    = aluno['prontuario']
        
        # Checa bloqueios usando o texto extraído (Opção 1)
        bloqueios = get_bloqueios_por_prontuario(pront)
        skip, hits = should_skip(prato_do_dia_texto, bloqueios)
        
        if skip:
            inicio = datetime.now(TZ).strftime('%H:%M:%S')
            time.sleep(random.randint(0, JITTER_MAX))
            fim = datetime.now(TZ).strftime('%H:%M:%S')
        
            motivo = f'NAO_PEDIU: prato contém bloqueios -> {hits}'
            registrar_pedido(aluno_id, target_date_pedido, motivo)
            detalhes.append((pront, True, motivo, inicio, fim, 0))
            continue

        # Faz o pedido
        time.sleep(random.randint(0, JITTER_MAX))
        inicio = datetime.now(TZ).strftime('%H:%M:%S')
        
        sucesso, mensagem = False, ''
        tentativa = 0
        for tentativa in range(1, TENTATIVAS + 1):
            try:
                r = enviar_prontuario(sess, pront)
                sucesso, mensagem = parse_feedback(r.text)
                if sucesso:
                    break
                raise ValueError(mensagem)
            except Exception as e:
                mensagem = str(e)
                time.sleep(RETRY_SEC)
        
        fim = datetime.now(TZ).strftime('%H:%M:%S')
        detalhes.append((pront, sucesso, mensagem, inicio, fim, tentativa))
    
        if sucesso:
            motivo = f'PEDIU_OK: {mensagem}'
        else:
            motivo = f'ERRO_PEDIDO: {mensagem}'
        
        registrar_pedido(aluno_id, target_date_pedido, motivo)

    # Relatório E-mail
    linhas = ['Relatório Auto-Almoço — ' + now.strftime('%d/%m/%Y')]
    linhas.append(f'Data-alvo: {target_date_pedido.strftime("%d/%m/%Y")} ({WEEKDAY_PT[target_dow]})')
    ok_total = sum(1 for _, s, *_ in detalhes if s)
    linhas.append(f'Sucesso: {ok_total}/{len(detalhes)}\n')
    linhas.append('Prontuário | Status | Começou -> Terminou | Tentativas | Mensagem')
    linhas.append('-' * 72)
    for pront, ok, msg, ini, fim, tent in detalhes:
        status = 'OK ' if ok else 'FALHOU'
        linhas.append(f'{pront} | {status} | {ini}→{fim} | {tent} | {msg}')
    send_email('Relatório Auto-Almoço', '\n'.join(linhas))

if __name__ == '__main__':
    main()
