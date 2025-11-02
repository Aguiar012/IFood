FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN ls -la / && ls -la /app


RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*

# package*.json está na RAIZ do repo (build context = /), por isso funciona:
COPY package*.json ./
RUN npm ci --omit=dev --no-optional && npm i -g pm2

# copie só o que precisa para os dois bots + ecosystem
COPY whatsapp/aviso_suap ./whatsapp/aviso_suap
COPY whatsapp/chatbot   ./whatsapp/chatbot
COPY whatsapp/ecosystem.config.js ./ecosystem.config.js

EXPOSE 3000 3001
# pm2-runtime é a forma recomendada de PM2 em Docker
CMD ["pm2-runtime","ecosystem.config.js"]
