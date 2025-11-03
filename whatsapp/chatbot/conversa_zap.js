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
const WA_AUTH_DIR =
  process.env.WA_AUTH_DIR || path.join(DATA_DIR, "wa_auth_zapbot");
fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

// ---------- LOG + HTTP ----------
const logger = P({ level: "info" });
const app = express();
app.use(express.json());

// ---------- ESTADO GLOBAL ----------
let sock;
let waReady = false;
let waLastOpen = 0;
let wdTimer = null;
let startingWA = false;
globalThis.__lastQR = "";

// ---------- LOCK ROBUSTO (HOST+PID+TTL) ----------
const HOST = process.env.HOSTNAME || "local";
const LOCK_FILE =
  process.env.LOCK_FILE || path.join(DATA_DIR, "locks/conversazap.lock.json");
fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeLock() {
  const data = { ts: Date.now(), pid: process.pid, host: HOST };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data));
  } catch {}
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function tryAcquireLock() {
  const cur = readLock();
  const now = Date.now();
  const TTL = 90_000; // 90s cobre janela de rolling deploy

  if (cur) {
    const sameHost = cur.host === HOST;
    const fresh = now - (cur.ts || 0) < TTL;
    const alive = sameHost && cur.pid && isPidAlive(cur.pid);

    // Mesmo host: se o PID anterior morreu, assume imediatamente
    if (sameHost && !alive) {
      writeLock();
      return true;
    }
    // Host diferente (outro pod): respeita TTL antes de assumir
    if (!sameHost && fresh) {
      console.error(
        "Outra instância ativa usando o mesmo volume (host diferente e lock fresco). Abortando."
      );
      process.exit(1);
    }
  }
  writeLock();
  return true;
}
if (!tryAcquireLock()) {
  console.error("Falha ao adquirir lock. Abortando.");
  process.exit(1);
}
// Atualiza carimbo do lock a cada 30s
setInterval(writeLock, 30_000);

// Limpa o lock em desligamentos limpos (sem chamar exit aqui para não atropelar outros handlers)
for (const sig of ["SIGINT", "SIGTERM", "beforeExit", "exit"]) {
  process.on(sig, () => {
    try {
      const cur = readLock();
      if (cur && cur.host === HOST && cur.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch {}
  });
}

// ---------- Proxy ----------
async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  // HTTPS + WS CONNECT
  return new HttpsProxyAgent(url);
}

// ---------- Util ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// Anti-spam simples (1 resposta a cada 15s por chat)
const lastReplyAt = new Map();
function canReply(jid, gapMs = 15_000) {
  const now = Date.now();
  const last = lastReplyAt.get(jid) || 0;
  if (now - last < gapMs) return false;
  lastReplyAt.set(jid, now);
  return true;
}

// ---------- Watchdog ----------
function armWaWatchdog() {
  if (wdTimer) return; // garante um único watchdog
  wdTimer = setInterval(async () => {
    const stale = Date.now() - waLastOpen > 3 * 60 * 1000; // 3 min
    if (!waReady || stale) {
      try {
        sock?.ws?.close();
      } catch {}
      await safeStartWA();
    }
  }, 60_000);
}

// ---------- Start seguro ----------
async function safeStartWA() {
  if (startingWA) return;
  startingWA = true;
  try {
    try {
      sock?.ws?.close();
    } catch {}
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
    browser: ["IFood ZapBot", "Chrome", "14.4.1"], // nome de “dispositivo”
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // Salva credenciais quando atualizam
  sock.ev.on("creds.update", saveCreds);

  // Atualiza status de conexão
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
      const text = String(lastDisconnect?.error || "");
      const isConflict =
        status === 409 ||
        status === 440 ||
        text.includes("Stream Errored (conflict)") ||
        text.includes('"conflict"');

      waReady = false;
      logger.warn({ status, isConflict }, "WA desconectado");

      const shouldReconnect =
        !isConflict && status !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(safeStartWA, 1500);
      else
        logger.error(
          "Sessão substituída/loggedOut — se preciso, apague a pasta de auth deste bot e repare o QR."
        );
    }
  });

  // Responder mensagens
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        const fromMe = !!m.key?.fromMe;
        const jid = m.key?.remoteJid || "";
        if (fromMe) continue;
        if (!jid || jid.endsWith("@status")) continue; // ignora status
        // if (jid.endsWith("@g.us")) continue; // se quiser ignorar grupos

        const msg =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          "";

        if (!msg) continue;
        if (!canReply(jid)) continue;

        await sock.presenceSubscribe(jid).catch(() => {});
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await sleep(1000 + Math.floor(Math.random() * 1200));
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});

        await sock.sendMessage(jid, { text: "KKKKKKKKKKKKKKKkk" });
      } catch (e) {
        logger.error(e, "falha no handler de mensagem");
      }
    }
  });

  // No shutdown limpo, tenta salvar creds antes de sair
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      try {
        await saveCreds();
      } catch {}
      // não chama exit aqui; o handler global de lock cuida da remoção
    });
  }
}

// ---------- HTTP util ----------
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ waReady }));

// QR grande no navegador
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
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(
    globalThis.__lastQR
  )}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

// /debug/proxy-ip
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
    const req = https.request(
      { host: "api.ipify.org", path: "/?format=json", agent },
      (r) => {
        let data = "";
        r.on("data", (d) => (data += d));
        r.on("end", () => res.type("json").send(data));
      }
    );
    req.on("error", (e) => res.status(500).send(String(e)));
    req.end();
  } catch (e) {
    res.status(500).send(String(e));
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

// ---------- Boot ----------
(async () => {
  tryAcquireLock(); // revalida ao subir
  armWaWatchdog();
  await safeStartWA();
  app.listen(PORT, () =>
    logger.info({ PORT, WA_AUTH_DIR }, "ZapBot up")
  );
})();
