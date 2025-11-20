// whatsapp/chatbot/conversa_zap.js
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import https from "https";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import WebSocket from "ws";

// ====== 1. CONFIGURAÇÃO INICIAL (LOGGER E APP) ======
// Definimos o logger primeiro para evitar erros de inicialização
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

const PORT = Number(process.env.PORT) || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);
const PROXY_URL = process.env.PROXY_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = paths.WA_AUTH_DIR;

// Garante pastas
try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

// ====== 2. IMPORTAÇÃO SEGURA DO BAILEYS ======
const baileysModule = require("@whiskeysockets/baileys");
const baileys = baileysModule.default || baileysModule;

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
  extractMessageContent,
  jidNormalizedUser,
  getContentType
} = baileys;

// ====== 3. MEMÓRIA BLINDADA (FALLBACK) ======
// Tenta pegar a função original. Se não existir, cria uma versão simples.
let makeStoreFunc = baileys.makeInMemoryStore || baileysModule.makeInMemoryStore;

if (typeof makeStoreFunc !== 'function') {
  logger.warn("⚠️ makeInMemoryStore não encontrado na lib. Usando versão interna simplificada.");
  
  // Versão caseira para garantir que o bot suba e traduza LIDs
  makeStoreFunc = ({ logger }) => {
    return {
      contacts: {},
      bind: (ev) => {
        ev.on('contacts.upsert', (updates) => {
          for (const c of updates) {
            if (c.id) {
              // Guarda o contato na memória
              // Se for LID, isso nos ajuda a achar o número real depois
              store.contacts[c.id] = Object.assign(store.contacts[c.id] || {}, c);
            }
          }
        });
        ev.on('contacts.update', (updates) => {
          for (const c of updates) {
            if (c.id && store.contacts[c.id]) {
              Object.assign(store.contacts[c.id], c);
            }
          }
        });
      },
      readFromFile: () => {}, // Funções vazias para não dar erro
      writeToFile: () => {}
    };
  };
}

// Agora criamos a store com segurança
const store = makeStoreFunc({ logger });
if (store.readFromFile) {
    try { store.readFromFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
}
// Salva periodicamente (se suportado)
setInterval(() => {
    if (store.writeToFile) {
        try { store.writeToFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    }
}, 10_000);


// ====== 4. FLUXO DO BOT ======
const flow = createConversaFlow({
  dataDir: DATA_DIR,
  dbUrl: process.env.DATABASE_URL,
  logger
});

// ====== 5. ESTADO E LOCK ======
let sock = null;
let waReady = false;
let waLastOpen = 0;
let wdTimer = null;
let startingWA = false;
let startingSince = 0;
let err428Count = 0;
let lastPongAt = 0;
let lastActivityAt = 0; 
globalThis.__lastQR = "";

// Janelas de saúde
const LIVENESS_FAIL_MIN = Number(process.env.LIVENESS_FAIL_MIN ?? "10");
const PING_EVERY_MS = 300_000; 
const PONG_GRACE_MS = 600_000; 

const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

const HOST = process.env.HOSTNAME || "local";
const LOCK_FILE = path.join(DATA_DIR, "state", "lock-conversazap.json");
try { fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true }); } catch {}

function writeLockSafe() {
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ ts: Date.now(), pid: process.pid, host: HOST })
    );
  } catch {}
}
writeLockSafe();
setInterval(writeLockSafe, 30_000);

// ====== 6. PROXY ======
let __proxyAgent;
async function buildProxyAgent(url) {
  if (!url) return undefined;
  if (__proxyAgent) return __proxyAgent;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  __proxyAgent = new HttpsProxyAgent(url);
  logger.info({ proxy: maskProxy(url) }, "Usando proxy para HTTPS/WSS");
  return __proxyAgent;
}
function maskProxy(u){
  try{ const m = new URL(u); if(m.username) m.username="****"; if(m.password) m.password="****"; return m.toString(); }
  catch{ return "****"; }
}

