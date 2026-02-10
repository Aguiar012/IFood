import psycopg
import logging
from sistema_pedido.configuracao import URL_BANCO_DADOS

def buscar_cancelamento_direto(aluno_id: int, data_pedido) -> bool:
    """
    Verifica se existe um pedido cancelado diretamente para este aluno nesta data.
    Retorna True se o aluno já cancelou (e portanto não devemos pedir).
    """
    if not URL_BANCO_DADOS:
        return False
        
    try:
        with psycopg.connect(URL_BANCO_DADOS) as conexao:
            with conexao.cursor() as cursor:
                cursor.execute("""
                    SELECT 1 
                      FROM pedido
                     WHERE aluno_id = %s
                       AND dia_pedido = %s
                       AND motivo LIKE 'CANCELADO_DIRETAMENTE%%';
                """, (aluno_id, data_pedido))
                resultado = cursor.fetchone()
                return resultado is not None
    except Exception as e:
        logging.error(f"Erro ao buscar cancelamento direto: {e}")
        return False

def buscar_alunos_para_dia(dia_da_semana: int) -> list[dict]:
    """
    Busca alunos que têm preferência para almoçar no dia da semana especificado.
    
    Args:
        dia_da_semana (int): 1=Segunda, ..., 5=Sexta
    
    Returns:
        list[dict]: Lista de dicionários com 'id' e 'prontuario'.
    """
    if not URL_BANCO_DADOS:
        logging.error("❌ URL do banco não configurada!")
        return []

    alunos = []
    try:
        with psycopg.connect(URL_BANCO_DADOS) as conexao:
            with conexao.cursor() as cursor:
                # Seleciona alunos ativos que marcaram este dia da semana
                cursor.execute("""
                    SELECT DISTINCT a.id, a.prontuario
                      FROM aluno a
                      JOIN preferencia_dia p ON p.aluno_id = a.id
                     WHERE a.ativo = true
                       AND p.dia_semana = %s
                     ORDER BY a.prontuario;
                """, (dia_da_semana,))
                
                for (id_aluno, prontuario) in cursor.fetchall():
                    alunos.append({'id': id_aluno, 'prontuario': prontuario})
                    
        return alunos
    except Exception as e:
        logging.error(f"❌ Erro no banco ao buscar alunos: {e}")
        return []

def buscar_pratos_bloqueados(prontuario: str) -> list[str]:
    """Retorna lista de nomes de pratos que o aluno bloqueou."""
    if not URL_BANCO_DADOS:
        return []

    try:
        with psycopg.connect(URL_BANCO_DADOS) as conexao:
            with conexao.cursor() as cursor:
                cursor.execute("""
                    SELECT pb.nome
                      FROM prato_bloqueado pb
                      JOIN aluno a ON a.id = pb.aluno_id
                     WHERE a.prontuario = %s
                     ORDER BY pb.nome;
                """, (prontuario,))
                # Retorna apenas uma lista de strings (ex: ['frango', 'peixe'])
                return [linha[0] for linha in cursor.fetchall()]
    except Exception as e:
        logging.error(f"Erro ao buscar bloqueios do prontuário {prontuario}: {e}")
        return []

def registrar_historico_pedido(aluno_id: int, data_pedido, motivo: str):
    """Salva no banco o resultado da tentativa de pedido (sucesso, erro ou pulo)."""
    if not URL_BANCO_DADOS:
        return

    # Corta o motivo para caber no banco se for muito grande
    motivo_seguro = (motivo or "")[:800]
    
    try:
        with psycopg.connect(URL_BANCO_DADOS) as conexao:
            with conexao.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO pedido (aluno_id, dia_pedido, motivo)
                    VALUES (%s, %s, %s)
                """, (aluno_id, data_pedido, motivo_seguro))
            conexao.commit()
    except Exception as e:
        logging.error(f"❌ Erro ao salvar histórico do pedido: {e}")

def atualizar_prato_dia(data_referencia, nome_prato: str):
    """
    Salva ou atualiza o prato do dia na tabela 'proximo_prato'.
    Isso permite que o Bot do WhatsApp saiba qual é o prato atual.
    """
    if not URL_BANCO_DADOS:
        return

    try:
        with psycopg.connect(URL_BANCO_DADOS) as conexao:
            with conexao.cursor() as cursor:
                cursor.execute("""
                    INSERT INTO proximo_prato (dia_referente, prato_nome, updated_at)
                    VALUES (%s, %s, NOW())
                    ON CONFLICT (dia_referente) 
                    DO UPDATE SET prato_nome = EXCLUDED.prato_nome, updated_at = NOW();
                """, (data_referencia, nome_prato))
            conexao.commit()
    except Exception as e:
        logging.error(f"❌ Erro ao salvar prato do dia no banco: {e}")
