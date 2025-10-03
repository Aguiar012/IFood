// send_whatsapp.cjs
// Requisitos: whatsapp-web.js, qrcode, qrcode-terminal, fluent-ffmpeg (opcional se já tinha)
// NODE 18+ no runner

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const qrcodeTerm = require('qrcode-terminal');
const { Client, LocalAuth, MessageAck } = require('whatsapp-web.js');

const NUMBER = process.env.WA_TO || '5511932291930';      // E.164 sem sinais
const TEXT   = process.env.WA_TEXT || 'Mensagem de teste via GitHub Actions.';

const QR_PNG_PATH = '/tmp/whatsapp-qr.png';

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'actions-cache' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

function ackToHuman(ack) {
  // Mapeamento oficial: ACK_PENDING(0), ACK_SERVER(1), ACK_DEVICE(2), ACK_READ(3), ACK_PLAYED(4), ACK_ERROR(-1)
  // Fonte: docs.wwebjs.dev (Globals → MessageAck)
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

async function getDisplayName(chatId) {
  try {
    const contact = await client.getContactById(chatId); // Contact.name/pushname/shortName na doc
    if (!contact) return chatId.replace('@c.us', '');
    const formatted = await contact.getFormattedNumber().catch(() => null);
    return contact.name || contact.pushname || formatted || chatId.replace('@c.us', '');
  } catch {
    return chatId.replace('@c.us', '');
  }
}

client.on('qr', async (qr) => {
  // QR no terminal e salvo como PNG (o workflow faz upload como artifact)
  qrcodeTerm.generate(qr, { small: true });
  await qrcode.toFile(QR_PNG_PATH, qr, { width: 512 });
  console.log(`QR salvo em: ${QR_PNG_PATH} (será enviado como artifact)`);
});

client.on('ready', () => {
  console.log('Cliente pronto. Validando número e enviando...');
});

(async () => {
  await client.initialize();

  // Verifica se o número existe e obtém o chatId serializado
  const numberId = await client.getNumberId(NUMBER); // docs: Client#getNumberId
  if (!numberId) {
    console.error(`Número ${NUMBER} não está no WhatsApp.`);
    await client.destroy();
    process.exit(1);
  }

  const chatId = numberId._serialized; // "5511...@c.us"
  const nome = await getDisplayName(chatId);

  const firstMsg = `Olá, ${nome}. ${TEXT}`;
  const sentMsg = await client.sendMessage(chatId, firstMsg); // docs: Client#sendMessage
  console.log(`Mensagem enviada. ID: ${sentMsg.id._serialized}`);

  // Acompanha ACKs do WhatsApp e envia atualizações no próprio chat
  // Encerramos quando chegar em READ/PLAYED ou em 90s, o que vier primeiro.
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 90_000);

    const handler = async (msg, ack) => {
      if (msg.id._serialized !== sentMsg.id._serialized) return;
      const human = ackToHuman(ack);
      console.log(`ACK atualizado: ${human} (${ack})`);

      try {
        await client.sendMessage(chatId, `Status da mensagem: ${human} (${ack})`);
      } catch (e) {
        console.warn('Falha ao enviar status pelo WhatsApp:', e?.message || e);
      }

      if (ack === MessageAck.ACK_READ || ack === MessageAck.ACK_PLAYED || ack === MessageAck.ACK_ERROR) {
        clearTimeout(timeout);
        resolve();
      }
    };

    client.on('message_ack', handler); // docs: Client#event:message_ack
  });

  await client.destroy();
  process.exit(0);
})().catch(async (err) => {
  console.error('Erro geral:', err);
  try { await client.destroy(); } catch {}
  process.exit(1);
});