// ====== 7. UTILS ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toJid(to){
  if (!to) throw new Error("destinatário vazio");
  return (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;
}
async function sendWA(to, text){
  if (!waReady) throw new Error("WhatsApp não conectado ainda");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  lastActivityAt = Date.now();
  return sent?.key?.id;
}

function cleanupSock() {
  try { sock?.ws?.removeAllListeners?.(); } catch {}
  try { sock?.ev?.removeAllListeners?.(); } catch {}
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
}

// ====== 8. WATCHDOG ======
function armWaWatchdog() {
  if (wdTimer) return;
  wdTimer = setInterval(async () => {
    const now = Date.now();
    const stale = false; 
    const noPong = now - lastPongAt > PONG_GRACE_MS; 
    const wsDead = !(sock?.ws) || (sock?.ws?.readyState !== 1);

    try { if (sock?.ws?.readyState === 1) { sock.ws.ping?.(); } } catch {}

    if (noPong || stale || wsDead || !waReady) {
      logger.warn({ waReady, stale, noPong, wsReady: sock?.ws?.readyState }, "Watchdog: hard restart");
      await safeStartWA(true);
    }
  }, PING_EVERY_MS);
}

let _saveCredsRef = async () => {};
let _sigHooked = false;
function registerSaveCreds(fn){
  _saveCredsRef = fn;
  if (_sigHooked) return;
  _sigHooked = true;
  for (const sig of ["SIGINT","SIGTERM"]) {
    process.on(sig, async () => { try { await _saveCredsRef(); } catch {} process.exit(0); });
  }
}

async function safeStartWA(force = false) {
  if (startingWA && !force) return;
  const DEADLINE_MS = 90_000;
  if (startingWA && force && (Date.now() - startingSince > DEADLINE_MS)) {
    logger.warn("Start preso — forçando destravar startingWA");
    startingWA = false;
  }
  if (startingWA) return;

  startingWA = true;
  startingSince = Date.now();
  try {
    cleanupSock();
    await startWA();
  } finally {
    startingWA = false;
  }
}

