// ELE NAO DEVE RESPONDER GRUPOS. APENAS MENSAGENS DIRETAS
// VERSÃO COM MELHORIAS DE ESTABILIDADE

import "dotenv/config"; // Carrega variáveis do .env automaticamente
import express from "express";
import P from "pino";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
import caminhos from "../configuracao_pastas.js";
import { criarFluxoConversa } from "./logica_respostas.js";

// --- CONFIGURAÇÃO ---
const PORTA = Number(process.env.PORT) || 3001;
const URL_PROXY = process.env.PROXY_URL || "";
// Caminho absoluto para garantir que a pasta não se perca
const DIRETORIO_DADOS = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("./dados_bot");
const DIRETORIO_AUTH = process.env.WA_AUTH_DIR ? path.resolve(process.env.WA_AUTH_DIR) : path.join(DIRETORIO_DADOS, "auth");

// Garante que os diretórios existem
try { fs.mkdirSync(DIRETORIO_AUTH, { recursive: true }); } catch { }
try { fs.mkdirSync(DIRETORIO_DADOS, { recursive: true }); } catch { }

const logger = P({
    level: "info",
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});
const app = express();
app.use(express.json());

// --- BAILEYS (Biblioteca do WhatsApp) ---
const baileys = require("@whiskeysockets/baileys");
// Importa qrcode-terminal para exibir no console
const qrcodeTerminal = require("qrcode-terminal");

const criarSocketWhatsApp = baileys.default || baileys.makeWASocket || baileys;
const {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    isJidBroadcast,
    isJidNewsletter,
    jidNormalizedUser,
    extractMessageContent,
    makeCacheableSignalKeyStore
} = baileys;

// --- MEMÓRIA (STORE) ---
// NOTA: makeInMemoryStore desabilitado — ele acumula RAM sem limite e causa OOM em containers.
// Dados importantes (alunos, pedidos, bloqueios) ficam no Postgres, não são afetados.
let memoria_whatsapp = null;

const fluxo = criarFluxoConversa({
    diretorioDados: DIRETORIO_DADOS,
    urlBanco: process.env.DATABASE_URL,
    logger,
    chaveGemini: process.env.GEMINI_API_KEY || ""
});

let socket = null;
let whatsappPronto = false;
globalThis.__ultimoQR = "";
const mensagensProcessadas = new Set();



// Limpa cache de mensagens processadas a cada 60 segundos (com limite de segurança)
setInterval(() => {
    if (mensagensProcessadas.size > 0) {
        logger.info(`[CACHE] Limpando ${mensagensProcessadas.size} IDs de mensagens do cache`);
        mensagensProcessadas.clear();
    }
}, 60_000);

// --- CONTADORES DE ESTABILIDADE ---
let tentativasReconexao = 0;
const MAX_TENTATIVAS_RAPIDAS = 5;
let ultimaConexaoBemSucedida = null;
let intervaloHeartbeat = null;
let intervaloWatchdog = null;
let ultimaAtividade = Date.now(); // Rastreia última atividade real (msg enviada/recebida)
let jaTeveConexao = false; // Indica se já conectou pelo menos 1 vez nesta sessão
const inicioProcesso = Date.now(); // Para grace period do health check

// Atualiza timestamp de atividade
function registrarAtividade() { ultimaAtividade = Date.now(); }

