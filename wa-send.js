// wa-send.js — Baileys com proxy + QR no terminal
const fs = require('fs');
const path = require('path');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const baileys = require('@whiskeysockets/baileys');
const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(url); // vale para HTTPS e WebSocket (CONNECT)
}

async function main() {
  const TO = process.env.WA_TO;                         // ex: 5511932...
  const TEXT = process.env.WA_TEXT || 'Hello from Actions';
  const AUTH_DIR = process.env.WA_AUTH_DIR || 'wa_auth';
  const PROXY_URL = process.env.WA_PROXY_URL;          // ex: http://login__cr.br:pass@gw.dataimpulse.com:10000

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const logger = P({ level: 'info' });
  logger.info({ to: TO, hasProxy: !!PROXY_URL }, 'boot');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const agent = await buildProxyAgent(PROXY_URL);

  const sock = baileys.default({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Chrome'),
    agent,                   // WebSocket via proxy
    fetchAgent: agent        // downloads/uploads via proxy
  });

  sock.ev.on('creds.update', saveCreds);

  // Exibir QR manualmente quando o WA mandar
  let opened = false;
  const MAX_MS = 120000; // 2 minutos para você escanear
  const start = Date.now();

  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      console.log('\n=== ESCANEIE ESTE QR NO WHATSAPP ===');
      qrcode.generate(u.qr, { small: true });
      console.log('Caminho no app: WhatsApp > Aparelhos conectados > Conectar aparelho\n');
    }
    if (u.connection === 'open') {
      opened = true;
      console.log('✅ Conectado ao WhatsApp (sessão ativa).');
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      console.error('❌ Conexão fechada. Code:', code);
    }
  });

  // Espera abrir (ou estourar tempo)
  while (!opened) {
    if (Date.now() - start > MAX_MS) {
      console.error('⏳ Timeout esperando o pareamento (QR). Tente novamente e escaneie o QR.');
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Envia mensagem
  const jid = `${TO}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: TEXT });
  console.log('📤 Mensagem enviada. ID:', sent?.key?.id);

  // Pequena espera p/ salvar credenciais
  await new Promise(r => setTimeout(r, 1000));
  try { await sock.ws.close(); } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e?.stack || e?.message || e);
  process.exit(1);
});
