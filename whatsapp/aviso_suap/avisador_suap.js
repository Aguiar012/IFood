import express from "express";
import P from "pino";
import cron from "node-cron";
import OpenAI from "openai";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");
const makeWASocket =
  (typeof baileys?.default === "function" && baileys.default) ||
  (typeof baileys?.makeWASocket === "function" && baileys.makeWASocket) ||
  baileys;

const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;

import fs from "fs";
import path from "path";
import https from "https";

import Imap from "imap-simple";
import { simpleParser } from "mailparser";

import paths from "../paths.js";
// import { createConversaFlow } from "../chatbot/conversa_flow.js"; // Não usado aqui diretamente

/* ===================== CONSTS/ENV ===================== */

const WA_AUTH_DIR = paths.WA_AUTH_DIR;

// Porta sem secrets (auto): conversazap -> 3001, aviso_suap -> 3000
const PORT = Number(process.env.PORT)
  || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TO = process.env.WA_TO || "";                 // 55119... ou ...@g.us
const PROXY_URL = process.env.PROXY_URL || "";         // http://USER:PASS@HOST:PORT
const FORWARD_WA_HTTP = process.env.FORWARD_WA_HTTP || ""; // ex: http://conversazap:3001

// >>> PERSISTÊNCIA NO VOLUME /app/data <<<
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STATE_FILE = process.env.STATE_PATH || path.join(DATA_DIR, "state", "state.json");
const SCORES_FILE = process.env.SCORES_PATH || path.join(DATA_DIR, "state", "scores.json");
// LOCK_FILE REMOVIDO para evitar crash loop no Northflank

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD;
const EMAIL_FILTER_FROM = process.env.EMAIL_FILTER_FROM || "aguiartiago012@gmail.com";

const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || "6");
const CRON_EXPR = process.env.POLL_CRON || "*/1 * * * *"; // a cada 1 min
const IMPORTANCE_LOG_LIMIT = Number(process.env.IMPORTANCE_LOG_LIMIT || "50");

/* ===================== APP/LOG ===================== */

const logger = P({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());

/* ===================== OpenAI (classificação) ===================== */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
async function classifyImportance(subject, body) {
  const schema = {
    name: "ImportanceSchema",
    schema: {
      type: "object",
      properties: {
        importance: { type: "integer", minimum: 0, maximum: 10 },
        reason: { type: "string" },
        short_summary: { type: "string" }
      },
      required: ["importance","reason","short_summary"],
      additionalProperties: false
    }
  };

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Você é um classificador de avisos escolares. Responda apenas em JSON válido." },
      { role: "user", content:
`Assunto: ${subject}

Corpo:
${body}

Regras (0–10):
- 9–10: muda hoje/amanhã (cancelou/adiantou/atrasou aula; troca sala/horário; prazo <48h).
- 7–8: vale para ESTA SEMANA (cronograma, Moodle aberto com prazo na semana, prova/trabalho na semana).
- 5–6: informativo relevante sem ação urgente.
- 0–4: baixo impacto (parabéns etc).
Retorne {importance, reason, short_summary<=140}.` }
    ],
    response_format: { type: "json_schema", json_schema: schema }
  });

  return JSON.parse(resp.choices[0].message.content);
}

/* ===================== WhatsApp (Baileys) ===================== */

let sock, waReady = false, waLastOpen = 0, startingWA = false;
globalThis.__lastQR = "";

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(url);
}

function armWaWatchdog(sockRef) {
  sockRef.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") waLastOpen = Date.now();
  });
  setInterval(async () => {
    // Aumentado tempo de watchdog para evitar reiniciar à toa
    const stale = Date.now() - waLastOpen > 30 * 60 * 1000; 
    if (!waReady && stale) {
      logger.warn({ waReady, stale }, "WA watchdog: restarting socket");
      try { sockRef.ws?.close(); } catch {}
      await safeStartWA();
    }
  }, 60_000);
}

async function safeStartWA() {
  if (startingWA) return;
  startingWA = true;
  try { await startWA(); }
  finally { startingWA = false; }
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version");
  const agent = await buildProxyAgent(PROXY_URL);


  sock = makeWASocket({
    version,
    auth: state,
    logger,
    // [AJUSTE 1] Garanta que o navegador seja recente.
    browser: ['IFood Avisos', 'Chrome', '120.0.0'], 
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    // [AJUSTE 2] CRUCIAL: Impede o download do histórico massivo
    syncFullHistory: false, 
    shouldIgnoreJid: jid => String(jid).endsWith("@newsletter"),
    // [AJUSTE 3] Aumentar timeouts para lidar com lentidão da rede
    keepAliveIntervalMs: 20_000, // Intervalo um pouco menor, mais ativo
    connectTimeoutMs: 90_000, // Dá mais tempo para conectar (90s)
    defaultQueryTimeoutMs: 90_000, // Dá mais tempo para o WhatsApp responder
    retryRequestDelayMs: 5000, // Espera mais tempo entre tentativas
    // Novo: Otimiza o Baileys para conexões leves
    getMessage: async (key) => ({}), // Melhora a performance ao ignorar buscas profundas de mensagens
    // ...
  });


  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr;
      try { qrcode.generate(qr, { small: true }); } catch {}
    }

    if (connection === "open") {
      waReady = true;
      waLastOpen = Date.now();
      logger.info("WA conectado");
      return;
    }

    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      
      // Se desconectou, tenta reconectar sempre, a menos que seja LOGOUT explícito
      if (status !== DisconnectReason.loggedOut) {
          setTimeout(startWA, 5000);
      } else {
          logger.error("Sessão encerrada (Logout).");
      }
    }
  });

  armWaWatchdog(sock);
}

