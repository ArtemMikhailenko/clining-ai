/**
 * Расшифровка голосовых. Claude аудио не принимает, поэтому голос сначала
 * превращаем в текст отдельным сервисом с OpenAI-совместимым /audio/transcriptions:
 * Groq (whisper-large-v3-turbo, бесплатный тариф — 8 часов аудио в сутки) или OpenAI.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mediaPath } from './media.js';

const run = promisify(execFile);
const BASE = (process.env.STT_BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.STT_KEY || '';
const MODEL = process.env.STT_MODEL || 'whisper-large-v3-turbo';

export const sttConfigured = () => Boolean(BASE);
export const sttLabel = () => (BASE ? `${new URL(BASE).host} · ${MODEL}` : 'не настроено');

/** Голосовые из WhatsApp приходят в opus/ogg — перегоняем в mp3: его принимают все сервисы. */
async function toMp3(file) {
  const out = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp3`);
  await run('ffmpeg', ['-y', '-i', mediaPath(file), '-ac', '1', '-ar', '16000', '-b:a', '64k', out]);
  return out;
}

export async function transcribe(file) {
  if (!BASE) throw new Error('расшифровка не настроена (STT_BASE_URL)');
  const mp3 = await toMp3(file);
  try {
    const form = new FormData();
    form.append('file', new Blob([await fs.promises.readFile(mp3)], { type: 'audio/mpeg' }), 'voice.mp3');
    form.append('model', MODEL);
    form.append('response_format', 'json');
    const r = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status}: ${String(data.error?.message ?? JSON.stringify(data)).slice(0, 200)}`);
    return String(data.text ?? '').trim();
  } finally {
    fs.rm(mp3, { force: true }, () => {});
  }
}
