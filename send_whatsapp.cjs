// send_whatsapp.cjs
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const MODE = process.env.MODE || 'send';                  // 'login' ou 'send'
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const CLIENT_ID = process.env.CLIENT_ID || 'almo-pt';
const WHATSAPP_TO = process.env.WHATSAPP_TO;
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';

console.log(`MODO: ${MODE}`);
console.log(`SESSION_DIR: ${SESSION_DIR}`);
console.log(`CLIENT_ID: ${CLIENT_ID}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/last.json'
  }
});

client.on('qr', (qr) => {
  console.log('QR GERADO: ESCANEIE ABAIXO');
  qrcode.generate(qr, { small: true });
  if (MODE === 'send') {
    console.error('ERRO: QR no modo send -> sessão NÃO restaurada/compatível.');
    process.exit(1);
  }
});

client.on('ready', async () => {
  console.log('READY OK');

  if (MODE === 'login') {
    // No login só queremos criar/vincular a sessão e sair
    process.exit(0);
  }

  // MODE === 'send'
  if (!WHATSAPP_TO) {
    console.error('Faltou WHATSAPP_TO');
    process.exit(1);
  }
  const text = fs.existsSync(MSG_FILE) ? fs.readFileSync(MSG_FILE, 'utf8') : 'Mensagem vazia';
  try {
    const to = WHATSAPP_TO.endsWith('@c.us') ? WHATSAPP_TO : `${WHATSAPP_TO}@c.us`;
    await client.sendMessage(to, text);
    console.log('Mensagem enviada.');
    process.exit(0);
  } catch (e) {
    console.error('Falha ao enviar:', e);
    process.exit(1);
  }
});

client.initialize();
