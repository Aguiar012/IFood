// bot-oi.js
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");

const makeWASocket =
  (typeof baileys?.default === "function" && baileys.default) ||
  (typeof baileys?.makeWASocket === "function" && baileys.makeWASocket) ||
  baileys;

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = baileys;

import fs from "fs";
import path from "path";
import https from "https";

// ---------- ENV (compatível com seu app.js) ----------
const PORT = process.env.PORT || 3000;
const PROXY_URL = process.env.PROXY_URL || "";
// use um diretório diferente do serviço principal para não conflitar
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || "wa_auth_oi";
// opcional: responda só DMs (não grupos)
const REPLY_GROUPS = (process.env.REPLY_GROUPS || "false").toLowerCase() === "true";
// opcional: lista de jids permitidos (CSV de números), vazia = qualquer um
const ALLOW_LIST = (process.env.WA_ALLOW_LIST || "")
  .split(",")
  .map(s => s.trim().replace(/\D/g, ""))
  .filter(Boolean);

fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

const logger = P({ level: "info" });
const app = express();
app.use(express.json());

let sock, waReady = false;
globalThis.__lastQR = "";

// ---------- Proxy (mesmo estilo do app.js) ----------
async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(url);
}

function toJid(str) {
  if (!str) return "";
  if (str.endsWith("@s.whatsapp.net") || str.endsWith("@g.us")) return str;
  return `${str.replace(/\D/g, "")}@s.whatsapp.net`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function extractText(msg) {
  if (!msg) return "";
  const type = baileys.getContentType(msg);
  if (!type) return "";
  const node = msg[type];
  if (!node) return "";
  if (typeof node === "string") return node;
  return node?.text || node?.caption || msg?.conversation || "";
}

function allowedToReply(jid) {
  // se não configurou allow list, permite geral
  if (!ALLOW_LIST.length) return true;
  const phone = (jid || "").replace("@s.whatsapp.net","").replace(/\D/g,"");
  return ALLOW_LIST.includes(phone);
}

// ---------- Boot do WhatsApp ----------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version (bot-oi)");

  const agent = await buildProxyAgent(PROXY_URL);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Chrome"),
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr;
      console.log("\n=== ESCANEIE ESTE QR (bot-oi) ===");
      qrcode.generate(qr, { small: true });
      console.log("Dica: abra /qr para imagem grande. QR expira em ~15s.\n");
    }
    if (connection === "open") { waReady = true; logger.info("WA conectado (bot-oi)"); }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      logger.warn({ status }, "WA desconectado (bot-oi)");
      if (shouldReconnect) setTimeout(startWA, 1500);
      else logger.error("loggedOut — apague a pasta do WA_AUTH_DIR do bot-oi para parear novamente.");
    }
  });

  // Responder mensagens com "oi" (delay humano + digitando)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const m of messages || []) {
      try {
        if (!m.message) continue;
        if (m.key.fromMe) continue; // ignora eco
        const jid = m.key.remoteJid || "";
        const isGroup = jid.endsWith("@g.us");
        if (isGroup && !REPLY_GROUPS) continue;
        if (!allowedToReply(jid)) continue;

        const textIn = extractText(m.message);
        // política simples: respondeu a QUALQUER coisa com "oi"
        if (typeof textIn !== "string") continue;

        // "digitando..." + atraso humano (1.1–3.8s com jitter)
        const base = 1100 + Math.floor(Math.random() * 1600);
        const jitter = Math.floor(Math.random() * 1100);
        const delay = base + jitter;

        try { await sock.presenceSubscribe(jid); } catch {}
        try { await sock.sendPresenceUpdate("composing", jid); } catch {}
        await sleep(delay);
        try { await sock.sendPresenceUpdate("paused", jid); } catch {}

        await sock.sendMessage(jid, { text: "oi" });

        // marca como lido (opcional)
        try {
          await sock.readMessages([m.key]);
        } catch {}
      } catch (e) {
        logger.error(e, "falha ao responder 'oi'");
      }
    }
  });

  for (const sig of ["SIGINT","SIGTERM"]) {
    process.on(sig, async () => { try { await saveCreds(); } catch {} process.exit(0); });
  }
}

// ---------- HTTP util (igual ao app.js) ----------
app.get("/", (_req, res) => res.send("ok (bot-oi)"));

app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type","text/html");
  res.end(`<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>WhatsApp QR (bot-oi)</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#fff}</style>
<div id="qrcode"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

// debug opcional: checar IP do proxy de saída
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

// ---------- Boot ----------
(async () => {
  await startWA();
  app.listen(PORT, () => logger.info({ PORT }, "bot-oi up"));
})();
