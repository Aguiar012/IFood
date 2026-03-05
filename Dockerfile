FROM node:20-alpine

# Fontes para renderização de imagem (satori/resvg)
RUN apk add --no-cache fontconfig ttf-liberation

# Cria diretorio de trabalho
WORKDIR /app

# Copia dependencias e script de patch primeiro para cachear layer
COPY package*.json ./
COPY scripts/ ./scripts/

# Instala dependencias de producao
RUN npm ci --only=production

# Aplica patch no Baileys (fix ENOENT no upload de mídia)
RUN node scripts/patch-baileys.js

# Copia o restante do codigo
COPY . .

# Cria diretorio para persistencia (auth) e tmp para media do Baileys
RUN mkdir -p dados_bot/auth /tmp

EXPOSE 3001

CMD ["npm", "start"]
