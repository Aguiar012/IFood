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
    Retorna a data DO ALMOÇO que o SICA considera no momento atual.
    - Antes de 13:15 -> D+1
    - A partir de 13:15 -> D+2
    """
    if now is None:
        now = datetime.now(TZ)
    cutoff = now.replace(hour=CUTOFF_HOUR, minute=CUTOFF_MIN, second=0, microsecond=0)
    days_ahead = 1 if now < cutoff else 2
    return (now + timedelta(days=days_ahead)).date()

# --------------------------- E-mail --------------------------------
def send_email(subject: str, body: str):
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = EMAIL_USER, TO_ADDRESS, subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

# --------------------- WhatsApp via Twilio -------------------------


# --------------------------- Dados ---------------------------------
def load_alunos_para_dia(target_dow: int):
    """
    Busca SOMENTE quem almoça no dia-alvo e está ativo.
    Retorna lista de dicts: { 'id': ..., 'prontuario': ... }
    """
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
    """
    Salva um registro na tabela 'pedido'.

    dia_pedido: date -> normalmente a target_date (data do almoço).
    motivo: texto curto explicando o que aconteceu.
    """
    if not DATABASE_URL:
        return
    # corta motivo gigante pra não encher a tabela com HTML inteiro, etc.
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

def prato_feedback():
    try:
        r = requests.get(URL_HOME, timeout=TIMEOUT_SEC)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, 'html.parser')
        p = soup.select_one('p')
        return p.get_text(" ", strip=True) if p else '(não encontrado)'
    except Exception as e:
        logging.warning('Não foi possível obter prato do dia: %s', e)
        return '(indisponível)'

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
    r'SKIP_DIA',                      # para pulos esperados por dia
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
    target_date = compute_target_date(now)
    target_dow  = target_date.isoweekday()

    logging.info("Janela SICA -> data-alvo: %s (%s)",
                 target_date.isoformat(), WEEKDAY_PT[target_dow])

    detalhes = []
    sess = requests.Session()

    prato_do_dia = prato_feedback()
    logging.info("Prato do dia (%s): %s", target_date.isoformat(), prato_do_dia)

    # === Somente quem come no dia-alvo ===
    alunos = load_alunos_para_dia(target_dow)

    for aluno in alunos:
        pront = aluno['prontuario']

        # Checagem de bloqueios de prato
        aluno_id = aluno['id']
        pront    = aluno['prontuario']
        
        bloqueios = get_bloqueios_por_prontuario(pront)
        skip, hits = should_skip(prato_do_dia, bloqueios)
        if skip:
            inicio = datetime.now(TZ).strftime('%H:%M:%S')
            time.sleep(random.randint(0, JITTER_MAX))
            fim = datetime.now(TZ).strftime('%H:%M:%S')
        
            motivo = f'NAO_PEDIU: prato contém bloqueios -> {hits}'
            registrar_pedido(aluno_id, target_date, motivo)
        
            detalhes.append((pront, True, motivo, inicio, fim, 0))
            continue

          # Tentativa de pedido
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
    
    registrar_pedido(aluno_id, target_date, motivo)


    # ----------------- E-mail de relatório -----------------
    linhas = ['Relatório Auto-Almoço — ' + now.strftime('%d/%m/%Y')]
    linhas.append(f'Data-alvo: {target_date.strftime("%d/%m/%Y")} ({WEEKDAY_PT[target_dow]})')
    ok_total = sum(1 for _, s, *_ in detalhes if s)
    linhas.append(f'Sucesso: {ok_total}/{len(detalhes)}\n')
    linhas.append('Prontuário | Status | Começou -> Terminou | Tentativas | Mensagem')
    linhas.append('-' * 72)
    for pront, ok, msg, ini, fim, tent in detalhes:
        status = 'OK ' if ok else 'FALHOU'
        linhas.append(f'{pront} | {status} | {ini}→{fim} | {tent} | {msg}')
    send_email('Relatório Auto-Almoço', '\n'.join(linhas))

    # -------------- Alerta WhatsApp admins (erros) --------------
    erros = [(p, m) for (p, ok, m, *_ ) in detalhes if (not ok) and is_relevant_error(m)]
    if erros and ADMINS_E164:
        max_linhas = 25
        corpo = []
        corpo.append('Falhas relevantes no Auto-Almoço:')
        corpo.append(now.strftime('Data: %d/%m/%Y  Hora: %H:%M:%S'))
        if prato_do_dia not in ('(indisponível)', '(não encontrado)'):
            corpo.append(f'Prato do dia ({target_date}): {prato_do_dia}')
        corpo.append('')
        for i, (pront, msg) in enumerate(erros[:max_linhas], start=1):
            corpo.append(f'{i}. {pront}: {msg}')
        restantes = len(erros) - min(len(erros), max_linhas)
        if restantes > 0:
            corpo.append(f'… (+{restantes} falhas adicionais)')
        resumo = '\n'.join(corpo)


if __name__ == '__main__':
    main()
