import requests
import logging
import time
from sistema_pedido.configuracao import URL_BOT_WHATSAPP, ADMINISTRADORES

# Configuração de retry para notificações críticas
MAX_TENTATIVAS = 3
ESPERA_ENTRE_TENTATIVAS = 15  # segundos

def notificar_administradores(mensagem: str):
    """
    Envia uma mensagem de alerta para os números de administradores configurados
    via API do bot WhatsApp.
    
    Inclui retry automático para evitar perda de alertas em caso de
    indisponibilidade temporária (ex: bot reiniciando após deploy).
    """
    if not URL_BOT_WHATSAPP or not ADMINISTRADORES:
        logging.warning("⚠️ Bot URL ou Admins não configurados. Alerta WhatsApp ignorado.")
        return

    # Limpa espaços e separa por vírgula para pegar cada número
    lista_admins = [num.strip() for num in ADMINISTRADORES.split(',') if num.strip()]
    
    for numero in lista_admins:
        enviado = False
        for tentativa in range(1, MAX_TENTATIVAS + 1):
            try:
                payload = {
                    "number": numero,
                    "message": mensagem
                }
                resposta = requests.post(URL_BOT_WHATSAPP, json=payload, timeout=15)
                
                if resposta.status_code == 200:
                    logging.info(f"📱 Alerta enviado para {numero}")
                    enviado = True
                    break
                elif resposta.status_code == 503:
                    # Bot conectado mas WhatsApp offline - retry pode ajudar
                    logging.warning(f"⏳ Bot offline (503) para {numero}. Tentativa {tentativa}/{MAX_TENTATIVAS}")
                else:
                    logging.error(f"❌ Erro {resposta.status_code} ao notificar {numero}: {resposta.text}")
                    enviado = True  # Não dá retry em erros 4xx (dados errados, etc)
                    break

            except requests.exceptions.ConnectionError:
                logging.warning(f"⏳ Conexão recusada para {numero}. Tentativa {tentativa}/{MAX_TENTATIVAS}")
            except requests.exceptions.Timeout:
                logging.warning(f"⏳ Timeout ao notificar {numero}. Tentativa {tentativa}/{MAX_TENTATIVAS}")
            except Exception as erro:
                logging.error(f"❌ Erro inesperado ao notificar {numero}: {erro}")
                break  # Erro desconhecido, não tenta de novo

            # Espera antes de tentar novamente
            if tentativa < MAX_TENTATIVAS:
                time.sleep(ESPERA_ENTRE_TENTATIVAS)

        if not enviado:
            logging.error(f"🚨 FALHA TOTAL: Não conseguiu notificar {numero} após {MAX_TENTATIVAS} tentativas!")

