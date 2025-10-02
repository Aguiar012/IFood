const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';
const TO_NUMBER = (process.env.WHATSAPP_TO || '').replace(/[^\d]/g, '');
if (!TO_NUMBER) {
  console.error('Faltou WHATSAPP_TO (ex: +5511932291930)');
  process.exit(1);
}
const message = fs.readFileSync(MSG_FILE, 'utf8').trim();
if (!message) {
  console.error(`Arquivo de mensagem vazio: ${MSG_FILE}`);
  process.exit(1);
}

const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--no-zygote','--single-process'
    ]
  }
});

(async () => {
  client.on('qr', (qr) => {
    console.log('QR_CODE:', qr.slice(0, 50) + '...');
  });
  client.on('authenticated', () => console.log('AUTH: ok'));
  client.on('auth_failure', msg => { console.error('AUTH FAILURE:', msg); process.exit(2); });
  client.on('ready', async () => {
    console.log('CLIENT READY');
    const chatId = `${TO_NUMBER}@c.us`;
    const chunks = [];
    const N = 3500;
    for (let i = 0; i < message.length; i += N) chunks.push(message.slice(i, i+N));
    for (let i = 0; i < chunks.length; i++) {
      await client.sendMessage(chatId, chunks[i]);
      console.log(`ENVIADO ${i+1}/${chunks.length}`);
      await new Promise(r => setTimeout(r, 600));
    }
    console.log('OK: envio concluído');
    process.exit(0);
  });
  await client.initialize();
})();
