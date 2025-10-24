# Dockerfile robusto
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# toolchain + git p/ eventuais builds nativos / deps via git
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ajuda em redes instáveis
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 60000 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set legacy-peer-deps true \
 && npm config set registry https://registry.npmjs.org/

COPY package*.json ./

# se houver lock usa ci; se não, cai para install
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund --legacy-peer-deps --no-optional ; \
    else \
      npm install --no-audit --no-fund --legacy-peer-deps --no-optional ; \
    fi

COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node","app.js"]
