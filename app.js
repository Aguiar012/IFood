import express from "express";
import P from "pino";
import cron from "node-cron";
import OpenAI from "openai";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
// SUBSTITUA todo o bloco de import do Baileys por isto:
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");

const makeWASocket =
  (typeof baileys?.default === "function" && baileys.default) ||
  (typeof baileys?.makeWASocket === "function" && baileys.makeWASocket) ||
  baileys; // fallback CJS

const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = baileys;

import fs from "fs";
import path from "path";
import https from "https";

import Imap from "imap-simple";
import { simpleParser } from "mailparser";

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TO = process.env.WA_TO || "";           // 55119... ou ...@g.us
const PROXY_URL = process.env.PROXY_URL || "";   // DataImpulse: http://USER:PASS@HOST:PORT
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || "wa_auth";

const EMAIL_USER = process.env.EMAIL_USER;       // conta Gmail do BOT (com 2FA)
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD; // App password (16 chars, sem espaços)
const EMAIL_FILTER_FROM = process.env.EMAIL_FILTER_FROM || "aguiartiago012@gmail.com"; // remetente de teste

const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || "6");
const CRON_EXPR = process.env.POLL_CRON || "*/1 * * * *"; // a cada 1 min

// Estado (arquivo pode ir para volume com STATE_PATH)
const STATE_FILE = process.env.STATE_PATH || "state.json";
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

// ---- Histórico de classificações (persistente) ----
const IMPORTANCE_LOG_LIMIT = Number(process.env.IMPORTANCE_LOG_LIMIT || "50");
const SCORES_FILE = process.env.SCORES_PATH || path.join(path.dirname(STATE_FILE), "scores.json");

function loadScores() { try { return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { return []; } }
function saveScores(list) { fs.writeFileSync(SCORES_FILE, JSON.stringify(list)); }

let lastScores = loadScores();


const logger = P({ level: "info" });
const app = express();
app.use(express.json());

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
      {
        role: "system",
        content: "Você é um classificador de avisos escolares. Responda apenas em JSON válido."
      },
      {
        role: "user",
        content:
`Assunto: ${subject}

Corpo:
${body}

Regras de pontuação (inteiro 0–10):
- 9–10 (muito urgente): cancela/adianta/atrasa aula de HOJE ou AMANHÃ; troca de sala/horário para hoje/amanhã; prazos em < 48h.
- 7–8 (importante na semana): cronograma ou instruções que valem para ESTA SEMANA (ex.: "até esta sexta-feira"); abertura de tarefa no Moodle com prazo nesta semana; "em anexo" com CRONOGRAMA/ORGANIZAÇÃO; prova/trabalho marcado para a semana atual.
- 5–6 (médio): informativo relevante, mas sem ação/pr Prazo nesta semana.
- 0–4 (baixo): comunicados sem ação, parabéns, conteúdo que não exige atenção próxima.

Notas:
- Detecte palavras como: hoje, amanhã, sexta-feira, cronograma, anexo, Moodle, prova, trabalho, prazo, entrega.
- Se mencionar "em anexo" com cronograma/organização do bimestre e valer nesta semana, prefira 7–8.
- Devolva: { "importance": INT, "reason": TEXTO CURTO, "short_summary": TEXTO <= 140 chars }`
      }
    ],
    response_format: { type: "json_schema", json_schema: schema }
  });

  return JSON.parse(resp.choices[0].message.content);
}

