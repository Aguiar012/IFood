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

// ====== 3. MEMÓRIA PERSISTENTE ======
let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store.json');

// Função auxiliar para criar store manual se precisar
const createManualStore = () => ({
    contacts: {},
    bind: (ev) => {
        ev.on('contacts.upsert', (u) => { 
            for(const c of u) if(c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id]||{}, c);
        });
        ev.on('contacts.update', (u) => { 
            for(const c of u) if(c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); 
        });
    },
    readFromFile: (p) => {
        try { 
            if(fs.existsSync(p)) store.contacts = JSON.parse(fs.readFileSync(p)).contacts; 
        } catch(e) { logger.error("Erro leitura store manual"); }
    },
    writeToFile: (p) => {
        try { fs.writeFileSync(p, JSON.stringify({contacts: store.contacts})); } catch {}
    }
});

if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
} else {
    logger.warn("⚠️ Usando memória manual.");
    store = createManualStore();
}

// Carrega dados antigos
try { store.readFromFile(STORE_PATH); } catch {}

// Salva periodicamente
setInterval(() => {
    try { store.writeToFile(STORE_PATH); } catch {}
}, 10_000);

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
  try { cleanupSock(); await startWA(); } finally { startingWA = false; }
}

// ====== 7. START WA ======
async function startWA() {
  try {
      const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
      registerSaveCreds(saveCreds);
      const { version } = await fetchLatestBaileysVersion();
      const agent = await buildProxyAgent(PROXY_URL);

      sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        agent,             
        fetchAgent: agent, 
        markOnlineOnConnect: true,
        syncFullHistory: true, 
        connectTimeoutMs: 60_000,
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
          logger.info("QR Code pronto.");
        }
        if (connection === "open") {
          waReady = true;
          waLastOpen = Date.now();
          lastPongAt = Date.now();
          logger.info("✅ WhatsApp CONECTADO!");
        }
        if (connection === "close") {
          const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
          waReady = false;
          if (status === DisconnectReason.loggedOut) {
             try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
             cleanupSock();
             setTimeout(() => startWA(), 3000);
          } else {
             cleanupSock();
             setTimeout(() => startWA(), 5000); 
          }
        }
      });

      sock.ws.on("pong", () => { lastPongAt = Date.now(); });

      // === HANDLER DE MENSAGENS ===
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" || !messages?.length) return;

        for (const m of messages) {
            const msgId = m.key?.id;
            if (handledMessageIds.has(msgId)) continue;
            handledMessageIds.add(msgId);

            const fromMe = !!m.key?.fromMe;
            let jid = m.key?.remoteJid || "";

            // 1. Lógica de Tradução
            if (jid.includes("@lid")) {
                let resolved = false;
                const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;

                // A) É o próprio dono?
                if (fromMe && sock.user?.id) {
                    jid = jidNormalizedUser(sock.user.id);
                    resolved = true;
                }

                // B) Busca na memória
                if (!resolved && store && store.contacts) {
                     let contact = store.contacts[lidKey];
                     if (contact && contact.id && !contact.id.includes("@lid")) {
                         jid = contact.id;
                         resolved = true;
                     }
                     // C) Busca Reversa (Lento mas necessário)
                     if (!resolved) {
                        const all = Object.values(store.contacts);
                        const found = all.find(c => c.lid === lidKey);
                        if (found && found.id && !found.id.includes("@lid")) {
                             jid = found.id;
                             resolved = true;
                        }
                     }
                }

                // D) Se FALHOU tudo:
                if (!resolved) {
                    logger.warn({ jid }, "⚠️ LID sem vínculo conhecido. Bloqueando para proteger DB.");
                    if (!fromMe) {
                        await sock.sendMessage(jid, { text: "⚠️ *Sincronização Pendente*\n\nAinda não consegui identificar seu número de telefone.\n\nPor favor, envie um *'Oi'* usando o app do **Celular**.\nAssim que fizer isso, o sistema vai aprender quem é você e liberará o acesso pelo computador para sempre." });
                    }
                    // AQUI É A PROTEÇÃO: Se não sabemos o número, NÃO salvamos no banco.
                    continue; 
                }
            }

            if (jidNormalizedUser) jid = jidNormalizedUser(jid);
            if (!jid || jid.endsWith("@status")) continue;

            // Se chegou aqui, jid é SEGURO (número de telefone)
            const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
            logger.info({ jid, ct }, "Msg processada com sucesso");

            if (fromMe) continue;

            const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
            const text = content?.conversation || content?.extendedTextMessage?.text || "";

            if (!text) continue;

            try { await sock.readMessages([m.key]); } catch {}
            
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

// ====== 8. WATCHDOG ======
setInterval(() => {
    const now = Date.now();
    if (waReady && (now - lastPongAt > 600_000)) {
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
