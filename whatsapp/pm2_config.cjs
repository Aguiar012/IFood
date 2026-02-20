module.exports = {
  apps: [
    {
      name: "aviso_suap",
      cwd: '/app',
      // Este arquivo(avisador_suap.js) não foi refatorado pois não estava no escopo explícito da lista de arquivos
      // Mas se o usuário quiser, podemos traduzir depois.Por enquanto mantém.
      script: "whatsapp/aviso_suap/avisador_suap.js",
      autorestart: true,
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
      cwd: '/app',
      // Atualizado para o novo arquivo traduzido
      script: "whatsapp/bot/servidor_bot.js",
      autorestart: true,
      // Configurações importantes para estabilidade:
      max_memory_restart: '400M', // Reinicia se vazar memória
      exp_backoff_restart_delay: 100, // Espera um pouco mais a cada erro
      env: {
        // ... seus envs ...
        PORT: 3001,
        DATA_DIR: "/app/data",
        WA_AUTH_DIR: "/app/data/wa_auth_zapbot",
        // Força node a não rejeitar certificados antigos se houver proxy
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        GMAIL_USER: "if.food.automatizacao@gmail.com",
        GMAIL_APP_PASSWORD: "rtqg sqvf avoy okba",
        CAE_EMAIL: "aguiartiago012@gmail.com"
      }
    }
  ]

};
