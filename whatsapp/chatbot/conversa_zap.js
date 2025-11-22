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

// Logger otimizado
const logger = P({ 
    level: "info",
    transport: { target: 'pino-pretty', options: { colorize: true } }
});

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
  extractMessageContent,
  makeCacheableSignalKeyStore // Importante para estabilidade
} = baileys;

// --- STORE & CACHE ---
// Cache de tentativas de mensagem para evitar erros de "decryption failed"
const msgRetryCounterCache = new Map();

let store;
const STORE_PATH = path.join(DATA_DIR, 'baileys_store_zap.json');
try {
    store = makeInMemoryStore({ logger });
    if (fs.existsSync(STORE_PATH)) store.readFromFile(STORE_PATH);
    setInterval(() => { try { store.writeToFile(STORE_PATH); } catch {} }, 10_000);
} catch (e) { logger.warn("Store falhou ao iniciar."); }

// --- FLUXO ---
const flow = createConversaFlow({ 
    dataDir: DATA_DIR, 
    dbUrl: process.env.DATABASE_URL, 
    logger 
});

// --- ESTADO GLOBAL ---
let sock = null;
let startingWA = false;
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// --- FUNÇÕES DE SESSÃO ---
function nukeSession() {
    logger.error("!!! SESSÃO INVÁLIDA (LOGOUT). APAGANDO DADOS !!!");
    try {
        sock?.end?.();
        sock = null;
        fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
    } catch (e) { logger.error("Erro ao limpar sessão: " + e); }
}

// --- START WA ---
async function startWA() {
    if (startingWA) return;
    startingWA = true;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        
        let agent;
        if (PROXY_URL) {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            agent = new HttpsProxyAgent(PROXY_URL);
        }

        logger.info(`Iniciando WhatsApp v${version.join('.')} | Auth: ${WA_AUTH_DIR}`);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                // Cache de chaves para evitar corrupção em reinícios
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false, // Remove o aviso de depreciação
            // Identidade fixa para o WhatsApp não achar que é um navegador novo toda vez
            browser: ["IFSP Almoço", "Chrome", "120.0.0"], 
            agent, 
            fetchAgent: agent,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 30_000, // Pinga o servidor a cada 30s para não cair
            retryRequestDelayMs: 5000,
            msgRetryCounterCache, 
            generateHighQualityLinkPreview: false,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
        });

        if (store) store.bind(sock.ev);

        // --- EVENTOS ---
        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                globalThis.__lastQR = qr;
                logger.info(">>> NOVO QR CODE GERADO <<<");
                // Não loga o QR no terminal para não poluir, use a rota /qr ou o log do Northflank
            }

            if (connection === "open") {
                logger.info("✅ CONECTADO E ESTÁVEL!");
                globalThis.__lastQR = ""; // Limpa QR antigo
            }

            if (connection === "close") {
                const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const reason = lastDisconnect?.error?.output?.payload?.error || lastDisconnect?.error?.message;
                
                logger.warn(`Conexão caiu. Status: ${status} | Motivo: ${reason}`);

                // SÓ apaga a sessão se for LOGOUT explícito (401 ou Logged Out)
                if (status === DisconnectReason.loggedOut) {
                    nukeSession();
                    startingWA = false;
                    startWA(); // Reinicia para gerar novo QR
                } else {
                    // Para qualquer outro erro (408, 409, 500, Stream Error, Restart Required)
                    // APENAS RECONECTA. Não apaga nada.
                    logger.info("Reconectando automaticamente...");
                    startingWA = false;
                    // Pequeno delay para não floodar
                    setTimeout(startWA, status === 428 ? 5000 : 2000);
                }
            }
        });

        // --- MENSAGENS ---
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;

            for (const m of messages) {
                try {
                    if (m.key.fromMe) continue;
                    const msgId = m.key.id;
                    if (handledMessageIds.has(msgId)) continue;
                    handledMessageIds.add(msgId);

                    // Resolve JID (LID ou Phone)
                    let jid = m.key.remoteJid;
                    if (jid.includes("@lid") && store) {
                         const c = store.contacts[jid];
                         if (c?.id && !c.id.includes("@lid")) jid = c.id;
                    }
                    if (jidNormalizedUser) jid = jidNormalizedUser(jid);

                    const content = extractMessageContent(m.message);
                    const text = content?.conversation || content?.extendedTextMessage?.text || "";
                    
                    if (!text) continue;

                    logger.info(`Msg de ${jid}: ${text.slice(0, 20)}...`);
                    const reply = await flow.handleText(jid, text);

                    if (reply) {
                        await sock.sendMessage(jid, { text: reply });
                    }
                } catch (err) {
                    logger.error("Erro processando msg: " + err);
                }
            }
        });

    } catch (err) {
        logger.error("Erro fatal no startWA: " + err);
        startingWA = false;
        setTimeout(startWA, 5000);
    } finally {
        // Mantém flag true até cair, para evitar múltiplas instâncias
        if (!sock) startingWA = false; 
    }
}

// --- ROTAS ---
app.get("/", (req, res) => res.send({ status: sock?.ws?.isOpen ? "online" : "offline" }));
app.get("/qr", (req, res) => {
    if (!globalThis.__lastQR) return res.send("<h3>Bot Conectado! Sem QR Code pendente.</h3>");
    res.send(`
        <html>
            <head><meta refresh="5"></head>
            <body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
                <h2>Escaneie para Conectar</h2>
                <div id="qrcode"></div>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
                <script>new QRCode(document.getElementById('qrcode'), { text: "${globalThis.__lastQR}", width: 300, height: 300 });</script>
                <p>Atualiza a cada 5s...</p>
            </body>
        </html>
    `);
});

// Inicia
app.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
    startWA();
});

// Tratamento de erros para não crashar o container
process.on("uncaughtException", e => logger.error("Uncaught: " + e));
process.on("unhandledRejection", e => logger.error("Unhandled: " + e));
