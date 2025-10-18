import os, json
import psycopg

DATABASE_URL = os.getenv("DATABASE_URL")
ARQ = "redes.json"

"""
Estrutura esperada em cada item do JSON:
{
  "prontuario": "3031365",
  "nome": "Ismael",
  "telefone": "+5511999999999",         # opcional
  "dias": [1,3,4],                      # 1=seg ... 7=dom
  "bloqueios": ["peixe","bisteca"]      # opcional; lista de palavras/trechos
}
Campos ausentes são ignorados com segurança.
"""

def main():
    if not DATABASE_URL:
        raise SystemExit("Faltou DATABASE_URL")

    with open(ARQ, "r", encoding="utf-8") as f:
        dados = json.load(f)

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            for item in dados:
                pront = item["prontuario"].strip()
                nome  = (item.get("nome") or "").strip() or None
                tel   = (item.get("telefone") or "").strip() or None
                dias  = item.get("dias", [])
                blq   = item.get("bloqueios", [])

                # upsert aluno
                cur.execute("""
                    insert into aluno (prontuario, nome, ativo)
                    values (%s, %s, true)
                    on conflict (prontuario) do update set
                      nome = coalesce(excluded.nome, aluno.nome)
                    returning id
                """, (pront, nome))
                aluno_id = cur.fetchone()[0]

                # contato (1:1)
                if tel:
                    cur.execute("""
                        insert into contato (aluno_id, telefone)
                        values (%s, %s)
                        on conflict (aluno_id) do update set telefone = excluded.telefone
                    """, (aluno_id, tel))

                # preferências
                for d in dias:
                    cur.execute("""
                        insert into preferencia_dia (aluno_id, dia_semana)
                        values (%s, %s)
                        on conflict (aluno_id, dia_semana) do nothing
                    """, (aluno_id, int(d)))

                # bloqueios (apaga e reinsere para ficar em sincronia)
                cur.execute("delete from prato_bloqueado where aluno_id=%s", (aluno_id,))
                for nome_blq in blq:
                    if str(nome_blq).strip():
                        cur.execute("""
                            insert into prato_bloqueado (aluno_id, nome)
                            values (%s, %s)
                        """, (aluno_id, nome_blq.strip()))
        conn.commit()

if __name__ == "__main__":
    main()
