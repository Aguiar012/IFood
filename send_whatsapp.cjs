const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

const CLIENT_ID = process.env.CLIENT_ID || 'almo-pt';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const TO = process.env.WHATSAPP_TO;           // e.g. "5511972093213"
const TEXT = process.env.WHATSAPP_TEXT || 'Teste automático';

console.log('MODO: send');
console.log('SESSION_DIR:', SESSION_DIR);
console.log('CLIENT_ID:', CLIENT_ID);

if (!TO) {
  console.error('Faltou WHATSAPP_TO');
  process.exit(2);
}

if (!fs.existsSync(`${SESSION_DIR}/session-${CLIENT_ID}`)) {
  console.error('ERRO: sessão não encontrada. Rode o workflow de LOGIN primeiro.');
  process.exit(3);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let qrSeen = false;
client.on('qr', () => {
  qrSeen = true;
  console.error('ERRO: QR no modo send -> sessão NÃO restaurada/compatível. Rode LOGIN.');
});

client.on('ready', async () => {
  if (qrSeen) {
    // Não envia nada se precisou QR
    process.exit(4);
  }
  try {
    // opcional: verifique se o número está no WhatsApp
    const isUser = await client.isRegisteredUser(`${TO}@c.us`);
    if (!isUser) {
      console.error('Número não está no WhatsApp (isRegisteredUser=false).');
      process.exit(5);
    }

    await client.sendMessage(`${TO}@c.us`, TEXT);
    console.log('Mensagem enviada.');
    setTimeout(() => process.exit(0), 1500);
  } catch (e) {
    console.error('Falha ao enviar:', e);
    process.exit(6);
  }
});

client.initialize();
