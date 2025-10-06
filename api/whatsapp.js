// Vercel Serverless Function: /api/whatsapp
// Twilio WhatsApp Sandbox (application/x-www-form-urlencoded) -> TwiML

import { readFile, stat as fsStat } from 'fs/promises';
import { parse as parseQS } from 'querystring';
import path from 'path';

// ====== Config ======
const TZ = 'America/Sao_Paulo';
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeg7WwXV0xQMlRbNn0tQ4Shw3DUeBJXZUGqLN0YBk8YD0Addw/viewform?usp=header';

const EMAIL_TO   = process.env.TO_ADDRESS || 'aguiartiago012@gmail.com';
const SMTP_HOST  = process.env.SMTP_SERVER;
const SMTP_PORT  = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
const SMTP_USER  = process.env.EMAIL_USER;
const SMTP_PASS  = process.env.EMAIL_PASS;

// Persistência opcional de “já cancelado”
const CANCEL_LOG_URL = process.env.CANCEL_LOG_URL || ''; // ex.: Apps Script

// ====== Helpers ======
function twiml(text) {
  const esc = (s='') => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(text)}</Message></Response>`;
}

// Agora em TZ (partes) sem depender do relógio UTC do host
function tzNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour, mm: +parts.minute, ss: +parts.second,
    dow: map[parts.weekday] ?? 0
  };
}

// Aritmética de datas em “calendário” (UTC puro, sem TZ do host)
function addDaysYMD(y, m, d, delta) {
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function dowYMD(y, m, d) { // 0=Dom .. 6=Sáb
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function pad2(n) { return String(n).padStart(2, '0'); }
function isoYMD({ y, m, d }) { return `${y}-${pad2(m)}-${pad2(d)}`; }
function brYMD({ y, m, d }) { return `${pad2(d)}/${pad2(m)}/${y}`; }

// === DATA ALVO DO CANCELAMENTO (REGRAS DO TI) ===
// - Sáb/Dom -> próxima segunda
// - Dias úteis: até 11:59 -> hoje; a partir de 12:00 -> próximo dia útil
function computeCancelableDate() {
  const now = tzNowParts();
  let cand = { y: now.y, m: now.m, d: now.d };
  let dow = now.dow;

  // Fim de semana => pula para segunda
  if (dow === 6 || dow === 0) {
    const add = (8 - dow) % 7 || 1; // Sáb(6)->2, Dom(0)->1
    cand = addDaysYMD(now.y, now.m, now.d, add);
    dow = dowYMD(cand.y, cand.m, cand.d);
  } else {
    // Dia útil: janela vira amanhã a partir de 12:00
    if (now.hh >= 12) {
      cand = addDaysYMD(now.y, now.m, now.d, 1);
      dow = dowYMD(cand.y, cand.m, cand.d);
    }
    // Se caiu em fim de semana, empurra até segunda
    while (dow === 6 || dow === 0) {
      cand = addDaysYMD(cand.y, cand.m, cand.d, 1);
      dow = dowYMD(cand.y, cand.m, cand.d);
    }
  }
  return { iso: isoYMD(cand), br: brYMD(cand) };
}

// ====== Carregamento de redes.json em memória ======
let cacheMap = null, cacheMtime = 0;
async function loadMap() {
  const p = path.resolve(process.cwd(), 'redes.json');
  const st = await fsStat(p);
  if (!cacheMap || cacheMtime !== st.mtimeMs) {
    const raw = await readFile(p, 'utf8');
    const arr = JSON.parse(raw); // [{ prontuario, telefone, pedido_para_amanha, ... }]
    cacheMap = new Map(arr.map(s => {
      const tel = String(s.telefone || '').replace(/[^\d]/g, '');
      return [
        `whatsapp:+${tel}`,
        {
          prontuario: String(s.prontuario || '').trim(),
          pedidoParaAmanha: Boolean(s.pedido_para_amanha)
        }
      ];
    }));
    cacheMtime = st.mtimeMs;
  }
  return cacheMap;
}

// ====== Persistência opcional do "já cancelado" ======
const memCancelled = new Set(); // fallback em memória

async function wasAlreadyCancelled(key) {
  if (CANCEL_LOG_URL) {
    try {
      const u = `${CANCEL_LOG_URL}?op=check&key=${encodeURIComponent(key)}`;
      const r = await fetch(u, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
      if (r.ok) {
        const j = await r.json();
        if (j && j.exists === true) return true;
      }
    } catch {}
  }
  return memCancelled.has(key);
}

async function markCancelled(key) {
  memCancelled.add(key);
  if (CANCEL_LOG_URL) {
    try {
      await fetch(CANCEL_LOG_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'mark', key, ts: Date.now() })
      });
    } catch {}
  }
}

// ====== Envio de e-mail ======
async function sendMail({ prontuario, dateISO, fromPhone }) {
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.log('[EMAIL-SIMULADO]', { prontuario, dateISO, fromPhone, to: EMAIL_TO });
    return { simulated: true };
  }
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const assunto = `Cancelamento de almoço — prontuário ${prontuario} — ${br}`;
  const corpo =
`Olá,

