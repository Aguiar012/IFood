import express from "express";
import P from "pino";
import cron from "node-cron";
import OpenAI from "openai";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} from "@whiskeysockets/baileys";
import fs from "fs";

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
const EMAIL_FILTER_FROM = process.env.EMAIL_FILTER_FROM || "xraiquzaxa@gmail.com"; // remetente de teste

const IMPORTANCE_THRESHOLD = Number(process.env.IMPORTANCE_THRESHOLD || "8");
const CRON_EXPR = process.env.POLL_CRON || "*/1 * * * *"; // a cada 1 min

const logger = P({ level: "info" });
const app = express(); app.use(express.json());

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

Regras:
- Dê nota 0–10 em 'importance'
- 9–10 = afeta se o aluno sai de casa (ex.: cancelou aula hoje/amanhã)
- Explique 'reason' e faça 'short_summary' (<=140 chars)` }
    ],
    response_format: { type: "json_schema", json_schema: schema }
  });

  return JSON.parse(resp.choices[0].message.content);
}

// ---------- WhatsApp (Baileys) ----------
let sock, waReady = false;

async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(url); // HTTPS + WS CONNECT
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
const STATE_FILE = "state.json";
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
    // Busca: e-mails não lidos do remetente de teste (evita variações de SINCE)
    const criteria = ["UNSEEN", ["FROM", EMAIL_FILTER_FROM]];
    const fetchOptions = { bodies: [""], markSeen: false }; // "" = RFC822 (mensagem completa)

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
      try {
        cls = await classifyImportance(subject, body);
      } catch (e) {
        logger.error(e, "falha na classificação OpenAI");
      }

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
