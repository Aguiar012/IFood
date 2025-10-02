// send_whatsapp.js
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

// Lê mensagem de um arquivo texto (ex: /tmp/relatorio.txt)
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';
// Número destino no formato E.164 sem "+" -> 5511999999999
// whatsapp-web.js usa "<numero>@c.us"
const TO_NUMBER = (process.env.WHATSAPP_TO || '').replace(/[^\d]/g, '');
if (!TO_NUMBER) {
  console.error('Faltou WHATSAPP_TO (ex: +5511999999999)');
  process.exit(1);
}

const message = fs.readFileSync(MSG_FILE, 'utf8').trim();
if (!message) {
  console.error(`Arquivo de mensagem vazio: ${MSG_FILE}`);
  process.exit(1);
}

// Usamos LocalAuth com diretório fixo para permitir cache no Actions
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth'; // mantenha assim p/ cache
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  }
});

(async () => {
  client.on('qr', (qr) => {
    // No workflow de login capturamos isso por outro arquivo
    console.log('QR_CODE:', qr.substring(0, 50) + '...'); // evita print gigante
  });

  client.on('authenticated', () => console.log('AUTH: ok'));
  client.on('auth_failure', msg => {
    console.error('AUTH FAILURE:', msg);
    process.exit(2);
  });
  client.on('ready', async () => {
    console.log('CLIENT READY');
    const chatId = `${TO_NUMBER}@c.us`;

    // Quebra em blocos de 3500 chars (margem segura)
    const chunks = [];
    const N = 3500;
    for (let i = 0; i < message.length; i += N) chunks.push(message.slice(i, i+N));

    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i];
      await client.sendMessage(chatId, part);
      console.log(`ENVIADO parte ${i+1}/${chunks.length} (${part.length} chars)`);
      await new Promise(r => setTimeout(r, 600)); // pequena folga
    }
    console.log('OK: todas as partes enviadas');
    process.exit(0);
  });

  await client.initialize();
})();
