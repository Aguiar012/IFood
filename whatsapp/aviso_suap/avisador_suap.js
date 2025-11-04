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
import { createConversaFlow } from "../chatbot/conversa_flow.js";


const WA_AUTH_DIR = paths.WA_AUTH_DIR;

const { handleText } = createConversaFlow({
  dataDir: paths.DATA_DIR,          // <-- antes era /app/data (global); agora é /app/data/conversazap
  dbUrl: process.env.DATABASE_URL,
  logger: console,
});

// Porta sem secrets (auto): conversazap -> 3001, aviso_suap -> 3000
const PORT = Number(process.env.PORT)
  || (paths.APP_KEY.includes("conversa") ? 3001 : 3000);

// ---------- ENV ----------

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TO = process.env.WA_TO || "";           // 55119... ou ...@g.us
const PROXY_URL = process.env.PROXY_URL || "";   // http://USER:PASS@HOST:PORT

// >>> PERSISTÊNCIA NO VOLUME /app/data <<<
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STATE_FILE = process.env.STATE_PATH || path.join(DATA_DIR, "state", "state.json");
const SCORES_FILE = process.env.SCORES_PATH || path.join(DATA_DIR, "state", "scores.json");
const LOCK_FILE = process.env.LOCK_FILE || path.join(DATA_DIR, "state", "lock.json");

const EMAIL_USER = process.env.EMAIL_USER;       // Gmail do bot (com 2FA)
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD; // App password (16 chars)
const EMAIL_FILTER_FROM = process.env.EMAIL_FILTER_FROM || "aguiartiago012@gmail.com";

const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || "6");
const CRON_EXPR = process.env.POLL_CRON || "*/1 * * * *"; // a cada 1 min
const IMPORTANCE_LOG_LIMIT = Number(process.env.IMPORTANCE_LOG_LIMIT || "50");

const logger = P({ level: "info" });
const app = express();
app.use(express.json());

// ---- Lock anti-dupla instância (se compartilhar o volume) ----
function tryAcquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (Date.now() - (cur.ts || 0) < 5 * 60 * 1000) return false;
  } catch {}
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid }));
  return true;
}
if (!tryAcquireLock()) {
  console.error("Outra instância ativa usando o mesmo volume. Abortando.");
  process.exit(1);
}
setInterval(() => {
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid })); } catch {}
}, 60_000);

// ---------- OpenAI (classificação) ----------
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

// ---------- WhatsApp (Baileys) ----------
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
    const stale = Date.now() - waLastOpen > 10 * 60 * 1000; // 10min
    if (!waReady || stale) {
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
    browser: ['IFood Avisos', 'Chrome', '14.4.1'],
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: jid => String(jid).endsWith("@newsletter")
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
  
      // 👇 considere 409/440 e "conflict" como logout/substituída
      const text = String(lastDisconnect?.error || "");
      const isConflict =
        status === 409 || status === 440 ||
        text.includes("Stream Errored (conflict)") ||
        text.includes('"conflict"');
  
      const shouldReconnect = !isConflict && status !== DisconnectReason.loggedOut;
  
      waReady = false;
      logger.warn({ status, isConflict }, "WA desconectado");
  
      if (shouldReconnect) {
        setTimeout(startWA, 1500);
      } else {
        logger.error("Sessão substituída / logout — apague a pasta de auth deste bot e repare o QR.");
        // Opcional (automático): limpar a sessão e reabrir para forçar QR novo
        // try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch {}
        // setTimeout(startWA, 1500);
      }
    }
  });


  armWaWatchdog(sock);

  for (const sig of ["SIGINT","SIGTERM"]) {
    process.on(sig, async () => { try { await saveCreds(); } catch {} process.exit(0); });
  }
}

function toJid(to) {
  if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) return to;
  return `${to.replace(/\D/g, "")}@s.whatsapp.net`;
}

async function sendWA(to, text) {
  if (!waReady) throw new Error("WhatsApp não conectado ainda");
  const jid = toJid(to);
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id;
}

// ---------- Estado simples (de-dupe) ----------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { seenIds: [] }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
const state = loadState();

