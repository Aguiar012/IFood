// send_whatsapp.cjs
// Requisitos: whatsapp-web.js ^1.33+, qrcode, qrcode-terminal, Node 18+
// Dica: no package.json use puppeteer "^24.15.0" para minimizar quebras.

const fs = require('fs');
const qrcode = require('qrcode');
const qrcodeTerm = require('qrcode-terminal');
const { Client, LocalAuth, MessageAck } = require('whatsapp-web.js');

const NUMBER = (process.env.WA_TO || process.env.WHATSAPP_TO || '5511932291930').trim();
const TEXT   = (process.env.WA_TEXT || process.env.WHATSAPP_MESSAGE || 'Mensagem de teste via GitHub Actions.').trim();

const QR_PNG_PATH = '/tmp/whatsapp-qr.png';
const WAIT_ACK_MS = 90_000; // esperar até 90s por ACKs

// Utilitário: esperar evento 'ready' como Promise
function waitReady(client) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout esperando ready')), 180_000);
    client.once('ready', () => { clearTimeout(t); resolve(); });
  });
}

function ackToHuman(ack) {
  // 0 pendente | 1 servidor | 2 entregue | 3 lido | 4 reproduzido | -1 erro
  switch (ack) {
    case MessageAck.ACK_PENDING: return 'pendente';
    case MessageAck.ACK_SERVER:  return 'enviado ao servidor';
    case MessageAck.ACK_DEVICE:  return 'entregue no aparelho';
    case MessageAck.ACK_READ:    return 'lido';
    case MessageAck.ACK_PLAYED:  return 'reproduzido';
    case MessageAck.ACK_ERROR:   return 'erro ao enviar';
    default:                     return `ack ${ack}`;
  }
}

async function getDisplayName(client, chatId) {
  try {
    const contact = await client.getContactById(chatId);
    if (!contact) return chatId.replace('@c.us', '');
    const formatted = await contact.getFormattedNumber().catch(() => null);
    return contact.name || contact.pushname || formatted || chatId.replace('@c.us', '');
  } catch {
    return chatId.replace('@c.us', '');
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth', clientId: 'actions-cache' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  qrcodeTerm.generate(qr, { small: true });
  await qrcode.toFile(QR_PNG_PATH, qr, { width: 512 });
  console.log(`QR salvo em: ${QR_PNG_PATH} (artifact)`);
});

client.on('authenticated', () => console.log('Autenticado.'));
client.on('auth_failure', (m) => console.error('Falha de auth:', m));
client.on('disconnected', (r) => console.error('Desconectado:', r));

(async () => {
  await client.initialize();
  await waitReady(client); // <<< ESSENCIAL contra o erro WidFactory

  console.log('Pronto. Validando destino...');
  const numberId = await client.getNumberId(NUMBER); // formato “5511...”, sem '+'
  if (!numberId) {
    console.error(`Número ${NUMBER} não está no WhatsApp (getNumberId=null).`);
    await client.destroy(); process.exit(3);
  }

  // opcional: segunda checagem
  const isReg = await client.isRegisteredUser(numberId._serialized).catch(() => null);
  if (isReg === false) {
    console.error(`ID ${numberId._serialized} não é usuário registrado (isRegisteredUser=false).`);
    await client.destroy(); process.exit(3);
  }

  const chatId = numberId._serialized;         // ex.: 55119XXXXXXXX@c.us
  const nome   = await getDisplayName(client, chatId);

  const text   = `Olá, ${nome}. ${TEXT}`;
  const sent   = await client.sendMessage(chatId, text);
  console.log('Mensagem enviada. ID:', sent.id._serialized);

  // reportar status no próprio chat conforme ACK evolui
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, WAIT_ACK_MS);
    const handler = async (msg, ack) => {
      if (msg.id._serialized !== sent.id._serialized) return;
      const human = ackToHuman(ack);
      console.log(`ACK: ${human} (${ack})`);
      try { await client.sendMessage(chatId, `Status da mensagem: ${human} (${ack})`); } catch {}
      if ([MessageAck.ACK_READ, MessageAck.ACK_PLAYED, MessageAck.ACK_ERROR].includes(ack)) {
        clearTimeout(timer); resolve();
      }
    };
    client.on('message_ack', handler);
  });

  await client.destroy();
  process.exit(0);
})().catch(async (err) => {
  console.error('Erro geral:', err);
  try { await client.destroy(); } catch {}
  process.exit(1);
});
