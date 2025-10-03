// send_whatsapp.cjs
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const MODO = process.env.MODO || 'send';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const CLIENT_ID = process.env.CLIENT_ID || 'default';

const TO = process.env.WHATSAPP_TO || '';
const MSG_FILE = process.env.WHATSAPP_MSG_FILE || '';
const MSG_TEXT = process.env.WHATSAPP_TEXT || '';

console.log(`MODO: ${MODO}`);
console.log(`SESSION_DIR: ${SESSION_DIR}`);
console.log(`CLIENT_ID: ${CLIENT_ID}`);

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: SESSION_DIR,
    clientId: CLIENT_ID,
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Em LOGIN mostramos o QR na saída; em SEND, QR = erro (sem sessão)
client.on('qr', (qr) => {
  if (MODO === 'login') {
    console.log('QR GERADO: ESCANEIE ABAIXO');
    qrcode.generate(qr, { small: true });
  } else {
    console.error('ERRO: QR no modo send -> sessão NÃO restaurada/compatível.');
    process.exit(1);
  }
});

client.on('ready', async () => {
  console.log('READY OK');
  if (MODO === 'login') {
    console.log('Login finalizado. Pode fechar.');
    process.exit(0);
    return;
  }

  // MODO SEND
  try {
    if (!TO) throw new Error('WHATSAPP_TO vazio.');
    const text = MSG_TEXT || (MSG_FILE ? fs.readFileSync(MSG_FILE, 'utf8') : '');
    if (!text) throw new Error('Mensagem vazia.');

    // Resolve o ID canônico do número (funciona mesmo sem estar em contatos)
    const id = await client.getNumberId(TO);
    if (!id) throw new Error(`Número inválido ou sem WhatsApp: ${TO}`);

    await client.sendMessage(id._serialized, text.trim());
    console.log('Mensagem enviada.');
    process.exit(0);
  } catch (err) {
    console.error('FALHA NO ENVIO:', err.message);
    process.exit(1);
  }
});

client.on('auth_failure', (m) => {
  console.error('Falha na autenticação:', m);
  process.exit(1);
});

client.initialize();
