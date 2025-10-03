const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const CLIENT_ID = process.env.CLIENT_ID || 'almo-pt';
const SESSION_DIR = process.env.SESSION_DIR || '.wwebjs_auth';

console.log('MODO: login');
console.log('SESSION_DIR:', SESSION_DIR);
console.log('CLIENT_ID:', CLIENT_ID);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  console.log('QR GERADO: ESCANEIE ABAIXO');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('LOGIN OK (ready). Sessão criada/atualizada.');
  // Mantenha o processo vivo um pouquinho para garantir flush do FS
  setTimeout(() => process.exit(0), 2000);
});

client.on('auth_failure', m => {
  console.error('FALHA DE AUTH:', m);
  process.exit(1);
});

client.initialize();