// === INICIAR WHATSAPP ===
async function iniciarWhatsApp() {
    try {
        // Limpeza de socket antigo para não vazar memória
        if (intervaloHeartbeat) {
            clearInterval(intervaloHeartbeat);
            intervaloHeartbeat = null;
        }
        if (intervaloWatchdog) {
            clearInterval(intervaloWatchdog);
            intervaloWatchdog = null;
        }
        if (socket) {
            const socketAntigo = socket;
            socket = null;
            whatsappPronto = false;
            try { socketAntigo.ev.removeAllListeners(); } catch (e) { logger.warn(`[CLEANUP] Erro ao remover listeners: ${e}`); }
            try { socketAntigo.end(undefined); } catch (e) { logger.warn(`[CLEANUP] Erro ao fechar socket: ${e}`); }
        }

        logger.info(`[AUTH] Salvando credenciais em: ${DIRETORIO_AUTH}`);
        const { state, saveCreds } = await useMultiFileAuthState(DIRETORIO_AUTH);
        const { version } = await fetchLatestBaileysVersion();

        let agenteProxy;
        if (URL_PROXY) {
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            agenteProxy = new HttpsProxyAgent(URL_PROXY, {
                timeout: 60000,
                keepAlive: true,
                scheduling: 'lifo'
            });
        }

        logger.info(`🚀 Iniciando WhatsApp v${version.join('.')} ...`);

        socket = criarSocketWhatsApp({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger: P({ level: "silent" }), // Silencia logs internos do Baileys
            printQRInTerminal: false, // DESATIVADO (Deprecated) - Usaremos qrcode-terminal
            browser: ["IF Food Bot", "Chrome", "1.0.0"],
            agent: agenteProxy,
            fetchAgent: agenteProxy,

            // --- CONFIGURAÇÕES DE ESTABILIDADE ---
            connectTimeoutMs: 120_000,        // 2 minutos para conectar (aumentado)
            keepAliveIntervalMs: 25_000,      // Ping a cada 25s (mais frequente)
            defaultQueryTimeoutMs: 90_000,    // 1.5 minuto para queries
            retryRequestDelayMs: 3000,        // 3s entre tentativas
            qrTimeout: 60_000,                // 60s para escanear QR
            emitOwnEvents: true,              // Emite eventos próprios
            markOnlineOnConnect: true,        // Marca como online ao conectar

            syncFullHistory: false,
            generateHighQualityLinkPreview: false, // Desativa para economizar recursos
            shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
        });

        if (memoria_whatsapp) memoria_whatsapp.bind(socket.ev);

        socket.ev.on("creds.update", async () => {
            try {
                await saveCreds();
                // Verifica se realmente salvou
                const arquivos = fs.readdirSync(DIRETORIO_AUTH);
                logger.info(`[AUTH] Credenciais salvas. Arquivos na pasta: ${arquivos.length}`);
            } catch (erro) {
                logger.error(`[AUTH] FALHA ao salvar credenciais: ${erro}`);
            }
        });

        socket.ev.on("connection.update", async (atualizacao) => {
            const { connection, lastDisconnect, qr } = atualizacao;

            if (qr) {
                globalThis.__ultimoQR = qr;

                // Se já teve conexão antes, QR inesperado = credenciais corrompidas
                if (jaTeveConexao) {
                    logger.error("[QR] QR CODE INESPERADO! Sessao anterior perdida. Limpando auth e reconectando...");
                    try { fs.rmSync(DIRETORIO_AUTH, { recursive: true, force: true }); } catch { }
                    try { fs.mkdirSync(DIRETORIO_AUTH, { recursive: true }); } catch { }
                    jaTeveConexao = false; // Permite o próximo QR ser exibido normalmente
                    tentativasReconexao = 0;
                    setTimeout(iniciarWhatsApp, 2000);
                    return;
                }

                logger.info("[QR] ESCANEIE O QR CODE LOGO ABAIXO:");
                // Exibe QR Code pequeno no terminal
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === "open") {
                logger.info("[OK] CONECTADO AO WHATSAPP!");
                whatsappPronto = true;
                globalThis.__ultimoQR = "";
                tentativasReconexao = 0; // Reseta contador
                ultimaConexaoBemSucedida = new Date();
                jaTeveConexao = true;
                registrarAtividade();

                // Heartbeat: envia sinal de vida a cada 5 min para evitar erro 428 (Precondition Required)
                // Limpa heartbeat anterior para evitar múltiplos intervalos acumulados
                if (intervaloHeartbeat) {
                    clearInterval(intervaloHeartbeat);
                    intervaloHeartbeat = null;
                }
                intervaloHeartbeat = setInterval(() => {
                    if (socket && whatsappPronto) {
                        socket.sendPresenceUpdate('available').catch((e) => {
                            logger.warn(`[HEARTBEAT] Falha ao enviar presença: ${e.message || e}`);
                        });
                        registrarAtividade(); // Heartbeat bem-sucedido conta como atividade
                    }
                }, 300_000);

                // --- WATCHDOG: Detecta conexões zumbi ---
                // A cada 3 minutos, verifica se o socket ainda responde de verdade
                if (intervaloWatchdog) {
                    clearInterval(intervaloWatchdog);
                    intervaloWatchdog = null;
                }
                intervaloWatchdog = setInterval(async () => {
                    if (!socket || !whatsappPronto) return;

                    const tempoInativo = Date.now() - ultimaAtividade;
                    // Se passou mais de 10 minutos sem NENHUMA atividade (nem heartbeat), conexão morreu
                    if (tempoInativo > 600_000) {
                        logger.error(`[WATCHDOG] Conexao inativa ha ${Math.round(tempoInativo / 60000)} min! Forcando reconexao...`);
                        whatsappPronto = false;
                        setTimeout(iniciarWhatsApp, 1000);
                        return;
                    }

                    // Teste ativo: tenta enviar presença e vê se funciona
                    try {
                        await socket.sendPresenceUpdate('available');
                    } catch (e) {
                        logger.warn(`[WATCHDOG] Socket nao respondeu ao teste de presenca: ${e.message || e}`);
                        logger.warn(`[WATCHDOG] Forcando reconexao...`);
                        whatsappPronto = false;
                        setTimeout(iniciarWhatsApp, 2000);
                    }
                }, 180_000); // A cada 3 minutos

                // Verifica se a pasta auth tem arquivos
                try {
                    const arquivos = fs.readdirSync(DIRETORIO_AUTH);
                    logger.info(`[AUTH] Pasta auth contem ${arquivos.length} arquivo(s).`);
                    if (arquivos.length === 0) {
                        logger.warn("[AUTH] ATENCAO: Pasta auth vazia apos conexao! Forcando salvamento...");
                        await saveCreds();
                        const arquivos2 = fs.readdirSync(DIRETORIO_AUTH);
                        logger.info(`[AUTH] Apos forcagem: ${arquivos2.length} arquivo(s).`);
                    }
                } catch (e) {
                    logger.error(`[AUTH] Erro ao verificar pasta auth: ${e}`);
                }
            }

            if (connection === "close") {
                whatsappPronto = false;
                const erro = lastDisconnect?.error;
                const status = new Boom(erro)?.output?.statusCode;
                const motivo = DisconnectReason[status] || `Código ${status}`;

                logger.warn(`[WARN] Conexao fechada. Motivo: ${motivo} (code: ${status})`);

                // Se estamos desligando graciosamente (Ctrl+C), NAO apagar sessao
                if (desligandoGraciosamente) {
                    logger.info("[STOP] Desligamento gracioso, mantendo sessao.");
                    return;
                }

                // --- LÓGICA DE RECONEXÃO INTELIGENTE ---

                // 1. Logout detectado (usuário deslogou pelo celular)
                if (status === DisconnectReason.loggedOut) {
                    logger.error("[LOGOUT] LOGOUT DETECTADO! Apagando sessao para novo QR Code...");
                    try { fs.rmSync(DIRETORIO_AUTH, { recursive: true, force: true }); } catch { }
                    tentativasReconexao = 0;
                    setTimeout(iniciarWhatsApp, 2000);
                    return;
                }

                // 2. Sessão substituída (outro dispositivo conectou)
                if (status === DisconnectReason.connectionReplaced) {
                    logger.error("[REPLACED] CONEXAO SUBSTITUIDA! Outro dispositivo conectou.");
                    // Não reconecta automaticamente para evitar loop
                    return;
                }

                // 3. Banimento (muito raro)
                if (status === DisconnectReason.forbidden) {
                    logger.error("[BAN] CONTA BANIDA OU RESTRITA!");
                    return;
                }

                // 4. Credenciais inválidas
                if (status === DisconnectReason.badSession) {
                    logger.error("[BAD_SESSION] SESSAO CORROMPIDA! Limpando e pedindo novo QR...");
                    try { fs.rmSync(DIRETORIO_AUTH, { recursive: true, force: true }); } catch { }
                    tentativasReconexao = 0;
                    setTimeout(iniciarWhatsApp, 2000);
                    return;
                }

                // 5. Outros erros: reconexão
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;

                // Tratamento especial para erros de instabilidade que exigem reconexão rápida
                // 408: Timeout (conexão expirou após inatividade)
                // 428: Precondition Required (geralmente conexão "fria")
                // 515: Stream Error (falha de stream)
                if (statusCode === 408 || statusCode === 428 || statusCode === 515) {
                    logger.warn(`[RECONNECT] Erro ${statusCode} detectado. Forcando reconexao imediata sem backoff...`);
                    // Não incrementa tentativasReconexao para evitar espera longa
                    setTimeout(iniciarWhatsApp, 1000);
                    return;
                }

                tentativasReconexao++;

                // Se muitas tentativas rápidas, espera mais tempo
                let tempoEspera = 3000; // 3 segundos padrão
                if (tentativasReconexao > MAX_TENTATIVAS_RAPIDAS) {
                    // Backoff exponencial: 10s, 20s, 40s, 80s... até 5 minutos
                    tempoEspera = Math.min(10000 * Math.pow(2, tentativasReconexao - MAX_TENTATIVAS_RAPIDAS), 300000);
                    logger.info(`[WAIT] Muitas tentativas. Aguardando ${tempoEspera / 1000}s antes de reconectar...`);
                }

                logger.info(`[RETRY] Tentativa de reconexao #${tentativasReconexao} em ${tempoEspera / 1000}s...`);
                setTimeout(iniciarWhatsApp, tempoEspera);
            }
        });

        socket.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify" || !messages?.length) return;
            for (const msg of messages) {
                try {
                    if (msg.key.fromMe) continue;
                    const idMsg = msg.key.id;
                    if (mensagensProcessadas.has(idMsg)) continue;
                    mensagensProcessadas.add(idMsg);

                    let jid = msg.key.remoteJid;

                    // Ignora grupos (@g.us) e newsletters
                    if (jid.endsWith("@g.us") || jid.endsWith("@newsletter")) continue;

                    // Normalização de JID
                    if (jidNormalizedUser) jid = jidNormalizedUser(jid);

                    // --- EXTRAÇÃO INTELIGENTE DE CONTEÚDO ---
                    const tipoMsg = Object.keys(msg.message)[0];
                    const conteudo = extractMessageContent(msg.message);

                    let texto = "";
                    let isButton = false;

                    try {
                        if (tipoMsg === "conversation") {
                            texto = msg.message.conversation; // Pega direto para garantir
                        } else if (tipoMsg === "extendedTextMessage") {
                            texto = msg.message.extendedTextMessage?.text;
                        } else if (tipoMsg === "buttonsResponseMessage") {
                            texto = msg.message.buttonsResponseMessage?.selectedButtonId;
                            isButton = true;
                        } else if (tipoMsg === "listResponseMessage") {
                            texto = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId;
                            isButton = true;
                        } else if (tipoMsg === "templateButtonReplyMessage") {
                            texto = msg.message.templateButtonReplyMessage?.selectedId;
                            isButton = true;
                        } else {
                            // Tenta extrair texto de qualquer jeito se falhar nos tipos acima
                            texto = conteudo?.conversation || conteudo?.text || conteudo?.selectedButtonId || "";
                        }
                    } catch (e) {
                        logger.warn(`[WARN] Erro ao extrair texto (Tipo: ${tipoMsg}): ${e.message}`);
                    }

                    // GARANTIA: Texto sempre será string
                    texto = String(texto || "").trim();

                    if (!texto) continue;

                    logger.info(`[MSG] Mensagem de ${jid} [${tipoMsg}]: "${texto.substring(0, 50)}..."`);
                    registrarAtividade(); // Mensagem recebida = bot está vivo

                    // Feedback visual de "digitando..."
                    await socket.sendPresenceUpdate('composing', jid);

                    // Processa no fluxo
                    const resposta = await fluxo.processarTexto(jid, texto, isButton);

                    if (resposta) {
                        // Suporta múltiplas mensagens (ex: imagem + botões)
                        const mensagens = Array.isArray(resposta) ? resposta : [resposta];
                        for (const msg of mensagens) {
                            const payload = typeof msg === "string" ? { text: msg } : msg;
                            await socket.sendMessage(jid, payload);
                        }
                        logger.info(`[SENT] ${mensagens.length} msg(s) enviada(s) para ${jid}`);
                    }
                } catch (erro) {
                    logger.error(`[ERROR] Erro ao processar mensagem: ${erro}`);
                }
            }
        });

    } catch (erro) {
        logger.error(`[FATAL] Erro fatal no WhatsApp: ${erro}`);
        tentativasReconexao++;
        const tempoEspera = Math.min(5000 * tentativasReconexao, 60000);
        logger.info(`[RETRY] Tentando novamente em ${tempoEspera / 1000}s...`);
        setTimeout(iniciarWhatsApp, tempoEspera);
    }
}

