@echo off
echo --- Iniciando Bot do WhatsApp (IF Food) ---
echo.

if not exist .env (
    echo [AVISO] Arquivo .env nao encontrado!
    echo Copie o conteudo de .env.example para um arquivo chamado .env e configure suas chaves.
    echo.
    pause
    exit /b
)

:: Carrega variáveis do .env (simples) - Opcional, pois o Node já pode usar dotenv se instalado, 
:: mas como não vi dotenv no package.json, vamos assumir que o usuário configurou o ambiente ou usaremos uma lib.
:: Na verdade, o código usa process.env direto. O ideal é instalar 'dotenv'.

echo Instalando dependencias (se necessario)...
call npm install
echo.

echo Verificando se dotenv esta instalado...
call npm list dotenv >nul 2>&1
if %errorlevel% neq 0 (
    echo Instalando dotenv para carregar variaveis locais...
    call npm install dotenv
)

echo.
echo Iniciando o bot...
echo (Para parar, pressione Ctrl + C)
echo.

:: Roda o node com suporte a .env
node -r dotenv/config whatsapp/chatbot/interacao_whatsapp.js

pause
