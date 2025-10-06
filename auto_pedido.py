import json, time, logging, random, os, smtplib, requests, re, base64
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime

# === Twilio Sandbox (WhatsApp) ===
TWILIO_ACCOUNT_SID = os.getenv('TWILIO_ACCOUNT_SID')
TWILIO_AUTH_TOKEN  = os.getenv('TWILIO_AUTH_TOKEN')
TWILIO_FROM        = os.getenv('TWILIO_FROM', 'whatsapp:+14155238886')
ADMINS_E164        = [s.strip() for s in os.getenv('ADMINS_E164', '').split(',') if s.strip()]

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

logging.basicConfig(format='%(asctime)s %(levelname)s: %(message)s',
                    level=logging.INFO)

# === E-mail ===
def send_email(subject: str, body: str):
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = EMAIL_USER, TO_ADDRESS, subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

# === WhatsApp via Twilio Sandbox ===
def send_whatsapp_text_twilio(to_e164: str, body: str):
    """
    Envia texto via Twilio WhatsApp Sandbox.
    Requer:
      - to_e164 no formato +5511..., e já 'join' no sandbox.
      - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN configurados.
    """
    if not (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN):
        logging.warning('TWILIO_* não configurados; alerta WhatsApp suprimido.')
        return
    to_full = to_e164 if to_e164.startswith('whatsapp:+') else f'whatsapp:{to_e164 if to_e164.startswith("+") else "+"+to_e164}'
    url = f'https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json'
    auth = base64.b64encode(f'{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}'.encode()).decode()
    data = {'From': TWILIO_FROM, 'To': to_full, 'Body': body[:1600]}
    try:
        r = requests.post(url, data=data, headers={'Authorization': f'Basic {auth}'}, timeout=15)
        if not r.ok:
            logging.error('Falha Twilio %s: %s', r.status_code, r.text)
    except Exception as e:
        logging.exception('Exceção no envio WhatsApp (Twilio): %s', e)

# === Dados ===
def load_alunos():
    with open(ARQUIVO, 'r', encoding='utf-8') as f:
        return json.load(f)

# === HTTP / parsing do site ===
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

# === Filtro de erros relevantes ===
IGNORE_PATTERNS = [
    r'Gerado anteriormente',  # duplicado
    r'Ticket Gerado',         # sucesso
]
def is_relevant_error(msg: str) -> bool:
    if not msg:
        return False
    for pat in IGNORE_PATTERNS:
        if re.search(pat, msg, re.IGNORECASE):
            return False
    return True

# === Execução principal ===
def main():
    hoje = datetime.now().isoweekday()  # 1=seg … 7=dom
    detalhes = []
    sess = requests.Session()

    prato_do_dia = prato_feedback()
    logging.info("Prato do dia: %s", prato_do_dia)

    for aluno in load_alunos():
        if hoje not in aluno.get('dias', []):
            aluno('pediu_para_amanha') = false
            continue

        pront = aluno['prontuario']
        time.sleep(random.randint(0, JITTER_MAX))  # jitter
        inicio = datetime.now().strftime('%H:%M:%S')

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

        fim = datetime.now().strftime('%H:%M:%S')
        detalhes.append((pront, sucesso, mensagem, inicio, fim, tentativa))

    # Email de relatório (como antes)
    linhas = ['Relatório Auto-Almoço — ' + datetime.now().strftime('%d/%m/%Y')]
    ok_total = sum(1 for _, s, *_ in detalhes if s)
    linhas.append(f'Sucesso: {ok_total}/{len(detalhes)}\n')
    linhas.append('Prontuário | Status | Começou -> Terminou | Tentativas | Mensagem')
    linhas.append('-' * 72)
    for pront, ok, msg, ini, fim, tent in detalhes:
        status = 'OK ' if ok else 'FALHOU'
        linhas.append(f'{pront} | {status} | {ini}→{fim} | {tent} | {msg}')
    send_email('Relatório Auto-Almoço', '\n'.join(linhas))

    # Alerta WhatsApp aos admins (apenas erros relevantes)
    erros = [(p, m) for (p, ok, m, *_ ) in detalhes if (not ok) and is_relevant_error(m)]
    if erros and ADMINS_E164:
        max_linhas = 25
        corpo = []
        corpo.append('Falhas relevantes no Auto-Almoço:')
        corpo.append(datetime.now().strftime('Data: %d/%m/%Y  Hora: %H:%M:%S'))
        if prato_do_dia not in ('(indisponível)', '(não encontrado)'):
            corpo.append(f'Prato do dia: {prato_do_dia}')
        corpo.append('')
        for i, (pront, msg) in enumerate(erros[:max_linhas], start=1):
            corpo.append(f'{i}. {pront}: {msg}')
        restantes = len(erros) - min(len(erros), max_linhas)
        if restantes > 0:
            corpo.append(f'… (+{restantes} falhas adicionais)')
        resumo = '\n'.join(corpo)
        for admin in ADMINS_E164:
            send_whatsapp_text_twilio(admin, resumo)

if __name__ == '__main__':
    main()
