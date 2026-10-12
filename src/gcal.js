/**
 * Google Календарь: уборки и напоминания менеджеров.
 *
 * Связь в одну сторону — CRM пишет, календарь показывает. Раз в минуту
 * собираем, какие события должны быть, сравниваем с тем, что уже отправили,
 * и создаём, меняем или удаляем только разницу. Так не нужно ловить каждое
 * изменение заявки по всему коду, а после сбоя Google всё догоняется само.
 *
 * Доступ — сервисный аккаунт Google: JSON-ключ лежит на сервере в переменной
 * GOOGLE_SERVICE_ACCOUNT, а владелец открывает этому аккаунту свои календари.
 * Отдельная библиотека не нужна: токен — это JWT, подписанный ключом из JSON.
 */
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { scheduleSetting, localDate } from './schedule.js';
import { getManager } from './calls.js';
import { adminLink } from './notify.js';
import { logFailure } from './integrations.js';

const API = 'https://www.googleapis.com/calendar/v3';
const BACK_DAYS = 7, AHEAD_DAYS = 120;   // окно синхронизации от сегодняшнего дня
const PER_RUN = 60;                       // запросов за один проход — квоту Google не выбираем
// цвета событий из палитры Google: зелёный — уборка, оранжевый — звонок,
// синий — задача, серый — напоминание без времени
const COLOR = { job: '10', call: '6', task: '9', follow: '8' };

const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');
const leadOf = (c) => { try { return JSON.parse(c.lead || '{}'); } catch { return {}; } };

/* ─────────── доступ ─────────── */

function account() {
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT || '').trim();
  if (!raw) return null;
  try {
    // на Render JSON вставляют как есть; base64 — на случай, если панель портит переносы
    const j = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    if (!j.client_email || !j.private_key) return null;
    return { email: j.client_email, key: String(j.private_key).replace(/\\n/g, '\n') };
  } catch {
    return null;
  }
}
export const gcalConfigured = () => Boolean(account());

