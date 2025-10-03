// send_whatsapp.js
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const TO = (process.env.WHATSAPP_TO || '').replace(/[^\d]/g, ''); // ex: +5511... -> 5511...
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';

// ✅ O login criou a sessão em ".wwebjs_auth/session"
//    Então vamos usar clientId 'session' e apontar o userDataDir exatamente para esse caminho.
const CLIENT_ID = 'session';
const USER_DATA_DIR = path.join(SESSION_DIR, 'session');

if (!TO) {
  console.error('WHATSAPP_TO vazio.');
  process.exit(1);
}

const text = fs.existsSync(MSG_FILE) ? fs.readFileSync(MSG_FILE, 'utf8') : 'ping';

console.log('USANDO SESSAO EM:', SESSION_DIR, 'clientId:', CLIENT_ID);
console.log('PUPPETEER userDataDir:', USER_DATA_DIR);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    userDataDir: USER_DATA_DIR,              // 👈 força usar o mesmo perfil (Default/ etc.)
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let readyOnce = false;

client.on('qr', () => {
  console.error('ATENCAO: QR solicitado no send -> nao achou perfil/sessao. Verifique userDataDir e cache.');
  process.exit(1);
});

client.on('ready', async () => {
  if (readyOnce) return; readyOnce = true;
  console.log('CLIENT READY');
  const chatId = `${TO}@c.us`;

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

client.on('auth_failure', (m) => { console.error('AUTH FAILURE:', m); process.exit(1); });
client.on('disconnected', (r) => { console.error('DISCONNECTED:', r); process.exit(1); });

client.initialize();
setTimeout(() => { console.error('TIMEOUT no send (120s)'); process.exit(1); }, 120000);
