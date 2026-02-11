FROM node:20-alpine

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

# Expose se tiver servidor web (opcional, mas bom pra health check)
EXPOSE 3001

# Comando de inicio
CMD ["npm", "start"]