function toJid(to) {
  if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) return to;
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}

// ——— ÚNICO ponto de envio de WA — com forward HTTP opcional ———
async function sendWA(to, text) {
  if (FORWARD_WA_HTTP) {
    const url = `${FORWARD_WA_HTTP.replace(/\/$/,"")}/test/wa?to=${encodeURIComponent(to)}&text=${encodeURIComponent(text)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`forward http status ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`forward http error ${j.error || "unknown"}`);
    return j.id || null;
  }

  if (!waReady) throw new Error("WhatsApp não conectado ainda");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id;
}

/* ===================== Estado simples (de-dupe) ===================== */
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seenIds: [] }; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }
const state = loadState();

function loadScores() { try { return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { return []; } }
function saveScores(list) { try { fs.writeFileSync(SCORES_FILE, JSON.stringify(list)); } catch {} }
let lastScores = loadScores();

/* ===================== IMAP (Gmail via App Password) ===================== */
const IMAP_CONFIG = {
  imap: {
    user: EMAIL_USER,
    password: EMAIL_APP_PASSWORD,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    authTimeout: 30000
  }
};

async function checkIMAPOnce() {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) return;
  
  // Se WA não estiver pronto e não tiver forward, nem tenta buscar email pra não perder
  if (!FORWARD_WA_HTTP && !waReady) return;

  const connection = await Imap.connect(IMAP_CONFIG);
  try {
    await connection.openBox("INBOX");

    function imapDate(d){
      const mm = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
      return `${d.getUTCDate()}-${mm}-${d.getUTCFullYear()}`;
    }
    const days = Number(process.env.IMAP_SINCE_DAYS || "3");
    const since = new Date(Date.now() - days*864e5);

    const criteria = [
      "UNSEEN",
      ["SINCE", imapDate(since)],
      ["FROM", EMAIL_FILTER_FROM]
    ];

    const fetchOptions = { bodies: [""], markSeen: false };

    const results = await connection.search(criteria, fetchOptions);
    logger.info({ count: results.length }, "IMAP search results");

    for (const res of results) {
      const part = res.parts.find(p => p.which === "");
      if (!part?.body) continue;

      const parsed = await simpleParser(part.body);
      const msgId = parsed.messageId || `${parsed.subject}-${parsed.date}`;
      if (state.seenIds.includes(msgId)) continue;

      const subject = parsed.subject || "";
      const from = parsed.from?.text || "";
      const body = parsed.text || parsed.html || parsed.textAsHtml || "";

      logger.info({ from, subject }, "novo e-mail (IMAP)");

      let cls = { importance: 0, reason: "", short_summary: "" };
      try { cls = await classifyImportance(subject, body); }
      catch (e) { logger.error(e, "falha na classificação OpenAI"); }

      const rec = {
        ts: new Date().toISOString(),
        from, subject,
        importance: cls.importance,
        reason: cls.reason,
        summary: cls.short_summary
      };
      lastScores.push(rec);
      lastScores = lastScores.slice(-IMPORTANCE_LOG_LIMIT);
      saveScores(lastScores);

      const isImportant = cls.importance >= IMPORTANCE_THRESHOLD;
      let delivered = false;

      if (isImportant) {
        const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
        const plain = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ") : "") || "";
        const text = `Mensagem do SUAP agora ${now}:\n\nAssunto: ${subject}\nDe: ${from}\n\n${plain}`.slice(0, 3500);
        try {
          const id = await sendWA(WA_TO, text);
          delivered = true;
          logger.info({ id }, "WhatsApp enviado");
        } catch (e) {
          logger.error(e, "falha ao enviar no WhatsApp");
        }
      }

      if (!isImportant || delivered) {
        state.seenIds.push(msgId);
        state.seenIds = state.seenIds.slice(-500);
        saveState(state);
      }
    }
  } catch (e) {
    logger.error(e, "erro IMAP");
  } finally {
    await connection.end();
  }
}

/* ===================== Rotas ===================== */
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ waReady, seenCount: (state.seenIds||[]).length }));

// Boot
(async () => {
  if (!FORWARD_WA_HTTP) {
    await safeStartWA();
  }
  cron.schedule(CRON_EXPR, () => { checkIMAPOnce().catch(e => logger.error(e)); });
  app.listen(PORT, () => logger.info({ PORT }, "Servidor Avisos Online"));
})();
