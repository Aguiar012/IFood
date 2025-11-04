// config/paths.js
import fs from "fs";
import path from "path";

function appKey() {
  // Deriva do nome do arquivo de entrada (ex.: conversazap/index.js -> "conversazap")
  const entry = path.basename(process.argv[1] || "app.js");
  const base = entry.replace(/\.[^.]+$/, ""); // sem extensão
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

const APP_KEY = process.env.APP_KEY || appKey(); // sem secrets, auto
const BASE = "/app/data";
const DATA_DIR = path.join(BASE, APP_KEY);
const WA_AUTH_DIR = path.join(DATA_DIR, "wa_auth");
const STATE_DIR = path.join(DATA_DIR, "state");
const STATE_FILE = path.join(DATA_DIR, `state_${APP_KEY}.json`);
const SCORES_FILE = path.join(STATE_DIR, `scores_${APP_KEY}.json`);
const LOCK_FILE = path.join(DATA_DIR, `.lock-${APP_KEY}`);

for (const p of [DATA_DIR, WA_AUTH_DIR, STATE_DIR]) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

export default { APP_KEY, BASE, DATA_DIR, WA_AUTH_DIR, STATE_DIR, STATE_FILE, SCORES_FILE, LOCK_FILE };
