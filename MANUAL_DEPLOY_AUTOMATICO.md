# 🚀 Como Configurar a Atualização Automática do Bot

Você já está a um passo de nunca mais precisar abrir aquele terminal preto da Oracle para atualizar as suas modificações no VS Code!

O arquivo que faz a "mágica" para o GitHub entrar sozinho na Oracle toda vez que você enviar novos commits chama `.github/workflows/deploy-oracle.yml` (e eu já o criei na sua pasta agora mesmo!).

Mas, por segurança, o GitHub só vai conseguir acessar o seu servidor se ele tiver a sua **chave SSH**. Siga os passos abaixo, no próprio site do GitHub, para "emprestar" sua chave para o robô de atualizações em segredo:

## Passo a Passo no GitHub

1. Acesse o [seu repositório no GitHub](https://github.com/Aguiar012/IFood).
2. Vá na aba **`Settings`** (Configurações).
3. Na barra lateral esquerda, desça até a opção **`Secrets and variables`** e clique em **`Actions`**.
4. Clique no botão verde **`New repository secret`** para criar **3 segredos**:

### Segredo 1: `ORACLE_HOST`
- Em **Name** digite exatamente: `ORACLE_HOST`
- Em **Secret** cole o IP do seu servidor da Oracle: `163.176.246.50`
- Clique em *Add secret*.

### Segredo 2: `ORACLE_USER`
- Em **Name** digite: `ORACLE_USER`
- Em **Secret** cole seu usuário do servidor: `ubuntu`
- Clique em *Add secret*.

### Segredo 3: `ORACLE_SSH_KEY`
- Em **Name** digite: `ORACLE_SSH_KEY`
- Em **Secret** cole absolutamente TODO o texto daquele seu arquivo de texto que você fez download hoje (o arquivo `ssh-key-2026-03-08.key`).
*- Cole inclusive aquelas linhas contendo as palavras "BEGIN" e "END".*
- Clique em *Add secret*.

---

### Tudo pronto! E agora?

Deste momento em diante, **toda vez que você rodar no seu VS Code:**
```bash
git add .
git commit -m "fiz tal coisa"
git push
```
...basta você cruzar os braços! 

O próprio site do GitHub vai se conectar na Oracle usando a chave que você deu, baixar suas coisas e reiniciar o seu aplicativo em questão de um minuto. 

Se quiser ver isso acontecendo ao vivo, basta depois do "push" entrar lá no site do GitHub, ir na aba **"`Actions`"** e assistir no terminal em tempo real!

*Boa Sorte com o Bot! 😁*
