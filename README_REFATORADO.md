# IF Food - Sistema de Automação e Bot

Este projeto foi refatorado para ser mais fácil de entender e manter. O código foi modularizado e traduzido para português.

## Estrutura do Projeto

### 1. Sistema Python (Pedidos Automáticos)
A lógica de fazer os pedidos no site agora fica na pasta `sistema_pedido/`.

- **`sistema_pedido/iniciar_pedidos.py`**: O script principal. É esse que você deve rodar ou agendar.
- **`sistema_pedido/configuracao.py`**: Onde ficam as variáveis (URL, tempos de espera).
- **`sistema_pedido/cliente_site.py`**: Funções que acessam o site do refeitório.
- **`sistema_pedido/banco_dados.py`**: Funções que mexem no banco de dados.
- **`sistema_pedido/servicos/`**: Envio de E-mail e WhatsApp.

**Como rodar manualmente:**
```bash
python -m sistema_pedido.iniciar_pedidos
```

### 2. Bot WhatsApp (Node.js)
O código do bot muda para a pasta `whatsapp/chatbot` com novos nomes.

- **`chatbot/interacao_whatsapp.js`**: O servidor principal (antigo `conversa_zap.js`).
- **`chatbot/fluxo_conversa.js`**: A lógica de inteligência (antigo `conversa_flow.js`).
- **`caminhos.js`**: Configuração de pastas (antigo `paths.js`).

**Como rodar o bot:**
Use o PM2 com o arquivo atualizado:
```bash
pm2 start whatsapp/ecosystem.config.cjs
```

### 3. Rodando o Bot Localmente (Windows)

Se você quiser rodar o bot no seu próprio computador para testes:

1.  Instale o [Node.js](https://nodejs.org/).
2.  Crie um arquivo `.env` na raiz do projeto (use o `.env.example` como base).
3.  Preencha as variáveis no `.env` (ex: `DATABASE_URL`).
4.  Execute o arquivo:
    ```bash
    .\iniciar_bot_local.bat
    ```
    Ou via terminal:
    ```bash
    npm install
    npm start
    ```
5.  Escaneie o QR Code que aparecerá no terminal (ou acesse `http://localhost:3001/qr`).

## Arquivos Antigos
Os arquivos originais foram renomeados/mantidos como backup:
- `auto_pedido_ANTIGO.py` (era `auto_pedido.py`).

## Solução de Problemas

- **Erro de Banco**: Confirme se `DATABASE_URL` está definido.
- **Bot Travado**: Apague `whatsapp/data/wa_auth_zapbot` para reiniciar a sessão.
