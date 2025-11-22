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
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || paths.WA_AUTH_DIR;

// Garante pastas
try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: "info" }); // Nível simplificado para reduzir ruído
const app = express();
app.use(express.json());

// --- BAILEYS IMPORTS ---
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
} catch (e) { logger.warn("Store falhou ao iniciar, seguindo sem persistência de contatos."); }

// --- FLUXO ---
const flow = createConversaFlow({ 
    dataDir: DATA_DIR, 
    dbUrl: process.env.DATABASE_URL, 
    logger 
});

// --- ESTADO GLOBAL ---
let sock = null;
let startingWA = false;
let waReady = false;
let reconnectAttempts = 0;
globalThis.__lastQR = "";

// Lock para evitar duplicidade de mensagens
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// --- FUNÇÕES DE LIMPEZA ---
function nukeSession() {
    logger.error("!!! SESSÃO CORROMPIDA DETECTADA. APAGANDO DADOS DE AUTH !!!");
    try {
        sock?.end?.();
        sock = null;
        fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
        logger.info("Pasta de autenticação removida. Reiniciando para gerar novo QR...");
    } catch (e) {
        logger.error({ err: String(e) }, "Erro ao limpar sessão");
    }
}

function cleanupSock() {
    try { sock?.end?.(); } catch {}
    try { sock?.ws?.close?.(); } catch {}
    sock = null;
    waReady = false;
}

// --- START WA ---
async function startWA() {
    if (startingWA) return;
    startingWA = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        
        // Configura Proxy se existir
        let agent;
        if (PROXY_URL) {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            agent = new HttpsProxyAgent(PROXY_URL);
        }

        logger.info(`Iniciando Socket v${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            logger,
            printQRInTerminal: true, // Útil para ver no log do Northflank
            browser: ["Ubuntu", "Chrome", "22.0.0"], // Navegador fixo ajuda a manter sessão
            agent, 
            fetchAgent: agent,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 10_000,
            retryRequestDelayMs: 5000,
            syncFullHistory: false, // Desativar para evitar sobrecarga inicial e timeouts
            generateHighQualityLinkPreview: false,
            shouldIgnoreJid: jid => {
                 const j = String(jid);
                 return isJidBroadcast(j) || isJidNewsletter(j);
            }
        });

        if (store) store.bind(sock.ev);

        // --- EVENTOS DE CONEXÃO ---
        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                globalThis.__lastQR = qr;
                logger.info("Novo QR Code gerado. Escaneie agora.");
                reconnectAttempts = 0;
            }

            if (connection === "open") {
                waReady = true;
                reconnectAttempts = 0;
                logger.info("✅ CONECTADO E PRONTO!");
            }

            if (connection === "close") {
                waReady = false;
                const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const errMessage = String(lastDisconnect?.error || "");

                logger.warn({ status, errMessage }, "Conexão Fechada");

                // Lógica de Auto-Cura
                if (
                    status === DisconnectReason.loggedOut || 
                    errMessage.includes("SessionError") ||
                    errMessage.includes("MessageCounterError")
                ) {
                    nukeSession();
                    setTimeout(startWA, 3000); // Reinicia limpo
                } 
                else if (status === 409 || errMessage.includes("conflict")) {
                    logger.warn("Conflito detectado. Esperando 10s aleatórios para evitar briga...");
                    setTimeout(startWA, 10000 + Math.random() * 5000);
                } 
                else if (status === 428 || status === 408) {
                    logger.warn("Timeout de conexão. Tentando reconectar rápido...");
                    setTimeout(startWA, 2000);
                }
                else {
                    // Erro genérico, reconecta com backoff exponencial
                    const delay = Math.min(reconnectAttempts * 2000, 30000) + 2000;
                    reconnectAttempts++;
                    logger.info(`Reconectando em ${delay}ms...`);
                    setTimeout(startWA, delay);
                }
            }
        });

        // --- MENSAGENS ---
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;

            for (const m of messages) {
                try {
                    const msgId = m.key.id;
                    if (handledMessageIds.has(msgId)) continue;
                    handledMessageIds.add(msgId);

                    if (m.key.fromMe) continue;

                    // Tratamento de JID e Conteúdo
                    let jid = m.key.remoteJid;
                    // Normaliza LID para JID de telefone se possível
                    if (jid.includes("@lid") && store) {
                         const contact = store.contacts[jid] || {};
                         if (contact.id && !contact.id.includes("@lid")) jid = contact.id;
                    }
                    
                    const content = extractMessageContent(m.message);
                    const text = content?.conversation || content?.extendedTextMessage?.text || "";
                    
                    if (!text) continue;

                    logger.info({ from: jid }, "Processando mensagem");
                    const reply = await flow.handleText(jid, text);

                    if (reply) {
                        await sock.sendMessage(jid, { text: reply });
                    }
                } catch (err) {
                    // Se der erro de criptografia aqui, pode ser sinal de sessão podre
                    if (String(err).includes("SessionError")) {
                        logger.error("Erro de Sessão ao processar mensagem. Nuking...");
                        sock.ws.close(); // Força close para cair no handler de limpeza
                    } else {
                        logger.error({ err: String(err) }, "Erro ao processar msg");
                    }
                }
            }
        });

    } catch (err) {
        logger.error(err, "Erro fatal no startWA");
        setTimeout(startWA, 5000);
    } finally {
        startingWA = false;
    }
}

// --- SERVIDOR EXPRESS (MANTÉM O CONTAINER VIVO) ---
app.get("/", (req, res) => res.send({ status: waReady ? "online" : "offline" }));
app.get("/qr", (req, res) => {
    if (!globalThis.__lastQR) return res.send("Aguarde QR...");
    res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: "${globalThis.__lastQR}", width: 300, height: 300 });</script>`);
});

app.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
    startWA();
});

// --- TRATAMENTO DE ERROS GLOBAIS ---
process.on("uncaughtException", (err) => {
    logger.error(err, "Uncaught Exception");
    // Não sai do processo, tenta manter vivo
});
process.on("unhandledRejection", (err) => {
    logger.error(err, "Unhandled Rejection");
});
