# Dockerfile ultra-tolerante
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# toolchain para possíveis builds nativos + git
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Copia tudo primeiro (vamos instalar em runtime)
COPY . .

# Dicas ao npm para reduzir conflitos e dar verbosidade
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_LOGLEVEL=verbose \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000

ENV PORT=3000
EXPOSE 3000

# 1) tenta npm ci se existir lock; 2) cai para npm install;
# 3) se der ruim, tenta novamente com --force; 4) inicia o app
CMD bash -lc '\
  if [ -f package-lock.json ]; then \
    echo ">> npm ci"; npm ci --no-optional || (echo ">> npm ci falhou, tentando npm install" && npm install --no-optional); \
  else \
    echo ">> npm install"; npm install --no-optional || (echo ">> npm install falhou, tentando com --force" && npm install --no-optional --force); \
  fi && \
  echo ">> deps instaladas, iniciando app" && node app.js'
