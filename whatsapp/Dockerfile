FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN ls -la / && ls -la /app


RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*

# package*.json está na RAIZ do repo (build context = /), por isso funciona:
COPY package*.json ./

# instala dependências mesmo sem lockfile e evita conflitos de peer deps
RUN npm config set legacy-peer-deps true \
 && npm config set audit false \
 && npm config set fund false \
 && if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-optional; \
    else \
      npm install --omit=dev --no-optional; \
    fi \
 && npm i -g pm2@latest

# copie só o que precisa para os dois bots + ecosystem
COPY whatsapp/aviso_suap ./whatsapp/aviso_suap
COPY whatsapp/bot        ./whatsapp/bot
COPY whatsapp   ./whatsapp
COPY whatsapp/pm2_config.cjs ./ecosystem.config.cjs

EXPOSE 3000 3001
# pm2-runtime é a forma recomendada de PM2 em Docker
CMD ["pm2-runtime","ecosystem.config.cjs"]
