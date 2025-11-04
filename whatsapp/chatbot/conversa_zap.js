import express from "express";
import P from "pino";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import https from "https";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const baileys = require("@whiskeysockets/baileys");
const WS = require("ws"); // para /debug/ws-check

const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = baileys;

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3001);
const PROXY_URL = process.env.PROXY_URL || ""; // http://USER:PASS@HOST:PORT

// >>> PERSISTÊNCIA NO VOLUME /app/data (PASTA SEPARADA DO OUTRO BOT!) <<<
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const WA_AUTH_DIR = process.env.WA_AUTH_DIR || path.join(DATA_DIR, "wa_auth_zapbot");
fs.mkdirSync(WA_AUTH_DIR, { recursive: true });

// ---------- LOG + HTTP ----------
const logger = P({ level: "info" });
const app = express();
app.use(express.json());

// ---------- ESTADO GLOBAL ----------
let sock;
let waReady = false;
let waLastOpen = 0;
let wdTimer = null;
let startingWA = false;
globalThis.__lastQR = "";

// ---------- LOCK (HOST+PID+TTL) ----------
const HOST = process.env.HOSTNAME || "local";
const LOCK_FILE = process.env.LOCK_FILE || path.join(DATA_DIR, "locks/conversazap.lock.json");
fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

function readLock() { try { return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch { return null; } }
function writeLock() { try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), pid: process.pid, host: HOST })); } catch {} }
function isPidAlive(pid){ try{ process.kill(pid,0); return true;}catch{ return false; } }
function tryAcquireLock(){
  const cur = readLock(); const now = Date.now(); const TTL = 90_000;
  if (cur){
    const sameHost = cur.host === HOST, fresh = now - (cur.ts||0) < TTL, alive = sameHost && cur.pid && isPidAlive(cur.pid);
    if (sameHost && !alive) { writeLock(); return true; }
    if (!sameHost && fresh) { console.error("Outra instância ativa no mesmo volume. Abortando."); process.exit(1); }
  }
  writeLock(); return true;
}
if (!tryAcquireLock()){ console.error("Falha ao adquirir lock."); process.exit(1); }
setInterval(writeLock, 30_000);
for (const ev of ["SIGINT","SIGTERM","beforeExit","exit"]) process.on(ev, () => { try {
  const cur = readLock(); if (cur && cur.host===HOST && cur.pid===process.pid) fs.unlinkSync(LOCK_FILE);
} catch {} });

// ---------- Proxy ----------
let _proxyAgent;
async function buildProxyAgent(url) {
  if (!url) return undefined;
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  // >>> AQUI O FIX: passe a URL diretamente (string/URL), NADA de { uri: ... }
  return new HttpsProxyAgent(url);
}
function maskProxy(url){
  try{
    const u = new URL(url);
    const user = u.username ? u.username.slice(0,4)+"***" : "";
    const host = u.hostname ? (u.hostname.length>6 ? u.hostname.slice(0,3)+"***"+u.hostname.slice(-3) : u.hostname) : "";
    return `${u.protocol}//${user?user+":":""}***@${host}:${u.port||""}`;
  }catch{ return "invalid-proxy-url"; }
}

// ---------- Utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function toJid(to){ if (to.endsWith("@s.whatsapp.net") || to.endsWith("@g.us")) return to; return `${to.replace(/\D/g,"")}@s.whatsapp.net`; }
async function sendWA(to,text){ if(!waReady) throw new Error("WhatsApp não conectado"); const jid = toJid(to); const sent = await sock.sendMessage(jid,{ text }); return sent?.key?.id; }
const lastReplyAt = new Map();
function canReply(jid, gap=15_000){ const now=Date.now(), last=lastReplyAt.get(jid)||0; if(now-last<gap) return false; lastReplyAt.set(jid,now); return true; }

// ---------- Watchdog ----------
function armWaWatchdog(){
  if (wdTimer) return;
  wdTimer = setInterval(async () => {
    const stale = Date.now() - waLastOpen > 4*60*1000;
    if (stale || !waReady) { logger.warn({ waReady, stale }, "WA watchdog: restarting socket"); try{ sock?.ws?.close(); }catch{} await safeStartWA(); }
    else { try{ sock?.ws?.ping?.(); }catch{} }
  }, 60_000);
}

// ---------- Start seguro ----------
async function safeStartWA(){
  if (startingWA) return;
  startingWA = true;
  try { try{ sock?.ws?.close(); }catch{} await startWA(); }
  finally { startingWA = false; }
}

