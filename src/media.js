/**
 * Файлы клиентов: фото планировок и комнат. Лежат в data/media,
 * из видео берём кадр — так модель может «посмотреть» и видео тоже.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DIR = path.join(process.cwd(), 'data', 'media');
fs.mkdirSync(DIR, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

export const mediaPath = (file) => path.join(DIR, path.basename(file));

export async function saveMedia(buffer, mime, kind) {
  const id = crypto.randomUUID();
  const file = `${id}.${EXT[mime] ?? (kind === 'video' ? 'mp4' : 'jpg')}`;
  await fs.promises.writeFile(mediaPath(file), buffer);

  const item = { file, mime, kind };

  if (kind === 'video') {
    // кадр из середины первых секунд — по нему модель поймёт, что на видео
    const frame = `${id}-frame.jpg`;
    try {
      await run('ffmpeg', ['-y', '-ss', '1', '-i', mediaPath(file), '-frames:v', '1', '-vf', 'scale=1024:-1', mediaPath(frame)]);
      item.frame = frame;
    } catch {
      // ffmpeg нет или видео короче секунды — не критично, менеджер посмотрит сам
    }
  }
  return item;
}

/** Что показывать модели: для видео — извлечённый кадр. */
export async function asImage(item) {
  const file = item.kind === 'video' ? item.frame : item.file;
  if (!file) return null;
  const buf = await fs.promises.readFile(mediaPath(file));
  return { mime: item.kind === 'video' ? 'image/jpeg' : item.mime, base64: buf.toString('base64') };
}
