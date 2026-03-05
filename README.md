<div align="center">

# IF Food

### Bot de Almoço Automatizado do IFSP Pirituba

Pede almoço automaticamente no refeitório e permite gerenciar tudo pelo WhatsApp.

<br>

![Node.js](https://img.shields.io/badge/Node.js-20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.x-3776AB?style=for-the-badge&logo=python&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Bot-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)
![Gemini AI](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?style=for-the-badge&logo=google&logoColor=white)
![Fly.io](https://img.shields.io/badge/Fly.io-Deploy-8B5CF6?style=for-the-badge&logo=flydotio&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-DB-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)

</div>

---

## Como funciona

O sistema tem duas partes que trabalham juntas:

| Parte | Linguagem | O que faz |
|-------|-----------|-----------|
| **Bot WhatsApp** | Node.js | Conversa com o aluno, gerencia cadastro, bloqueios e cancelamentos |
| **Pedidos Automaticos** | Python | Roda todo dia de manha via GitHub Actions e faz os pedidos no site do refeitorio |

```
Aluno cadastra pelo WhatsApp
        |
        v
  Bot salva preferencias no banco (dias, bloqueios)
        |
        v
  Todo dia de manha, o script Python:
    1. Busca quem quer almocar naquele dia
    2. Checa se o prato do dia esta na lista de exclusao do aluno
    3. Faz o pedido no site do refeitorio
    4. Avisa o aluno se o pedido foi bloqueado
    5. Manda relatorio pros admins
```

---

## Funcionalidades

### Bot WhatsApp

- **Cadastro** com prontuario IFSP
- **Escolher dias** da semana para almocar
- **Bloquear pratos** que o aluno nao come (ex: peixe, figado)
- **Sugestoes inteligentes** — Gemini sugere pratos relacionados ao bloquear (ex: bloqueia "peixe", sugere "tilapia", "merluza")
- **Cancelar almoco** de um dia especifico (direto ou por e-mail a CAE)
- **Ver status** do cadastro e historico de pedidos
- **Ativar/Pausar** o bot a qualquer momento
- **IA contextual** — entende mensagens em linguagem natural via Gemini

### Pedidos Automaticos

- Roda **seg-sex as 6h e 13h** (GitHub Actions)
- Compara o prato do dia com a lista de exclusao de cada aluno
- **Notifica o aluno** por WhatsApp quando o pedido e bloqueado
- **Alerta os admins** por WhatsApp em caso de erro
- Envia **relatorio por e-mail** apos cada execucao

---

## Estrutura do Projeto

```
IF_Food/
|
|-- whatsapp/                         Bot WhatsApp (Node.js)
|   |-- bot/
|   |   |-- servidor_bot.js              Servidor Express + conexao Baileys
|   |   |-- logica_respostas.js          Fluxo de conversa e comandos
|   |   |-- inteligencia_artificial.js   Gemini: classificacao + sugestoes
|   |   '-- renderizar_email.js          Gera imagem do e-mail de cancelamento
|   '-- configuracao_pastas.js           Paths dos dados persistidos
|
|-- sistema_pedido/                   Pedidos Automaticos (Python)
|   |-- iniciar_pedidos.py               Orquestrador principal
|   |-- cliente_site.py                  Scraping do site + pedido POST
|   |-- banco_dados.py                   Queries PostgreSQL
|   |-- configuracao.py                  URLs, timeouts, fuso horario
|   |-- utils.py                         Data alvo, verificar bloqueios
|   '-- servicos/
|       |-- email.py                     Envia relatorio por e-mail
|       '-- whatsapp.py                  Notifica admins e alunos
|
|-- .github/workflows/
|   '-- main.yml                      Cron: roda pedidos seg-sex
|
|-- Dockerfile                        Imagem Node.js Alpine
|-- docker-compose.yml                Dev local com Docker
|-- fly.toml                          Config Fly.io (regiao GRU)
'-- package.json                      Dependencias Node.js
```

---

## Rodando localmente

### Pre-requisitos

- [Node.js](https://nodejs.org/) 18+
- [Python](https://python.org/) 3.10+
- Acesso ao banco PostgreSQL

### 1. Instalar dependencias

```bash
# Node.js (bot)
npm install

# Python (pedidos)
pip install requests beautifulsoup4 psycopg[binary]
```

### 2. Configurar variaveis de ambiente

Crie um arquivo `.env` na raiz:

```env
# Banco de dados (obrigatorio)
DATABASE_URL=postgres://usuario:senha@host:5432/banco

# Gemini AI (opcional)
GEMINI_API_KEY=sua_chave

# E-mail (opcional - para cancelamentos)
GMAIL_USER=email@gmail.com
GMAIL_APP_PASSWORD=senha_de_app
CAE_EMAIL=cae@ifsp.edu.br

# Notificacoes WhatsApp
BOT_URL=http://localhost:3001/send-message
ADMINS_E164=5511999999999
```

> **Nunca** suba o `.env` pro GitHub. Ele ja esta no `.gitignore`.

### 3. Iniciar o bot

```bash
# Pelo terminal
npm start

# Ou no Windows, clique duas vezes:
INICIAR_BOT_AQUI.bat
```

Escaneie o QR Code no terminal ou acesse `http://localhost:3001/qr`

### 4. Rodar pedidos manualmente

```bash
python -m sistema_pedido.iniciar_pedidos
```

---

## Deploy

### Fly.io (producao)

```bash
fly deploy
```

O bot roda em `gru` (Guarulhos) com volume persistente para manter a sessao do WhatsApp entre deploys.

### Docker local

```bash
docker compose up -d
```

### Pedidos automaticos

Os pedidos sao agendados via **GitHub Actions** (`.github/workflows/main.yml`):

| Horario (BRT) | Cron (UTC) | Objetivo |
|---------------|------------|----------|
| 06:00 | `0 09 * * 1-5` | Pedido principal da manha |
| 13:00 | `0 16 * * 1-5` | Segunda tentativa (se o primeiro falhar) |

---

## Stack

| Tecnologia | Uso |
|------------|-----|
| **Baileys** | Conexao WhatsApp Web (sem API oficial) |
| **Gemini 2.5 Flash Lite** | Classificacao de intencao + sugestoes de bloqueio |
| **Express** | Health check + API de envio de mensagens |
| **PostgreSQL** | Alunos, preferencias, bloqueios, historico |
| **BeautifulSoup** | Scraping do site do refeitorio IFSP |
| **GitHub Actions** | Cron dos pedidos automaticos |
| **Fly.io** | Hosting do bot (container Docker) |
| **Satori + resvg** | Renderizacao de imagem para e-mail de cancelamento |

---

## Problemas comuns

| Problema | Solucao |
|----------|---------|
| Bot nao conecta | Verifique `dados_bot/auth`. Se corrompido, apague e escaneie QR de novo |
| QR Code nao aparece | Acesse `http://localhost:3001/qr` no navegador |
| Erro de banco de dados | Confira `DATABASE_URL` no `.env` |
| Bot cai e nao volta | O health check em `/status` reinicia automaticamente no Fly.io |
| Pedido nao foi feito | Veja logs do GitHub Actions ou o historico no bot (`status`) |

---

## Licenca

MIT