Mensagem automática: o prontuário ${prontuario} solicita o cancelamento do pedido de almoço para ${br}.
Solicitação enviada a partir do número ${fromPhone}.
Horário (BRT): ${new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'medium' }).format(new Date())}.

Atenciosamente,
Sistema de Pedidos (WhatsApp Bot)`;

  await transporter.sendMail({
    from: SMTP_USER,
    to: EMAIL_TO,
    subject: assunto,
    text: corpo
  });

  return { simulated: false };
}

// ====== Respostas padrão (reutilizáveis) ======
async function replyDefault(from, reg) {
  if (!reg) {
    return (
      `Parece que não temos o seu número vinculado a nenhum prontuário no sistema.\n` +
      `Cadastre-se: ${FORM_URL}\n` +
      `Ativação em até 48h.`
    );
  }
  const { br, iso } = computeCancelableDate();
  const key = `${from}#${iso}`;
  if (await wasAlreadyCancelled(key)) {
    return `Seu pedido já foi cancelado para ${br}.`;
  }
  if (reg.pedidoParaAmanha === true) {
    return (
      `Olá! Encontramos o prontuário ${reg.prontuario} vinculado ao seu número.\n` +
      `Para cancelar o pedido do almoço para ${br}, responda: CONFIRMAR.`
    );
  } else {
    return (
      `Olá! Encontramos o prontuário ${reg.prontuario} vinculado ao seu número.\n` +
      `No momento não há pedido registrado para o próximo dia útil.`
    );
  }
}

// ====== Handler ======
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  // Body x-www-form-urlencoded (Twilio)
  let raw = '';
  await new Promise(r => { req.on('data', c => raw += c); req.on('end', r); });
  const data = parseQS(raw);
  const from = (data.From || '').trim();   // 'whatsapp:+5511...'
  const body = (data.Body || '').trim();

  const mapa = await loadMap();
  const reg  = mapa.get(from); // { prontuario, pedidoParaAmanha }

  // 1) “join <code>” do Sandbox: já responde com a mensagem padrão do fluxo
  if (/^join\s/i.test(body)) {
    const text = await replyDefault(from, reg);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(text));
  }

  // 2) CONFIRMAR -> envia e-mail + marca como cancelado
  if (/^CONFIRMAR$/i.test(body)) {
    if (!reg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Parece que não temos o seu número vinculado a nenhum prontuário no sistema.\n` +
        `Cadastre-se: ${FORM_URL}\n` +
        `Ativação em até 48h.`
      ));
    }
    const { iso, br } = computeCancelableDate();
    const key = `${from}#${iso}`;

    if (await wasAlreadyCancelled(key)) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(`Seu pedido já foi cancelado para ${br}.`));
    }
    try {
      await sendMail({ prontuario: reg.prontuario, dateISO: iso, fromPhone: from.replace(/^whatsapp:/, '') });
      await markCancelled(key);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Pronto! Enviaremos um e-mail de cancelamento para ${br} (prontuário ${reg.prontuario}).`
      ));
    } catch (e) {
      console.error('[EMAIL-ERRO]', e);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.`
      ));
    }
  }

  // 3) Qualquer outra mensagem -> fluxo padrão
  const text = await replyDefault(from, reg);
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml(text));
}
