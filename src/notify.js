/**
 * Уведомления менеджеру. Бот передал заявку человеку — об этом должны узнать
 * сразу, а не когда кто-то заглянет в админку. Шлём в WhatsApp тем же каналом,
 * которым бот отвечает клиентам: отдельный сервис и токены не нужны.
 */
import { db, getSetting } from './db.js';
import { channel } from './channels/index.js';
import { recipients, getManager } from './calls.js';

// отчёты — только владельцу: менеджерам хватает уведомлений по своим заявкам
const ownerPhones = () => db.prepare("SELECT phone FROM managers WHERE role='owner' AND phone IS NOT NULL AND phone != ''")
  .all().map((m) => m.phone);
import { scheduleSetting } from './schedule.js';
import { logFailure } from './integrations.js';

const LABELS = { service: 'Уборка', object_type: 'Объект', area_m2: 'Площадь', district: 'Где',
  address: 'Адрес', works: 'Что сделать', date: 'Когда', price_quote: 'Названа цена' };

const adminUrl = () => (getSetting('admin_url') || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

/** Время в часовом поясе компании: «14:05» сегодня, «пт 09:05» в другой день. */
export function localTime(sql) {
  if (!sql) return '';
  const d = new Date(String(sql).replace(' ', 'T') + 'Z');
  const tz = scheduleSetting('timezone');
  const day = (x) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(x);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  return day(d) === day(new Date()) ? time
    : new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric' }).format(d) + ' ' + time;
}

function callLine(conv) {
  if (!conv.call_due_at) return '';
  const m = getManager(conv.manager_id);
  return `${m ? `Ответственный: ${m.name}. ` : ''}Позвонить до ${localTime(conv.call_due_at)}`;
}

/** Текст уведомления: по нему видно, что за заявка и почему нужен человек. */
export function handoffText(conv, reason) {
  let lead = {};
  try { lead = JSON.parse(conv.lead || '{}'); } catch {}
  const who = lead.name || conv.name || 'Клиент';
  const facts = Object.entries(LABELS)
    .filter(([k]) => lead[k])
    .map(([k, t]) => `${t}: ${lead[k]}${k === 'area_m2' ? ' м²' : ''}`);
  const waiting = db.prepare('SELECT COUNT(*) n FROM conversations WHERE needs_human=1 AND deleted_at IS NULL').get().n;
  const url = adminUrl();
  return [
    `🔔 Нужен менеджер — ${who}, +${conv.phone}`,
    facts.join('\n'),
    conv.summary ? `Суть: ${conv.summary}` : '',
    `Причина: ${reason}`,
    callLine(conv),
    `Ждут ответа: ${waiting}`,
    url ? `Открыть: ${url}/?conv=${conv.id}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * Написать менеджерам. С convId — ответственному по заявке (если он есть),
 * owners — ещё и владельцу: так уходят эскалации.
 */
export async function notifyManagers(text, { convId = null, owners = false, managerId = null, ownersOnly = false } = {}) {
  if (getSetting('notify_on') !== '1') return false;
  const to = ownersOnly ? ownerPhones() : recipients(convId, { owners, managerId });
  if (!to.length) return false;
  for (const phone of to) {
    try { await channel.send({ phone, chat_id: null, channel: channel.name }, text); }
    catch (e) {
      console.error('уведомление менеджеру не ушло:', e.message);
      logFailure('notify', { target: phone, convId, payload: { text }, error: e.message, retry: true });
    }
  }
  return true;
}

export const adminLink = (convId) => (adminUrl() ? `${adminUrl()}/?conv=${convId}` : '');

/** Шлём один раз на передачу: пока менеджер не ответил, повторно не дёргаем. */
export async function notifyHandoff(convId, reason) {
  try {
    if (getSetting('notify_on') !== '1') return;
    const to = recipients(convId);
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
        logFailure('notify', { target: phone, convId, payload: { text }, error: e.message, retry: true });
      }
    }
  } catch (e) {
    console.error('уведомление менеджеру:', e.message);
  }
}
