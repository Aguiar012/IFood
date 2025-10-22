const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const AUTH_DIR = process.env.WA_AUTH_DIR || 'wa_auth';
const TO = (process.env.WA_TO || '5511932291930').replace(/[^\d]/g, '');
const MSG = process.env.WA_TEXT || 'Teste do GitHub Actions ✅';

// monta (opcional) o agent de proxy
function makeProxyAgent() {
  const proxyUrl = process.env.WA_PROXY_URL; // ex: http://login__cr.br:pass@gw.dataimpulse.com:10000
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

async function waitConnectionOpen(sock) {
  return new Promise((resolve, reject) => {
    const onUpdate = (u) => {
      if (u.qr) {
        qrcode.generate(u.qr, { small: true });
        console.log('👉 Escaneie o QR: WhatsApp > Aparelhos conectados > Conectar');
      }
      if (u.connection === 'open') {
        sock.ev.off('connection.update', onUpdate);
        resolve();
      }
      if (u.connection === 'close') {
        reject(new Error(`Conexão fechada. Motivo: ${u.lastDisconnect?.error?.output?.statusCode ?? 'desconhecido'}`));
      }
    };
    sock.ev.on('connection.update', onUpdate);
  });
}

async function main() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const proxyAgent = makeProxyAgent();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['IFood-Bot', 'Chrome', '1.0'],
    // proxy para WebSocket + downloads/uploads de mídia:
    agent: proxyAgent,
    fetchAgent: proxyAgent
  });

  sock.ev.on('creds.update', saveCreds);

  await waitConnectionOpen(sock);
  const jid = `${TO}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: MSG });
  console.log('✅ Mensagem enviada:', sent.key.id);
  await new Promise(r => setTimeout(r, 1000));
  try { await sock.ws.close(); } catch {}
}

main().catch((e) => {
  console.error('Erro:', e?.message || e);
  process.exit(1);
});
