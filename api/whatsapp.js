// Vercel Serverless Function: /api/whatsapp
// Twilio Sandbox envia application/x-www-form-urlencoded.
// Devolvemos TwiML (<Response><Message>...</Message></Response>).

import { readFile } from 'fs/promises';
import { parse as parseQS } from 'querystring';
import path from 'path';

function twiml(text) {
  const esc = (s='') => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc(text)}</Message></Response>`;
}

// Cache simples em memória por instância
let cacheMap = null, cacheMtime = 0;
async function loadMap() {
  // Lê redes.json empacotado no deploy do Vercel
  const p = path.resolve(process.cwd(), 'redes.json');
  const stat = await import('fs/promises').then(m => m.stat(p)).catch(()=>null);
  if (!cacheMap || !stat || stat.mtimeMs !== cacheMtime) {
    const raw = await readFile(p, 'utf8');
    const arr = JSON.parse(raw); // [{ prontuario, telefone, dias, ... }]
    // Twilio manda From = 'whatsapp:+55119...'
    cacheMap = new Map(arr.map(s => {
      const tel = String(s.telefone || '').replace(/[^\d]/g,''); // só dígitos
      return [`whatsapp:+${tel}`, { prontuario: String(s.prontuario||'').trim() }];
    }));
    cacheMtime = stat?.mtimeMs || Date.now();
  }
  return cacheMap;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  // lê body x-www-form-urlencoded
  let raw = '';
  await new Promise(r => { req.on('data', c=> raw += c); req.on('end', r); });
  const data = parseQS(raw);
  const from = (data.From || '').trim();      // ex: 'whatsapp:+5511932291930'
  const body = (data.Body || '').trim();      // texto do aluno

  // ignora mensagem de join do Sandbox
  if (/^join\s/i.test(body)) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml('Conectado. Envie "CANCELAR" para iniciar.'));
  }

  const mapa = await loadMap();
  const reg = mapa.get(from); // { prontuario }

  // CONFIRMAÇÃO: "CONFIRMO 3029701"
  const mConf = body.match(/^CONFIRMO\s+(\d{5,})$/i);
  if (mConf) {
    if (!reg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml('Seu número não está cadastrado. Envie: CADASTRAR <SEU_PRONTUARIO>.'));
    }
    const prMsg = mConf[1];
    if (reg.prontuario !== prMsg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml(
        `Prontuário ${prMsg} não corresponde ao deste número (${reg.prontuario}). Fale com o administrador.`
      ));
    }
    // TODO: dispare o e-mail para a secretaria aqui (SMTP ou API interna)
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(
      `Confirmado. Vamos enviar o e-mail para a secretaria com o prontuário ${reg.prontuario}.`
    ));
  }

  // INÍCIO: "CANCELAR"
  if (/^CANCELAR$/i.test(body)) {
    if (!reg) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml('Seu número não está cadastrado. Envie: CADASTRAR <SEU_PRONTUARIO>.'));
    }
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(
      `Encontrei este número como prontuário ${reg.prontuario}. ` +
      `Deseja enviar o e-mail de cancelamento? Responda: CONFIRMO ${reg.prontuario}`
    ));
  }

  // CADASTRO: "CADASTRAR 3029701" (apenas feedback; persistência real = via PR/DB)
  const mCad = body.match(/^CADASTRAR\s+(\d{5,})$/i);
  if (mCad) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml(
      `Cadastro recebido (${mCad[1]}). Peça ao admin para persistir no sistema. Depois, envie: CANCELAR`
    ));
  }

  // fallback
  const hint = reg
    ? `Prontuário vinculado: ${reg.prontuario}. Para cancelar, envie: CANCELAR`
    : 'Seu número não está cadastrado. Envie: CADASTRAR <SEU_PRONTUARIO>.';
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml(hint));
}