// ====== 9. START WA ======
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  registerSaveCreds(saveCreds);

  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version");
  const agent = await buildProxyAgent(PROXY_URL);

  sock = baileys.makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Chrome"),
    agent,             
    fetchAgent: agent, 
    markOnlineOnConnect: false,
    syncFullHistory: true, // ESSENCIAL PARA LIGAR O LID AO TELEFONE
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    printQRInTerminal: false,
    shouldIgnoreJid: jid => {
      const j = String(jid);
      return _isGroup(j) || _isBroadcast(j) || _isStatus(j) || _isNewsletter(j);
    }
  });

  // LIGA A MEMÓRIA AQUI
  store.bind(sock.ev);

  lastPongAt = Date.now();
  lastActivityAt = Date.now();

  try {
    sock.ws?.on?.("pong", () => {
      lastPongAt = Date.now();
    });
  } catch {}

  sock.ev.on("creds.update", saveCreds);

  let reconnectDelay = 1500;
  const MAX_DELAY = 60_000;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr;
      logger.info("QR atualizado — abra /qr");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      waReady = true;
      waLastOpen = Date.now();
      err428Count = 0;
      reconnectDelay = 1500;
      logger.info({ WA_AUTH_DIR, PORT }, "WA conectado");
      return;
    }

    if (connection === "close") {
      const err = lastDisconnect?.error;
      const status = new Boom(err)?.output?.statusCode;
      waReady = false;

      if (status === DisconnectReason.loggedOut) {
        try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
        logger.warn({ status }, "Logout detectado — auth resetado, gere novo QR.");
        setTimeout(() => safeStartWA(true), 1500);
        return;
      }

      if (status === 428) {
        err428Count++;
        const base = 20_000;
        const hold = Math.min(
          (base * Math.pow(2, Math.min(err428Count, 6))) +
          Math.floor(Math.random() * base),
          30 * 60 * 1000
        );
        logger.warn({ status, err428Count, hold }, "WA desconectado (428)");
        setTimeout(() => safeStartWA(true), hold);
        return;
      }

      logger.warn({ status }, "WA desconectado");
      setTimeout(() => safeStartWA(true), reconnectDelay + Math.floor(Math.random() * 1000));
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    }
  });

  // ===== 10. HANDLER DE MENSAGENS =====
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify") {
        logger.info({ type }, "messages.upsert ignorado (não-notify)");
        return;
      }

      if (!messages?.length) return;

      for (const m of messages) {
        const msgId = m.key?.id;
        if (!msgId) {
          logger.warn("Mensagem sem ID, ignorando");
          continue;
        }

        if (handledMessageIds.has(msgId)) {
          continue;
        }
        handledMessageIds.add(msgId);

        const fromMe = !!m.key?.fromMe;
        
        let jid = m.key?.remoteJid || "";

        // --- FIX DO WHATSAPP WEB (LID) ---
        // Se recebermos um ID estranho (@lid), perguntamos pra memória quem é esse cara
        if (jid.includes("@lid")) {
            const contact = store.contacts[jidNormalizedUser(jid)];
            if (contact && contact.id && !contact.id.includes("@lid")) {
                // Achamos! É o número real que está salvo na memória
                jid = contact.id; 
            } 
        }

        jid = jidNormalizedUser(jid);
        if (!jid || jid.endsWith("@status")) continue;

        const ct = getContentType(m.message);
        logger.info({ type, fromMe, jid, ct, msgId }, "RX upsert");

        if (fromMe) continue;

        const content = extractMessageContent(m.message) || {};
        const text =
          content.conversation ||
          content.extendedTextMessage?.text ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          content.buttonsResponseMessage?.selectedButtonId ||
          content.listResponseMessage?.singleSelectReply?.selectedRowId ||
          content.templateButtonReplyMessage?.selectedId ||
          "";

        if (!text) continue;

        try { await sock.readMessages([m.key]); } catch {}
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate("composing", jid);
          await sleep(300 + Math.floor(Math.random() * 400));
          await sock.sendPresenceUpdate("paused", jid);
        } catch {}

        let reply = "";
        try {
          reply = await flow.handleText(jid, text);
        } catch (e) {
          logger.error({ err: String(e) }, "flow.handleText falhou");
          reply = "Desculpa, falhei aqui. Tenta de novo em instantes.";
        }
        if (!reply) reply = "ok";

        await sock.sendMessage(jid, { text: reply });
        lastActivityAt = Date.now();
        logger.info({ jid, msgId }, "TX reply");
      }
    } catch (e) {
      logger.error(e, "falha no handler de mensagem");
    }
  });
}

// ====== 11. ROTAS HTTP ======
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => {
  const now = Date.now();
  const noPongTooLong = now - lastPongAt > LIVENESS_FAIL_MIN * 60_000;
  const ok = waReady && !noPongTooLong;
  res.status(ok ? 200 : 503).json({
    ok, waReady,
    wsReady: sock?.ws?.readyState ?? -1,
    lastOpenMsAgo: now - waLastOpen,
    lastPongMsAgo: now - lastPongAt,
    lastActivityMsAgo: now - lastActivityAt
  });
});

app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type","text/html");
  res.end(`<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#fff}</style>
<div id="qrcode"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(globalThis.__lastQR)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

app.post("/debug/force-restart", async (_req, res) => {
  await safeStartWA(true);
  res.json({ ok: true });
});

app.get("/test/wa", async (req, res) => {
  try {
    const id = await sendWA(req.query.to, req.query.text || "Teste OK");
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ====== 12. BOOT ======
(async () => {
  armWaWatchdog();
  await safeStartWA(true);
  logger.info({ PORT, DATA_DIR, WA_AUTH_DIR }, "up");
  app.listen(PORT, () => logger.info({ PORT, WA_AUTH_DIR }, "ZapBot up"));
})();

process.on("unhandledRejection", (e) => logger.error({ err: String(e) }, "unhandledRejection"));
process.on("uncaughtException", (e) => logger.error({ err: String(e) }, "uncaughtException"));
