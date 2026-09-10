# Образ для хостинга (Render и любой другой с Docker).
# Node 24 LTS: встроенный node:sqlite работает без флагов.
FROM node:24-slim

# ffmpeg — кадр из присланного видео, чтобы ИИ «увидел» комнату
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    # при 512 МБ на тарифе оставляем запас ffmpeg и самому процессу
    NODE_OPTIONS=--max-old-space-size=384

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# база, фото и ключи WhatsApp живут в /app/data — сюда монтируется постоянный диск
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