let token = null;
async function accessToken() {
  if (token && token.exp > Date.now() + 6e4) return token.value;
  const a = account();
  if (!a) throw new Error('На сервере нет ключа GOOGLE_SERVICE_ACCOUNT');
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({
    iss: a.email, scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(a.key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google не принял ключ: ' + (j.error_description || j.error || r.status));
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: 'Bearer ' + await accessToken(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error?.message || 'Google ответил ' + r.status);
    e.status = r.status;
    throw e;
  }
  return j;
}
const enc = encodeURIComponent;

/* ─────────── какие события должны быть ─────────── */

/** Время события: «09:30» в карточке — точное время, иначе событие на весь день. */
function localSpan(day, time, minutes) {
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(time || '').trim());
  if (!m || Number(m[1]) > 23) return { start: { date: day }, end: { date: addDays(day, 1) } };
  const tz = scheduleSetting('timezone');
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = from + minutes;
  const at = (d, t) => `${d}T${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}:00`;
  return { start: { dateTime: at(day, from), timeZone: tz }, end: { dateTime: at(to >= 1440 ? addDays(day, 1) : day, to), timeZone: tz } };
}

/** Срок из базы (UTC) — точный момент, длительность короткая: это напоминание. */
function utcSpan(sql, minutes = 15) {
  const t = Date.parse(String(sql).replace(' ', 'T') + 'Z');
  return { start: { dateTime: new Date(t).toISOString() }, end: { dateTime: new Date(t + minutes * 6e4).toISOString() } };
}

const lines = (...xs) => xs.filter(Boolean).join('\n');

function jobEvents(from, to) {
  const hours = Math.max(1, Number(getSetting('gcal_job_hours')) || 3);
  const out = [];
  // как в расписании CRM: только подтверждённая запись, а не пожелание клиента
  for (const c of db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL AND status != 'closed'
      AND job_date >= ? AND job_date <= ?`).all(from, to)) {
    const l = leadOf(c);
    const who = l.name || c.name || '+' + c.phone;
    out.push({
      key: 'job:conv:' + c.id, cal: 'job', day: c.job_date,
      body: {
        summary: `🧹 ${who}${l.service ? ' · ' + l.service : ''}${l.area_m2 ? ' · ' + l.area_m2 + ' м²' : ''}`,
        location: l.address || l.district || '',
        description: lines(`Телефон: +${c.phone}`, c.deal_sum ? `Цена: ${c.deal_sum} ₪` : l.price_quote ? `Оценка: ${l.price_quote}` : '',
          getManager(c.manager_id) ? `Менеджер: ${getManager(c.manager_id).name}` : '', l.works ? `Что сделать: ${l.works}` : '',
          adminLink(c.id) ? `Карточка: ${adminLink(c.id)}` : ''),
        colorId: COLOR.job, ...localSpan(c.job_date, c.job_time, hours * 60)
      }
    });
  }
  // уборки, заведённые руками — их в переписке нет
  for (const j of db.prepare('SELECT * FROM jobs WHERE conv_id IS NULL AND date >= ? AND date <= ?').all(from, to)) {
    out.push({
      key: 'job:manual:' + j.id, cal: 'job', day: j.date,
      body: {
        summary: `🧹 ${j.name || (j.phone ? '+' + j.phone : 'Уборка')}${j.service ? ' · ' + j.service : ''}${j.area ? ' · ' + j.area + ' м²' : ''}`,
        location: j.district || '',
        description: lines(j.phone ? `Телефон: +${j.phone}` : '', j.price ? `Цена: ${j.price}` : '', j.note || ''),
        colorId: COLOR.job, ...localSpan(j.date, j.time, hours * 60)
      }
    });
  }
  return out;
}

function taskEvents(from, to) {
  const out = [];
  const inWindow = (day) => day && day >= from && day <= to;
  for (const c of db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL
      AND (call_due_at IS NOT NULL OR next_action_at IS NOT NULL OR followup_at IS NOT NULL)`).all()) {
    const l = leadOf(c);
    const who = l.name || c.name || '+' + c.phone;
    const desc = lines(`Телефон: +${c.phone}`, l.district ? `Где: ${l.district}` : '', adminLink(c.id) ? `Карточка: ${adminLink(c.id)}` : '');
    const mgr = (id) => getManager(id)?.name || 'без ответственного';
    if (c.call_due_at && c.status !== 'closed') {
      const day = localDate(new Date(String(c.call_due_at).replace(' ', 'T') + 'Z'));
      if (inWindow(day)) out.push({ key: 'call:' + c.id, cal: 'task', day,
        body: { summary: `📞 ${mgr(c.manager_id)}: позвонить — ${who}`, description: desc, colorId: COLOR.call, ...utcSpan(c.call_due_at) } });
    }
    if (c.next_action && c.next_action_at) {
      const day = localDate(new Date(String(c.next_action_at).replace(' ', 'T') + 'Z'));
      if (inWindow(day)) out.push({ key: 'next:' + c.id, cal: 'task', day,
        body: { summary: `📌 ${mgr(c.next_action_mgr || c.manager_id)}: ${c.next_action} — ${who}`, description: desc, colorId: COLOR.task,
          ...utcSpan(c.next_action_at) } });
    }
    // напоминание, которое ставит менеджер; то, что бот напишет сам, в календарь не идёт
    if (c.followup_at && c.followup_who === 'manager' && inWindow(c.followup_at)) {
      out.push({ key: 'follow:' + c.id, cal: 'task', day: c.followup_at,
        body: { summary: `🔔 ${mgr(c.manager_id)}: ${c.followup_note || 'напомнить'} — ${who}`, description: desc, colorId: COLOR.follow,
          start: { date: c.followup_at }, end: { date: addDays(c.followup_at, 1) } } });
    }
  }
  return out;
}

/* ─────────── синхронизация ─────────── */

const calendars = () => ({ job: String(getSetting('gcal_jobs_id') || '').trim(), task: String(getSetting('gcal_tasks_id') || '').trim() });

function fail(msg) {
  // ошибка повторяется каждую минуту — в журнал пишем только новую
  if (getSetting('gcal_error') !== msg) logFailure('gcal', { error: msg });
  setSetting('gcal_error', msg);
}

