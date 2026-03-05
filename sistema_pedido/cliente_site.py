import requests
import logging
import re
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from sistema_pedido.configuracao import (
    URL_PRINCIPAL, TEMPO_TIMEOUT, FUSO_HORARIO, HORA_CORTE, MINUTO_CORTE
)
from sistema_pedido.banco_dados import atualizar_prato_dia, buscar_prato_por_data

# Mensagens de erro que não precisamos alertar o admin (são "erros" normais de fluxo)
PADROES_ERRO_IGNORAR = [
    r'Gerado anteriormente', 
    r'Ticket Gerado', 
    r'PULOU_PREF', 
    r'Pulou por prefer.ncia', 
    r'SKIP_DIA',
    r'Final de Semana'   # Site retorna isso quando tenta pedir em fim de semana
]

def validar_erro_relevante(mensagem: str) -> bool:
    """Retorna True se o erro for grave e merecer alerta no WhatsApp."""
    if not mensagem: return False
    for padrao in PADROES_ERRO_IGNORAR:
        if re.search(padrao, mensagem, re.IGNORECASE):
            return False
    return True

def obter_token_csrf(sessao, url):
    """Busca o token de segurança (CSRF) escondido no HTML da página."""
    resposta = sessao.get(url, timeout=TEMPO_TIMEOUT)
    resposta.raise_for_status() # Lança erro se a página der 404/500
    
    soup = BeautifulSoup(resposta.texto if hasattr(resposta, 'texto') else resposta.text, 'html.parser')
    input_token = soup.find('input', {'name': 'csrfmiddlewaretoken'})
    
    if not input_token:
        raise RuntimeError('Token de segurança (CSRF) não encontrado na página.')
    return input_token['value']

def interpretar_resposta_pedido(html: str):
    """Lê o HTML de resposta do pedido para saber se deu certo ou errado."""
    soup = BeautifulSoup(html, 'html.parser')
    
    # Procura mensagem de erro (alert-danger)
    div_erro = soup.select_one('.alert.alert-danger.alert-dismissable.fade.in')
    if div_erro:
        return False, div_erro.get_text(" ", strip=True)
    
    # Procura mensagem de sucesso (alert-success)
    div_sucesso = soup.select_one('.alert.alert-success.alert-dismissable.fade.in')
    if div_sucesso:
        return True, div_sucesso.get_text(" ", strip=True)
        
    return False, 'Não encontrei mensagem de confirmação no site.'

def _extrair_prato_do_banner(banner):
    """Extrai o nome do prato de um banner jumbotron."""
    texto_banner = banner.get_text(" ", strip=True)
    if "não cadastrado" in texto_banner.lower():
        return "Cardápio não cadastrado"
    
    paragrafos = banner.find_all('p')
    for p in paragrafos:
        texto_p = p.get_text(" ", strip=True)
        if "Prato Principal" in texto_p:
            match_prato = re.search(r'Opção 1:\s*(.*?)(?:\s+Opção 2:|$)', texto_p, re.IGNORECASE)
            if match_prato:
                return match_prato.group(1).strip()
            else:
                return texto_p.replace("Prato Principal:", "").strip()
    return "Prato não identificado no texto"


def _buscar_banner_por_data(banners, data_alvo, meses):
    """Procura um banner com a data especificada."""
    for banner in banners:
        tag_titulo = banner.find('h2', class_='display-3')
        if not tag_titulo:
            continue
        texto_titulo = tag_titulo.get_text(" ", strip=True)
        match = re.search(r'(\d{1,2})\s+de\s+([A-Za-zçÇ]+)\s+de\s+(\d{4})', texto_titulo, re.IGNORECASE)
        if match:
            d, nome_mes, y = match.groups()
            mes_num = meses.get(nome_mes.capitalize())
            if mes_num:
                data_cardapio = datetime(int(y), mes_num, int(d)).date()
                if data_cardapio == data_alvo:
                    return banner
    return None


