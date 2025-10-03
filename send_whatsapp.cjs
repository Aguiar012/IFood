// send_whatsapp.cjs
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const QRPNG = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { executablePath } = require('puppeteer');

const TO = (process.env.WHATSAPP_TO || process.env.INPUT_PHONE || process.env.PHONE || '').trim();
const MESSAGE = (process.env.WHATSAPP_MESSAGE || process.env.INPUT_MESSAGE || process.env.MESSAGE || 'Olá do GitHub Actions').trim();

if (!TO) {
  console.error('ERRO: defina WHATSAPP_TO (ex.: 5511932291930).');
  process.exit(2);
}

const AUTH_DIR = path.resolve('.wwebjs_auth'); // persistido via cache
const AUTH_WINDOW_MS = 3 * 60 * 1000; // 3 min p/ escanear QR na 1ª vez
let authTimer = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }), // .wwebjs_auth por padrão
  puppeteer: {
    headless: true,
    executablePath: executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

// Gera QR no log e em PNG (artefato)
client.on('qr', async (qr) => {
  console.log('--- ESCANEIE ESTE QR A PARTIR DO APP DO WHATSAPP ---');
  qrcodeTerminal.generate(qr, { small: true });
  try {
    const out = '/tmp/whatsapp-qr.png';
    await QRPNG.toFile(out, qr, { scale: 8, margin: 2 });
    console.log(`QR salvo em: ${out} (será enviado como artifact)`);
  } catch (e) {
    console.warn('Falha ao salvar PNG do QR:', e.message);
  }
  if (!authTimer) {
    authTimer = setTimeout(() => {
      console.error('Tempo de autenticação excedido (QR não escaneado em 3 min).');
      process.exit(1);
    }, AUTH_WINDOW_MS);
  }
});

client.on('authenticated', () => console.log('Autenticado.'));
client.on('auth_failure', (m) => console.error('Falha de auth:', m));
client.on('disconnected', (r) => console.error('Desconectado:', r));

client.on('ready', async () => {
  if (authTimer) clearTimeout(authTimer);
  console.log('Cliente pronto. Validando número e enviando...');

  try {
    // getNumberId retorna null se o número não tem WhatsApp
    const numberId = await client.getNumberId(TO); // aceita número "limpo" (sem +)
    // Alternativa: `${TO}@c.us`
    if (!numberId) {
      console.error(`O número ${TO} não está registrado no WhatsApp (getNumberId=null).`);
      await client.destroy();
      process.exit(3);
    }

    const result = await client.sendMessage(numberId._serialized, MESSAGE);
    console.log('Mensagem enviada. ID:', result?.id?._serialized || '(sem id)');
    await client.destroy();
    process.exit(0);
  } catch (e) {
    console.error('Erro ao enviar:', e);
    try { await client.destroy(); } catch {}
    process.exit(4);
  }
});

(async () => {
  // Garantir diretório da sessão
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await client.initialize();
})();
