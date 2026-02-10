// config/caminhos.js
import fs from "fs";
import path from "path";

function obterChaveApp() {
  // Deriva do nome do arquivo de entrada (ex.: interacao_whatsapp.js -> "interacao_whatsapp")
  const entrada = path.basename(process.argv[1] || "app.js");
  const base = entrada.replace(/\.[^.]+$/, ""); // sem extensão
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

const CHAVE_APP = process.env.APP_KEY || obterChaveApp(); // sem secrets, auto
const BASE = "/app/data";
const DIRETORIO_DADOS = path.join(BASE, CHAVE_APP);
const DIRETORIO_AUTENTICACAO = path.join(DIRETORIO_DADOS, "wa_auth");
const DIRETORIO_ESTADO = path.join(DIRETORIO_DADOS, "state");
const ARQUIVO_ESTADO = path.join(DIRETORIO_DADOS, `state_${CHAVE_APP}.json`);
const ARQUIVO_PONTUACOES = path.join(DIRETORIO_ESTADO, `scores_${CHAVE_APP}.json`);
const ARQUIVO_TRAVA = path.join(DIRETORIO_DADOS, `.lock-${CHAVE_APP}`);

// Cria diretórios se não existirem
for (const p of [DIRETORIO_DADOS, DIRETORIO_AUTENTICACAO, DIRETORIO_ESTADO]) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

export default { 
    CHAVE_APP, 
    BASE, 
    DIRETORIO_DADOS, 
    DIRETORIO_AUTENTICACAO, 
    DIRETORIO_ESTADO, 
    ARQUIVO_ESTADO, 
    ARQUIVO_PONTUACOES, 
    ARQUIVO_TRAVA 
};
