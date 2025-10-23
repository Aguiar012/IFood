import express from "express";
import P from "pino";
import cron from "node-cron";
import OpenAI from "openai";
import { google } from "googleapis";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WA_TO = process.env.WA_TO || ""; // ex: 55119... (número) ou ...@g.us (grupo)
const PROXY_URL = process.env.PROXY_URL || ""; // ex: http://user:pass@host:port (DataImpulse)
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || "wa_auth";
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || ""; // https://seu-servico.northflank.app/oauth/callback
const GMAIL_QUERY = process.env.GMAIL_QUERY || 'from:xraiquzaxa@gmail.com newer_than:2d';
const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || "8");
const CRON_EXPR = process.env.POLL_CRON || "*/1 * * * *"; // a cada 1 min

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
      required: ["importance", "reason", "short_summary"],
      additionalProperties: false
    }
  };
  const prompt = `Assunto: ${subject}\n\nCorpo:\n${body}\n\nRegras:\n- Dê nota 0–10 para 'importance'\n- 9–10 = afeta se aluno sai de casa (ex.: cancelou aula hoje/amanhã)\n- Explique 'reason' e faça 'short_summary' (<=140 chars)`;
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Você é um classificador de avisos escolares. Responda apenas em JSON válido." },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_schema", json_schema: schema }
  });
  return JSON.parse(resp.choices[0].message.content);
}

// ---------- WhatsApp (Baileys) ----------
let sock, waReady = false;
const seenMsgIds = new Set();

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(url);
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
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
      console.log("\n=== ESCANEIE ESTE QR NO WHATSAPP ===");
      qrcode.generate(qr, { small: true });
      console.log("WhatsApp > Aparelhos conectados > Conectar aparelho\n");
    }
    if (connection === "open") {
      waReady = true;
      logger.info("WA conectado");
    }
    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      waReady = false;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      logger.warn({ status }, "WA desconectado");
      if (shouldReconnect) setTimeout(startWA, 1500);
      else logger.error("loggedOut — apague a pasta wa_auth para parear novamente.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const id = m.key.id;
      if (seenMsgIds.has(id)) continue;
      seenMsgIds.add(id);
      setTimeout(() => seenMsgIds.delete(id), 10 * 60 * 1000);

      const jid = m.key.remoteJid;
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        "";
      logger.info({ jid, text }, "mensagem recebida");
      // (opcional) aqui você poderia responder automaticamente se quiser
    }
  });
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

// ---------- Gmail (OAuth + polling) ----------
const oauth2 = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI
);
const gmail = google.gmail({ version: "v1", auth: oauth2 });

// persistência simples em arquivo
import fs from "fs";
const STATE_FILE = "state.json";
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { seenEmailIds: [] }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s));
}
const state = loadState();

// tokens do Gmail
const TOKEN_FILE = "gmail_token.json";
function loadToken() {
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    oauth2.setCredentials(t);
    return !!t.refresh_token || !!t.access_token;
  } catch { return false; }
}
function saveToken(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t));
}

app.get("/oauth/init", (_req, res) => {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    return res.status(400).send("Defina GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REDIRECT_URI");
  }
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly", "email", "profile"],
    prompt: "consent"
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    saveToken(tokens);
    return res.send("✅ Gmail conectado! Pode fechar esta aba.");
  } catch (e) {
    logger.error(e);
    res.status(500).send("Erro no OAuth: " + (e?.message || e));
  }
});

function b64uToStr(b64u) {
  return Buffer.from(b64u.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function extractBody(payload) {
  // tenta text/plain, senão text/html
  if (payload?.mimeType === "text/plain" && payload?.body?.data) {
    return b64uToStr(payload.body.data);
  }
  if (payload?.parts) {
    for (const p of payload.parts) {
      const r = extractBody(p);
      if (r) return r;
    }
  }
  if (payload?.mimeType === "text/html" && payload?.body?.data) {
    const html = b64uToStr(payload.body.data);
    return html.replace(/<[^>]+>/g, " "); // simplão: tira tags
  }
  return "";
}
function getHeader(headers, name) {
  return (headers || []).find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

async function checkGmailOnce() {
  if (!loadToken()) {
    logger.warn("Gmail ainda não autenticado. Acesse /oauth/init");
    return;
  }
  const list = await gmail.users.messages.list({
    userId: "me",
    q: GMAIL_QUERY,
    maxResults: 10
  });
  const ids = list.data.messages?.map(m => m.id) || [];
  for (const id of ids) {
    if (state.seenEmailIds.includes(id)) continue;
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = msg.data.payload?.headers || [];
    const subject = getHeader(headers, "Subject");
    const from = getHeader(headers, "From");
    const date = getHeader(headers, "Date");
    const body = extractBody(msg.data.payload) || msg.data.snippet || "";

    logger.info({ from, subject }, "novo e-mail");

    // classificar
    let cls = { importance: 0, reason: "", short_summary: "" };
    try {
      cls = await classifyImportance(subject, body);
    } catch (e) {
      logger.error(e, "falha na classificação");
    }

    // se importante, enviar no WhatsApp
    if (cls.importance >= IMPORTANCE_THRESHOLD) {
      const text = `⚠️ *AVISO IMPORTANTE* (score ${cls.importance})
De: ${from}
Assunto: ${subject}
Quando: ${date}
— Resumo —
${cls.short_summary}

(motivo: ${cls.reason})`;
      try {
        const id = await sendWA(WA_TO, text);
        logger.info({ id }, "WhatsApp enviado");
      } catch (e) {
        logger.error(e, "falha ao enviar WhatsApp");
      }
    }

    // marca como visto
    state.seenEmailIds.push(id);
    state.seenEmailIds = state.seenEmailIds.slice(-200); // limita
    saveState(state);
  }
}

// ---------- util / teste ----------
app.get("/", (_req, res) => res.send("ok"));
app.get("/test/wa", async (req, res) => {
  try {
    const id = await sendWA(req.query.to || WA_TO, req.query.text || "Teste OK");
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- boot ----------
(async () => {
  await startWA();
  // agenda o polling do Gmail
  cron.schedule(CRON_EXPR, () => {
    checkGmailOnce().catch(e => logger.error(e, "erro no check Gmail"));
  });
  app.listen(PORT, () => logger.info({ PORT }, "up"));
})();
