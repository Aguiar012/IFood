import json, time, logging, random, os, smtplib, requests
from email.message import EmailMessage
from bs4 import BeautifulSoup
from datetime import datetime, timedelta 

datetime.now() - timedelta(hours=3) # horário de brasilia

#  Configurações gerais
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

# Utilidades de e-mail
def send_email(subject: str, body: str):
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = EMAIL_USER, TO_ADDRESS, subject
    msg.set_content(body)
    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
        smtp.starttls()
        smtp.login(EMAIL_USER, EMAIL_PASS)
        smtp.send_message(msg)

#  Leitura do JSON 
def load_alunos():
    with open(ARQUIVO, 'r') as f:
        return json.load(f)

#  Funções de envio 
def get_csrf_token(sess):
    """Faz GET em /home e extrai o valor do input 'csrfmiddlewaretoken'."""
    resp = sess.get(URL_HOME, timeout=TIMEOUT_SEC)
    soup = BeautifulSoup(resp.text, 'html.parser')
    token_input = soup.find('input', {'name': 'csrfmiddlewaretoken'})
    if not token_input:
        raise RuntimeError('CSRF token não encontrado na página')
    return token_input['value']

def enviar_prontuario(sess, prontuario: str):
    token = get_csrf_token(sess)
    payload = {
        'csrfmiddlewaretoken': token,
        'prontuario': prontuario,
        'tipo': '1'
    }
    headers = {'Referer': URL_HOME}   # alguns servidores exigem
    return sess.post(URL_HOME, data=payload, headers=headers, timeout=TIMEOUT_SEC)

def parse_feedback(html: str):
    soup = BeautifulSoup(html, 'html.parser')

    # Erro vermelho
    erro_div = soup.select_one('.alert.alert-danger.alert-dismissable.fade.in')
    if erro_div:
        msg = erro_div.get_text(" ", strip=True)
        return False, msg

    # Sucesso verde
    ok_div = soup.select_one('.alert.alert-success.alert-dismissable.fade.in')
    if ok_div:
        msg = ok_div.get_text(" ", strip=True)
        return True, msg

    return False, 'Nenhum alerta de sucesso/erro encontrado'

def prato_feedback():
    soup = BeautifulSoup(requests.get(URL_HOME).content, 'html.parser')

    # Almoço do dia / Opção 1
    prato_do_dia_div = soup.select_one('p')
    texto_prato_do_dia = erro_div.get_text(" ", strip=True)

    return texto_prato_do_dia

#  Execução principal 
def main():
    hoje = datetime.now().isoweekday()  # 1=seg … 7=dom
    detalhes = []
    sess = requests.Session()

    prato_do_dia = prato_feedback()
    print(prato_do_dia)

    for aluno in load_alunos():
        if hoje not in aluno.get('dias', []):
            continue

        pront = aluno['prontuario']
        time.sleep(random.randint(0, JITTER_MAX))  # jitter, tempo aleatório
        inicio = datetime.now().strftime('%H:%M:%S')

        sucesso, mensagem = False, ''
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

    #  Monta email e envia o relatório 
    linhas = ['Relatório Auto-Almoço — ' + datetime.now().strftime('%d/%m/%Y')]
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
