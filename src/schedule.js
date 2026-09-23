/**
 * График работы компании: часы по каждому дню отдельно, праздники и выходные даты,
 * автозакрытие остывших заявок.
 *
 * Бот работает круглосуточно, живой менеджер — нет. И график должен быть
 * в одном месте: бот берёт его отсюда, а не из свободного текста, иначе
 * настройки и обещания клиенту расходятся.
 */
import { db, getSetting } from './db.js';

const DEFAULTS = {
  timezone: 'Asia/Jerusalem',
  off_hours: 'notice',          // always | notice | silent
  off_hours_note: '',
  holidays: '',
  autoclose_days: '0'
};
export const scheduleSetting = (k) => getSetting(k) ?? DEFAULTS[k];

export const DAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const DAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Часы по дням: {"0":["08:00","20:00"], "5":["08:00","13:00"], "6":null}. */
export function workHours() {
  try {
    const h = JSON.parse(getSetting('work_hours') || 'null');
    if (h && typeof h === 'object') return h;
  } catch { /* ниже соберём из старых настроек */ }

  // миграция со старой схемы «одни часы на все рабочие дни»
  const days = String(getSetting('work_days') ?? '0,1,2,3,4').split(',').map(Number);
  const from = getSetting('work_from') || '08:00';
  const to = getSetting('work_to') || '20:00';
  return Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, days.includes(d) ? [from, to] : null]));
}

/** Праздники: строки «ГГГГ-ММ-ДД  название». Название необязательно. */
export function holidays() {
  return String(scheduleSetting('holidays') || '').split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(l);
      return m ? { date: m[1], name: m[2] || 'выходной' } : null;
    })
    .filter(Boolean);
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Разбор «сейчас» в часовом поясе компании. */
function localParts(at) {
  const tz = scheduleSetting('timezone');
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit'
    }).formatToParts(at);
    const get = (t) => p.find((x) => x.type === t)?.value;
    const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      day: WD[get('weekday')],
      min: Number(get('hour')) * 60 + Number(get('minute')),
      date: new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(at)
    };
  } catch {
    return null;                                   // неизвестный пояс — не мешаем работать
  }
}

export function isHoliday(dateIso) {
  return holidays().find((h) => h.date === dateIso) || null;
}

export function withinWorkHours(at = new Date()) {
  const now = localParts(at);
  if (!now) return true;
  if (isHoliday(now.date)) return false;

  const win = workHours()[now.day];
  if (!Array.isArray(win)) return false;

  const from = toMin(win[0]), to = toMin(win[1]);
  return from <= to ? now.min >= from && now.min < to : now.min >= from || now.min < to;
}

/**
 * Сколько рабочих секунд прошло между двумя моментами. Ночь, выходные и
 * праздники не считаем: иначе письмо в 23:10 и ответ в 08:05 выглядят как
 * девять часов молчания, и метрика скорости ответа теряет смысл.
 */
export function workingSeconds(from, to) {
  if (!(to > from)) return 0;
  const h = workHours();
  const hol = new Set(holidays().map((x) => x.date));
  let sec = 0;
  let cursor = new Date(from);
  for (let guard = 0; cursor < to && guard < 400; guard++) {
    const p = localParts(cursor);
    if (!p) return Math.round((to - from) / 1000);          // неизвестный пояс — как есть
    const nextDay = new Date(cursor.getTime() + (1440 - p.min) * 60000);
    const end = nextDay < to ? nextDay : to;
    const win = hol.has(p.date) ? null : h[p.day];
    if (Array.isArray(win)) {
      const open = toMin(win[0]);
      const close = toMin(win[1]) > open ? toMin(win[1]) : 1440;   // смена через полночь — до конца суток
      const endMin = p.min + (end - cursor) / 60000;
      sec += Math.max(0, Math.min(endMin, close) - Math.max(p.min, open)) * 60;
    }
    cursor = end;
  }
  return Math.round(sec);
}

/** График человеческим текстом — уходит в промпт, чтобы бот не выдумывал часы. */
export function scheduleText() {
  const h = workHours();
  const parts = [0, 1, 2, 3, 4, 5, 6].map((d) => Array.isArray(h[d])
    ? `${DAY_SHORT[d]} ${h[d][0]}–${h[d][1]}`
    : `${DAY_SHORT[d]} выходной`);

  const today = localParts(new Date())?.date ?? '';
  const soon = holidays().filter((x) => x.date >= today).slice(0, 6);
  const hol = soon.length
    ? ` Нерабочие даты: ${soon.map((x) => `${x.date} (${x.name})`).join(', ')}.`
    : '';
  return `ГРАФИК РАБОТЫ: ${parts.join(', ')}.${hol}`
    + ' Не предлагай и не подтверждай уборку в нерабочий день или вне этих часов —'
    + ' предложи ближайший рабочий день.';
}

/** Заявки без движения дольше N дней закрываем сами, чтобы доска не зарастала. */
export function sweepStale() {
  const days = Number(scheduleSetting('autoclose_days')) || 0;
  if (!days) return 0;
  const rows = db.prepare(`
    SELECT id FROM conversations
    WHERE status != 'closed' AND needs_human = 0 AND last_at < datetime('now', ?)`).all(`-${days} days`);
  for (const r of rows) {
    db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(r.id);
    db.prepare("INSERT INTO messages(conv_id,direction,author,body) VALUES(?,'out','system',?)")
      .run(r.id, `Закрыта автоматически: без ответа ${days} дн.`);
  }
  return rows.length;
}
