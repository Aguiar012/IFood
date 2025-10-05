// Vercel Serverless Function: /api/whatsapp
// Responde a mensagens do Twilio WhatsApp Sandbox (application/x-www-form-urlencoded) com TwiML.
// Fluxo:
//  - Qualquer mensagem:
//      * se número não cadastrado -> link do formulário
//      * se cadastrado -> "Encontramos prontuário XXX..." + (se pedido_para_amanha) pergunta confirmação
//  - "CONFIRMAR" -> envia e-mail (ou simula) e evita flood por dia

import { readFile, stat as fsStat } from 'fs/promises';
import { parse as parseQS } from 'querystring';
import path from 'path';

// ====== Config ======
const TZ = 'America/Sao_Paulo';
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeg7WwXV0xQMlRbNn0tQ4Shw3DUeBJXZUGqLN0YBk8YD0Addw/viewform?usp=header';
const EMAIL_TO = process.env.TO_ADDRESS || 'aguiartiago012@gmail.com'; // pode mudar depois
const SMTP_HOST = process.env.SMTP_SERVER;
const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
const SMTP_USER = process.env.EMAIL_USER;
const SMTP_PASS = process.env.EMAIL_PASS;

// ====== Helpers ======
function twiml(text) {
  const esc = (s='') => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(text)}</Message></Response>`;
}

// Data/hora no fuso BRT
function nowInTZ() {
  const now = new Date();
  // Obter partes com timeZone
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  // weekday: Mon/Tue/Wed/Thu/Fri/Sat/Sun
  const wmap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  const dow = wmap[parts.weekday] ?? 0;
  // Construir um Date equivalente no fuso via "yyyy-mm-dd hh:mm:ss" local e criar Date UTC dessa string
  const y = parts.year, m = parts.month, d = parts.day, hh = parts.hour, mm = parts.minute, ss = parts.second;
  const localIso = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  // Retornamos metadata útil e um Date "representativo"
  return { dow, y, m, d, hh, mm, ss, localIso };
}

function nextTargetDateISO() {
  // Amanhã, exceto se hoje for sexta(5), sábado(6) ou domingo(0) -> próxima segunda
  const { dow, y, m, d, hh, mm, ss, localIso } = nowInTZ();
  // Criar um Date a partir de partes no TZ é complexo; aqui usamos um truque:
  // criamos um Date "agora" e somamos dias considerando os casos, depois formatamos no TZ.
  const now = new Date();
  let add = 1;
  if (dow === 5) add = 3;    // sexta -> +3 = segunda
  else if (dow === 6) add = 2; // sábado -> +2 = segunda
  else if (dow === 0) add = 1; // domingo -> +1 = segunda (amanhã)
  const target = new Date(now.getTime() + add*24*3600*1000);

  // formatar target como YYYY-MM-DD no TZ
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(target);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`; // YYYY-MM-DD
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

// ====== Envio de e-mail (opcional) ======
async function sendMail({ prontuario, dateISO, fromPhone }) {
  // Se SMTP não está configurado, simulamos "enviado" (sem erro).
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.log('[EMAIL-SIMULADO]', { prontuario, dateISO, fromPhone, to: EMAIL_TO });
    return { simulated: true };
  }
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // ajuste conforme seu provedor
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const assunto = `Cancelamento de almoço — prontuário ${prontuario} — ${dateISO}`;
  const corpo =
`Olá,

Essa é uma mensagem automática para informar que o prontuário ${prontuario} solicita o cancelamento do pedido de almoço para o dia ${dateISO}.
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

// ====== Anti-flood (memória por execução) ======
const cancelledSet = new Set(); // chave: `${from}#${dateISO}`

// ====== Handler ======
export const config = { api: { bodyParser: false } }; // ler raw body

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  // ler body x-www-form-urlencoded
  let raw = '';
  await new Promise(r => { req.on('data', c => raw += c); req.on('end', r); });
  const data = parseQS(raw);
  const from = (data.From || '').trim();  // 'whatsapp:+5511...'
  const body = (data.Body || '').trim();

  // Ignorar "join <code>" do sandbox
  if (/^join\s/i.test(body)) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml('Conectado. Envie qualquer mensagem para começarmos.'));
  }

  const mapa = await loadMap();
  const reg = mapa.get(from); // { prontuario, pedidoParaAmanha }

  // Comando CONFIRMAR (qualquer capitalização)
  if (/^CONFIRMAR$/i.test(body)) {
    if (!reg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Parece que não temos o seu número vinculado a nenhum prontuário no sistema.\n` +
        `Por favor, preencha o cadastro: ${FORM_URL}\n` +
        `Efetuamos o cadastro em até 48h.`
      ));
    }
    const dateISO = nextTargetDateISO();
    const key = `${from}#${dateISO}`;
    if (cancelledSet.has(key)) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(`Seu pedido já foi cancelado para ${dateISO}.`));
    }
    try {
      await sendMail({ prontuario: reg.prontuario, dateISO, fromPhone: from.replace(/^whatsapp:/, '') });
      cancelledSet.add(key);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Pronto! Enviaremos um e-mail de cancelamento para ${dateISO} (prontuário ${reg.prontuario}).`
      ));
    } catch (e) {
      console.error('[EMAIL-ERRO]', e);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.`
      ));
    }
  }

  // Qualquer outra mensagem: mensagem "natural"
  if (!reg) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(
      `Parece que não temos o seu número vinculado a nenhum prontuário no sistema.\n` +
      `Por favor entre no link ${FORM_URL} para cadastrarmos o seu número.\n` +
      `Efetuamos o cadastro em até 48h.`
    ));
  } else {
    const cab = `Olá! Encontramos o prontuário ${reg.prontuario} vinculado ao seu número.`;
    if (reg.pedidoParaAmanha === true) {
      const dateISO = nextTargetDateISO();
      const key = `${from}#${dateISO}`;
      // Se já foi cancelado nesta execução, avisa
      if (cancelledSet.has(key)) {
        res.setHeader('Content-Type', 'text/xml');
        return res.status(200).send(twiml(`Seu pedido já foi cancelado para ${dateISO}.`));
      }
      const linha2 =
        `Gostaria de cancelar seu pedido do almoço para ${dateISO}? ` +
        `Digite CONFIRMAR e enviaremos um e-mail para a CAE por você.`;
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(`${cab}\n${linha2}`));
    } else {
      const linha2 = `No momento não há pedido registrado para o próximo dia útil.`;
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(`${cab}\n${linha2}`));
    }
  }
}
