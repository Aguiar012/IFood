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
const baileys = require("@whiskeysockets/baileys");
import WebSocket from "ws";

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  extractMessageContent,
  jidNormalizedUser,
  getContentType
} = baileys;

import paths from "./whatsapp/paths.js";
import { createConversaFlow } from "./whatsapp/chatbot/conversa_flow.js";


const WA_AUTH_DIR = paths.WA_AUTH_DIR;

const { handleText } = createConversaFlow({
  dataDir: paths.DATA_DIR,          // <-- antes era /app/data (global); agora é /app/data/conversazap
  dbUrl: process.env.DATABASE_URL,
  logger: console,
});

// Porta sem secrets (auto): conversazap -> 3001, aviso_suap -> 3000
const PORT = Number(process.env.PORT)
  || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);

/* ===================== ENV ===================== */
const PROXY_URL = process.env.PROXY_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || path.join(DATA_DIR, "wa_auth_zapbot");
fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

/* ===================== LOG + HTTP ===================== */
const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

/* ===================== FLOW ===================== */
const flow = createConversaFlow({
  dataDir: DATA_DIR,
  dbUrl: process.env.DATABASE_URL,
  logger
});

/* ===================== ESTADO GLOBAL ===================== */
let sock;
let waReady = false;
let waLastOpen = 0;
let wdTimer = null;
let startingWA = false;
globalThis.__lastQR = "";
let err428Count = 0;

/* ===================== LOCK (HOST+PID+TTL) ===================== */
const HOST = process.env.HOSTNAME || "local";
const LOCK_FILE = process.env.LOCK_FILE || path.join(DATA_DIR, "locks/conversazap.lock.json");
fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

function readLock() { try { return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch { return null; } }
function writeLock() { try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid, host: HOST })); } catch {} }
function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function tryAcquireLock() {
  const cur = readLock(); const now = Date.now(); const TTL = 90_000;
  if (cur) {
    const sameHost = cur.host === HOST;
    const fresh = now - (cur.ts || 0) < TTL;
    const alive = sameHost && cur.pid && isPidAlive(cur.pid);
    if (sameHost && !alive) { writeLock(); return true; }
    if (!sameHost && fresh) {
      console.error("Outra instância ativa usando o mesmo volume. Abortando.");
      process.exit(1);
    }
  }
  writeLock(); return true;
}
if (!tryAcquireLock()) { console.error("Falha ao adquirir lock. Abortando."); process.exit(1); }
setInterval(writeLock, 30_000);

/* limpar lock ao sair */
for (const ev of ["SIGINT", "SIGTERM", "beforeExit", "exit"]) {
  process.on(ev, () => {
    try {
      const cur = readLock();
      if (cur && cur.host === HOST && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {}
  });
}

/* ===================== Proxy ===================== */
let __proxyAgent;
async function buildProxyAgent(url) {
  if (!url) return undefined;
  if (__proxyAgent) return __proxyAgent;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  __proxyAgent = new HttpsProxyAgent(url);
  logger.info({ proxy: maskProxy(url) }, "Usando proxy para HTTPS e WSS");
  return __proxyAgent;
}
function maskProxy(u) {
  try {
    const m = new URL(u);
    if (m.username) m.username = "****";
    if (m.password) m.password = "****";
    return m.toString();
  } catch { return "****"; }
}

/* ===================== Utils ===================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toJid(to) {
  if (!to) throw new Error("destinatário vazio");
  if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) return to;
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}
async function sendWA(to, text) {
  if (!waReady) throw new Error("WhatsApp não conectado ainda");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id;
}

/* ===================== Watchdog ===================== */
function armWaWatchdog() {
  if (wdTimer) return;
  wdTimer = setInterval(async () => {
    const stale = Date.now() - waLastOpen > 4 * 60 * 1000;
    if (stale || !waReady) {
      logger.warn({ waReady, stale }, "WA watchdog: restarting socket");
      try { sock?.ws?.close(); } catch {}
      await safeStartWA();
    } else {
      try { sock?.ws?.ping?.(); } catch {}
    }
  }, 60_000);
}

/* ===================== SaveCreds hooks (uma vez só) ===================== */
let _saveCredsRef = async () => {};
let _sigHooked = false;
function registerSaveCreds(fn) {
  _saveCredsRef = fn;
  if (_sigHooked) return;
  _sigHooked = true;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { try { await _saveCredsRef(); } catch {} });
  }
}

/* ===================== Start seguro ===================== */
async function safeStartWA() {
  if (startingWA) return;
  startingWA = true;
  try {
    try { sock?.ws?.close(); } catch {}
    await startWA();
  } finally {
    startingWA = false;
  }
}