function loadScores() { try { return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { return []; } }
function saveScores(list) { fs.writeFileSync(SCORES_FILE, JSON.stringify(list)); }
let lastScores = loadScores();

// ---------- IMAP (Gmail via App Password) ----------
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
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) {
    logger.warn("IMAP não configurado (EMAIL_USER/EMAIL_APP_PASSWORD).");
    return;
  }
  if (!waReady) { logger.warn("WA offline; pulando IMAP para evitar perda."); return; }

  const connection = await Imap.connect(IMAP_CONFIG);
  try {
    await connection.openBox("INBOX");

    // Criteiro é que deve enviar emails recebidos agora ou nos ultimos 3 dias
    function imapDate(d){
      const mm = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
      return `${d.getUTCDate()}-${mm}-${d.getUTCFullYear()}`; // ex: 02-Nov-2025
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

      // log/visualizador
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
      } else {
        logger.info({ importance: cls.importance, threshold: IMPORTANCE_THRESHOLD, subject }, "descartado por importância (< threshold)");
      }

      // Marca como visto apenas se não importante OU entregue com sucesso
      if (!isImportant || delivered) {
        state.seenIds.push(msgId);
        state.seenIds = state.seenIds.slice(-500);
        saveState(state);
      } else {
        logger.warn({ msgId, subject }, "importante mas não entregue; manter para retry");
      }
    }
  } catch (e) {
    logger.error(e, "erro IMAP");
  } finally {
    await connection.end();
  }
}

// ---------- Rotas ----------
app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type","text/html");
  res.end(`<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#fff}</style>
<div id="qrcode"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

let _proxyAgent;
async function getProxyAgent() {
  if (_proxyAgent) return _proxyAgent;
  if (!PROXY_URL) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  _proxyAgent = new HttpsProxyAgent(PROXY_URL);
  return _proxyAgent;
}
app.get("/debug/proxy-ip", async (_req, res) => {
  try {
    const agent = await getProxyAgent();
    const req = https.request({ host: "api.ipify.org", path: "/?format=json", agent }, r => {
      let data=""; r.on("data", d => data+=d); r.on("end", () => res.type("json").send(data));
    });
    req.on("error", e => res.status(500).send(String(e)));
    req.end();
  } catch (e) { res.status(500).send(String(e)); }
});

// Visualizador de importância
app.get("/importance.json", (_req, res) => {
  res.json({ threshold: IMPORTANCE_THRESHOLD, count: lastScores.length, items: [...lastScores].reverse() });
});
app.get("/importance", (_req, res) => {
  const esc = s => String(s||"").replace(/[<>&]/g, t => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[t]));
  const rows = [...lastScores].reverse().map(r => `
    <tr>
      <td>${new Date(r.ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
      <td>${r.importance}</td>
      <td>${esc(r.subject)}</td>
      <td>${esc(r.from)}</td>
      <td>${esc(r.summary)}</td>
      <td>${esc(r.reason)}</td>
    </tr>
  `).join("");
  res.set("content-type","text/html").send(`<!doctype html>
  <meta name=viewport content="width=device-width,initial-scale=1">
  <title>Importância dos e-mails</title>
  <style>
    body{font-family:system-ui,Arial,sans-serif;padding:16px}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
    th{background:#f5f5f5} tr:nth-child(even){background:#fafafa}
    code{background:#f3f3f3;padding:2px 4px;border-radius:4px}
  </style>
  <h1>Classificações de importância</h1>
  <p>Limiar atual: <code>${IMPORTANCE_THRESHOLD}</code> • Total guardado: <code>${lastScores.length}</code> • API: <a href="/importance.json">/importance.json</a></p>
  <table><thead><tr><th>Quando (SP)</th><th>Score</th><th>Assunto</th><th>De</th><th>Resumo</th><th>Motivo</th></tr></thead>
  <tbody>${rows || "<tr><td colspan=6>(vazio)</td></tr>"}</tbody></table>`);
});

// util/health
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ waReady, lastOpenMsAgo: Date.now()-waLastOpen, seenCount: (state.seenIds||[]).length }));
app.get("/test/wa", async (req, res) => {
  try {
    const id = await sendWA(req.query.to || WA_TO, req.query.text || "Teste OK");
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Boot ----------
(async () => {
  await safeStartWA();
  cron.schedule(CRON_EXPR, () => { checkIMAPOnce().catch(e => logger.error(e)); });
  app.listen(PORT, () => logger.info({ PORT, DATA_DIR, WA_AUTH_DIR, STATE_FILE, SCORES_FILE }, "up"));
})();
