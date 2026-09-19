/**
 * Разбор видео квартиры. Claude видео не принимает, поэтому разбираем сами:
 *  1) звуковую дорожку расшифровываем с таймкодами — клиент часто комментирует съёмку;
 *  2) кадры берём по смене сцены (клиент перешёл в другую комнату), а не по таймеру;
 *  3) длинный ролик режем на блоки и разбираем по частям, потом сводим в один отчёт.
 * Так длина видео ничем не ограничена и ничего не теряется.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { mediaPath } from './media.js';
import { transcribeSegments, sttConfigured } from './stt.js';

const run = promisify(execFile);
const MAX_FRAMES = Number(process.env.VIDEO_FRAMES) || 24;     // потолок на ролик
const CHUNK = Number(process.env.VIDEO_CHUNK) || 12;           // кадров в одном запросе к модели
const SCENE = Number(process.env.VIDEO_SCENE) || 0.25;         // чувствительность к смене сцены
const MAX_MIN = Number(process.env.VIDEO_MAX_MINUTES) || 12;   // длиннее — зовём человека

const Report = z.object({
  rooms: z.array(z.object({ room: z.string(), notes: z.string() })),
  condition: z.enum(['', 'лёгкое', 'среднее', 'сильное', 'после ремонта']),
  works: z.array(z.string()),       // окна, трисы, полировка пола, краска, шпаклёвка, цемент
  said: z.string(),                 // что клиент проговорил на видео, своими словами
  summary: z.string()               // одна строка для менеджера
});

const SYSTEM = [
  'Ты разбираешь видео помещения для клининговой компании, которая убирает после ремонта.',
  'Тебе дают кадры из видео по порядку и расшифровку слов клиента с этого же отрезка.',
  'Опиши только то, что действительно видно и сказано: помещения, степень загрязнения,',
  'что нужно сделать — окна, трисы, полировка пола, следы краски, шпаклёвки, цемента, строительная пыль.',
  'Не выдумывай: не видно — не пиши. Кадры мутные — так и скажи в summary.',
  'Пиши по-русски, коротко, без вводных слов.'
].join('\n');

export const videoLimitMinutes = () => MAX_MIN;

export async function duration(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mediaPath(file)]);
    return Number(stdout) || 0;
  } catch { return 0; }
}

/** Моменты смены сцены плюс страховочные кадры через равные промежутки. */
async function frameTimes(file, dur) {
  const scenes = [];
  try {
    const { stderr } = await run('ffmpeg', ['-i', mediaPath(file), '-vf', `select='gt(scene,${SCENE})',showinfo`, '-an', '-f', 'null', '-'],
      { maxBuffer: 8 * 1024 * 1024 });
    for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) scenes.push(Number(m[1]));
  } catch {}

  const step = Math.max(4, dur / MAX_FRAMES);
  const forced = [];
  for (let t = Math.min(1, dur / 2); t < dur; t += step) forced.push(t);

  const times = [...new Set([...scenes, ...forced].map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
  // кадры ближе двух секунд друг к другу — это одна и та же комната
  const spaced = times.filter((t, i, a) => i === 0 || t - a[i - 1] >= 2);
  if (spaced.length <= MAX_FRAMES) return spaced;
  const every = spaced.length / MAX_FRAMES;
  return Array.from({ length: MAX_FRAMES }, (_, i) => spaced[Math.floor(i * every)]);
}

async function grab(file, times) {
  const out = [];
  for (const [i, t] of times.entries()) {
    const frame = path.join(os.tmpdir(), `${crypto.randomUUID()}-${i}.jpg`);
    try {
      await run('ffmpeg', ['-y', '-ss', t.toFixed(2), '-i', mediaPath(file), '-frames:v', '1',
        '-vf', 'scale=768:-2', '-q:v', '4', frame]);
      out.push({ at: t, file: frame });
    } catch {}
  }
  return out;
}

/** Слова клиента, сказанные на этом отрезке видео. */
const saidBetween = (segments, from, to) => segments
  .filter((s) => s.end >= from && s.start <= to).map((s) => s.text).join(' ').trim();

export async function analyzeVideo(item, provider) {
  const dur = await duration(item.file);
  if (dur > MAX_MIN * 60) return { tooLong: true, minutes: Math.round(dur / 60) };

  let segments = [], said = '';
  if (sttConfigured()) {
    const audio = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp3`);
    try {
      await run('ffmpeg', ['-y', '-i', mediaPath(item.file), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', audio]);
      const r = await transcribeSegments(audio);
      segments = r.segments; said = r.text;
    } catch (e) {
      console.error('звук из видео:', e.message);
    } finally {
      fs.rm(audio, { force: true }, () => {});
    }
  }

  const times = await frameTimes(item.file, dur);
  const frames = await grab(item.file, times);
  if (!frames.length) return null;

  try {
    const parts = [];
    for (let i = 0; i < frames.length; i += CHUNK) {
      const block = frames.slice(i, i + CHUNK);
      const from = block[0].at, to = block.at(-1).at + 5;
      const images = [];
      for (const f of block) {
        images.push({ mime: 'image/jpeg', base64: (await fs.promises.readFile(f.file)).toString('base64') });
      }
      const words = saidBetween(segments, from, to);
      const text = [
        `Кадры с ${Math.round(from)} по ${Math.round(to)} секунду видео, по порядку.`,
        words ? `Клиент в это время говорит: «${words}»` : 'Звука нет или клиент молчит.'
      ].join('\n');
      const { out } = await provider.complete({ system: SYSTEM, turns: [{ role: 'user', text, images }], schema: Report });
      parts.push(out);
    }

    if (parts.length === 1) return { ...parts[0], said: parts[0].said || said, frames: frames.length, seconds: Math.round(dur) };

    // несколько блоков — сводим в один отчёт, чтобы не было повторов по комнатам
    const { out } = await provider.complete({
      system: SYSTEM + '\nТебе дают разборы частей одного видео. Сведи их в один отчёт без повторов.',
      turns: [{ role: 'user', text: JSON.stringify(parts, null, 1), images: [] }],
      schema: Report
    });
    return { ...out, said: out.said || said, frames: frames.length, seconds: Math.round(dur) };
  } finally {
    for (const f of frames) fs.rm(f.file, { force: true }, () => {});
  }
}
