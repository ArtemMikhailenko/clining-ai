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
import { db, getSetting, setSetting, audit } from './db.js';
import { scheduleSetting, localDate, localClock } from './schedule.js';
import { getManager, sqlTime } from './calls.js';
import { setNext } from './control.js';
import { adminLink } from './notify.js';
import { logFailure } from './integrations.js';

const API = 'https://www.googleapis.com/calendar/v3';
const BACK_DAYS = 7, AHEAD_DAYS = 120;   // окно синхронизации от сегодняшнего дня
const PER_RUN = 60;                       // запросов за один проход — квоту Google не выбираем
// цвета событий из палитры Google — как в календаре CRM: зелёный — заказ,
// синий — звонок, оранжевый — задача, серый — напоминание без времени
const COLOR = { job: '10', call: '9', task: '6', follow: '8' };

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
  // «09:30» — начало, «8:00–14:00» — интервал целиком
  const ts = [...String(time || '').matchAll(/(\d{1,2})[:.](\d{2})/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  if (!ts.length || ts[0] >= 1440) return { start: { date: day }, end: { date: addDays(day, 1) } };
  const tz = scheduleSetting('timezone');
  const from = ts[0];
  const to = ts[1] > from ? ts[1] : from + minutes;
  const at = (d, t) => `${d}T${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}:00`;
  return { start: { dateTime: at(day, from), timeZone: tz }, end: { dateTime: at(to >= 1440 ? addDays(day, 1) : day, to), timeZone: tz } };
}

/** Срок из базы (UTC) — точный момент, длительность короткая: это напоминание. */
function utcSpan(sql, minutes = 15) {   // как в календаре CRM: звонок — 15 минут
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
  const done = { created: 0, updated: 0, deleted: 0, from_google: 0 };
  try {
    const cals = calendars();
    const today = localDate();
    const from = addDays(today, -BACK_DAYS), to = addDays(today, AHEAD_DAYS);
    // сначала читаем календари: переносы и удаления в Google применяются к CRM,
    // и только потом CRM отправляет свою версию — иначе она затёрла бы правку
    for (const [kind, calId] of Object.entries(cals)) if (calId) await pull(kind, calId, from, to, done);

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
      // запоминаем версию Google и отправленное время: правку в календаре отличим от своей
      db.prepare('UPDATE gcal_events SET g_updated=?, sent=? WHERE key=?')
        .run(ev.updated || null, JSON.stringify({ start: w.body.start, end: w.body.end }), key);
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

/* ─────────── из Google в CRM ─────────── */

async function listEvents(calId, from, to) {
  const out = [];
  let page = '';
  do {
    const q = new URLSearchParams({ timeMin: addDays(from, -1) + 'T00:00:00Z', timeMax: addDays(to, 2) + 'T00:00:00Z',
      singleEvents: 'true', maxResults: '2500', ...(page ? { pageToken: page } : {}) });
    const r = await api('GET', `/calendars/${enc(calId)}/events?${q}`);
    out.push(...(r.items || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
/** Начало и конец события из Google: точный момент или дата на весь день. */
function whenOf(ev) {
  if (ev.start?.dateTime) {
    const a = new Date(ev.start.dateTime), b = new Date(ev.end?.dateTime || ev.start.dateTime);
    const pa = localClock(a), pb = localClock(b);
    return { at: a, end: b, date: pa?.date || localDate(a), min: pa?.min ?? null, endMin: pb?.date === pa?.date ? pb?.min : 1440 };
  }
  return ev.start?.date ? { at: null, date: ev.start.date, min: null } : null;
}
/** То же время, что мы отправляли? Сравниваем моменты, а не строки: Google меняет формат. */
function sameTime(sent, ev) {
  const t = (x) => (x?.dateTime ? Date.parse(x.dateTime) : x?.date || null);
  return t(sent?.start) === t(ev.start) && t(sent?.end) === t(ev.end);
}

/**
 * Событие CRM передвинули в Google — переносим срок в карточку. Название и
 * описание не трогаем: их CRM пишет сама и при следующей отправке вернёт.
 */
function applyMove(key, ev, w) {
  const [kind, a, b] = key.split(':');
  const actor = 'Google Календарь';
  if (kind === 'call' || kind === 'next') {
    if (!w.at) return false;   // звонок с точным временем не превращаем в «весь день»
    const col = kind === 'call' ? 'call_due_at' : 'next_action_at';
    const c = db.prepare(`SELECT ${col} v FROM conversations WHERE id=?`).get(Number(a));
    if (!c || !c.v) return false;
    const v = sqlTime(w.at);
    if (v === c.v) return false;
    db.prepare(`UPDATE conversations SET ${col}=?${kind === 'call' ? ', call_escalated_at=NULL' : ', next_action_notified_at=NULL'} WHERE id=?`).run(v, Number(a));
    audit('lead', Number(a), col, c.v, v, actor, 'перенесено в календаре');
    return true;
  }
  if (kind === 'follow') {
    const c = db.prepare('SELECT followup_at v FROM conversations WHERE id=?').get(Number(a));
    if (!c || !c.v || c.v === w.date) return false;
    db.prepare('UPDATE conversations SET followup_at=? WHERE id=?').run(w.date, Number(a));
    audit('lead', Number(a), 'followup_at', c.v, w.date, actor, 'перенесено в календаре');
    return true;
  }
  if (kind === 'job') {
    const time = w.min == null ? '' : hm(w.min) + (w.endMin > w.min ? '–' + hm(w.endMin) : '');
    if (a === 'conv') {
      const c = db.prepare('SELECT job_date, job_time FROM conversations WHERE id=?').get(Number(b));
      if (!c || (c.job_date === w.date && (c.job_time || '') === time)) return false;
      db.prepare('UPDATE conversations SET job_date=?, job_time=? WHERE id=?').run(w.date, time || null, Number(b));
      audit('lead', Number(b), 'job_date', `${c.job_date} ${c.job_time || ''}`.trim(), `${w.date} ${time}`.trim(), actor, 'перенесено в календаре');
      return true;
    }
    const j = db.prepare('SELECT date, time FROM jobs WHERE id=?').get(Number(b));
    if (!j || (j.date === w.date && (j.time || '') === time)) return false;
    db.prepare('UPDATE jobs SET date=?, time=? WHERE id=?').run(w.date, time || null, Number(b));
    return true;
  }
  return false;
}

async function pull(kind, calId, from, to, done) {
  const items = await listEvents(calId, from, to);
  const ours = new Map(db.prepare('SELECT * FROM gcal_events WHERE calendar_id=?').all(calId).map((r) => [r.event_id, r]));
  const seen = new Set();
  const external = [];
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    seen.add(ev.id);
    const row = ours.get(ev.id);
    if (!row) { external.push(ev); continue; }
    if (!row.g_updated) {   // событие отправили до двусторонней связи — просто запоминаем версию
      db.prepare('UPDATE gcal_events SET g_updated=? WHERE key=?').run(ev.updated, row.key);
      continue;
    }
    if (ev.updated === row.g_updated) continue;
    let sent = null;
    try { sent = JSON.parse(row.sent || 'null'); } catch {}
    const w = whenOf(ev);
    if (w && sent && !sameTime(sent, ev) && applyMove(row.key, ev, w)) done.from_google++;
    // правка учтена; hash сбрасываем, чтобы CRM отправила событие в своём виде
    db.prepare("UPDATE gcal_events SET g_updated=?, hash='' WHERE key=?").run(ev.updated, row.key);
  }
  // удалили в Google: задачу и напоминание считаем выполненными; звонок и заказ
  // так не отменяются — звонок закрывается записью результата, заказ не должен
  // пропасть от случайного удаления. Их CRM создаст заново.
  for (const [id, row] of ours) {
    if (seen.has(id) || !row.day || row.day < from || row.day > to) continue;
    const [k, convId] = row.key.split(':');
    if (k === 'next' || k === 'follow') {
      setNext(Number(convId), { done: true }, 'Google Календарь');
      db.prepare('DELETE FROM gcal_events WHERE key=?').run(row.key);
      done.from_google++;
    }
  }
  // своё событие в календаре — показываем в CRM как есть
  db.prepare('DELETE FROM gcal_external WHERE cal=?').run(kind);
  const ins = db.prepare(`INSERT OR REPLACE INTO gcal_external(event_id, cal, summary, location, description, date, start_min, dur, link, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const ev of external) {
    const w = whenOf(ev);
    if (!w) continue;
    ins.run(ev.id, kind, ev.summary || '(без названия)', ev.location || '', ev.description || '', w.date, w.min,
      w.min == null ? null : Math.max(15, Math.round((w.end - w.at) / 6e4)), ev.htmlLink || '', ev.updated || '');
  }
}

/** «Сделано» в CRM у события из Google — удаляем его из календаря. */
export async function doneExternal(eventId) {
  const r = db.prepare('SELECT * FROM gcal_external WHERE event_id=?').get(eventId);
  if (!r) throw new Error('Нет такого события');
  const calId = calendars()[r.cal];
  await api('DELETE', `/calendars/${enc(calId)}/events/${enc(eventId)}`).catch((e) => { if (![404, 410].includes(e.status)) throw e; });
  db.prepare('DELETE FROM gcal_external WHERE event_id=?').run(eventId);
}

/** Проверка из настроек: ключ принят, оба календаря видны и в них можно писать. */
export async function calendarStatus() {
  const a = account();
  const cals = calendars();
  const res = { configured: Boolean(a), email: a?.email || '',
    // переменная есть, но JSON не читается — частая ошибка при копировании
    has_env: Boolean(String(process.env.GOOGLE_SERVICE_ACCOUNT || '').trim()), on: getSetting('gcal_on') === '1',
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
