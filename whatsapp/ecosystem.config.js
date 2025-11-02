// roda dois apps no mesmo container, cada um com sua porta e pasta de sessão
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
        // (o resto dos ENVs globais virá do serviço na Northflank)
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
