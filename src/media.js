/**
 * Файлы клиентов: фото и видео квартир. Лежат в data/media.
 * Из видео берём несколько кадров по всему ролику — так модель «видит»
 * все комнаты, а не только прихожую с первой секунды.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const DIR = path.join(process.cwd(), 'data', 'media');
fs.mkdirSync(DIR, { recursive: true });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const FRAMES = 4;

export const mediaPath = (file) => path.join(DIR, path.basename(file));

/**
 * input — Buffer или поток. Видео пишем потоком прямо на диск:
 * ролик из WhatsApp бывает на десятки мегабайт, а памяти на сервере 512 МБ.
 */
export async function saveMedia(input, mime, kind) {
  const id = crypto.randomUUID();
  const file = `${id}.${EXT[mime] ?? (kind === 'video' ? 'mp4' : 'jpg')}`;
  if (Buffer.isBuffer(input)) await fs.promises.writeFile(mediaPath(file), input);
  else await pipeline(input, fs.createWriteStream(mediaPath(file)));

  const item = { file, mime, kind };
  if (kind === 'video') {
    const frames = await videoFrames(file, id);
    if (frames.length) { item.frames = frames; item.frame = frames[0]; }
  }
  return item;
}

/** Кадры на 10, 35, 60 и 85% длины ролика. Нет ffmpeg — не страшно, менеджер посмотрит сам. */
async function videoFrames(file, id) {
  let dur = 0;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath(file)]);
    dur = Number(stdout) || 0;
  } catch {}
  const points = dur > 4 ? [0.1, 0.35, 0.6, 0.85].slice(0, FRAMES).map((k) => k * dur) : [Math.min(1, dur / 2)];
  const out = [];
  for (const [i, t] of points.entries()) {
    const frame = `${id}-frame${i}.jpg`;
    try {
      await run('ffmpeg', ['-y', '-ss', t.toFixed(2), '-i', mediaPath(file), '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', mediaPath(frame)]);
      out.push(frame);
    } catch {}
  }
  return out;
}

/** Что показывать модели: для видео — все извлечённые кадры, для фото — само фото. */
export async function asImages(item) {
  const files = item.kind === 'video' ? (item.frames ?? (item.frame ? [item.frame] : [])) : [item.file];
  const out = [];
  for (const f of files) {
    try {
      const buf = await fs.promises.readFile(mediaPath(f));
      out.push({ mime: item.kind === 'video' ? 'image/jpeg' : item.mime, base64: buf.toString('base64') });
    } catch {}
  }
  return out;
}
export const asImage = async (item) => (await asImages(item))[0] ?? null;
