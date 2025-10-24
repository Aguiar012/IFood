FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# copie SOMENTE os manifests pra aproveitar cache
COPY package*.json ./

RUN npm config set legacy-peer-deps true \
 && if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-optional ; \
    else \
      npm install --omit=dev --no-optional ; \
    fi

# agora copie o resto do código
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node","app.js"]
