import json, os, argparse
from typing import List, Dict, Any

ARQUIVO = 'redes.json'

def load_alunos() -> List[Dict[str, Any]]:
    if not os.path.exists(ARQUIVO):
        return []
    with open(ARQUIVO, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_alunos(alunos: List[Dict[str, Any]]) -> None:
    with open(ARQUIVO, 'w', encoding='utf-8') as f:
        json.dump(alunos, f, ensure_ascii=False, indent=2)
        f.write("\n")

def add_aluno(prontuario: str, dias: List[int], comentario: str=""):
    alunos = load_alunos()
    for a in alunos:
        if a['prontuario'] == prontuario:
            a['dias'] = dias
            if comentario:
                a['_comentario'] = comentario
            save_alunos(alunos)
            print(f"Atualizado: {prontuario}")
            return
    novo = {"prontuario": prontuario, "dias": dias}
    if comentario:
        novo["_comentario"] = comentario
    alunos.append(novo)
    save_alunos(alunos)
    print(f"Adicionado: {prontuario}")

def rm_aluno(prontuario: str):
    alunos = load_alunos()
    antes = len(alunos)
    alunos = [a for a in alunos if a['prontuario'] != prontuario]
    if len(alunos) < antes:
        save_alunos(alunos)
        print(f"Removido: {prontuario}")
    else:
        print(f"Nenhum encontrado: {prontuario}")

def list_alunos():
    for a in load_alunos():
        print(f"{a['prontuario']} | dias={a['dias']} | {a.get('_comentario','')}")

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")

    p_add = sub.add_parser("add")
    p_add.add_argument("--prontuario", required=True)
    p_add.add_argument("--dias", nargs="+", type=int, required=True)
    p_add.add_argument("--comentario", default="")

    p_rm = sub.add_parser("rm")
    p_rm.add_argument("--prontuario", required=True)

    sub.add_parser("list")

    args = parser.parse_args()

    if args.cmd == "add":
        add_aluno(args.prontuario, args.dias, args.comentario)
    elif args.cmd == "rm":
        rm_aluno(args.prontuario)
    elif args.cmd == "list":
        list_alunos()
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