/* ===================== WhatsApp ===================== */
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  registerSaveCreds(saveCreds);

  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version");
  const agent = await buildProxyAgent(PROXY_URL);
  const browser = Browsers.macOS("Chrome");

  sock = baileys.makeWASocket({
    version,
    auth: state,
    logger,
    browser,
    agent,              // WebSocket via proxy
    fetchAgent: agent,  // HTTP via proxy (media, check-ins)
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    printQRInTerminal: false
  });

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

      if (status === DisconnectReason.loggedOut) {
        try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
        waReady = false;
        logger.warn({ status }, "Logout detectado — auth resetado, gere novo QR.");
        setTimeout(safeStartWA, 1500);
        return;
      }

      if (status === 428) {
        err428Count++;
        logger.warn({ status, err428Count }, "WA desconectado (428)");
        waReady = false;
        const hold =
          err428Count === 1 ? 30_000 :
          err428Count === 2 ? 120_000 :
          err428Count <= 4 ? 600_000 :
          1_800_000;
        setTimeout(safeStartWA, hold);
        return;
      }

      waReady = false;
      logger.warn({ status }, "WA desconectado");
      setTimeout(safeStartWA, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    }
  });

  /* ===== Inbound messages ===== */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (!messages?.length) return;
      for (const m of messages) {
        const fromMe = !!m.key?.fromMe;
        let jid = m.key?.remoteJid || "";
        if (!jid || jid.endsWith("@status")) continue;

        // normaliza (remove device suffix / lid forms)
        jid = jidNormalizedUser(jid);

        // log bruto
        const ct = getContentType(m.message);
        logger.info({ type, fromMe, jid, ct }, "RX upsert");

        // só responda outros (se quiser ecoar seus próprios, troque aqui)
        if (fromMe) continue;

        // extrai texto de forma robusta
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

        if (!text) {
          logger.info({ jid }, "Sem texto extraído — ignorando.");
          continue;
        }

        // marca como lido + presença
        try { await sock.readMessages([m.key]); } catch {}
        try {
          await sock.presenceSubscribe(jid);
          await sock.sendPresenceUpdate("composing", jid);
          await sleep(400 + Math.floor(Math.random() * 400));
          await sock.sendPresenceUpdate("paused", jid);
        } catch {}

        // chama o motor de conversa
        let reply = "";
        try {
          reply = await flow.handleText(jid, text);
        } catch (e) {
          logger.error({ err: String(e) }, "flow.handleText falhou");
          reply = "Desculpa, falhei aqui. Tenta de novo em instantes.";
        }

        // fallback de teste
        if (!reply) reply = "ok";

        await sock.sendMessage(jid, { text: reply });
        logger.info({ jid, reply }, "TX reply");
      }
    } catch (e) {
      logger.error(e, "falha no handler de mensagem");
    }
  });
}

/* ===================== HTTP util ===================== */
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ waReady, ts: Date.now() }));

app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type", "text/html");
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

// /debug/proxy-ip
let _proxyAgentSingleton;
async function getProxyAgent() {
  if (_proxyAgentSingleton) return _proxyAgentSingleton;
  if (!PROXY_URL) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  _proxyAgentSingleton = new HttpsProxyAgent(PROXY_URL);
  return _proxyAgentSingleton;
}
app.get("/debug/proxy-ip", async (_req, res) => {
  try {
    const agent = await getProxyAgent();
    const req = https.request({ host: "api.ipify.org", path: "/?format=json", agent }, r => {
      let data=""; r.on("data", d => data+=d); r.on("end", () => res.type("json").send(data));
    });
    req.on("error", e => res.status(500).send(String(e)));
    req.end();
  } catch (e) { res.status(500).send(String(e)); }
});

// /debug/ws — testa WebSocket via o MESMO proxy
app.get("/debug/ws", async (_req, res) => {
  try {
    const agent = await getProxyAgent();
    const t0 = Date.now();
    const ws = new WebSocket("wss://echo.websocket.events/", { agent, handshakeTimeout: 10000 });
    let done = false;
    ws.on("open", () => ws.send("ping"));
    ws.on("message", () => {
      if (done) return; done = true; ws.close();
      res.json({ ok: true, viaProxy: !!agent, rttMs: Date.now()-t0 });
    });
    ws.on("error", (e) => {
      if (done) return; done = true; res.status(500).json({ ok: false, error: String(e) });
    });
    setTimeout(() => {
      if (done) return; done = true; try { ws.terminate(); } catch {}
      res.status(504).json({ ok: false, error: "timeout" });
    }, 12000);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// /test/wa?to=55...&text=...
app.get("/test/wa", async (req, res) => {
  try {
    const id = await sendWA(req.query.to, req.query.text || "Teste OK");
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* ===================== Boot ===================== */
(async () => {
  tryAcquireLock(); // revalida ao subir
  armWaWatchdog();
  await safeStartWA();
  logger.info({ PORT, DATA_DIR, WA_AUTH_DIR }, "up");
  app.listen(PORT, () => logger.info({ PORT, WA_AUTH_DIR }, "ZapBot up"));
})();
