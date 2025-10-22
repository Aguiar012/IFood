// CommonJS para rodar fácil no Actions sem config extra
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = process.env.WA_AUTH_DIR || 'wa_auth';
const TO = (process.env.WA_TO || '5511932291930').replace(/[^\d]/g, ''); // seu número em E.164
const MSG = process.env.WA_TEXT || 'Teste do GitHub Actions ✅';

async function waitConnectionOpen(sock) {
  return new Promise((resolve, reject) => {
    const onUpdate = (u) => {
      if (u.qr) {
        // mostra QR no log (abra os logs do job e escaneie na 1ª vez)
        qrcode.generate(u.qr, { small: true });
        console.log('👉 Escaneie o QR acima no WhatsApp: Menu > Aparelhos conectados > Conectar aparelho');
      }
      if (u.connection === 'open') {
        sock.ev.off('connection.update', onUpdate);
        resolve();
      }
      if (u.connection === 'close') {
        const reason = u.lastDisconnect?.error?.output?.statusCode;
        reject(new Error(`Conexão fechada. Motivo: ${reason ?? 'desconhecido'}`));
      }
    };
    sock.ev.on('connection.update', onUpdate);
  });
}

async function main() {
  // garante diretório de sessão
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR); // sessão em múltiplos arquivos
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // usamos qrcode-terminal manualmente
    browser: ['IFood-Bot', 'Chrome', '1.0']
  });

  sock.ev.on('creds.update', saveCreds);

  // conecta (na 1ª vez vai exibir QR)
  await waitConnectionOpen(sock);

  const jid = `${TO}@s.whatsapp.net`;
  const sent = await sock.sendMessage(jid, { text: MSG });
  console.log('✅ Mensagem enviada:', sent.key.id);

  // aguarda salvar credenciais e fecha
  await new Promise((r) => setTimeout(r, 1000));
  try { await sock.ws.close(); } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error('Erro:', e?.message || e);
  process.exit(1);
});
