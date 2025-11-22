import express from "express";
import P from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import paths from "../paths.js";
import { createConversaFlow } from "./conversa_flow.js";

// --- CONFIGURAÇÃO ---
const PORT = Number(process.env.PORT) || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);
const PROXY_URL = process.env.PROXY_URL || "";
const DATA_DIR = process.env.DATA_DIR || "/app/data";
// Garante que usa a pasta certa
const WA_AUTH_DIR = path.join(DATA_DIR, "wa_auth_zapbot");

// Garante criação das pastas
try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

// --- BAILEYS ---
const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
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
  extractMessageContent
} = baileys;

// --- STORE ---
let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store_zap.json');
try {
    store = makeInMemoryStore({ logger });
    if (fs.existsSync(STORE_PATH)) store.readFromFile(STORE_PATH);
    setInterval(() => { try { store.writeToFile(STORE_PATH); } catch {} }, 10_000);
} catch(e) { 
    logger.warn("Store iniciada em modo fallback (sem persistência)."); 
}

// --- FLUXO ---
const flow = createConversaFlow({ 
    dataDir: DATA_DIR, 
    dbUrl: process.env.DATABASE_URL, 
    logger 
});

// --- ESTADO GLOBAL ---
let sock = null;
let waReady = false;
let startingWA = false;
let lastPongAt = Date.now();
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

// --- FUNÇÃO DE AUTO-CURA (HARD RESET) ---
function hardResetAuth() {
    logger.error("!!! DETECTADA CORRUPÇÃO DE SESSÃO OU LOGOUT !!!");
    logger.error("Iniciando AUTO-CURA: Apagando pasta de autenticação e reiniciando...");
    
    try {
        // Fecha conexões
        if (sock) {
            sock.end(undefined);
            sock = null;
        }
        // Apaga a pasta corrupta
        fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
        logger.info("Pasta de autenticação apagada com sucesso.");
    } catch (err) {
        logger.error({ err }, "Erro ao tentar apagar pasta de autenticação.");
    }

    // Mata o processo para o PM2 reiniciar limpo
    logger.info("Encerrando processo para reinício limpo...");
    process.exit(1); 
}

// --- LIMPEZA DE SOCKET ---
function cleanupSock() {
    try { sock?.end?.(undefined); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    try { sock?.ev?.removeAllListeners?.(); } catch {}
    sock = null;
    waReady = false;
}

async function startWA() {
    if (startingWA) return;
    startingWA = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const agent = await getProxyAgent();

        logger.info(`Iniciando Socket v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            logger,
            browser: ["Ubuntu", "Chrome", "22.0.0"], // Browser fixo ajuda na estabilidade
            agent, fetchAgent: agent,
            markOnlineOnConnect: true,
            syncFullHistory: false, // Desligado para evitar sobrecarga inicial
            connectTimeoutMs: 60_000,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
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
                logger.info("NOVO QR CODE GERADO - Escaneie para conectar.");
            }

            if (connection === "open") {
                waReady = true;
                lastPongAt = Date.now();
                logger.info("✅ CONECTADO COM SUCESSO!");
            }

            if (connection === "close") {
                const error = lastDisconnect?.error;
                const statusCode = new Boom(error)?.output?.statusCode;
                
                waReady = false;
                logger.warn({ statusCode, error: error?.message }, "Conexão fechada");

                // --- DETECÇÃO DE SESSÃO MORTA ---
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isSessionError = String(error?.message).includes("SessionError") || 
                                       String(error?.message).includes("MessageCounterError") ||
                                       String(error?.stack).includes("Crypto");

                if (isLoggedOut || isSessionError) {
                    hardResetAuth(); // CHAMA A AUTO-CURA
                } else if (statusCode === 409) { // Conflito
                    logger.warn("Conflito detectado. Aguardando 10s antes de tentar reconectar...");
                    cleanupSock();
                    setTimeout(startWA, 10000);
                } else {
                    // Reconexão padrão
                    cleanupSock();
                    setTimeout(startWA, 5000);
                }
            }
        });

        sock.ws.on("pong", () => { lastPongAt = Date.now(); });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;
            for (const m of messages) {
                const msgId = m.key?.id;
                if (handledMessageIds.has(msgId)) continue;
                handledMessageIds.add(msgId);

                if (m.key?.fromMe) continue;
                
                // Tratamento simplificado de JID para evitar erros
                const jid = m.key?.remoteJid;
                if (!jid || jid.includes("status")) continue;

                const content = extractMessageContent ? extractMessageContent(m.message) : m.message;
                const text = content?.conversation || content?.extendedTextMessage?.text || "";
                if (!text) continue;

                // Marca como lida para evitar acumular
                try { await sock.readMessages([m.key]); } catch {}

                try {
                    const reply = await flow.handleText(jid, text);
                    if (reply && waReady && sock) {
                        await sock.sendMessage(jid, { text: reply });
                    }
                } catch (e) {
                    logger.error(e, "Erro no fluxo de conversa");
                }
            }
        });

    } catch (e) {
        logger.error(e, "Erro fatal ao iniciar WA");
        // Se der erro fatal na inicialização (ex: corrupto), reseta tbm
        if(String(e).includes("Corrupt") || String(e).includes("Unexpected end")) {
            hardResetAuth();
        } else {
            setTimeout(() => { startingWA = false; startWA(); }, 5000);
        }
    } finally {
        startingWA = false;
    }
}

// --- SERVER ---
app.get("/", (req, res) => res.send("Bot Online"));
app.get("/qr", (req, res) => {
    if (!globalThis.__lastQR) return res.send("Aguarde o QR Code...");
    res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(globalThis.__lastQR)}, width: 300, height: 300 });</script>`);
});

const server = app.listen(PORT, () => {
    logger.info({ PORT }, "Servidor HTTP rodando.");
    startWA();
});

// --- GRACEFUL SHUTDOWN ---
async function shutdown() {
    logger.info("Desligando...");
    cleanupSock();
    server.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
