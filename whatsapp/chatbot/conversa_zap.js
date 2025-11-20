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

import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// ====== 1. CONFIGURAÇÃO INICIAL ======
const PORT = Number(process.env.PORT) || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);
const PROXY_URL = process.env.PROXY_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = paths.WA_AUTH_DIR;

try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

// ====== 2. IMPORTAÇÃO SEGURA DO BAILEYS ======
const baileysModule = require("@whiskeysockets/baileys");

const getExport = (key) => {
  if (baileysModule[key]) return baileysModule[key];
  if (baileysModule.default && baileysModule.default[key]) return baileysModule.default[key];
  return undefined;
};

const useMultiFileAuthState = getExport("useMultiFileAuthState");
const fetchLatestBaileysVersion = getExport("fetchLatestBaileysVersion");
const makeInMemoryStore = getExport("makeInMemoryStore");
const DisconnectReason = getExport("DisconnectReason");
const Browsers = getExport("Browsers");
const isJidGroup = getExport("isJidGroup");
const isJidBroadcast = getExport("isJidBroadcast");
const isJidStatusBroadcast = getExport("isJidStatusBroadcast");
const isJidNewsletter = getExport("isJidNewsletter");
const extractMessageContent = getExport("extractMessageContent");
const jidNormalizedUser = getExport("jidNormalizedUser");
const getContentType = getExport("getContentType");

const makeWASocket = baileysModule.default || baileysModule.makeWASocket || baileysModule;

if (typeof useMultiFileAuthState !== "function" || typeof makeWASocket !== "function") {
  throw new Error("CRÍTICO: Funções essenciais do Baileys não encontradas.");
}

// ====== HELPER FUNCTIONS (CORREÇÃO AQUI) ======
// Adicionei estas funções de volta para evitar o ReferenceError
const _isGroup = j => (isJidGroup ? isJidGroup(j) : String(j).endsWith("@g.us"));
const _isBroadcast = j => (isJidBroadcast ? isJidBroadcast(j) : String(j).endsWith("@broadcast"));
const _isStatus = j => (isJidStatusBroadcast ? isJidStatusBroadcast(j) : String(j) === "status@broadcast");
const _isNewsletter = j => (isJidNewsletter ? isJidNewsletter(j) : String(j).endsWith("@newsletter"));

// ====== 3. MEMÓRIA (STORE) ======
let store;
if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
    try { store.readFromFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    setInterval(() => {
        try { store.writeToFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    }, 10_000);
} else {
    logger.warn("⚠️ Usando memória simples (fallback).");
    store = {
        contacts: {},
        bind: (ev) => {
            ev.on('contacts.upsert', (u) => { for(const c of u) if(c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id]||{}, c); });
            ev.on('contacts.update', (u) => { for(const c of u) if(c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); });
        },
        readFromFile: () => {}, writeToFile: () => {}
    };
}

// ====== 4. FLUXO ======
const flow = createConversaFlow({
  dataDir: DATA_DIR,
  dbUrl: process.env.DATABASE_URL,
  logger
});

// ====== 5. ESTADO ======
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

const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// Lock
const HOST = process.env.HOSTNAME || "local";
const LOCK_FILE = path.join(DATA_DIR, "state", "lock-conversazap.json");
try { fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true }); } catch {}

function writeLockSafe() {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid, host: HOST })); } catch {}
}
writeLockSafe();
setInterval(writeLockSafe, 30_000);

// Proxy
let __proxyAgent;
async function buildProxyAgent(url) {
  if (!url) return undefined;
  if (__proxyAgent) return __proxyAgent;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  __proxyAgent = new HttpsProxyAgent(url);
  return __proxyAgent;
}

// Utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toJid(to){
  if (!to) throw new Error("vazio");
  return (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;
}
async function sendWA(to, text){
  if (!waReady) throw new Error("WhatsApp desconectado");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  lastActivityAt = Date.now();
  return sent?.key?.id;
}

function cleanupSock() {
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
}

// ====== 6. WATCHDOG ======
const PING_EVERY_MS = 300_000; 
const PONG_GRACE_MS = 600_000; 

