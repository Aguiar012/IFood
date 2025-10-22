// wa-send.js
// Envia 1 mensagem via Baileys usando proxy HTTP(S) da DataImpulse
// e imprime QR somente no primeiro login.

const fs = require('fs');
const path = require('path');
const P = require('pino');
const baileys = require('@whiskeysockets/baileys');
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = baileys;

async function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  // https-proxy-agent v7 é ESM; usando import() dinâmico garante compat
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}

async function waitOpenOrFail(sock, logger) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout esperando conexão')), 30000);

    sock.ev.on('connection.update', (u) => {
      logger.info({ update: u }, 'connection.update');
      if (u.connection === 'open') { clearTimeout(t); resolve(); }
      if (u.connection === 'close') {
        clearTimeout(t);
        const err = u?.lastDisconnect?.error;
        reject(err || new Error('conexão fechada'));
      }
    });
  });
}

(async () => {
  const to = process.env.WA_TO;                           // ex: 55119... (sem +)
  const text = process.env.WA_TEXT || 'Hello from Actions';
  const authDir = process.env.WA_AUTH_DIR || 'wa_auth';
  const proxyUrl = process.env.WA_PROXY_URL;              // ex: http://LOGIN__cr.br:PWD@gw.dataimpulse.com:10000

  const logger = P({ level: 'info' }); // troque para 'debug' se quiser mais verboso
  logger.info({ to, authDir, hasProxy: !!proxyUrl }, 'boot');

  // prepara auth e versão
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const firstLogin = !fs.existsSync(path.join(authDir, 'creds.json'));
  const { version } = await fetchLatestBaileysVersion();

  // proxy (1 agente para WS + fetch)
  const agent = await buildProxyAgent(proxyUrl);

  const sock = baileys.default({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: firstLogin, // QR só na primeira vez
    agent,                         // WebSocket via proxy
    fetchAgent: agent              // uploads/downloads via proxy
  });

  sock.ev.on('creds.update', saveCreds);

  try {
    await waitOpenOrFail(sock, logger);
  } catch (e) {
    logger.error({ err: String(e) }, 'falha ao abrir conexão');
    process.exit(1);
  }

  const jid = `${to}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
  logger.info({ to: jid }, 'mensagem enviada com sucesso');
  process.exit(0);
})().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
