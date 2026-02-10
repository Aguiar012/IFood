import time
import random
import requests
import logging
from datetime import datetime
from sistema_pedido.configuracao import (
    FUSO_HORARIO, ATRASO_MAXIMO, TENTATIVAS_PEDIDO, TEMPO_ESPERA_ERRO, 
    validar_configuracao
)
from sistema_pedido.utils import data_alvo_pedido, verificar_bloqueios, DIAS_SEMANA_PT
from sistema_pedido.cliente_site import (
    buscar_cardapio_site, realizar_pedido, validar_erro_relevante
)
from sistema_pedido.banco_dados import (
    buscar_alunos_para_dia, buscar_pratos_bloqueados, 
    registrar_historico_pedido, buscar_cancelamento_direto
)
from sistema_pedido.servicos.email import enviar_email
from sistema_pedido.servicos.whatsapp import notificar_administradores

def principal():
    """Função principal que gerencia todo o processo de pedidos."""
    validar_configuracao()
    agora = datetime.now(FUSO_HORARIO)
    
    # Cria uma sessão HTTP para manter cookies (importante para o CSRF token)
    sessao = requests.Session()

    # 1. Atualiza o cardápio no banco e descobre o prato do dia
    texto_prato_dia = buscar_cardapio_site(sessao)
    
    # 2. Calcula para qual data vamos fazer os pedidos
    data_pedido = data_alvo_pedido(agora)
    dia_semana_iso = data_pedido.isoweekday()
    nome_dia_semana = DIAS_SEMANA_PT.get(dia_semana_iso, 'dia-desconhecido')

    logging.info(f"📅 Data alvo do pedido: {data_pedido} ({nome_dia_semana})")
    logging.info(f"🍛 Texto usado para checar bloqueios: {texto_prato_dia}")

    # Lista para guardar o relatório de execução
    detalhes_execucao = []
    
    # 3. Busca alunos que querem almoçar nesse dia da semana
    alunos = buscar_alunos_para_dia(dia_semana_iso)
    logging.info(f"👥 Encontrados {len(alunos)} alunos para processar.")

    for aluno in alunos:
        id_aluno = aluno['id']
        prontuario = aluno['prontuario']
        
        # 4. Checa se o aluno cancelou manualmente (via Bot) para este dia
        if buscar_cancelamento_direto(id_aluno, data_pedido):
            hora_inicio = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
            # Pausa aleatória para parecer humano
            time.sleep(random.randint(0, ATRASO_MAXIMO))
            hora_fim = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
            
            motivo = 'NAO_PEDIU: CANCELADO_DIRETAMENTE pelo Bot.'
            logging.info(f"⏭️ PULOU: {prontuario} cancelou diretamente.")
            
            detalhes_execucao.append((prontuario, True, motivo, hora_inicio, hora_fim, 0))
            continue
        
        # 5. Verifica restrições alimentares (bloqueios)
        lista_bloqueios = buscar_pratos_bloqueados(prontuario)
        deve_pular, motivo_bloqueio = verificar_bloqueios(texto_prato_dia, lista_bloqueios)
        
        if deve_pular:
            hora_inicio = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
            time.sleep(random.randint(0, ATRASO_MAXIMO))
            hora_fim = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
            
            motivo = f'NAO_PEDIU: prato contém bloqueios -> {motivo_bloqueio}'
            logging.info(f"🚫 BLOQUEADO: {prontuario} por {motivo_bloqueio}")
            
            registrar_historico_pedido(id_aluno, data_pedido, motivo)
            detalhes_execucao.append((prontuario, True, motivo, hora_inicio, hora_fim, 0))
            continue

        # 6. Tenta realizar o pedido
        time.sleep(random.randint(0, ATRASO_MAXIMO))
        hora_inicio = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
        
        sucesso_pedido = False
        mensagem_resultado = ''
        tentativa = 0
        
        for tentativa in range(1, TENTATIVAS_PEDIDO + 1):
            logging.info(f"🔄 Tentativa {tentativa} para {prontuario}...")
            try:
                sucesso_pedido, mensagem_resultado = realizar_pedido(sessao, prontuario)
                if sucesso_pedido:
                    logging.info(f"✅ Sucesso para {prontuario}: {mensagem_resultado}")
                    break
                else:
                    logging.warning(f"⚠️ Falha para {prontuario}: {mensagem_resultado}")
                    raise ValueError(mensagem_resultado) # Força cair no except para tentar de novo ou sair
            except Exception as e:
                mensagem_resultado = str(e)
                if tentativa < TENTATIVAS_PEDIDO:
                    time.sleep(TEMPO_ESPERA_ERRO)
        
        hora_fim = datetime.now(FUSO_HORARIO).strftime('%H:%M:%S')
        detalhes_execucao.append((prontuario, sucesso_pedido, mensagem_resultado, hora_inicio, hora_fim, tentativa))
    
        # 7. Salva o resultado no banco
        if sucesso_pedido:
            motivo_log = f'PEDIU_OK: {mensagem_resultado}'
        else:
            motivo_log = f'ERRO_PEDIDO: {mensagem_resultado}'
        
        registrar_historico_pedido(id_aluno, data_pedido, motivo_log)

    # 8. Gera Relatório por E-mail
    linhas_email = [f'Relatório Auto-Almoço — {agora.strftime("%d/%m/%Y")}']
    linhas_email.append(f'Data-alvo: {data_pedido.strftime("%d/%m/%Y")} ({nome_dia_semana})')
    
    total_sucesso = sum(1 for _, ok, _, _, _, _ in detalhes_execucao if ok)
    linhas_email.append(f'Sucesso: {total_sucesso}/{len(detalhes_execucao)}\n')
    linhas_email.append('Prontuário | Status | Começou -> Terminou | Tentativas | Mensagem')
    linhas_email.append('-' * 72)
    
    for pront, ok, msg, ini, fim, tent in detalhes_execucao:
        status_txt = 'OK ' if ok else 'FALHOU'
        linhas_email.append(f'{pront} | {status_txt} | {ini}→{fim} | {tent} | {msg}')
        
    enviar_email('Relatório Auto-Almoço', '\n'.join(linhas_email))

    # 9. Envia Alerta no WhatsApp (apenas erros relevantes)
    lista_erros = [
        (p, m) for (p, ok, m, *_ ) in detalhes_execucao 
        if (not ok) and validar_erro_relevante(m)
    ]
    
    if lista_erros:
        corpo_zap = []
        corpo_zap.append('🚨 *Falhas no Auto-Almoço:*')
        corpo_zap.append(agora.strftime('%d/%m %H:%M'))
        corpo_zap.append(f'Prato: {texto_prato_dia}')
        corpo_zap.append('')
        
        for i, (pront, msg) in enumerate(lista_erros[:20], start=1):
            corpo_zap.append(f'{i}. {pront}: {msg}')
            
        if len(lista_erros) > 20:
            corpo_zap.append(f'... (+{len(lista_erros)-20} falhas)')
        
        notificar_administradores('\n'.join(corpo_zap))
        logging.info("📱 Alerta de erros enviado para o WhatsApp.")

if __name__ == '__main__':
    principal()