// ---------- WhatsApp ----------
async function startWA(){
  const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Baileys version");

  const agent = await buildProxyAgent(PROXY_URL);
  if (PROXY_URL) logger.info({ proxy: maskProxy(PROXY_URL) }, "Usando proxy para HTTPS e WSS");
  else logger.warn("PROXY_URL não definido — tráfego sairá direto");

  sock = baileys.makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Chrome"),
    agent,       // WSS
    fetchAgent: agent, // HTTPS
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000
  });

  sock.ev.on("creds.update", saveCreds);

  // backoff + circuit breaker pra 428
  let reconnectDelay = 1500;
  const MAX_DELAY = 60_000;
  let err428Count = 0;
  const MAX_428 = 3;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr){ globalThis.__lastQR = qr; logger.info("QR atualizado — abra /qr (auto-refresh)"); }

    if (connection === "open"){
      waReady = true; waLastOpen = Date.now(); reconnectDelay = 1500; err428Count = 0;
      logger.info({ WA_AUTH_DIR, PORT }, "WA conectado"); return;
    }

    if (connection === "close"){
      const err = lastDisconnect?.error;
      const status = new Boom(err)?.output?.statusCode;
      const text = String(err || "");
      const isConflict = status===409 || status===440 || text.includes("Stream Errored (conflict)") || text.includes('"conflict"');
      if (status===428 || /Connection (Closed|Terminated)/i.test(text)) err428Count++;

      if (status === DisconnectReason.loggedOut){
        try{ fs.rmSync(WA_AUTH_DIR, { recursive:true, force:true }); }catch{}
        fs.mkdirSync(WA_AUTH_DIR, { recursive:true });
        waReady = false;
        logger.warn({ status }, "Logout detectado — auth resetado; gere novo QR.");
        setTimeout(safeStartWA, 1500); return;
      }

      waReady = false;
      logger.warn({ status, isConflict, err428Count }, "WA desconectado");

      if (err428Count >= MAX_428){
        logger.warn("Muitos 428 seguidos — pausando reconexão por 5 minutos (provável bloqueio da proxy para WSS).");
        setTimeout(() => { err428Count = 0; safeStartWA(); }, 5*60_000);
        return;
      }
      if (!isConflict){
        setTimeout(safeStartWA, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay*2, MAX_DELAY);
      } else {
        logger.error("Sessão substituída — apague a pasta de auth e faça novo pareamento.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages){
      try{
        const fromMe = !!m.key?.fromMe; const jid = m.key?.remoteJid || "";
        if (fromMe) continue; if (!jid || jid.endsWith("@status")) continue;

        const msg =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption || "";

        if (!msg) continue;
        if (!canReply(jid)) continue;

        await sock.presenceSubscribe(jid).catch(()=>{});
        await sock.sendPresenceUpdate("composing", jid).catch(()=>{});
        await sleep(1000 + Math.floor(Math.random()*1200));
        await sock.sendPresenceUpdate("paused", jid).catch(()=>{});
        await sock.sendMessage(jid, { text: "KKKKKKKKKKKKKKKkk" });
      } catch(e){ logger.error(e, "falha no handler de mensagem"); }
    }
  });

  for (const sig of ["SIGINT","SIGTERM"]) process.on(sig, async () => { try{ await saveCreds(); }catch{} });
}

// ---------- HTTP util ----------
app.get("/", (_req,res)=>res.send("ok"));
app.get("/health", (_req,res)=>res.json({ waReady }));

app.get("/qr", (_req,res)=>{
  const qr = globalThis.__lastQR || "";
  if (!qr) return res.status(404).send("QR ainda não gerado. Aguarde reconexão.");
  res.set("content-type", "text/html");
  res.end(`<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>WhatsApp QR</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#fff;font-family:sans-serif} .box{display:grid;gap:10px;place-items:center}</style>
<div class="box"><div id="qrcode"></div><small>Recarrega em 15s</small></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  new QRCode(document.getElementById('qrcode'), { text: ${JSON.stringify(globalThis.__lastQR)}, width: 360, height: 360, correctLevel: QRCode.CorrectLevel.M });
  setTimeout(()=>location.reload(),15000);
</script>`);
});

// Confirma IP via proxy (HTTP)
let _proxyAgent;
async function getProxyAgent(){ if (_proxyAgent!==undefined) return _proxyAgent; _proxyAgent = await buildProxyAgent(PROXY_URL); return _proxyAgent; }
app.get("/debug/proxy-ip", async (_req,res)=>{
  try{
    const agent = await getProxyAgent();
    const req = https.request({ host:"api.ipify.org", path:"/?format=json", agent }, r=>{
      let data=""; r.on("data",d=>data+=d); r.on("end", ()=>res.type("json").send(data));
    });
    req.on("error", e=>res.status(500).send(String(e))); req.end();
  }catch(e){ res.status(500).send(String(e)); }
});

// Testa WEBSOCKET pela proxy (tem que funcionar pro WhatsApp)
app.get("/debug/ws-check", async (_req,res)=>{
  try{
    const agent = await getProxyAgent();
    await new Promise((resolve, reject)=>{
      const ws = new WS("wss://echo.websocket.events", { agent, handshakeTimeout: 8000 });
      const timer = setTimeout(()=>{ try{ ws.terminate(); }catch{}; reject(new Error("timeout")); }, 9000);
      ws.on("open", ()=>{ clearTimeout(timer); try{ ws.close(); }catch{}; resolve(); });
      ws.on("error", err=>{ clearTimeout(timer); reject(err); });
    });
    res.json({ ok:true, msg:"WSS via proxy OK" });
  }catch(e){ res.status(500).json({ ok:false, msg:"WSS via proxy FALHOU", error: String(e) }); }
});

// /test/wa?to=55...&text=...
app.get("/test/wa", async (req,res)=>{
  try{ const id = await sendWA(req.query.to, req.query.text || "Teste OK"); res.json({ ok:true, id }); }
  catch(e){ res.status(500).json({ ok:false, error: e?.message || String(e) }); }
});

// ---------- Boot ----------
(async ()=>{
  tryAcquireLock();
  armWaWatchdog();
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") logger.warn("NODE_TLS_REJECT_UNAUTHORIZED=0 torna conexões inseguras — remova essa env.");
  await safeStartWA();
  app.listen(PORT, ()=>logger.info({ PORT, WA_AUTH_DIR }, "ZapBot up"));
})();
