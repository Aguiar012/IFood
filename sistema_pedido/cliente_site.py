import requests
import logging
import re
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from sistema_pedido.configuracao import (
    URL_PRINCIPAL, TEMPO_TIMEOUT, FUSO_HORARIO, HORA_CORTE, MINUTO_CORTE
)
from sistema_pedido.banco_dados import atualizar_prato_dia

# Mensagens de erro que não precisamos alertar o admin (são "erros" normais de fluxo)
PADROES_ERRO_IGNORAR = [
    r'Gerado anteriormente', 
    r'Ticket Gerado', 
    r'PULOU_PREF', 
    r'Pulou por prefer.ncia', 
    r'SKIP_DIA'
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


def buscar_cardapio_site(sessao):
    """
    Acessa o site, le o 'Jumbotron' (banner principal) e tenta descobrir o prato do dia.
    Também salva essa informação no banco de dados para o Bot usar.
    Tenta a data alvo primeiro (amanha se apos corte), e faz fallback para hoje.
    """
    agora = datetime.now(FUSO_HORARIO)
    corte = agora.replace(hour=HORA_CORTE, minute=MINUTO_CORTE, second=0, microsecond=0)

    hoje = agora.date()
    
    # Decide a data principal para buscar
    if agora <= corte:
        data_alvo = hoje
    else:
        data_alvo = (agora + timedelta(days=1)).date()

    # Pula fim de semana
    while data_alvo.isoweekday() in (6, 7):
        data_alvo += timedelta(days=1)

    logging.info(f"Buscando cardapio no site para a data: {data_alvo}")

    meses = {
        'Janeiro': 1, 'Fevereiro': 2, 'Março': 3, 'Abril': 4, 'Maio': 5, 'Junho': 6,
        'Julho': 7, 'Agosto': 8, 'Setembro': 9, 'Outubro': 10, 'Novembro': 11, 'Dezembro': 12
    }

    try:
        resposta = sessao.get(URL_PRINCIPAL, timeout=TEMPO_TIMEOUT)
        resposta.raise_for_status()
        soup = BeautifulSoup(resposta.text, 'html.parser')
        todos_banners = soup.select('.jumbotron')

        # 1. Tenta a data alvo principal
        banner_alvo = _buscar_banner_por_data(todos_banners, data_alvo, meses)
        prato_encontrado = None

        if banner_alvo:
            prato_encontrado = _extrair_prato_do_banner(banner_alvo)
            logging.info(f"Cardapio encontrado -> Dia: {data_alvo} | Prato: {prato_encontrado}")
            atualizar_prato_dia(data_alvo, prato_encontrado)
        else:
            logging.warning(f"Data {data_alvo} nao encontrada no site.")
            atualizar_prato_dia(data_alvo, "Data não encontrada no site")

        # 2. Fallback: se a data alvo nao e hoje, tenta tambem salvar o de hoje
        if data_alvo != hoje and hoje.isoweekday() not in (6, 7):
            banner_hoje = _buscar_banner_por_data(todos_banners, hoje, meses)
            if banner_hoje:
                prato_hoje = _extrair_prato_do_banner(banner_hoje)
                logging.info(f"Cardapio de hoje tambem encontrado -> Dia: {hoje} | Prato: {prato_hoje}")
                atualizar_prato_dia(hoje, prato_hoje)
                # Se o alvo principal nao foi encontrado, usa o de hoje como referencia
                if not prato_encontrado or "não" in prato_encontrado.lower():
                    prato_encontrado = prato_hoje

        return prato_encontrado or "(cardápio não disponível)"

    except Exception as e:
        logging.error(f"Erro ao ler cardapio do site: {e}")
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
