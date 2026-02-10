// ELE NAO DEVE RESPONDER GRUPOS. APENAS MENSAGENS

import express from "express";
import P from "pino";
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

try { fs.mkdirSync(WA_AUTH_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const logger = P({ level: "info" });
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
  isJidBroadcast,
  isJidNewsletter,
  jidNormalizedUser,
  extractMessageContent,
  makeCacheableSignalKeyStore
} = baileys;

// --- STORE (MEMÓRIA PURA) ---
// Removida a persistência em disco para evitar travamentos por memória cheia
let store;
try {
    store = makeInMemoryStore({ logger });
} catch (e) {}

const flow = createConversaFlow({ 
    dataDir: DATA_DIR, 
    dbUrl: process.env.DATABASE_URL, 
    logger 
});

let sock = null;
let waReady = false;
globalThis.__lastQR = "";
const handledMessageIds = new Set();
setInterval(() => handledMessageIds.clear(), 60_000);

// === START WA ===
async function startWA() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        
        let agent;
        if (PROXY_URL) {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            // [MODIFICADO] Configuração robusta para Proxy Residencial (DataImpulse)
            agent = new HttpsProxyAgent(PROXY_URL, {
                timeout: 60000,       // 60s de tolerância para o proxy responder
                keepAlive: true,      // Mantém o túnel aberto (reduz quedas)
                scheduling: 'lifo'    // Otimização de fila
            });
        }

        logger.info(`Iniciando WA v${version.join('.')} (Modo Leve)...`);

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "120.0.0"],
            agent, 
            fetchAgent: agent,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 15_000,
            defaultQueryTimeoutMs: 60_000,
            retryRequestDelayMs: 5000,
            // syncFullHistory: false, // Opcional: Descomente se quiser boot instantâneo sem histórico antigo
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
        });

        if (store) store.bind(sock.ev);

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                globalThis.__lastQR = qr;
                logger.info(">>> NOVO QR CODE DISPONÍVEL <<<");
            }

            if (connection === "open") {
                logger.info("✅ CONECTADO!");
                waReady = true;
                globalThis.__lastQR = "";
            }

            if (connection === "close") {
                waReady = false;
                const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
                
                // Lógica Teimosa: Só para se for Logout explícito
                if (status === DisconnectReason.loggedOut) {
                    logger.error("Logout detectado. Apagando sessão...");
                    try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
                    startWA(); 
                } else {
                    logger.info("Reconectando em 3s...");
                    setTimeout(startWA, 3000);
                }
            }
        });

        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;
            for (const m of messages) {
                try {
                    if (m.key.fromMe) continue;
                    const msgId = m.key.id;
                    if (handledMessageIds.has(msgId)) continue;
                    handledMessageIds.add(msgId);

                    let jid = m.key.remoteJid;

                    // --- ADICIONE ESTA LINHA AQUI ---
                    if (jid.endsWith("@g.us")) continue; // Ignora mensagens de grupo
                    // --------------------------------
                  
                    if (jid.includes("@lid") && store) {
                         const c = store.contacts[jid];
                         if (c?.id && !c.id.includes("@lid")) jid = c.id;
                    }
                    if (jidNormalizedUser) jid = jidNormalizedUser(jid);

                    const content = extractMessageContent(m.message);
                    const text = content?.conversation || content?.extendedTextMessage?.text || "";
                    if (!text) continue;

                    const reply = await flow.handleText(jid, text);
                    if (reply) await sock.sendMessage(jid, { text: reply });
                } catch (err) {
                    logger.error(`Erro msg: ${err}`);
                }
            }
        });

    } catch (err) {
        logger.error(`Erro fatal: ${err}`);
        setTimeout(startWA, 5000);
    }
}

// --- API ---
app.post("/send-message", async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) return res.status(400).json({ error: "Dados inválidos" });
        if (!waReady || !sock) return res.status(503).json({ error: "Bot offline" });

        const jid = number.includes("@") ? number : `${number.replace(/\D/g, "")}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});

app.get("/", (req, res) => res.send("ok"));
app.get("/qr", (req, res) => {
    if (!globalThis.__lastQR) return res.send("<h3>Conectado ou Aguardando...</h3>");
    res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: "${globalThis.__lastQR}", width: 300, height: 300 });</script>`);
});

app.listen(PORT, () => {
    logger.info(`Server na porta ${PORT}`);
    startWA();
});

process.on("uncaughtException", e => logger.error("Uncaught: " + e));
process.on("unhandledRejection", e => logger.error("Unhandled: " + e));
