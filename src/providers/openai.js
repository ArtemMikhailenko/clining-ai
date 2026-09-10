/**
 * Любой провайдер с OpenAI-совместимым /chat/completions.
 * Проверенные базовые URL — в README (Gemini, Groq, Cerebras, OpenRouter, Ollama).
 */
import { z } from 'zod';

const BASE = (process.env.AI_BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.AI_API_KEY || 'none';       // Ollama ключ не проверяет
const MODEL = process.env.AI_MODEL || 'gemini-2.5-flash';

export const configured = () => Boolean(BASE);
export const label = () => `${new URL(BASE || 'http://none').host} · ${MODEL}`;

// 429 — упёрлись в лимит, 5xx — временный сбой провайдера.
// На бесплатных тарифах 503 «high demand» прилетает регулярно, и без повтора
// каждый такой случай сбрасывал бы диалог на живого менеджера.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRIES = Number(process.env.AI_RETRIES ?? 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(body, attempt = 1) {
  let r;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body)
    });
  } catch (e) {
    // сеть отвалилась — тоже повод повторить
    if (attempt > RETRIES) throw e;
    await sleep(attempt * 1500);
    return call(body, attempt + 1);
  }

  const data = await r.json().catch(() => ({}));
  if (r.ok) return data;

  if (RETRYABLE.has(r.status) && attempt <= RETRIES) {
    // 429 — это чаще всего лимит запросов в МИНУТУ, ждать полторы секунды бессмысленно.
    // 5xx — временный сбой, он проходит быстро.
    const fallback = r.status === 429 ? attempt * 15000 : attempt * 1500;
    const wait = Number(r.headers.get('retry-after')) * 1000 || fallback;
    console.log(`[ai] ${r.status} от провайдера, повтор через ${Math.round(wait / 100) / 10} с (попытка ${attempt}/${RETRIES})`);
    await sleep(wait);
    return call(body, attempt + 1);
  }

  // раньше тут резалось до 300 символов и настоящая причина (какая именно квота
  // кончилась) не доходила до лога — теперь достаём сообщение целиком
  const e = (Array.isArray(data) ? data[0]?.error : data?.error) ?? {};
  const quota = /limit: (\d+)/.exec(e.message ?? '');
  const human = r.status === 429 && quota
    ? `исчерпан лимит модели: ${quota[1]} запросов в сутки`
    : (e.message ?? JSON.stringify(data)).replace(/\s+/g, ' ').slice(0, 400);

  const err = new Error(`${r.status}: ${human}`);
  err.status = r.status;
  throw err;
}

const toMessage = (t) => ({
  role: t.role,
  content: t.images?.length
    ? [
        ...t.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } })),
        ...(t.text ? [{ type: 'text', text: t.text }] : [])
      ]
    : t.text
});

export async function complete({ system, turns, schema }) {
  const jsonSchema = z.toJSONSchema(schema);
  const messages = [{ role: 'system', content: system }, ...turns.map(toMessage)];
  const base = { model: MODEL, messages, temperature: 0.4, max_tokens: 1500 };

  let data;
  try {
    data = await call({
      ...base,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: jsonSchema } }
    });
  } catch (e) {
    // не все совместимые провайдеры поддерживают json_schema — откатываемся на json_object
    if (e.status !== 400) throw e;   // 400 = схема не поддержана; всё остальное уже отретраено
    data = await call({
      ...base,
      messages: [
        { role: 'system', content: system + '\n\nОтвечай ТОЛЬКО валидным JSON по схеме:\n' + JSON.stringify(jsonSchema) },
        ...turns.map(toMessage)
      ],
      response_format: { type: 'json_object' }
    });
  }

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('провайдер вернул пустой ответ');

  let parsed;
  try {
    // некоторые модели заворачивают JSON в ```json … ```
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    throw new Error('ответ не разобрался как JSON: ' + text.slice(0, 200));
  }

  const check = schema.safeParse(parsed);
  if (!check.success) throw new Error('ответ не по схеме: ' + check.error.issues.map((i) => i.path.join('.')).join(', '));

  const u = data.usage ?? {};
  return { out: check.data, usage: { in: u.prompt_tokens, cached: 0, out: u.completion_tokens } };
}
