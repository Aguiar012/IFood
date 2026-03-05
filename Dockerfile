FROM node:20-alpine

# Fontes para renderização de imagem (satori/resvg)
RUN apk add --no-cache fontconfig ttf-liberation

# Cria diretorio de trabalho
WORKDIR /app

# Copia dependencias primeiro para cachear layer
COPY package*.json ./

# Instala dependencias de producao
RUN npm ci --only=production

# Copia o restante do codigo
COPY . .

# Cria diretorio para persistencia (auth)
RUN mkdir -p dados_bot/auth

EXPOSE 3001

CMD ["npm", "start"]
