# Dockerfile
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependências que alguns pacotes exigem em build
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Flags para evitar conflitos de peer deps e libs opcionais
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps --no-optional

COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node","app.js"]
