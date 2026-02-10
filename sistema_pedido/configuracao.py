import os
import logging
from zoneinfo import ZoneInfo

# === Configurações Gerais do Sistema ===

# URL do site do refeitório onde os pedidos são feitos
URL_PRINCIPAL = 'http://200.133.203.133/home'

# Intervalo máximo de atraso aleatório (em segundos) para simular comportamento humano
# Isso evita que todos os pedidos sejam feitos exatamente no mesmo milissegundo
ATRASO_MAXIMO = 120  

# Quantas vezes tentar fazer o pedido em caso de erro
TENTATIVAS_PEDIDO = 2

# Tempo de espera (em segundos) antes de tentar novamente após um erro
TEMPO_ESPERA_ERRO = 30

# Tempo limite (em segundos) para esperar uma resposta do site
TEMPO_TIMEOUT = 10

# === Configurações de E-mail (Gmail) ===
EMAIL_USUARIO = os.getenv('EMAIL_USER')
EMAIL_SENHA   = os.getenv('EMAIL_PASS')
SERVIDOR_SMTP = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
PORTA_SMTP    = int(os.getenv('SMTP_PORT', 587))
EMAIL_DESTINO = os.getenv('TO_ADDRESS')

# === Configuração do Bot de Alerta (WhatsApp) ===
# URL do seu bot (Node.js) que envia as mensagens
URL_BOT_WHATSAPP = os.getenv('BOT_URL') 

# Lista de números de telefone (administradores) que receberão alertas de erro
# Deve ser uma string separada por vírgulas, ex: "5511999999999,5511888888888"
ADMINISTRADORES = os.getenv('ADMINS_E164', '')

# === Banco de Dados ===
URL_BANCO_DADOS = os.getenv('DATABASE_URL')

# === Configurações de Tempo e Fuso Horário ===
# Fuso horário oficial do campus (São Paulo)
FUSO_HORARIO = ZoneInfo('America/Sao_Paulo')

# Horário limite para considerar o pedido para "amanhã" ou "hoje"
# Se for antes das 13:15, tenta pedir para o dia seguinte (se for útil).
HORA_CORTE = 13
MINUTO_CORTE = 15

# Configuração básica de logs (mensagens no terminal)
logging.basicConfig(
    format='%(asctime)s %(levelname)s: %(message)s',
    level=logging.INFO
)

def validar_configuracao():
    """Verifica se as variáveis de ambiente essenciais estão definidas."""
    erros = []
    if not EMAIL_USUARIO:
        erros.append("EMAIL_USER não definido")
    if not EMAIL_SENHA:
        erros.append("EMAIL_PASS não definido")
    if not URL_BANCO_DADOS:
        erros.append("DATABASE_URL não definido")
    
    if erros:
        logging.warning("⚠️ Algumas configurações estão faltando: %s", ", ".join(erros))
    else:
        logging.info("✅ Configuração carregada com sucesso.")
