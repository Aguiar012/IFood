// whatsapp/chatbot/conversa_zap.js
const express = require('express')
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import https from "https";
import WebSocket from "ws"; // Importação direta do WS

// Imports locais
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// Cria o require para compatibilidade (Igual ao avisador_suap.js)
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Configuração
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

// ====== IMPORTAÇÃO DO BAILEYS (Igual ao seu bot que funciona) ======
const baileys = require("@whiskeysockets/baileys");

// Extrai as funções com segurança
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
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

// Função principal de criação do socket
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;

// ====== MEMÓRIA (STORE) ======
let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store.json');

if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
    try { 
        if (fs.existsSync(STORE_PATH)) {
            store.readFromFile(STORE_PATH);
        }
    } catch (err) {
        logger.warn("Iniciando store do zero.");
    }

    setInterval(() => {
        try { store.writeToFile(STORE_PATH); } catch {}
    }, 10_000);
} else {
    logger.warn("⚠️ Store nativa não encontrada. Usando fallback.");
    store = {
        contacts: {},
        bind: (ev) => {
            ev.on('contacts.upsert', (u) => { 
                for (const c of u) if (c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id] || {}, c);
            });
            ev.on('contacts.update', (u) => { 
                for (const c of u) if (c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); 
            });
        }
    };
}

// ====== FLUXO ======
const flow = createConversaFlow({ 
  dataDir: DATA_DIR, 
  dbUrl: process.env.DATABASE_URL, 
  logger 
});

// ====== ESTADO ======
let sock = null;
let waReady = false;
let startingWA = false;
let lastPongAt = Date.now();
let lastActivityAt = 0; 
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// Lock System
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
function toJid(to) {
  if (!to) return "";
  return (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;
}

async function sendWA(to, text) {
  // Proteção contra sock nulo ou desconectado
  if (!waReady || !sock) return null;
  try {
      const jid = toJid(to);
      const sent = await sock.sendMessage(jid, { text });
      lastActivityAt = Date.now();
      return sent?.key?.id;
  } catch (e) {
      logger.error({ err: String(e) }, "Erro ao enviar msg");
      return null;
  }
}

function cleanupSock() {
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
  waReady = false;
}

// ====== WATCHDOG ======
const PING_EVERY_MS = 300_000; 
const PONG_GRACE_MS = 600_000; 

function armWaWatchdog() {
  setInterval(async () => {
    const now = Date.now();
    // Só reinicia se estiver marcado como Ready e sem Pong há muito tempo
    if (waReady && (now - lastPongAt > PONG_GRACE_MS)) {
      logger.warn("Watchdog: Sem resposta do servidor. Reiniciando...");
      await safeStartWA(true);
    }
  }, PING_EVERY_MS);
}

async function safeStartWA(force = false) {
  if (startingWA) return;
  startingWA = true;
  try { 
      if(force) cleanupSock();
      await startWA(); 
  } finally { 
      startingWA = false; 
  }
}

// ====== START WA ======
async function startWA() {
  try {
      const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();
      const agent = await buildProxyAgent(PROXY_URL);

      logger.info(`Iniciando Socket WA v${version.join('.')}`);

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

      if (store && store.bind) store.bind(sock.ev);
      
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          globalThis.__lastQR = qr;
          qrcode.generate(qr, { small: true });
          logger.info("QR Code atualizado.");
        }
        if (connection === "open") {
          waReady = true;
          lastPongAt = Date.now();
          logger.info("✅ WhatsApp CONECTADO!");
        }
        if (connection === "close") {
          const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
          waReady = false;
          
          if (status === DisconnectReason.loggedOut) {
             logger.warn("Desconectado (Logout). Limpando sessão...");
             try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
             cleanupSock();
             setTimeout(() => startWA(), 3000);
          } else {
             logger.warn({ status }, "Conexão caiu. Reconectando...");
             cleanupSock();
             setTimeout(() => startWA(), 5000); 
          }
        }
      });

      sock.ws.on("pong", () => { lastPongAt = Date.now(); });

      // === MENSAGENS ===
      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify" || !messages?.length) return;

        for (const m of messages) {
            const msgId = m.key?.id;
            if (handledMessageIds.has(msgId)) continue;
            handledMessageIds.add(msgId);

            const fromMe = !!m.key?.fromMe;
            let jid = m.key?.remoteJid || "";

            // ====== LÓGICA DE TRADUÇÃO (SEM BLOQUEIO) ======
            if (jid.includes("@lid")) {
                let resolved = false;
                const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;

                // 1. Tenta se for o próprio dono (self)
                if (fromMe && sock.user?.id) {
                    const myJid = jidNormalizedUser ? jidNormalizedUser(sock.user.id) : sock.user.id;
                    if (!myJid.includes("@lid")) { jid = myJid; resolved = true; }
                }

                // 2. Tenta memória
                if (!resolved && store && store.contacts) {
                     // Busca direta
                     let c = store.contacts[lidKey];
                     if (c && c.id && !c.id.includes("@lid")) { 
                         jid = c.id; 
                         resolved = true; 
                     }
                     
                     // Busca profunda (Reverse Search)
                     if (!resolved) {
                        const all = Object.values(store.contacts);
                        const found = all.find(ct => ct.lid === lidKey);
                        if (found && found.id && !found.id.includes("@lid")) { 
                             jid = found.id; 
                             resolved = true; 
                             logger.info({ from: lidKey, to: jid }, "LID traduzido (Reverse Search)");
                        }
                     }
                }
                
                if (!resolved) {
                   logger.info({ jid }, "LID não traduzido. Usando ID original.");
                }
            }

            if (jidNormalizedUser) jid = jidNormalizedUser(jid);
            if (!jid || jid.endsWith("@status")) continue;

            // Se for mensagem do bot, ignora
            if (fromMe) continue;

            const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
            const text = content?.conversation || content?.extendedTextMessage?.text || "";

            if (!text) continue;

            try { await sock.readMessages([m.key]); } catch {}
            
            // === PROCESSA FLUXO ===
            let reply = "";
            try { 
                reply = await flow.handleText(jid, text); 
            } catch (e) { 
                logger.error(e, "Erro no fluxo"); 
            }
            
            // Envio seguro
            if (reply && sock && waReady) {
                await sock.sendMessage(jid, { text: reply });
                lastActivityAt = Date.now();
            }
        }
      });

  } catch (e) {
      logger.error(e, "Erro fatal no startWA");
      setTimeout(() => startWA(), 10000);
  } finally {
      startingWA = false;
  }
}

// ====== ROTAS ======
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

// ====== BOOT ======
(async () => {
  armWaWatchdog();
  await safeStartWA(true);
  app.listen(PORT, () => logger.info({ PORT }, "Servidor Online"));
})();

process.on("unhandledRejection", (e) => logger.error(e));
process.on("uncaughtException", (e) => logger.error(e));
