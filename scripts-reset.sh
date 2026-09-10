#!/bin/sh
# Чистит диалоги и фото. Привязку WhatsApp (data/wa-auth) не трогает.
# Если сервер запущен, он держит открытым старый файл базы и после очистки
# продолжит писать в него — поэтому сначала останавливаем.
if lsof -nP -iTCP:"${PORT:-3000}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Сервер запущен на порту ${PORT:-3000}. Останови его, потом повтори:"
  echo "  pkill -f 'src/server.js' && npm run reset && npm start"
  exit 1
fi
rm -rf data/app.db data/app.db-wal data/app.db-shm data/media
echo "База и фото очищены. Привязка WhatsApp сохранена."
