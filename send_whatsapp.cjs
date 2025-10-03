// send_whatsapp.cjs
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

const MODE = process.env.MODE || 'send';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';
const CLIENT_ID = process.env.CLIENT_ID || 'almo-pt';
const WHATSAPP_TO = process.env.WHATSAPP_TO || '';
const MSG_FILE = process.env.MSG_FILE || '/tmp/relatorio.txt';

console.log(`MODO: ${MODE}`);
console.log(`SESSION_DIR: ${SESSION_DIR}`);
console.log(`CLIENT_ID: ${CLIENT_ID}`);

function onlyDigits(s) { return (s || '').replace(/\D/g, ''); }

const acks = new Map();

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

client.on('auth_failure', (m) => console.error('AUTH FAILURE:', m));
client.on('change_state', (s) => console.log('STATE:', s));
client.on('disconnected', (r) => console.error('DISCONNECTED:', r));
client.on('message_ack', (msg, ack) => {
  if (msg.fromMe) {
    console.log('ACK update:', ack, 'MessageID:', msg.id.id);
    acks.set(msg.id.id, ack); // 1=enviado, 2=entregue, 3=lido
  }
});

client.on('ready', async () => {
  console.log('READY OK');
  console.log('SENDER:', client.info.wid?._serialized, '| NAME:', client.info.pushname || '');

  if (MODE === 'login') process.exit(0);

  // 1) Sanitiza e valida destino
  let num = onlyDigits(WHATSAPP_TO);
  if (!num) {
    console.error('Faltou WHATSAPP_TO (somente dígitos, com DDI).');
    process.exit(1);
  }
  if (num.length < 11) {
    console.warn('Aviso: número curto. Use DDI+DDD+número, ex: 5511999999999');
  }

  const numberId = await client.getNumberId(num);
  if (!numberId) {
    console.error('Destino NÃO tem WhatsApp ou está inválido:', num);
    process.exit(1);
  }
  const to = numberId._serialized; // ex: 5511999999999@c.us
  console.log('DESTINO RESOLVIDO:', to);

  // 2) Evita auto-DM (enviar para o mesmo número logado)
  const me = client.info.wid?._serialized;
  if (me && me.split('@')[0] === to.split('@')[0]) {
    console.error('Você está tentando enviar para o MESMO número da sessão. WhatsApp Web não entrega auto-DM.');
    process.exit(1);
  }

  // 3) Texto
  const text = fs.existsSync(MSG_FILE) ? fs.readFileSync(MSG_FILE, 'utf8') : 'Mensagem vazia';

  // 4) Envia e espera ACK por até 15s
  const msg = await client.sendMessage(to, text);
  const id = msg.id.id;
  console.log('Mensagem enviada. MessageID:', id);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const v = acks.get(id);
    if (v >= 1) break; // já subiu para "enviado ao servidor"
    await new Promise(r => setTimeout(r, 300));
  }
  const finalAck = acks.get(id);
  console.log('ACK final:', finalAck === undefined ? 'none' : finalAck);

  // tenta logar o assunto do chat só para termos rastro
  try {
    const chat = await msg.getChat();
    console.log('CHAT NAME:', chat.name || '(sem nome)');
  } catch {}

  // segura 2s para garantir flush no log
  await new Promise(r => setTimeout(r, 2000));
  process.exit(0);
});

client.initialize();
