/**
 * Адаптеры каналов. Выбор — переменной CHANNEL: mock | meta | waha
 * Интерфейс одинаковый, поэтому логика бота от провайдера не зависит.
 */

/* ── mock: локальный симулятор (страница /sim), ничего никуда не уходит ── */
const mock = {
  name: 'mock',
  ready: () => true,
  async send() {
    return { wa_id: 'mock-' + Date.now() };
  },
  parse(body) {
    if (!body?.from || !body?.text) return [];
    return [{ phone: String(body.from), name: body.name || null, text: String(body.text),
              wa_id: 'sim-' + Date.now(), chat_id: String(body.from) }];
  }
};

/* ── meta: официальный WhatsApp Cloud API ── */
const meta = {
  name: 'meta',
  ready: () => Boolean(process.env.META_TOKEN && process.env.META_PHONE_ID),
  async send(conv, text) {
    const url = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_ID}/messages`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.META_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conv.phone,
        type: 'text',
        text: { preview_url: false, body: text }
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Meta API ${r.status}: ${JSON.stringify(data)}`);
    return { wa_id: data.messages?.[0]?.id ?? null };
  },
  parse(body) {
    const out = [];
    for (const entry of body?.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        const v = ch.value ?? {};
        const profiles = Object.fromEntries((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages ?? []) {
          if (m.type !== 'text') continue;             // для теста берём только текст
          out.push({ phone: m.from, name: profiles[m.from] ?? null, text: m.text.body, wa_id: m.id });
        }
      }
    }
    return out;
  }
};

/* ── waha: self-hosted шлюз «через зеркало» (WhatsApp Web по QR) ── */
const waha = {
  name: 'waha',
  ready: () => Boolean(process.env.WAHA_URL),
  async send(conv, text) {
    const r = await fetch(`${process.env.WAHA_URL.replace(/\/$/, '')}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.WAHA_API_KEY ? { 'X-Api-Key': process.env.WAHA_API_KEY } : {})
      },
      body: JSON.stringify({
        session: process.env.WAHA_SESSION || 'default',
        // отвечаем ровно в тот chatId, который прислал WAHA: движок может
        // отдавать <id>@lid вместо <номер>@c.us, и собранный из цифр id не дойдёт
        chatId: conv.chat_id || `${String(conv.phone).replace(/\D/g, '')}@c.us`,
        text
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`WAHA ${r.status}: ${JSON.stringify(data)}`);
    return { wa_id: data.id?._serialized ?? data.id ?? null };
  },
  parse(body) {
    if (body?.event !== 'message') return [];
    const p = body.payload ?? {};
    if (p.fromMe) return [];
    const text = p.body ?? p.text;
    if (!text) return [];
    const chatId = String(p.from || '');
    // на @lid цифры из id — не телефон; настоящий номер берём из _data, если он есть
    const phone = chatId.endsWith('@lid')
      ? (p._data?.from?.user ?? p._data?.author?.user ?? chatId)
      : chatId.split('@')[0];
    return [{ phone, name: p._data?.notifyName ?? p.notifyName ?? null, text,
              wa_id: typeof p.id === 'string' ? p.id : (p.id?._serialized ?? null), chat_id: chatId }];
  }
};

import { baileys } from './baileys.js';

const all = { mock, meta, waha, baileys };
export const channel = all[process.env.CHANNEL || 'mock'] ?? mock;
export const channels = all;

/**
 * Отправлять надо туда, откуда сообщение пришло. Диалоги из симулятора помечены
 * каналом 'mock' — иначе ответ на выдуманный номер ушёл бы реальному человеку.
 */
export const adapterFor = (conv) => all[conv?.channel] ?? channel;
