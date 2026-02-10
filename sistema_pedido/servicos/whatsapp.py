import requests
import logging
from sistema_pedido.configuracao import URL_BOT_WHATSAPP, ADMINISTRADORES

def notificar_administradores(mensagem: str):
    """
    Envia uma mensagem de alerta para os números de administradores configurados
    via API do seu bot WhatsApp.
    
    Args:
        mensagem (str): O texto a ser enviado.
    """
    if not URL_BOT_WHATSAPP or not ADMINISTRADORES:
        logging.warning("⚠️ Bot URL ou Admins não configurados. Alerta WhatsApp ignorado.")
        return

    # Limpa espaços e separa por vírgula para pegar cada número
    lista_admins = [num.strip() for num in ADMINISTRADORES.split(',') if num.strip()]
    
    for numero in lista_admins:
        try:
            payload = {
                "number": numero,     # Número do destinatário
                "message": mensagem   # Mensagem
            }
            # Envia requisição POST para o bot (Node.js)
            # Timeout curto (10s) para não travar o script se o bot estiver offline
            resposta = requests.post(URL_BOT_WHATSAPP, json=payload, timeout=10)
            
            if resposta.status_code != 200:
                logging.error(f"❌ Erro ao notificar {numero}: {resposta.text}")
            else:
                logging.info(f"📱 Alerta enviado para {numero}")

        except Exception as erro:
            logging.error(f"❌ Falha de conexão ao notificar admin {numero}: {erro}")
