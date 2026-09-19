/**
 * Расшифровка голосовых. Claude аудио не принимает, поэтому голос сначала
 * превращаем в текст отдельным сервисом с OpenAI-совместимым /audio/transcriptions:
 * Groq (whisper-large-v3-turbo, бесплатный тариф — 8 часов аудио в сутки) или OpenAI.
 */
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mediaPath } from './media.js';

const run = promisify(execFile);
const BASE = (process.env.STT_BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.STT_KEY || '';
const MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';

export const sttConfigured = () => Boolean(BASE);
export const sttLabel = () => (BASE ? `${new URL(BASE).host} · ${MODEL}` : 'не настроено');

/** Голосовые из WhatsApp приходят в opus/ogg — перегоняем в mp3: его принимают все сервисы. */
const resolve = (file) => (path.isAbsolute(file) ? file : mediaPath(file));

async function toMp3(file) {
  const out = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp3`);
  await run('ffmpeg', ['-y', '-i', resolve(file), '-ac', '1', '-ar', '16000', '-b:a', '64k', out]);
  return out;
}

/** С таймкодами: нужно, чтобы слова клиента легли на кадры того же момента видео. */
export async function transcribeSegments(file, lang = '') {
  const data = await post(file, lang, 'verbose_json');
  const segments = (data.segments ?? []).map((s) => ({
    start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim()
  })).filter((s) => s.text);
  return { text: String(data.text ?? '').trim(), segments };
}

export async function transcribe(file, lang = '') {
  return String((await post(file, lang, 'json')).text ?? '').trim();
}

async function post(file, lang, format) {
  if (!BASE) throw new Error('расшифровка не настроена (STT_BASE_URL)');
  const mp3 = await toMp3(file);
  try {
    const form = new FormData();
    form.append('file', new Blob([await fs.promises.readFile(mp3)], { type: 'audio/mpeg' }), 'voice.mp3');
    form.append('model', MODEL);
    form.append('response_format', format);
    // подсказка языка: по короткому голосовому распознавание путает русский с украинским
    if (lang) form.append('language', lang);
    const r = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status}: ${String(data.error?.message ?? JSON.stringify(data)).slice(0, 200)}`);
    return data;
  } finally {
    fs.rm(mp3, { force: true }, () => {});
  }
}
