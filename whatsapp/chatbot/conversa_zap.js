// whatsapp/chatbot/conversa_zap.js
import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import * as BaileysNamespace from "@whiskeysockets/baileys"; // Importação limpa
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// === 1. CONFIGURAÇÃO ===
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

// === 2. BAILEYS HELPER (Resolve imports) ===
const getExport = (key) => {
    // Tenta pegar direto ou do default
    return BaileysNamespace[key] || (BaileysNamespace.default ? BaileysNamespace.default[key] : undefined);
};

const useMultiFileAuthState = getExport("useMultiFileAuthState");
const fetchLatestBaileysVersion = getExport("fetchLatestBaileysVersion");
const makeInMemoryStore = getExport("makeInMemoryStore");
const DisconnectReason = getExport("DisconnectReason");
const Browsers = getExport("Browsers");
const isJidGroup = getExport("isJidGroup");
const isJidBroadcast = getExport("isJidBroadcast");
const isJidNewsletter = getExport("isJidNewsletter");
const jidNormalizedUser = getExport("jidNormalizedUser");
const getContentType = getExport("getContentType");
const makeWASocket = BaileysNamespace.default || BaileysNamespace.makeWASocket || BaileysNamespace;

if (!useMultiFileAuthState || !makeWASocket) {
    throw new Error("CRITICO: Funcoes do Baileys nao encontradas via import.");
}

// === 3. MEMÓRIA (STORE) ===
let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store.json');

// Fallback simples de store
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
        try { if(fs.existsSync(p)) store.contacts = JSON.parse(fs.readFileSync(p)).contacts; } catch(e) {}
    },
    writeToFile: (p) => {
        try { fs.writeFileSync(p, JSON.stringify({contacts: store.contacts})); } catch {}
    }
});

if (typeof makeInMemoryStore === 'function') {
    store = makeInMemoryStore({ logger });
} else {
    logger.warn("Usando store manual.");
    store = createManualStore();
}

// Carrega e salva memória
try { store.readFromFile(STORE_PATH); } catch {}
setInterval(() => { try { store.writeToFile(STORE_PATH); } catch {} }, 10_000);

// === 4. FLUXO ===
const flow = createConversaFlow({ dataDir: DATA_DIR, dbUrl: process.env.DATABASE_URL, logger });

// === 5. ESTADO ===
let sock = null;
let waReady = false;
let startingWA = false;
let lastPongAt = Date.now();
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// Proxy
let __proxyAgent;
async function getProxyAgent() {
    if (!PROXY_URL) return undefined;
    if (__proxyAgent) return __proxyAgent;
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    __proxyAgent = new HttpsProxyAgent(PROXY_URL);
    return __proxyAgent;
}

// Utils
const toJid = (to) => (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) ? to : `${to.replace(/\D/g,"")}@s.whatsapp.net`;

async function sendWA(to, text){
    if (!waReady || !sock) throw new Error("WhatsApp desconectado");
    const sent = await sock.sendMessage(toJid(to), { text });
    return sent?.key?.id;
}

function cleanupSock() {
    try { sock?.end?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    sock = null;
    waReady = false;
}

// === 6. WATCHDOG ===
setInterval(async () => {
    const now = Date.now();
    // Reinicia se ficar 10 min sem pong E estiver marcado como ready
    if (waReady && (now - lastPongAt > 600_000)) {
        logger.warn("Watchdog: Sem pong. Reiniciando...");
        await startWA(true);
    }
}, 60_000);

// === 7. START WA ===
async function startWA(force = false) {
    if (startingWA) return;
    startingWA = true;
    try {
        if (force) cleanupSock();
        
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const agent = await getProxyAgent();

        logger.info(`Iniciando WA v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            logger,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            agent, fetchAgent: agent,
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
                logger.info("QR Code gerado.");
            }
            if (connection === "open") {
                waReady = true;
                lastPongAt = Date.now();
                logger.info("✅ Conectado!");
            }
            if (connection === "close") {
                const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
                waReady = false;
                if (status === DisconnectReason?.loggedOut) {
                    try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
                    cleanupSock();
                    setTimeout(() => startWA(true), 2000);
                } else {
                    cleanupSock();
                    setTimeout(() => startWA(true), 3000);
                }
            }
        });

        sock.ws.on("pong", () => { lastPongAt = Date.now(); });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;

            for (const m of messages) {
                const msgId = m.key?.id;
                if (!msgId || handledMessageIds.has(msgId)) continue;
                handledMessageIds.add(msgId);

                const fromMe = !!m.key?.fromMe;
                let jid = m.key?.remoteJid || "";

                // 1. Tenta traduzir LID -> Celular (Sem bloquear)
                if (jid.includes("@lid")) {
                    let resolved = false;
                    // A: Dono
                    if (fromMe && sock.user?.id) {
                        const myJid = jidNormalizedUser ? jidNormalizedUser(sock.user.id) : sock.user.id;
                        if (!myJid.includes("@lid")) { jid = myJid; resolved = true; }
                    }
                    // B: Memoria
                    if (!resolved && store && store.contacts) {
                        const lidKey = jidNormalizedUser ? jidNormalizedUser(jid) : jid;
                        let c = store.contacts[lidKey];
                        // Busca direta
                        if (c && c.id && !c.id.includes("@lid")) { jid = c.id; resolved = true; }
                        // Busca reversa
                        if (!resolved) {
                            const all = Object.values(store.contacts);
                            const found = all.find(ct => ct.lid === lidKey);
                            if (found && found.id && !found.id.includes("@lid")) { jid = found.id; resolved = true; }
                        }
                    }
                    if (!resolved) logger.info({ jid }, "LID usado (não traduzido).");
                }

                if (jidNormalizedUser) jid = jidNormalizedUser(jid);
                if (!jid || jid.endsWith("@status")) continue;

                const ct = getContentType ? getContentType(m.message) : Object.keys(m.message)[0];
                logger.info({ jid, ct }, "Msg RX");

                if (fromMe) continue;

                const content = m.message; // Baileys novo simplifica
                // Extrai texto de várias formas possíveis
                const text = content?.conversation || 
                             content?.extendedTextMessage?.text || 
                             content?.imageMessage?.caption || 
                             "";

                if (!text) continue;

                try { await sock.readMessages([m.key]); } catch {}
                
                let reply = "";
                try { reply = await flow.handleText(jid, text); } 
                catch (e) { logger.error(e, "Erro fluxo"); }
                
                if (reply && waReady) {
                    await sock.sendMessage(jid, { text: reply });
                }
            }
        });

    } catch (e) {
        logger.error(e, "Erro startWA");
        setTimeout(() => startWA(true), 10000);
    } finally {
        startingWA = false;
    }
}

// === 8. ROTAS ===
app.get("/", (req, res) => res.send("ok"));
app.get("/qr", (req, res) => {
    const qr = globalThis.__lastQR;
    if (!qr) return res.send("Aguarde...");
    res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 300, height: 300 });</script>`);
});

// === 9. BOOT ===
(async () => {
    await startWA();
    app.listen(PORT, () => logger.info({ PORT }, "Server Up"));
})();

process.on("unhandledRejection", (e) => logger.error(e));
process.on("uncaughtException", (e) => logger.error(e));
// FIM DO ARQUIVO
