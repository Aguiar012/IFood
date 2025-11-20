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

// ====== 1. CONFIGURAÇÃO ======
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

// ====== 2. IMPORTAÇÃO SEGURA ======
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
const isJidGroup = getExport("isJidGroup");
const isJidBroadcast = getExport("isJidBroadcast");
const isJidStatusBroadcast = getExport("isJidStatusBroadcast");
const isJidNewsletter = getExport("isJidNewsletter");
const extractMessageContent = getExport("extractMessageContent");
const jidNormalizedUser = getExport("jidNormalizedUser");
const getContentType = getExport("getContentType");
const makeWASocket = baileysModule.default || baileysModule.makeWASocket || baileysModule;

if (!useMultiFileAuthState || !makeWASocket) {
  throw new Error("CRÍTICO: Funções do Baileys não encontradas.");
}

// ====== 3. MEMÓRIA PERSISTENTE (STORE) ======
let store;
if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
    try { store.readFromFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    setInterval(() => {
        try { store.writeToFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    }, 10_000);
} else {
    logger.warn("⚠️ Usando memória simples.");
    store = {
        contacts: {},
        bind: (ev) => {
            ev.on('contacts.upsert', (u) => { for(const c of u) if(c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id]||{}, c); });
            ev.on('contacts.update', (u) => { for(const c of u) if(c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); });
        }
    };
}

// ====== 4. FLUXO ======
const flow = createConversaFlow({ dataDir: DATA_DIR, dbUrl: process.env.DATABASE_URL, logger });

// ====== 5. ESTADO ======
let sock = null;
let waReady = false;
let waLastOpen = 0;
let startingWA = false;
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

// ====== 6. START WA ======
async function startWA() {
  if (startingWA) return;
  startingWA = true;
  
  try {
      const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();
      const agent = await buildProxyAgent(PROXY_URL);

      logger.info(`Iniciando socket... Versão: ${version.join('.')}`);

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        // Navegador Fixo para evitar rejeição do servidor
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        agent,             
        fetchAgent: agent, 
        markOnlineOnConnect: true,
        syncFullHistory: true, 
        // TIMEOUTS AUMENTADOS PARA EVITAR QUEDAS
        connectTimeoutMs: 180_000, // 3 minutos para conectar
        defaultQueryTimeoutMs: 180_000, // 3 minutos para queries
        keepAliveIntervalMs: 60_000, // Ping a cada 1 min
        retryRequestDelayMs: 5000,
        printQRInTerminal: false,
        shouldIgnoreJid: jid => {
          const j = String(jid);
          return (isJidGroup && isJidGroup(j)) || (isJidBroadcast && isJidBroadcast(j)) || (isJidNewsletter && isJidNewsletter(j));
        }
      });

      if (store) store.bind(sock.ev);
      
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          globalThis.__lastQR = qr;
          qrcode.generate(qr, { small: true });
          logger.info("QR Code gerado. Escaneie para vincular.");
        }
        if (connection === "open") {
          waReady = true;
          waLastOpen = Date.now();
          lastPongAt = Date.now();
          logger.info("✅ WhatsApp CONECTADO!");
        }
        if (connection === "close") {
          const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
          const shouldReconnect = status !== DisconnectReason.loggedOut;
          
          waReady = false;
          logger.warn({ status }, "Conexão fechada.");

          if (status === DisconnectReason.loggedOut) {
            logger.error("Sessão encerrada (Logout). Limpando dados...");
            try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
            // Reinicia para gerar novo QR limpo
            cleanupSock();
            setTimeout(() => startWA(), 3000);
          } else {
             // Reconexão suave (sem limpar dados)
             cleanupSock();
             setTimeout(() => startWA(), 5000); 
          }
        }
      });

      // Monitoramento de Pongs (Keep Alive)
      sock.ws.on("pong", () => { lastPongAt = Date.now(); });

      // Mensagens
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" || !messages?.length) return;

        for (const m of messages) {
            const msgId = m.key?.id;
            if (handledMessageIds.has(msgId)) continue;
            handledMessageIds.add(msgId);

            const fromMe = !!m.key?.fromMe;
            let jid = m.key?.remoteJid || "";

            // --- TRADUÇÃO WEB ID ---
            if (jid.includes("@lid") && store && store.contacts) {
                const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;
                const contact = store.contacts[lidKey] || store.contacts[jid];
                if (contact && contact.id && !contact.id.includes("@lid")) {
                    jid = contact.id; 
                }
            }
            if (jidNormalizedUser) jid = jidNormalizedUser(jid);
            if (!jid || jid.endsWith("@status")) continue;

            const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
            logger.info({ jid, ct }, "Mensagem recebida");

            if (fromMe) continue;

            // Extrai texto
            const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
            const text = content?.conversation || content?.extendedTextMessage?.text || "";

            if (!text) continue;

            try { await sock.readMessages([m.key]); } catch {}
            
            // Processa fluxo
            let reply = "";
            try { reply = await flow.handleText(jid, text); } 
            catch (e) { logger.error(e, "Erro fluxo"); }
            
            if (reply) await sock.sendMessage(jid, { text: reply });
            lastActivityAt = Date.now();
        }
      });

  } catch (e) {
      logger.error(e, "Erro fatal no startWA");
      setTimeout(() => startWA(), 10000);
  } finally {
      startingWA = false;
  }
}

// ====== 7. ROTAS ======
app.get("/", (req, res) => res.send("ok"));
app.get("/qr", (req, res) => {
  const qr = globalThis.__lastQR;
  if (!qr) return res.send("Aguarde o QR...");
  res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 300, height: 300 });</script>`);
});
app.post("/debug/force-restart", (req, res) => {
    cleanupSock();
    setTimeout(() => startWA(), 1000);
    res.json({ ok: true });
});

// ====== 8. WATCHDOG (Keep Alive) ======
// Apenas monitora se travou de vez, não reinicia por qualquer coisa
setInterval(() => {
    const now = Date.now();
    // Se não receber Pong por 10 minutos, aí sim reinicia
    if (waReady && (now - lastPongAt > 600_000)) {
        logger.warn("Sem resposta do servidor (Pong) há 10min. Reiniciando...");
        cleanupSock();
        startWA();
    }
}, 60_000);

// Start
(async () => {
  await startWA();
  app.listen(PORT, () => logger.info({ PORT }, "Servidor Online"));
})();

process.on("unhandledRejection", (e) => logger.error(e));
process.on("uncaughtException", (e) => logger.error(e));
