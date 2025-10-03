// send_whatsapp.js
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

const TO = (process.env.WHATSAPP_TO || '').replace(/[^\d]/g, ''); // e.g. +55119... -> 55119...
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const CLIENT_ID = 'default'; // mantenha igual no login

if (!TO) {
  console.error('WHATSAPP_TO vazio.');
  process.exit(1);
}

const text = fs.existsSync(MSG_FILE) ? fs.readFileSync(MSG_FILE, 'utf8') : 'ping';

console.log('USANDO SESSAO EM:', SESSION_DIR, 'clientId:', CLIENT_ID);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let readyOnce = false;

client.on('qr', () => {
  // Se cair aqui é porque a sessão NÃO foi carregada.
  console.error('ATENCAO: QR solicitado no send -> a sessao nao foi restaurada ou clientId/dataPath nao batem.');
  process.exit(1);
});

client.on('ready', async () => {
  if (readyOnce) return;
  readyOnce = true;
  console.log('CLIENT READY');

  const chatId = `${TO}@c.us`;

  // quebra mensagem grande em blocos de até 3500 chars (limite seguro)
  const chunks = [];
  const max = 3500;
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));

  let sent = 0;
  for (const part of chunks) {
    await client.sendMessage(chatId, part);
    sent += 1;
  }
  console.log(`ENVIADO ${sent}/${chunks.length}`);
  process.exit(0);
});

client.on('auth_failure', (m) => {
  console.error('AUTH FAILURE:', m);
  process.exit(1);
});

client.on('disconnected', (r) => {
  console.error('DISCONNECTED:', r);
  process.exit(1);
});

client.initialize();

// kill guard
setTimeout(() => {
  console.error('TIMEOUT no send (120s)'); process.exit(1);
}, 120000);
