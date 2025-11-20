// whatsapp/chatbot/conversa_zap.js
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

// Configuração de imports compatíveis
const require = createRequire(import.meta.url);

// Imports locais
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// --- CONFIGURAÇÃO ---
const PORT = Number(process.env.PORT) || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);
const PROXY_URL = process.env.PROXY_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = paths.WA_AUTH_DIR;

try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

// --- BAILEYS ---
const baileys = require("@whiskeysockets/baileys");

// Tenta pegar o construtor do socket
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;

// Extrai funções
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  DisconnectReason,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  jidNormalizedUser,
  getContentType,
  extractMessageContent,
  Browsers
} = baileys;

// --- STORE (Memória) ---
let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store_zap.json');

if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
    try {
        if (fs.existsSync(STORE_PATH)) {
            store.readFromFile(STORE_PATH);
        }
    } catch(e) { logger.warn("Store iniciada limpa."); }

    setInterval(() => {
        try { store.writeToFile(STORE_PATH); } catch {}
    }, 10_000);
} else {
    // Fallback seguro
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

// --- FLUXO ---
const flow = createConversaFlow({ 
    dataDir: DATA_DIR, 
    dbUrl: process.env.DATABASE_URL, 
    logger 
});

// --- ESTADO ---
let sock = null;
let waReady = false;
let startingWA = false;
let lastPongAt = Date.now();
let lastActivityAt = 0;
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// --- PROXY ---
let __proxyAgent;
async function getProxyAgent() {
    if (!PROXY_URL) return undefined;
    if (__proxyAgent) return __proxyAgent;
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    __proxyAgent = new HttpsProxyAgent(PROXY_URL);
    return __proxyAgent;
}

// --- UTILS ---
const toJid = (to) => (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;

async function sendWA(to, text){
    if (!waReady || !sock) return null;
    try {
        const jid = toJid(to);
        const sent = await sock.sendMessage(jid, { text });
        lastActivityAt = Date.now();
        return sent?.key?.id;
    } catch (e) {
        logger.error({ err: String(e) }, "Erro envio");
        return null;
    }
}

function cleanupSock() {
    try { sock?.end?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    sock = null;
    waReady = false;
}

// --- WATCHDOG ---
const PONG_GRACE_MS = 600_000; // 10 min sem resposta = reiniciar
const PING_EVERY_MS = 300_000; // Checa a cada 5 min

setInterval(async () => {
    const now = Date.now();
    if (waReady && (now - lastPongAt > PONG_GRACE_MS)) {
        logger.warn("Watchdog: Sem resposta. Reiniciando...");
        await safeStartWA(true);
    }
}, PING_EVERY_MS);

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

// --- START WA ---
async function startWA() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const agent = await getProxyAgent();

        logger.info(`Iniciando Socket v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            logger,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            agent, fetchAgent: agent,
            markOnlineOnConnect: true,
            syncFullHistory: true, // Baixa contatos para a memória
            connectTimeoutMs: 60_000,
            printQRInTerminal: false,
            shouldIgnoreJid: jid => {
                const j = String(jid);
                return (isJidGroup && isJidGroup(j)) || 
                       (isJidBroadcast && isJidBroadcast(j)) || 
                       (isJidNewsletter && isJidNewsletter(j));
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
                logger.info("✅ CONECTADO!");
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

        // --- MENSAGENS ---
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;

            for (const m of messages) {
                const msgId = m.key?.id;
                if (!msgId || handledMessageIds.has(msgId)) continue;
                handledMessageIds.add(msgId);

                const fromMe = !!m.key?.fromMe;
                let jid = m.key?.remoteJid || "";

                // === TENTATIVA DE TRADUÇÃO (Web -> Celular) ===
                // Sem bloquear: Se achar, troca. Se não, usa o original.
                if (jid.includes("@lid")) {
                    let resolved = false;
                    const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;

                    // 1. Se for o próprio bot
                    if (fromMe && sock.user?.id) {
                        const myJid = jidNormalizedUser ? jidNormalizedUser(sock.user.id) : sock.user.id;
                        if (!myJid.includes("@lid")) { jid = myJid; resolved = true; }
                    }

                    // 2. Busca na memória (Store)
                    if (!resolved && store && store.contacts) {
                        let c = store.contacts[lidKey];
                        if (c && c.id && !c.id.includes("@lid")) { 
                            jid = c.id; 
                            resolved = true; 
                        }
                        // Busca profunda
                        if (!resolved) {
                             const all = Object.values(store.contacts);
                             const found = all.find(ct => ct.lid === lidKey);
                             if (found && found.id && !found.id.includes("@lid")) {
                                 jid = found.id;
                                 resolved = true;
                             }
                        }
                    }
                }

                if (jidNormalizedUser) jid = jidNormalizedUser(jid);
                if (!jid || jid.endsWith("@status")) continue;

                const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
                logger.info({ jid, ct }, "Msg RX");

                if (fromMe) continue;

                const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
                const text = content?.conversation || content?.extendedTextMessage?.text || "";

                if (!text) continue;

                try { await sock.readMessages([m.key]); } catch {}
                
                // === FLUXO ===
                let reply = "";
                try { 
                    reply = await flow.handleText(jid, text); 
                } catch (e) { 
                    logger.error(e, "Erro no fluxo"); 
                }
                
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
    if (!qr) return res.send("Aguarde...");
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
