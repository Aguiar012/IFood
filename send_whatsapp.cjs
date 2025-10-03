// send_whatsapp.cjs
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');

const MODE = process.env.MODE || 'send';                  // 'login' ou 'send'
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const CLIENT_ID = process.env.CLIENT_ID || 'almo-pt';     // tem que ser IGUAL no login e no send
const WHATSAPP_TO = process.env.WHATSAPP_TO;              // ex: 5511932291930@c.us
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';

console.log(`MODO: ${MODE}`);
console.log(`SESSION_DIR: ${SESSION_DIR}`);
console.log(`CLIENT_ID: ${CLIENT_ID}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  // NUNCA defina puppeteer.userDataDir manualmente com LocalAuth
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => {
  // Se aparecer QR no send, a sessão não foi restaurada
  console.log('QR SOLICITADO.');
  if (MODE === 'send') {
    console.error('ERRO: QR solicitado no modo send -> sessão NÃO restaurada/compatível.');
    process.exit(1);
  }
});

client.on('ready', async () => {
  console.log('READY OK');
  if (MODE === 'login') {
    // Só garantir que logou e salvará no cache ao fim do job
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