// ---------- WhatsApp (Baileys) ----------
let sock, waReady = false;
globalThis.__lastQR = ""; // para servir o QR em /qr

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(url); // HTTPS + WS CONNECT
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
    browser: Browsers.macOS("Chrome"),
    agent,
    fetchAgent: agent,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      globalThis.__lastQR = qr; // guarda o QR para /qr
      console.log("\n=== ESCANEIE ESTE QR NO WHATSAPP ===");
      qrcode.generate(qr, { small: true });
      console.log("Dica: acesse /qr para ver a imagem grande.\n");
    }
    if (connection === "open") { waReady = true; logger.info("WA conectado"); }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      logger.warn({ status }, "WA desconectado");
      if (shouldReconnect) setTimeout(startWA, 1500);
      else logger.error("loggedOut — apague a pasta wa_auth para parear novamente.");
    }
  });

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
  const connection = await Imap.connect(IMAP_CONFIG);
  try {
    await connection.openBox("INBOX");
    const criteria = ["UNSEEN", ["FROM", EMAIL_FILTER_FROM]];
    const fetchOptions = { bodies: [""], markSeen: false }; // "" = RFC822

    const results = await connection.search(criteria, fetchOptions);
    for (const res of results) {
      const part = res.parts.find(p => p.which === "");
      if (!part?.body) continue;

      const parsed = await simpleParser(part.body);
      const msgId = parsed.messageId || `${parsed.subject}-${parsed.date}`;
      if (state.seenIds.includes(msgId)) continue;

      const subject = parsed.subject || "";
      const from = parsed.from?.text || "";
      const date = parsed.date ? new Date(parsed.date).toString() : "";
      const body = parsed.text || parsed.html || parsed.textAsHtml || "";

      logger.info({ from, subject }, "novo e-mail (IMAP)");
      let cls = { importance: 0, reason: "", short_summary: "" };
      try { cls = await classifyImportance(subject, body); }
      catch (e) { logger.error(e, "falha na classificação OpenAI"); }

      // registra a classificação (passando ou não)
      const record = {
        ts: new Date().toISOString(),
        from,
        subject,
        importance: cls.importance,
        reason: cls.reason,
        summary: cls.short_summary
      };
      lastScores.push(record);
      lastScores = lastScores.slice(-IMPORTANCE_LOG_LIMIT);
      saveScores(lastScores);
      
      // se NÃO passou no limiar, deixa claro no log
      if (cls.importance < IMPORTANCE_THRESHOLD) {
        logger.info(
          { importance: cls.importance, threshold: IMPORTANCE_THRESHOLD, subject },
          "descartado por importância (< threshold)"
        );
      }

      if (cls.importance >= IMPORTANCE_THRESHOLD) {      
        // “email puro” (prioriza texto; se vier só HTML, tira as tags grosseiramente)
        const plain =
          parsed.text ||
          (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ") : "") ||
          "";
      
        const text = `Mensagem do *SUAP*:\n\n${subject}\n\n${plain}`.slice(0, 3500);
      
        try {
          const id = await sendWA(WA_TO, text);
          logger.info({ id }, "WhatsApp enviado");
        } catch (e) {
          logger.error(e, "falha ao enviar no WhatsApp");
        }
      }


      state.seenIds.push(msgId);
      state.seenIds = state.seenIds.slice(-500);
      saveState(state);
    }
  } catch (e) {
    logger.error(e, "erro IMAP");
  } finally {
    await connection.end();
  }
}

// ---------- /qr (QR em imagem grande para escanear) ----------
app.get("/qr", (_req, res) => {
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type","text/html");
  res.end(`<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>
  body{margin:0;display:grid;place-items:center;height:100vh;background:#fff}
</style>
<div id="qrcode"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(qr)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  // auto-refresh a cada 15s (QR do WA expira)
  setTimeout(()=>location.reload(),15000);
</script>`);
});

// ---------- debug opcional: IP de saída pelo proxy ----------
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



// ---- Visualizador de importância ----
app.get("/importance.json", (_req, res) => {
  res.json({
    threshold: IMPORTANCE_THRESHOLD,
    count: lastScores.length,
    items: [...lastScores].reverse() // mais recentes primeiro
  });
});

app.get("/importance", (_req, res) => {
  const rows = [...lastScores].reverse().map(r => `
    <tr>
      <td>${new Date(r.ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
      <td>${(r.importance ?? "").toString()}</td>
      <td>${String(r.subject || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</td>
      <td>${String(r.from || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</td>
      <td>${String(r.summary || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</td>
      <td>${String(r.reason || "").replace(/[<>&]/g, s => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[s]))}</td>
    </tr>
  `).join("");

  res.set("content-type","text/html").send(`<!doctype html>
  <meta name=viewport content="width=device-width,initial-scale=1">
  <title>Importância dos e-mails</title>
  <style>
    body{font-family:system-ui,Arial,sans-serif;padding:16px}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;vertical-align:top}
    th{background:#f5f5f5}
    tr:nth-child(even){background:#fafafa}
    code{background:#f3f3f3;padding:2px 4px;border-radius:4px}
  </style>
  <h1>Classificações de importância</h1>
  <p>Limiar atual: <code>${IMPORTANCE_THRESHOLD}</code> • Total guardado: <code>${lastScores.length}</code></p>
  <p>API: <a href="/importance.json">/importance.json</a></p>
  <table>
    <thead><tr>
      <th>Quando (SP)</th><th>Score</th><th>Assunto</th><th>De</th><th>Resumo</th><th>Motivo</th>
    </tr></thead>
    <tbody>${rows || "<tr><td colspan=6>(vazio)</td></tr>"}</tbody>
  </table>`);
});


// ---------- HTTP util ----------
app.get("/", (_req, res) => res.send("ok"));
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
  await startWA();
  cron.schedule(CRON_EXPR, () => { checkIMAPOnce().catch(e => logger.error(e)); });
  app.listen(PORT, () => logger.info({ PORT }, "up"));
})();
