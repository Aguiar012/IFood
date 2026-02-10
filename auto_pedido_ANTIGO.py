import json, time, logging, random, os, smtplib, requests, re, base64, unicodedata
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import psycopg


# === Config geral ===
URL_HOME    = 'http://200.133.203.133/home'
JITTER_MAX  = 120
TENTATIVAS  = 2
RETRY_SEC   = 30
TIMEOUT_SEC = 10

EMAIL_USER   = os.getenv('EMAIL_USER')
EMAIL_PASS   = os.getenv('EMAIL_PASS')
SMTP_SERVER  = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT    = int(os.getenv('SMTP_PORT', 587))
TO_ADDRESS   = os.getenv('TO_ADDRESS')

# Configuração do Bot de Alerta
BOT_URL      = os.getenv('BOT_URL') # URL do seu bot no Northflank + /send-message
ADMINS_E164  = os.getenv('ADMINS_E164', '') # Lista de números separados por vírgula

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

# --------------------------- WhatsApp ---------------------
def notify_admins(message):
    """Envia mensagem para os admins via API do seu bot"""
    if not BOT_URL or not ADMINS_E164:
        logging.warning("BOT_URL ou ADMINS_E164 não configurados. Pulei o alerta.")
        return

    admins = [a.strip() for a in ADMINS_E164.split(',') if a.strip()]
    
    for admin in admins:
        try:
            payload = {
                "number": admin,
                "message": message
            }
            # Timeout curto para não travar o script se o bot estiver offline
            r = requests.post(BOT_URL, json=payload, timeout=10)
            if r.status_code != 200:
                logging.error(f"Erro ao notificar {admin}: {r.text}")
        except Exception as e:
            logging.error(f"Falha de conexão ao notificar {admin}: {e}")

# --------------------------- Dados ---------------------------------

def checar_cancelamento_direto(aluno_id: int, dia_pedido) -> bool:
    """Verifica se o aluno cancelou diretamente (sem e-mail) para o dia alvo."""
    if not DATABASE_URL:
        return False
    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            # Busca por qualquer registro de pedido que comece com a tag de cancelamento direto
            cur.execute("""
                select 1
                  from pedido
                 where aluno_id = %s
                   and dia_pedido = %s
                   and motivo like 'CANCELADO_DIRETAMENTE%%';
            """, (aluno_id, dia_pedido))
            return cur.fetchone() is not None
          
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

# === FUNÇÃO: ATUALIZAR PRÓXIMO PRATO ===
def atualizar_proximo_prato(sess):
    if not DATABASE_URL:
        return "(banco off)"

    now = datetime.now(TZ)
    cutoff = now.replace(hour=CUTOFF_HOUR, minute=CUTOFF_MIN, second=0, microsecond=0)

    if now <= cutoff:
        target_date = now.date()
    else:
        target_date = (now + timedelta(days=1)).date()

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

        all_jumbotrons = soup.select('.jumbotron')
        target_container = None

        for jumbo in all_jumbotrons:
            title_tag = jumbo.find('h2', class_='display-3')
            if not title_tag:
                continue
            txt = title_tag.get_text(" ", strip=True)
            match = re.search(r'(\d{1,2})\s+de\s+([A-Za-zçÇ]+)\s+de\s+(\d{4})', txt, re.IGNORECASE)
            if match:
                d, m_name, y = match.groups()
                m = meses.get(m_name.capitalize())
                if m:
                    card_date = datetime(int(y), m, int(d)).date()
                    if card_date == target_date:
                        target_container = jumbo
                        break
        
        if target_container:
            container_text = target_container.get_text(" ", strip=True)
            if "não cadastrado" in container_text.lower():
                prato_encontrado = "Cardápio não cadastrado"
            else:
                paragraphs = target_container.find_all('p')
                for p in paragraphs:
                    p_text = p.get_text(" ", strip=True)
                    if "Prato Principal" in p_text:
                        match_prato = re.search(r'Opção 1:\s*(.*?)(?:\s+Opção 2:|$)', p_text, re.IGNORECASE)
                        if match_prato:
                            prato_encontrado = match_prato.group(1).strip()
                        else:
                            prato_encontrado = p_text.replace("Prato Principal:", "").strip()
                        break
                if not prato_encontrado:
                    prato_encontrado = "Prato não identificado no texto"
        else:
            prato_encontrado = "Data não encontrada no site"

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
    if not txt: return ""
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
IGNORE_PATTERNS = [r'Gerado anteriormente', r'Ticket Gerado', r'PULOU_PREF', r'Pulou por prefer.ncia', r'SKIP_DIA']

def is_relevant_error(msg: str) -> bool:
    if not msg: return False
    for pat in IGNORE_PATTERNS:
        if re.search(pat, msg, re.IGNORECASE):
            return False
    return True

# ----------------------- Execução principal ------------------------
def main():
    now = datetime.now(TZ)
    sess = requests.Session()

    prato_do_dia_texto = atualizar_proximo_prato(sess)
    
    target_date_pedido = compute_target_date(now)
    target_dow  = target_date_pedido.isoweekday()

    logging.info("Data alvo do pedido: %s (%s)", target_date_pedido.isoformat(), WEEKDAY_PT[target_dow])
    logging.info("Texto usado para checar bloqueios: %s", prato_do_dia_texto)

    detalhes = []
    alunos = load_alunos_para_dia(target_dow)

    for aluno in alunos:
        aluno_id = aluno['id']
        pront    = aluno['prontuario']
      
        # [NOVO] 1. Checa se o aluno cancelou diretamente pelo bot (cancelamento de última hora)
        if checar_cancelamento_direto(aluno_id, target_date_pedido):
            inicio = datetime.now(TZ).strftime('%H:%M:%S')
            time.sleep(random.randint(0, JITTER_MAX))
            fim = datetime.now(TZ).strftime('%H:%M:%S')
            motivo = 'NAO_PEDIU: CANCELADO_DIRETAMENTE pelo Bot.'
            logging.info(f"PULOU: {pront} cancelou diretamente. Motivo: {motivo}")
            
            # Adiciona ao relatório (assume sucesso, pois a ação de pedido foi impedida)
            detalhes.append((pront, True, motivo, inicio, fim, 0))
            
            # Pula o restante do loop para este aluno
            continue
        
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

        time.sleep(random.randint(0, JITTER_MAX))
        inicio = datetime.now(TZ).strftime('%H:%M:%S')
        
        sucesso, mensagem = False, ''
        tentativa = 0
        for tentativa in range(1, TENTATIVAS + 1):
            try:
                r = enviar_prontuario(sess, pront)
                sucesso, mensagem = parse_feedback(r.text)
                if sucesso: break
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

    # E-mail
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

    # Alerta Admins via WhatsApp Próprio (Novo)
    erros = [(p, m) for (p, ok, m, *_ ) in detalhes if (not ok) and is_relevant_error(m)]
    if erros and ADMINS_E164 and BOT_URL:
        corpo = []
        corpo.append('🚨 *Falhas no Auto-Almoço:*')
        corpo.append(now.strftime('%d/%m %H:%M'))
        corpo.append(f'Prato: {prato_do_dia_texto}')
        corpo.append('')
        for i, (pront, msg) in enumerate(erros[:20], start=1):
            corpo.append(f'{i}. {pront}: {msg}')
        if len(erros) > 20:
            corpo.append(f'... (+{len(erros)-20} falhas)')
        
        notify_admins('\n'.join(corpo))

if __name__ == '__main__':
    main()