// --- API ---
app.post("/send-message", async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) return res.status(400).json({ error: "Dados inválidos: number e message obrigatórios" });
        if (!whatsappPronto || !socket) return res.status(503).json({ error: "Bot offline no momento" });

        const jid = number.includes("@") ? number : `${number.replace(/\D/g, "")}@s.whatsapp.net`;
        await socket.sendMessage(jid, { text: message });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});

app.get("/", (req, res) => res.send("Servidor Bot Online"));
app.get("/status", (req, res) => {
    const tempoInativo = Date.now() - ultimaAtividade;
    const tempoDesdeInicio = Date.now() - inicioProcesso;
    const status = {
        online: whatsappPronto,
        tentativasReconexao,
        ultimaConexao: ultimaConexaoBemSucedida,
        inativoHa: Math.round(tempoInativo / 1000) + "s",
        uptimeSegundos: Math.round(tempoDesdeInicio / 1000)
    };
    // Grace period de 3 min após iniciar — retorna 200 enquanto conecta pela primeira vez
    if (tempoDesdeInicio < 180_000) {
        return res.json(status);
    }
    // Só retorna 503 se AMBAS as condições forem verdadeiras:
    // 1. Bot está offline (whatsappPronto = false)
    // 2. Última atividade foi há mais de 5 minutos (não é uma reconexão rápida)
    // Isso evita que o Fly.io mate o processo durante reconexões normais (que duram segundos)
    if (!whatsappPronto && tempoInativo > 300_000) {
        return res.status(503).json(status);
    }
    res.json(status);
});
app.get("/qr", (req, res) => {
    if (!globalThis.__ultimoQR) return res.send("<h3>Conectado ou Aguardando QR Code...</h3>");
    res.send(`<div id="qrcode"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script><script>new QRCode(document.getElementById('qrcode'), { text: "${globalThis.__ultimoQR}", width: 300, height: 300 });</script>`);
});

