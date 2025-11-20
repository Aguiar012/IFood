// whatsapp/chatbot/conversa_zap.js
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import https from "https";
import { createRequire } from "module";
import WebSocket from "ws";
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// --- 1. DEFINE REQUIRE DEPOIS DOS IMPORTS ---
const require = createRequire(import.meta.url);

// --- 2. CONFIGURAÇÃO ---
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

// --- 3. IMPORTAÇÃO DO BAILEYS ---
const baileysModule = require("@whiskeysockets/baileys");
const baileys = baileysModule.default || baileysModule;

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

// --- 4. MEMÓRIA (STORE) ---
let store;
// Tenta usar a memória nativa ou cria uma simples se falhar
if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
    try { store.readFromFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    setInterval(() => {
        try { store.writeToFile(path.join(DATA_DIR, 'baileys_store.json')); } catch {}
    }, 10_000);
} else {
    store = {
        contacts: {},
        bind: (ev) => {
            ev.on('contacts.upsert', (u) => { 
                for(const c of u) if(c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id]||{}, c); 
            });
            ev.on('contacts.update', (u) => { 
                for(const c of u) if(c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); 
            });
        }
    };
}

// --- 5. VARIAVEIS DE ESTADO ---
let sock = null;
let waReady = false;
let startingWA = false;
let lastPongAt = 0;
let lastActivityAt = 0; 
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

const flow = createConversaFlow({ dataDir: DATA_DIR, dbUrl: process.env.DATABASE_URL, logger });

// Lock File
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

// Função segura de envio (evita o crash 'null')
async function sendWA(to, text){
  if (!waReady || !sock) {
      // Se não estiver conectado, não tenta enviar para não crashar
      return null;
  }
  try {
      const jid = (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;
      const sent = await sock.sendMessage(jid, { text });
      lastActivityAt = Date.now();
      return sent?.key?.id;
  } catch (e) {
      logger.error({ err: String(e) }, "Erro ao enviar mensagem");
      return null;
  }
}

function cleanupSock() {
  try { sock?.end?.(); } catch {}
  try { sock?.ws?.close?.(); } catch {}
  sock = null;
  waReady = false;
}

// --- 6. WATCHDOG ---
const PING_EVERY_MS = 300_000; 
const PONG_GRACE_MS = 600_000; 
function armWaWatchdog() {
  setInterval(async () => {
    const now = Date.now();
    const noPong = now - lastPongAt > PONG_GRACE_MS; 
    const wsDead = !(sock?.ws) || (sock?.ws?.readyState !== 1);

    try { if (sock?.ws?.readyState === 1) { sock.ws.ping?.(); } } catch {}

    if (noPong || wsDead) {
      if (waReady) {
          logger.warn("Watchdog: Conexão perdida. Reiniciando...");
          await safeStartWA(true);
      }
    }
  }, PING_EVERY_MS);
}

async function safeStartWA(force = false) {
  if (startingWA) return;
  startingWA = true;
  try { cleanupSock(); await startWA(); } finally { startingWA = false; }
}

// --- 7. START WA ---
async function startWA() {
  try {
      const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();
      const agent = await buildProxyAgent(PROXY_URL);

      sock = baileys.makeWASocket({
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
          // Verifica se as funcoes existem antes de chamar (proteção extra)
          const isG = isJidGroup ? isJidGroup(j) : j.endsWith("@g.us");
          const isB = isJidBroadcast ? isJidBroadcast(j) : j.endsWith("@broadcast");
          const isN = isJidNewsletter ? isJidNewsletter(j) : j.endsWith("@newsletter");
          return isG || isB || isN;
        }
      });

      if (store && store.bind) store.bind(sock.ev);
      
      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr) {
          globalThis.__lastQR = qr;
          qrcode.generate(qr, { small: true });
          logger.info("QR Code gerado.");
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

            // --- TENTATIVA DE TRADUÇÃO WEB -> CELULAR ---
            if (jid.includes("@lid")) {
                let resolved = false;
                const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;

                // 1. Se for o próprio bot (você no Web), pega da conexão
                if (fromMe && sock.user?.id) {
                    const myJid = jidNormalizedUser ? jidNormalizedUser(sock.user.id) : sock.user.id;
                    if (!myJid.includes("@lid")) {
                        jid = myJid;
                        resolved = true;
                    }
                }

                // 2. Tenta a memória (Store)
                if (!resolved && store && store.contacts) {
                     let contact = store.contacts[lidKey];
                     if (contact && contact.id && !contact.id.includes("@lid")) {
                         jid = contact.id;
                         resolved = true;
                     }
                     // 3. Busca profunda
                     if (!resolved) {
                        const all = Object.values(store.contacts);
                        const found = all.find(c => c.lid === lidKey);
                        if (found && found.id && !found.id.includes("@lid")) {
                             jid = found.id;
                             resolved = true;
                        }
                     }
                }
                // SE NÃO RESOLVEU, SEGUE ASSIM MESMO (SEM BLOQUEIO)
                if (!resolved) {
                    logger.info({ jid }, "LID não traduzido. Usando ID original.");
                }
            }

            if (jidNormalizedUser) jid = jidNormalizedUser(jid);
            if (!jid || jid.endsWith("@status")) continue;

            // Ignora mensagens antigas ou de sistema
            if (m.messageStubType) continue;

            if (fromMe) continue; // Bot não fala sozinho

            const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