function armWaWatchdog() {
  if (wdTimer) return;
  wdTimer = setInterval(async () => {
    const now = Date.now();
    const stale = false; 
    const noPong = now - lastPongAt > PONG_GRACE_MS; 
    const wsDead = !(sock?.ws) || (sock?.ws?.readyState !== 1);

    try { if (sock?.ws?.readyState === 1) { sock.ws.ping?.(); } } catch {}

    if (noPong || stale || wsDead || !waReady) {
      logger.warn({ waReady, wsReady: sock?.ws?.readyState }, "Watchdog: restart");
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
  if (startingWA) return;
  startingWA = true;
  startingSince = Date.now();
  try { cleanupSock(); await startWA(); } finally { startingWA = false; }
}

// ====== 7. START WA ======
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  registerSaveCreds(saveCreds);
  const { version } = await fetchLatestBaileysVersion();
  const agent = await buildProxyAgent(PROXY_URL);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers ? Browsers.macOS("Chrome") : ["Mac OS", "Chrome", "10.0"],
    agent,             
    fetchAgent: agent, 
    markOnlineOnConnect: false,
    syncFullHistory: true,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    printQRInTerminal: false,
    shouldIgnoreJid: jid => {
      const j = String(jid);
      // Agora as funções _isGroup existem!
      return _isGroup(j) || _isBroadcast(j) || _isStatus(j) || _isNewsletter(j);
    }
  });

  if (store) store.bind(sock.ev);
  
  lastPongAt = Date.now();
  lastActivityAt = Date.now();

  try { sock.ws?.on?.("pong", () => { lastPongAt = Date.now(); }); } catch {}
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr;
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      waReady = true;
      waLastOpen = Date.now();
      logger.info("WA conectado.");
    }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      if (status === DisconnectReason?.loggedOut) {
        try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
        setTimeout(() => safeStartWA(true), 1500);
      } else {
        setTimeout(() => safeStartWA(true), 2000);
      }
    }
  });

  // ===== 8. HANDLER DE MENSAGENS =====
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (type !== "notify" || !messages?.length) return;

      for (const m of messages) {
        const msgId = m.key?.id;
        if (!msgId || handledMessageIds.has(msgId)) continue;
        handledMessageIds.add(msgId);

        const fromMe = !!m.key?.fromMe;
        let jid = m.key?.remoteJid || "";

        // ====== TRAVA DE SEGURANÇA DO WEB (LID) ======
        if (jid.includes("@lid")) {
            let resolved = false;
            
            if (store && store.contacts) {
                 const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;
                 const contact = store.contacts[lidKey];
                 
                 if (contact && contact.id && !contact.id.includes("@lid")) {
                     jid = contact.id; 
                     resolved = true;
                 }
            }

            if (!resolved) {
                if (!fromMe) {
                    logger.warn({ jid }, "LID não identificado. Solicitando sync via celular.");
                    await sock.sendMessage(jid, { text: "🔄 *Atenção*\n\nIdentifiquei que você está usando o WhatsApp Web, mas o sistema ainda não sincronizou seu número.\n\nPor favor, envie um *'Oi'* usando seu **CELULAR** agora.\n\nIsso é necessário apenas uma vez para corrigir o cadastro." });
                }
                continue; 
            }
        }

        if (jidNormalizedUser) jid = jidNormalizedUser(jid);
        
        if (!jid || jid.endsWith("@status")) continue;

        const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
        logger.info({ jid, ct }, "Mensagem processada (ID Real)");

        if (fromMe) continue;

        const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
        const text =
          content?.conversation ||
          content?.extendedTextMessage?.text ||
          content?.imageMessage?.caption ||
          content?.videoMessage?.caption ||
          content?.buttonsResponseMessage?.selectedButtonId ||
          content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          content?.templateButtonReplyMessage?.selectedId ||
          "";

        if (!text) continue;

        try { await sock.readMessages([m.key]); } catch {}
        try {
            await sock.presenceSubscribe(jid);
            await sock.sendPresenceUpdate("composing", jid);
            await sleep(500);
            await sock.sendPresenceUpdate("paused", jid);
        } catch {}

        let reply = "";
        try {
          reply = await flow.handleText(jid, text);
        } catch (e) {
          logger.error({ err: String(e) }, "Erro no fluxo");
          reply = "Desculpa, tive um erro técnico. Tente novamente.";
        }
        if (!reply) reply = "ok";

        await sock.sendMessage(jid, { text: reply });
        lastActivityAt = Date.now();
    }
    } catch (e) {
      logger.error(e, "Erro upsert");
    }
  });
}

// ====== 9. ROTAS HTTP ======
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ ok: waReady }));
app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("Aguarde QR...");
  res.set("content-type","text/html");
  res.end(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 300, height: 300 });</script>`);
});
app.post("/debug/force-restart", async (_req, res) => {
  await safeStartWA(true);
  res.json({ ok: true });
});
app.get("/test/wa", async (req, res) => {
  try { res.json({ id: await sendWA(req.query.to, req.query.text || "Teste") }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ====== 10. BOOT ======
(async () => {
  armWaWatchdog();
  await safeStartWA(true);
  logger.info({ PORT, DATA_DIR, WA_AUTH_DIR }, "ZapBot Iniciado");
  app.listen(PORT, () => logger.info({ PORT }, "HTTP Server up"));
})();

process.on("unhandledRejection", (e) => logger.error({ err: String(e) }, "unhandledRejection"));
process.on("uncaughtException", (e) => logger.error({ err: String(e) }, "uncaughtException"));