def buscar_cardapio_site(sessao, data_pedido=None):
    """
    Acessa o site, le o 'Jumbotron' (banner principal) e tenta descobrir o prato do dia.
    Também salva essa informação no banco de dados para o Bot usar.

    Se data_pedido for fornecida, busca ESPECIFICAMENTE o prato dessa data
    (para que o bloqueio compare o prato correto, não o de hoje).
    Caso contrário, mantém comportamento antigo (busca prato de hoje/amanhã).
    """
    agora = datetime.now(FUSO_HORARIO)
    corte = agora.replace(hour=HORA_CORTE, minute=MINUTO_CORTE, second=0, microsecond=0)

    hoje = agora.date()

    # Decide a data principal para buscar no site
    if agora <= corte:
        data_alvo_site = hoje
    else:
        data_alvo_site = (agora + timedelta(days=1)).date()

    # Pula fim de semana
    while data_alvo_site.isoweekday() in (6, 7):
        data_alvo_site += timedelta(days=1)

    logging.info(f"Buscando cardápio no site para a data: {data_alvo_site}")
    if data_pedido and data_pedido != data_alvo_site:
        logging.info(f"📌 Data do PEDIDO é {data_pedido} (diferente do cardápio visível hoje)")

    meses = {
        'Janeiro': 1, 'Fevereiro': 2, 'Março': 3, 'Abril': 4, 'Maio': 5, 'Junho': 6,
        'Julho': 7, 'Agosto': 8, 'Setembro': 9, 'Outubro': 10, 'Novembro': 11, 'Dezembro': 12
    }

    try:
        resposta = sessao.get(URL_PRINCIPAL, timeout=TEMPO_TIMEOUT)
        resposta.raise_for_status()
        soup = BeautifulSoup(resposta.text, 'html.parser')
        todos_banners = soup.select('.jumbotron')

        # 1. Salva TODOS os banners encontrados no banco (para uso futuro)
        prato_por_data = {}
        for banner in todos_banners:
            tag_titulo = banner.find('h2', class_='display-3')
            if not tag_titulo:
                continue
            texto_titulo = tag_titulo.get_text(" ", strip=True)
            match = re.search(r'(\d{1,2})\s+de\s+([A-Za-zçÇ]+)\s+de\s+(\d{4})', texto_titulo, re.IGNORECASE)
            if match:
                d, nome_mes, y = match.groups()
                mes_num = meses.get(nome_mes.capitalize())
                if mes_num:
                    data_banner = datetime(int(y), mes_num, int(d)).date()
                    prato_banner = _extrair_prato_do_banner(banner)
                    prato_por_data[data_banner] = prato_banner
                    atualizar_prato_dia(data_banner, prato_banner)
                    logging.info(f"Cardápio salvo -> Dia: {data_banner} | Prato: {prato_banner}")

        # 2. Determina qual prato retornar para checagem de bloqueios
        # PRIORIDADE: prato da data_pedido (dia que o aluno vai comer)
        prato_para_bloqueio = None

        if data_pedido and data_pedido in prato_por_data:
            prato_para_bloqueio = prato_por_data[data_pedido]
            logging.info(f"✅ Prato da data do PEDIDO ({data_pedido}) encontrado no site: {prato_para_bloqueio}")
        elif data_pedido:
            # Tenta buscar do banco de dados (pode ter sido salvo em execução anterior)
            prato_banco = buscar_prato_por_data(data_pedido)
            if prato_banco and "não" not in prato_banco.lower() and "erro" not in prato_banco.lower():
                prato_para_bloqueio = prato_banco
                logging.info(f"✅ Prato da data do PEDIDO ({data_pedido}) encontrado no BANCO: {prato_para_bloqueio}")
            else:
                logging.warning(f"⚠️ Prato da data do PEDIDO ({data_pedido}) NÃO encontrado (site nem banco). Bloqueio DESATIVADO para segurança.")
                # Se não sabemos o prato do dia alvo, NÃO bloqueamos
                # (melhor pedir e o aluno não comer do que não pedir e ficar sem almoço)
                prato_para_bloqueio = None

        # Fallback: se não pediu data_pedido específica, usa comportamento antigo
        if prato_para_bloqueio is None and data_pedido is None:
            prato_para_bloqueio = prato_por_data.get(data_alvo_site)
            if not prato_para_bloqueio:
                # Fallback para hoje
                prato_para_bloqueio = prato_por_data.get(hoje)

        return prato_para_bloqueio or "(cardápio não disponível)"

    except Exception as e:
        logging.error(f"Erro ao ler cardápio do site: {e}")
        return "(erro na atualização)"

def realizar_pedido(sessao, prontuario: str):
    """Envia a requisição POST para fazer o pedido."""
    try:
        token = obter_token_csrf(sessao, URL_PRINCIPAL)
        dados = {
            'csrfmiddlewaretoken': token, 
            'prontuario': prontuario, 
            'tipo': '1' # Código para almoço padrão?
        }
        cabecalhos = {'Referer': URL_PRINCIPAL}
        
        resposta = sessao.post(URL_PRINCIPAL, data=dados, headers=cabecalhos, timeout=TEMPO_TIMEOUT)
        return interpretar_resposta_pedido(resposta.text)
        
    except Exception as e:
        return False, str(e)
