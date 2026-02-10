import smtplib
import logging
from email.message import EmailMessage
from sistema_pedido.configuracao import (
    EMAIL_USUARIO, EMAIL_SENHA, SERVIDOR_SMTP, PORTA_SMTP, EMAIL_DESTINO
)

def enviar_email(assunto: str, corpo: str):
    """
    Envia um e-mail simples usando as configurações do sistema_pedido.
    
    Args:
        assunto (str): O título do e-mail.
        corpo (str): O conteúdo da mensagem (texto puro).
    """
    if not EMAIL_USUARIO or not EMAIL_DESTINO:
        logging.warning("⚠️ Tentativa de enviar e-mail falhou: Credenciais ou Destinatário não configurados.")
        return

    mensagem = EmailMessage()
    mensagem['From'] = EMAIL_USUARIO
    mensagem['To'] = EMAIL_DESTINO
    mensagem['Subject'] = assunto
    mensagem.set_content(corpo)

    try:
        # Conecta ao servidor SMTP (ex: Gmail)
        with smtplib.SMTP(SERVIDOR_SMTP, PORTA_SMTP) as smtp:
            smtp.starttls() # Inicia criptografia TLS para segurança
            smtp.login(EMAIL_USUARIO, EMAIL_SENHA)
            smtp.send_message(mensagem)
        logging.info(f"📧 E-mail enviado: '{assunto}'")
    except Exception as erro:
        logging.error(f"❌ Falha ao enviar email: {erro}")