let running = false;
export async function syncCalendar() {
  if (running || !gcalConfigured() || getSetting('gcal_on') !== '1') return { skipped: true };
  running = true;
  const done = { created: 0, updated: 0, deleted: 0 };
  try {
    const cals = calendars();
    const today = localDate();
    const from = addDays(today, -BACK_DAYS), to = addDays(today, AHEAD_DAYS);
    const want = new Map([...jobEvents(from, to), ...taskEvents(from, to)]
      .filter((e) => cals[e.cal]).map((e) => [e.key, { ...e, calId: cals[e.cal] }]));
    const have = new Map(db.prepare('SELECT * FROM gcal_events').all().map((r) => [r.key, r]));
    const save = db.prepare(`INSERT INTO gcal_events(key, calendar_id, event_id, hash, day, updated_at) VALUES(?,?,?,?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET calendar_id=excluded.calendar_id, event_id=excluded.event_id, hash=excluded.hash,
      day=excluded.day, updated_at=excluded.updated_at`);
    let budget = PER_RUN;

    for (const [key, w] of want) {
      const hash = crypto.createHash('sha1').update(w.calId + JSON.stringify(w.body)).digest('hex');
      const h = have.get(key);
      if (h && h.hash === hash) continue;
      if (budget-- <= 0) break;
      let ev = null;
      if (h && h.calendar_id === w.calId) {
        try { ev = await api('PUT', `/calendars/${enc(w.calId)}/events/${enc(h.event_id)}`, w.body); done.updated++; }
        catch (e) { if (![404, 410].includes(e.status)) throw e; }   // событие удалили в календаре руками — создадим заново
      } else if (h) {
        await api('DELETE', `/calendars/${enc(h.calendar_id)}/events/${enc(h.event_id)}`).catch(() => {});
      }
      if (!ev) { ev = await api('POST', `/calendars/${enc(w.calId)}/events`, w.body); done.created++; }
      save.run(key, w.calId, ev.id, hash, w.day);
    }

    for (const [key, h] of have) {
      if (want.has(key)) continue;
      // прошедшие уборки оставляем в календаре как историю, задачи убираем сразу
      if (key.startsWith('job:') && h.day && h.day < today) continue;
      if (budget-- <= 0) break;
      try { await api('DELETE', `/calendars/${enc(h.calendar_id)}/events/${enc(h.event_id)}`); done.deleted++; }
      catch (e) { if (![404, 410].includes(e.status)) throw e; }
      db.prepare('DELETE FROM gcal_events WHERE key=?').run(key);
    }
    setSetting('gcal_error', '');
    setSetting('gcal_last_sync', new Date().toISOString());
    return done;
  } catch (e) {
    fail(e.status === 404 ? 'Календарь не найден или не открыт для сервисного аккаунта' : e.message);
    throw e;
  } finally {
    running = false;
  }
}

/** Проверка из настроек: ключ принят, оба календаря видны и в них можно писать. */
export async function calendarStatus() {
  const a = account();
  const cals = calendars();
  const res = { configured: Boolean(a), email: a?.email || '', on: getSetting('gcal_on') === '1',
    last_sync: getSetting('gcal_last_sync') || null, last_error: getSetting('gcal_error') || '',
    events: db.prepare('SELECT count(*) n FROM gcal_events').get().n, calendars: {} };
  if (!a) return res;
  for (const [k, id] of Object.entries(cals)) {
    if (!id) { res.calendars[k] = { ok: false, error: 'не указан' }; continue; }
    try {
      const c = await api('GET', `/users/me/calendarList/${enc(id)}`).catch(async (e) => {
        // календарь открыт, но ещё не добавлен в список аккаунта — добавим сами
        if (e.status !== 404) throw e;
        return api('POST', '/users/me/calendarList', { id });
      });
      const canWrite = ['writer', 'owner'].includes(c.accessRole);
      res.calendars[k] = { ok: canWrite, name: c.summary, error: canWrite ? '' : 'открыт только на просмотр — нужно «Внесение изменений в мероприятия»' };
    } catch (e) {
      res.calendars[k] = { ok: false, error: e.status === 404 ? 'не найден или не открыт для ' + a.email : e.message };
    }
  }
  return res;
}

export function startCalendar() {
  const tick = () => syncCalendar().catch((e) => console.error('Google Календарь:', e.message));
  setTimeout(tick, 15e3).unref?.();
  setInterval(tick, 6e4).unref?.();
}
