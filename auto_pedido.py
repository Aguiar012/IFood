import json, time, logging, requests, os, smtplib, random
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime

URL_HOME    = 'http://200.133.203.133/home'
URL_SUBMIT  = 'http://200.133.203.133/home'   # AJUSTE AQUI após inspeção!
ARQUIVO     = 'redes.json'

JITTER_MAX  = 120
TENTATIVAS  = 3
RETRY_SEC   = 30
TIMEOUT_SEC = 10

EMAIL_USER   = os.getenv('EMAIL_USER')
EMAIL_PASS   = os.getenv('EMAIL_PASS')
SMTP_SERVER  = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT    = int(os.getenv('SMTP_PORT', 587))
TO_ADDRESS   = os.getenv('TO_ADDRESS')

logging.basicConfig(format='%(asctime)s %(levelname)s: %(message)s',
                    level=logging.INFO)

def send_email(subject, body):
    msg = EmailMessage()
    msg['From'] = EMAIL_USER
    msg['To'] = TO_ADDRESS
    msg['Subject'] = subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

def load_alunos():
    with open(ARQUIVO, 'r') as f:
        return json.load(f)

def enviar(sess, pront):
    """Submete o prontuário. Ajuste para GET se necessário."""
    sess.get(URL_HOME, timeout=TIMEOUT_SEC)           # para pegar cookies / token
    return sess.post(URL_SUBMIT,
                     data={'prontuario': pront},
                     timeout=TIMEOUT_SEC)

def parse_result(html):
    soup = BeautifulSoup(html, 'html.parser')
    sucesso = soup.select_one('.alert.alert-success')
    erro     = soup.select_one('.alert.alert-danger')
    if sucesso:
        return True, sucesso.get_text(strip=True)
    if erro:
        return False, erro.get_text(strip=True)
    return False, 'Sem mensagem de sucesso nem erro - possivelmente endpoint errado'

def main():
    hoje = datetime.now().isoweekday()  # 1=seg … 7=dom
    detalhes = []                       # lista de tuplas p/ e-mail
    sess = requests.Session()

    for aluno in load_alunos():
        pront = aluno['prontuario']
        if hoje not in aluno.get('dias', []):
            continue

        time.sleep(random.randint(0, JITTER_MAX))
        ts_inicio = datetime.now().strftime('%H:%M:%S')

        ok, msg, tentativa = False, '', 0
        for tentativa in range(1, TENTATIVAS + 1):
            try:
                r = enviar(sess, pront)
                ok, msg = parse_result(r.text)
                if ok:
                    break
                raise ValueError(msg)
            except Exception as e:
                msg = str(e)
                time.sleep(RETRY_SEC)

        ts_fim = datetime.now().strftime('%H:%M:%S')
        detalhes.append((pront, ok, msg, ts_inicio, ts_fim, tentativa))

    # ───────────── Email ─────────────
    linhas = ['Relatório de envios ' + datetime.now().strftime('%d/%m/%Y')]
    for pront, ok, msg, ini, fim, tent in detalhes:
        status = 'OK' if ok else 'FAIL'
        linhas.append(f'{pront} | {status} | {ini}→{fim} | T{tent} | {msg}')

    sucesso_total = sum(1 for _, ok, *_ in detalhes if ok)
    linhas.insert(1, f'Sucesso: {sucesso_total}/{len(detalhes)}\n')
    send_email('Relatório Auto-Almoço', '\n'.join(linhas))

if __name__ == '__main__':
    main()
