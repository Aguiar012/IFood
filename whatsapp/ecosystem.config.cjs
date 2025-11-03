module.exports = {
apps: [
  {
    name: "aviso_suap",
    script: "whatsapp/aviso_suap/avisador_suap.js",
    env: {
      PORT: 3000,
      DATA_DIR: "/app/data",
      WA_AUTH_DIR: "/app/data/wa_auth_suap",
      STATE_PATH: "/app/data/state_suap.json",
      SCORES_PATH: "/app/data/state/scores_suap.json",
      LOCK_FILE: "/app/data/locks/suap.lock.json"
    }
  },
  {
    name: "conversazap",
    script: "whatsapp/chatbot/conversa_zap.js",
    env: {
      PORT: 3001,
      DATA_DIR: "/app/data",
      WA_AUTH_DIR: "/app/data/wa_auth_zapbot",
      LOCK_FILE: "/app/data/locks/conversazap.lock.json"
    }
  }
]

};
