// send_whatsapp.js
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const MODE = process.env.MODE || 'send';                 // 'login' ou 'send'
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth'; // diretório raiz estável no cache
const CLIENT_ID   = process.env.CLIENT_ID   || 'almo-pt'; // id estável para a sessão remota
const WHATSAPP_TO = process.env.WHATSAPP_TO;              // ex: 5511932291930@c.us
const MSG_FILE    = process.env.MSG_FILE || '/tmp/relatorio.txt';

// Store de sessão REMOTA em arquivo (robusto para CI)
const STORE_DIR = path.join(SESSION_DIR, 'remote-store');
const STORE_FILE = path.join(STORE_DIR, `${CLIENT_ID}.json`);

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

console.log(`MODO: ${MODE}`);
console.log(`STORE_FILE: ${STORE_FILE}`);

const authStrategy = new RemoteAuth({
  clientId: CLIENT_ID,
  backupSyncIntervalMs: 300000, // faz backup periódico da sessão
  // Implementação mínima de store em arquivo
  dataPath: STORE_DIR
});

// Pequeno “monkey patch”: RemoteAuth guarda os dados via indexedDB internamente,
// mas também em arquivos em dataPath. Apenas garantimos que a pasta existe.
const client = new Client({
  authStrategy,
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  }
});

let qrShown = false;

client.on('qr', (qr) => {
  qrShown = true;
  console.log('QR_CODE:');
  qrcode.generate(qr, { small: true });
  if (MODE === 'send') {
    console.error('ATENCAO: QR solicitado no send -> execute primeiro o workflow de LOGIN.');
    // encerra com código específico para facilitar debug
    process.exit(2);
  }
});

client.on('ready', async () => {
  console.log('READY OK');

  if (MODE === 'login') {
    console.log('Sessao criada/validada. Pode fechar.');
    process.exit(0);
    return;
  }

  // MODE === 'send'
  if (!WHATSAPP_TO) {
    console.error('Faltando WHATSAPP_TO');
    process.exit(3);
  }
  const text = fs.existsSync(MSG_FILE) ? fs.readFileSync(MSG_FILE, 'utf8') : 'Mensagem vazia';
  try {
    await client.sendMessage(`${WHATSAPP_TO}@c.us`.replace(/@c\.us@c\.us$/, '@c.us'), text);
    console.log('Mensagem enviada.');
    process.exit(0);
  } catch (e) {
    console.error('Falha ao enviar:', e);
    process.exit(4);
  }
});

client.on('auth_failure', (m) => {
  console.error('AUTH FAILURE:', m);
  process.exit(5);
});

client.on('disconnected', (r) => {
  console.error('DISCONNECTED:', r);
  process.exit(6);
});

client.initialize();

// mata em 2 min para não travar jobs
setTimeout(() => {
  console.error('Timeout atingido.');
  process.exit(qrShown ? 2 : 7);
}, 120000);
