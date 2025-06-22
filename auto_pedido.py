import json, time, logging, requests, os, smtplib, random
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime

# ——— Configurações ———
URL_HOME    = 'http://200.133.203.133/home'
URL_SUBMIT  = 'http://200.133.203.133/home'
ARQUIVO     = 'redes.json'
JITTER_MAX  = 120
TENTATIVAS  = 3
RETRY_SEC   = 30

EMAIL_USER   = os.getenv('EMAIL_USER')
EMAIL_PASS   = os.getenv('EMAIL_PASS')
SMTP_SERVER  = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT    = int(os.getenv('SMTP_PORT', 587))
TO_ADDRESS   = os.getenv('TO_ADDRESS')

logging.basicConfig(
    format='%(asctime)s %(levelname)s: %(message)s',
    level=logging.INFO
)

def send_email(subject, body):
    msg = EmailMessage()
    msg['From']    = EMAIL_USER
    msg['To']      = TO_ADDRESS
    msg['Subject'] = subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

def load_alunos():
    with open(ARQUIVO, 'r') as f:
        return json.load(f)

def submit_prontuario(sess, pront):
    sess.get(URL_HOME, timeout=10)
    return sess.post(URL_SUBMIT, data={'prontuario': pront}, timeout=10)

def check_feedback(html):
    soup = BeautifulSoup(html, 'html.parser')
    alert = soup.select_one('.alert.alert-danger.alert-dismissable.fade.in > strong')
    if alert and alert.get_text(strip=True) == 'Que pena!':
        detalhe = soup.select_one('.alert.alert-danger').text.split('devido ao problema:')[-1].strip()
        return False, detalhe
    return True, None

def main():
    hoje = datetime.now().isoweekday()  # 1=segunda … 7=domingo
    resultados = []
    sess = requests.Session()

    for aluno in load_alunos():
        pront = aluno['prontuario']
        dias = aluno.get('dias', [])
        if hoje not in dias:
            logging.info(f'{pront}: pula hoje (dia {hoje})')
            continue

        # jitter antes de cada envio
        espera = random.randint(0, JITTER_MAX)
        logging.info(f'{pront}: esperando {espera}s antes de enviar')
        time.sleep(espera)

        sucesso, detalhe_falha = False, None
        for i in range(1, TENTATIVAS+1):
            try:
                r = submit_prontuario(sess, pront)
                ok, detalhe = check_feedback(r.text)
                if ok:
                    logging.info(f'{pront}: sucesso na tentativa {i}')
                    sucesso = True
                    break
                else:
                    raise Exception(detalhe)
            except Exception as e:
                detalhe_falha = str(e)
                logging.warning(f'{pront}: falha {i}/{TENTATIVAS} – {e}')
                time.sleep(RETRY_SEC)

        resultados.append((pront, sucesso, detalhe_falha))

    # gerar relatório
    enviados = [p for p, s, _ in resultados if s]
    falhas   = [(p, d) for p, s, d in resultados if not s]

    body = [
        f'Almoços solicitados com sucesso: {len(enviados)}/{len(resultados)}'
    ]
    if enviados:
        body.append('→ ' + ', '.join(enviados))
    if falhas:
        body.append(f'\nFalhas ({len(falhas)}):')
        for p, d in falhas:
            body.append(f'  • {p}: {d}')

    send_email('Relatório Auto-Almoço', '\n'.join(body))


if __name__ == '__main__':
    main()
