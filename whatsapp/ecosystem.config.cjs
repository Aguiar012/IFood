module.exports = {
  apps: [
    {
      name: "aviso_suap",
      script: "whatsapp/aviso_suap/avisador_suap.js",
      env: {
        PORT: "3000",
        WA_AUTH_DIR: "/app/data/wa_auth_suap",
        STATE_PATH: "/app/data/state_suap.json",
        SCORES_PATH: "/app/data/state/scores_suap.json"
      }
    },
    {
      name: "zapbot",
      script: "whatsapp/chatbot/conversa_zap.js",
      env: {
        PORT: "3001",
        WA_AUTH_DIR: "/app/data/wa_auth_zapbot"
      }
    }
  ]
};