app.listen(PORTA, () => {
    logger.info(`[SERVER] Servidor rodando na porta ${PORTA}`);
    logger.info(`[STATUS] Status: http://localhost:${PORTA}/status`);
    logger.info(`[QR] QR Code: http://localhost:${PORTA}/qr`);
    iniciarWhatsApp();
});

// --- TRATAMENTO DE ERROS GLOBAIS ---
process.on("uncaughtException", e => {
    logger.error("[UNCAUGHT] Erro Nao Capturado: " + e);
    // Não deixa o processo morrer
});
process.on("unhandledRejection", e => {
    logger.error("[UNHANDLED] Rejeicao Nao Tratada: " + e);
});

// --- SINAL DE DESLIGAMENTO GRACIOSO ---
let desligandoGraciosamente = false;

async function desligarGraciosamente(sinal) {
    if (desligandoGraciosamente) return; // Evita executar duas vezes
    logger.info(`[STOP] Recebido ${sinal}. Desligando bot...`);
    desligandoGraciosamente = true;
    if (intervaloHeartbeat) {
        clearInterval(intervaloHeartbeat);
        intervaloHeartbeat = null;
    }
    if (intervaloWatchdog) {
        clearInterval(intervaloWatchdog);
        intervaloWatchdog = null;
    }
    if (socket) {
        try { socket.ev.removeAllListeners(); } catch { }
        try { socket.end(undefined); } catch { }
    }
    try { await fluxo.fechar(); } catch { }
    // Aguarda evento connection.close processar sem deletar auth
    setTimeout(() => process.exit(0), 2000);
}

process.on("SIGINT", () => desligarGraciosamente("SIGINT"));
process.on("SIGTERM", () => desligarGraciosamente("SIGTERM")); // Fly.io envia SIGTERM
