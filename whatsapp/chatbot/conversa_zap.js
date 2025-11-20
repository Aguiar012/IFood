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

// Garante pastas
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

// ====== 3. MEMÓRIA PERSISTENTE (STORE) ======
// Essa lógica garante que, mesmo se der erro na lib, nós salvamos no disco.
let store;

if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
} else {
    logger.warn("⚠️ Usando memória manual com persistência em disco.");
    store = {
        contacts: {},
        bind: (ev) => {
            ev.on('contacts.upsert', (u) => { 
                for(const c of u) if(c.id) store.contacts[c.id] = Object.assign(store.contacts[c.id]||{}, c); 
            });
            ev.on('contacts.update', (u) => { 
                for(const c of u) if(c.id && store.contacts[c.id]) Object.assign(store.contacts[c.id], c); 
            });
        },
        // Implementação manual de salvar/ler arquivo
        readFromFile: (fpath) => {
            try {
                if (fs.existsSync(fpath)) {
                    const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
                    if (data.contacts) store.contacts = data.contacts;
                    logger.info(`Memória carregada de ${fpath}`);
                }
            } catch(e) { logger.error({ err: String(e) }, "Erro ao ler store manual"); }
        },
        writeToFile: (fpath) => {
            try {
                fs.writeFileSync(fpath, JSON.stringify({ contacts: store.contacts }));
            } catch(e) { logger.error({ err: String(e) }, "Erro ao salvar store manual"); }
        }
    };
}

// Tenta carregar dados antigos (para lembrar quem é você após restart)
try { 
    store.readFromFile(path.join(DATA_DIR, 'baileys_store.json')); 
} catch (e) {
    logger.info("Iniciando memória do zero.");
}

// Salva a cada 10 segundos para garantir persistência
setInterval(() => {
    try { 
        store.writeToFile(path.join(DATA_DIR, 'baileys_store.json')); 
    } catch {}
}, 10_000);


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

// ====== 6. WATCHDOG (Monitoramento) ======
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
      logger.warn({ waReady, wsReady: sock?.ws?.readyState }, "Watchdog: reiniciando conexão...");
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
    // Forçar navegador Desktop para evitar instabilidades
    browser: Browsers ? Browsers.macOS("Chrome") : ["Mac OS", "Chrome", "10.0"],
    agent,             
    fetchAgent: agent, 
    markOnlineOnConnect: false,
    // Ativa sync completo para mapear WEB <-> Celular
    syncFullHistory: true, 
    // Aumenta timeouts para evitar quedas em conexões lentas (Erro Timed Out)
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 90_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 5000,
    printQRInTerminal: false,
    shouldIgnoreJid: jid => {
      const j = String(jid);
      const isG = isJidGroup ? isJidGroup(j) : j.endsWith("@g.us");
      const isB = isJidBroadcast ? isJidBroadcast(j) : j.endsWith("@broadcast");
      const isN = isJidNewsletter ? isJidNewsletter(j) : j.endsWith("@newsletter");
      const isS = isJidStatusBroadcast ? isJidStatusBroadcast(j) : j === "status@broadcast";
      return isG || isB || isS || isN;
    }
  });

  // Liga a memória (para traduzir Web -> Celular)
  store.bind(sock.ev);
  
  lastPongAt = Date.now();
  lastActivityAt = Date.now();

  try { sock.ws?.on?.("pong", () => { lastPongAt = Date.now(); }); } catch {}
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
      // Reseta contador de erro ao conectar com sucesso
      err428Count = 0; 
      logger.info("WhatsApp CONECTADO e pronto!");
    }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      
      // 428 = Precondition Required (Sessão inválida/corrompida)
      // 401 = Logged Out
      if (status === DisconnectReason?.loggedOut || status === 428) {
        logger.warn({ status }, "Sessão inválida ou Logout. Limpando auth para novo QR.");
        try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
        setTimeout(() => safeStartWA(true), 2000);
      } else {
        // Erros temporários (Timeouts, Internet) -> Reconecta rápido
        logger.warn({ status }, "Desconectado temporariamente. Reconectando...");
        setTimeout(() => safeStartWA(true), 3000);
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

        // ====== TRADUÇÃO AUTOMÁTICA (WEB -> CELULAR) ======
        if (jid.includes("@lid")) {
            let resolved = false;
            
            if (store && store.contacts) {
                 // Tenta achar pelo LID direto ou normalizado
                 const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;
                 const contact = store.contacts[lidKey] || store.contacts[jid];
                 
                 if (contact && contact.id && !contact.id.includes("@lid")) {
                     jid = contact.id; 
                     resolved = true;
                     logger.info({ lid: lidKey, real: jid }, "ID Web traduzido para Celular com sucesso.");
                 }
            }

            if (!resolved) {
                if (!fromMe) {
                    logger.warn({ jid }, "LID não identificado na memória. Solicitando sync.");
                    await sock.sendMessage(jid, { text: "🔄 *Sincronização Necessária*\n\nO sistema identificou seu acesso via WhatsApp Web, mas ainda não baixou seus dados de contato.\n\nPor favor, envie um *'Oi'* pelo seu **CELULAR** agora.\n\nIsso vai corrigir seu cadastro permanentemente." });
                }
                continue; // Impede salvar erro no banco
            }
        }

        if (jidNormalizedUser) jid = jidNormalizedUser(jid);
        
        if (!jid || jid.endsWith("@status")) continue;

        const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
        logger.info({ jid, ct }, "Mensagem processada");

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
