/**
 * Уведомления менеджеру. Бот передал заявку человеку — об этом должны узнать
 * сразу, а не когда кто-то заглянет в админку. Шлём в WhatsApp тем же каналом,
 * которым бот отвечает клиентам: отдельный сервис и токены не нужны.
 */
import { db, getSetting } from './db.js';
import { channel } from './channels/index.js';

const LABELS = { service: 'Уборка', object_type: 'Объект', area_m2: 'Площадь', district: 'Где',
  address: 'Адрес', works: 'Что сделать', date: 'Когда', price_quote: 'Названа цена' };

const numbers = () => (getSetting('manager_numbers') || '')
  .split(/[,;\n]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 9);

const adminUrl = () => (getSetting('admin_url') || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

/** Текст уведомления: по нему видно, что за заявка и почему нужен человек. */
export function handoffText(conv, reason) {
  let lead = {};
  try { lead = JSON.parse(conv.lead || '{}'); } catch {}
  const who = lead.name || conv.name || 'Клиент';
  const facts = Object.entries(LABELS)
    .filter(([k]) => lead[k])
    .map(([k, t]) => `${t}: ${lead[k]}${k === 'area_m2' ? ' м²' : ''}`);
  const waiting = db.prepare('SELECT COUNT(*) n FROM conversations WHERE needs_human=1').get().n;
  const url = adminUrl();
  return [
    `🔔 Нужен менеджер — ${who}, +${conv.phone}`,
    facts.join('\n'),
    conv.summary ? `Суть: ${conv.summary}` : '',
    `Причина: ${reason}`,
    `Ждут ответа: ${waiting}`,
    url ? `Открыть: ${url}/?conv=${conv.id}` : ''
  ].filter(Boolean).join('\n');
}

/** Просто написать менеджерам: используется и для передачи, и для «диалог молчит». */
export async function notifyManagers(text) {
  if (getSetting('notify_on') !== '1') return false;
  const to = numbers();
  if (!to.length) return false;
  for (const phone of to) {
    try { await channel.send({ phone, chat_id: null, channel: channel.name }, text); }
    catch (e) { console.error('уведомление менеджеру не ушло:', e.message); }
  }
  return true;
}

export const adminLink = (convId) => (adminUrl() ? `${adminUrl()}/?conv=${convId}` : '');

/** Шлём один раз на передачу: пока менеджер не ответил, повторно не дёргаем. */
export async function notifyHandoff(convId, reason) {
  try {
    if (getSetting('notify_on') !== '1') return;
    const to = numbers();
    if (!to.length) return;
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
    if (!conv || conv.notified_at) return;
    db.prepare("UPDATE conversations SET notified_at=datetime('now') WHERE id=?").run(convId);

    const text = handoffText(conv, reason);
    console.log(`[notify] заявка ${convId} → ${to.join(', ')}`);
    for (const phone of to) {
      if (String(conv.phone).replace(/\D/g, '') === phone) continue;   // не пишем самому клиенту
      try {
        await channel.send({ phone, chat_id: null, channel: channel.name }, text);
      } catch (e) {
        console.error('уведомление менеджеру не ушло:', e.message);
      }
    }
  } catch (e) {
    console.error('уведомление менеджеру:', e.message);
  }
}
