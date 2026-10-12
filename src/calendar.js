/**
 * Календарь в CRM: всё, что запланировано, на одной сетке — как в Google
 * Календаре. Уборки, пожелания клиентов, звонки, задачи и напоминания
 * собираются из тех же полей, что и карточки, поэтому календарь не может
 * разойтись с заявками: отдельно в нём ничего не хранится.
 *
 * Время отдаём уже в часовом поясе компании (ГГГГ-ММ-ДД и минуты от полуночи):
 * браузер менеджера может стоять в другом поясе, а уборка в 9:00 — это 9:00 у клиента.
 */
import { db, getSetting } from './db.js';
import { localClock, isHoliday } from './schedule.js';
import { getManager } from './calls.js';

const leadOf = (c) => { try { return JSON.parse(c.lead || '{}'); } catch { return {}; } };
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/**
 * Время заказа: «09:30» — начало, «8:00–14:00» — интервал целиком.
 * Без времени — событие на весь день.
 */
function spanOf(t, defMin) {
  const all = [...String(t || '').matchAll(/(\d{1,2})[:.](\d{2})/g)]
    .map((m) => (Number(m[1]) <= 24 && Number(m[2]) <= 59 ? Number(m[1]) * 60 + Number(m[2]) : null)).filter((x) => x != null);
  if (!all.length) return { start: null, dur: null };
  const [start, end] = all;
  return { start, dur: end > start ? end - start : defMin };
}
const CALL_MIN = 15;   // звонок и задача занимают в календаре 15 минут
/** Срок из базы (UTC) → дата и минуты по часовому поясу компании. */
function localOf(sql) {
  const at = new Date(String(sql).replace(' ', 'T') + 'Z');
  const p = localClock(at);
  return p ? { date: p.date, start: p.min, at } : null;
}

export function calendarEvents(from, to) {
  const ok = (d) => d && d >= from && d <= to;
  const jobMin = Math.max(30, (Number(getSetting('gcal_job_hours')) || 3) * 60);
  const who = (id) => getManager(id)?.name || '';
  const out = [];
  const now = Date.now();

  // подтверждённые уборки и пожелания клиентов
  for (const c of db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL AND status != 'closed'`).all()) {
    const l = leadOf(c);
    const base = { conv_id: c.id, name: l.name || c.name || '+' + c.phone, phone: c.phone,
      service: l.service || '', area: l.area_m2 || '', district: l.district || '', manager_id: c.manager_id, who: who(c.manager_id) };
    if (/^\d{4}-\d{2}-\d{2}$/.test(c.job_date || '') && ok(c.job_date)) {
      out.push({ ...base, layer: 'job', key: 'job:' + c.id, date: c.job_date, ...spanOf(c.job_time, jobMin),
        time: c.job_time || '', price: c.deal_sum ? String(c.deal_sum) : l.price_quote || '' });
    } else if (!c.job_date && /^\d{4}-\d{2}-\d{2}$/.test(l.date_iso || '') && l.stage !== 'отказ' && ok(l.date_iso)) {
      out.push({ ...base, layer: 'wish', key: 'wish:' + c.id, date: l.date_iso, ...spanOf(l.time, jobMin),
        time: l.time || '', price: l.price_quote || '' });
    }
  }
  // уборки, заведённые руками
  for (const j of db.prepare('SELECT * FROM jobs WHERE conv_id IS NULL AND date >= ? AND date <= ?').all(from, to)) {
    out.push({ layer: 'job', key: 'manual:' + j.id, job_id: j.id, manual: true, date: j.date, ...spanOf(j.time, jobMin),
      time: j.time || '', name: j.name || (j.phone ? '+' + j.phone : 'Уборка'), phone: j.phone || '', service: j.service || '',
      area: j.area || '', district: j.district || '', price: j.price || '', note: j.note || '' });
  }

  // звонки, задачи и напоминания
  const convs = db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL
    AND (call_due_at IS NOT NULL OR next_action_at IS NOT NULL OR followup_at IS NOT NULL)`).all();
  for (const c of convs) {
    const l = leadOf(c);
    const base = { conv_id: c.id, name: l.name || c.name || '+' + c.phone, phone: c.phone, district: l.district || '' };
    if (c.call_due_at && c.status !== 'closed') {
      const t = localOf(c.call_due_at);
      if (t && ok(t.date)) out.push({ ...base, layer: 'call', key: 'call:' + c.id, date: t.date, start: t.start, dur: CALL_MIN,
        what: 'позвонить', manager_id: c.manager_id, who: who(c.manager_id), late: t.at.getTime() <= now });
    }
    if (c.next_action && c.next_action_at) {
      const t = localOf(c.next_action_at);
      const m = c.next_action_mgr || c.manager_id;
      if (t && ok(t.date)) out.push({ ...base, layer: 'task', key: 'task:' + c.id, date: t.date, start: t.start, dur: CALL_MIN,
        what: c.next_action, manager_id: m, who: who(m), late: t.at.getTime() <= now });
    }
    if (c.followup_at && ok(c.followup_at)) {
      const manual = c.followup_who === 'manager';
      // бот по закрытой заявке не пишет — такое напоминание не показываем
      if (manual || c.status !== 'closed') out.push({ ...base, layer: manual ? 'follow' : 'bot', key: 'follow:' + c.id,
        date: c.followup_at, start: null, dur: null, what: c.followup_note || (manual ? 'напомнить' : 'бот напишет клиенту'),
        manager_id: manual ? c.manager_id : null, who: manual ? who(c.manager_id) : 'бот' });
    }
  }

  const holidays = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const h = isHoliday(d); if (h) holidays.push({ date: d, name: h.name || h }); }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? -1) - (b.start ?? -1));
  return { from, to, events: out, holidays };
}
