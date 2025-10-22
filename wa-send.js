// wa-send.js — Baileys com proxy + reconexão pós-pareamento
const fs = require('fs');
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const baileys = require('@whiskeysockets/baileys');
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = baileys;

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(url); // HTTPS + WebSocket (CONNECT)
}

const TO = process.env.WA_TO;                         // ex: 55119...
const TEXT = process.env.WA_TEXT || 'Hello from Actions';
const AUTH_DIR = process.env.WA_AUTH_DIR || 'wa_auth';
const PROXY_URL = process.env.WA_PROXY_URL;

const logger = P({ level: 'info' });

let sendDone = false; // pra não enviar duas vezes em reconexões

(async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const agent = await buildProxyAgent(PROXY_URL);

  logger.info({ to: TO, hasProxy: !!PROXY_URL }, 'boot');

  async function startSock() {
    const sock = baileys.default({
      version,
      auth: state,
      logger,
      browser: Browsers.macOS('Chrome'),
      agent,
      fetchAgent: agent
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR quando necessário
      if (qr) {
        console.log('\n=== ESCANEIE ESTE QR NO WHATSAPP ===');
        qrcode.generate(qr, { small: true });
        console.log('WhatsApp > Aparelhos conectados > Conectar aparelho\n');
      }

      if (connection === 'open') {
        console.log('✅ Conectado ao WhatsApp.');
        if (!sendDone) {
          sendDone = true;
          const jid = `${TO}@s.whatsapp.net`;
          sock.sendMessage(jid, { text: TEXT })
            .then((sent) => {
              console.log('📤 Mensagem enviada. ID:', sent?.key?.id);
              setTimeout(() => process.exit(0), 800);
            })
            .catch((e) => {
              console.error('❌ Falha ao enviar:', e?.message || e);
              process.exit(1);
            });
        }
      }

      if (connection === 'close') {
        const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.error('⚠️ Conexão fechada. Status:', status);

        // Se não é logout definitivo, REINICIA (necessário após o 515)
        const shouldReconnect = status !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          // pequena espera pra evitar loop muito agressivo
          setTimeout(() => startSock(), 800);
        } else {
          console.error('Sessão encerrada (loggedOut). Exclua o cache para parear de novo.');
          process.exit(1);
        }
      }
    });

    return sock;
  }

  await startSock();
})();
