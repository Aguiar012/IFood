
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

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = baileys;

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3001);
const PROXY_URL = process.env.PROXY_URL || ""; // http://USER:PASS@HOST:PORT

// >>> PERSISTÊNCIA NO VOLUME /app/data (PASTA SEPARADA DO OUTRO BOT!) <<<
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || path.join(DATA_DIR, "wa_auth_zapbot");
fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

const logger = P({ level: "info" });
const app = express();
app.use(express.json());

let sock, waReady = false;
globalThis.__lastQR = "";

const LOCK_FILE = process.env.LOCK_FILE || path.join(DATA_DIR, "locks/conversazap.lock.json");
fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

function tryAcquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (Date.now() - (cur.ts || 0) < 5 * 60 * 1000) return false; // 5 min
  } catch {}
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return true;
}
if (!tryAcquireLock()) {
  console.error("Outra instância ativa usando o mesmo volume. Abortando.");
  process.exit(1);
}
setInterval(() => {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid })); } catch {}
}, 60_000);

let waLastOpen = 0;
let wdTimer = null;
function armWaWatchdog(){
  if (wdTimer) return; // garante um único watchdog
  wdTimer = setInterval(async () => {
    const stale = Date.now() - waLastOpen > 10 * 60 * 1000; // 10 min
    if (!waReady || stale) {
      try { sock?.ws?.close(); } catch {}
      await safeStartWA(); // ver item 3
    }
  }, 60_000);
}

// ---------- Proxy (igual ao app.js) ----------
async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  // HTTPS + WS CONNECT
  return new HttpsProxyAgent(url);
}

// ---------- Util ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toJid(to) {
  if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) return to;
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}
async function sendWA(to, text) {
  if (!waReady) throw new Error("WhatsApp não conectado ainda");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id;
}

// Limita spam de resposta (1 resposta a cada 15s por chat)
const lastReplyAt = new Map();
function canReply(jid, gapMs = 15_000) {
  const now = Date.now();
  const last = lastReplyAt.get(jid) || 0;
  if (now - last < gapMs) return false;
  lastReplyAt.set(jid, now);
  return true;
}

let startingWA = false;
async function safeStartWA () {
  if (startingWA) return;
  startingWA = true;
  try {
    // garante limpeza do socket anterior, se existir
    try { sock?.ws?.close(); } catch {}
    await startWA();
  } finally {
    startingWA = false;
  }
}

// ---------- WhatsApp ----------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version");
  const agent = await buildProxyAgent(PROXY_URL);

  sock = baileys.makeWASocket({
    version,
    auth: state,
    logger,
    // Nome do “dispositivo” exclusivo p/ esse bot:
    browser: ["IFood ZapBot", "Chrome", "14.4.1"],
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  armWaWatchdog(sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr;
      console.log("\n=== ESCANEIE ESTE QR NO WHATSAPP ===");
      qrcode.generate(qr, { small: true });
      console.log("Dica: GET /qr para ver a imagem grande.\n");
    }
    if (connection === "open") {
      waReady = true;
      waLastOpen = Date.now();
      logger.info({ WA_AUTH_DIR, PORT }, "WA conectado");
    }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      // trate 'conflict' como logout/substituída p/ evitar loop
      const text = String(lastDisconnect?.error || "");
      const isConflict =
        status === 409 || status === 440 ||
        text.includes("Stream Errored (conflict)") ||
        text.includes('"conflict"');

      waReady = false;
      logger.warn({ status, isConflict }, "WA desconectado");

      const shouldReconnect = !isConflict && status !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(safeStartWA, 1500);
      else logger.error("Sessão substituída/loggedOut — se preciso, apague a pasta de auth deste bot e repare o QR.");
    }
  });

  // Responder “oi” com delay humano
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        const fromMe = !!m.key?.fromMe;
        const jid = m.key?.remoteJid || "";
        if (fromMe) continue;
        if (!jid || jid.endsWith("@status")) continue; // ignora status
        // opcional: responda só DM (não grupos)
        // if (jid.endsWith("@g.us")) continue;

        const msg =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          "";

        if (!msg) continue;
        if (!canReply(jid)) continue; // anti-spam

        // “Digitando…” + delay humano simples (1.0–2.2s)
        await sock.presenceSubscribe(jid).catch(() => {});
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await sleep(1000 + Math.floor(Math.random() * 1200));
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});

        // resposta minimalista
        await sock.sendMessage(jid, { text: "KKKKKKKKKKKKKKKkk" });
      } catch (e) {
        logger.error(e, "falha no handler de mensagem");
      }
    }
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { try { await saveCreds(); } catch {} process.exit(0); });
  }
}

// ---------- HTTP util ----------
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ waReady }));

// QR grande no navegador
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
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

// /debug/proxy-ip (igual ao app.js)
let _proxyAgent;
async function getProxyAgent() {
  if (_proxyAgent) return _proxyAgent;
  if (!PROXY_URL) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  _proxyAgent = new HttpsProxyAgent(PROXY_URL);
  return _proxyAgent;
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

// /test/wa?to=55...&text=...
app.get("/test/wa", async (req, res) => {
  try {
    const id = await sendWA(req.query.to, req.query.text || "Teste OK");
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Boot ----------
(async () => {
  armWaWatchdog();
  await safeStartWA();
  app.listen(PORT, () => logger.info({ PORT, WA_AUTH_DIR }, "ZapBot up"));
})();
