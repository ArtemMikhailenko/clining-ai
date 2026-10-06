/**
 * Контроль (ТЗ §7, §8): следующее действие у каждой активной карточки,
 * предупреждения и экран «Контроль дня».
 *
 * Всё считается на лету из заявок, звонков и журнала — отдельной таблицы
 * задач нет, поэтому предупреждение не может «забыть» сняться: исправили
 * данные — флаг пропал сам.
 */
import { db, getSetting, audit, waitsMedia } from './db.js';
import { actorName } from './context.js';
import { debtOf } from './deals.js';
import { recUrl } from './auth.js';
import { getManager, listManagers, sqlTime, CALL_STATUS } from './calls.js';
import { localDate, localClock, workHours, isHoliday } from './schedule.js';
import { dominantLang } from './lang.js';
import { STAGE_TITLE, CLOSE_TITLE, amountOf } from './stages.js';
import { notifyManagers, adminLink, localTime } from './notify.js';

const parse = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
const hoursSince = (s) => (s ? (Date.now() - parse(s)) / 36e5 : Infinity);
const num = (k, d) => Number(getSetting(k)) || d;
const leadOf = (c) => { try { return JSON.parse(c.lead || '{}'); } catch { return {}; } };

/** Сводка звонков по заявкам одним запросом: на доске их сотня. */
function callStats(ids) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT conv_id, count(*) n, min(at) first_at,
      sum(status='answered') answered,
      sum(status='answered' AND recording IS NULL AND (no_record_reason IS NULL OR no_record_reason='')) norec,
      (SELECT status FROM calls k2 WHERE k2.conv_id=k.conv_id ORDER BY id DESC LIMIT 1) last_status,
      (SELECT id FROM calls k3 WHERE k3.conv_id=k.conv_id AND recording IS NOT NULL AND rec_deleted_at IS NULL
        ORDER BY id DESC LIMIT 1) last_rec
    FROM calls k WHERE conv_id IN (${ids.map(() => '?').join(',')}) GROUP BY conv_id`).all(...ids);
  return new Map(rows.map((r) => [r.conv_id, r]));
}

/**
 * Следующее действие карточки. Явно заданное менеджером важнее всего;
 * звонок по сроку — тоже действие; бот, который сам ведёт диалог, — тоже.
 */
export function nextAction(c) {
  if (c.stage === 'closed') return null;
  if (c.call_due_at) return { kind: 'call', what: 'позвонить', at: c.call_due_at, who: getManager(c.manager_id)?.name || '' };
  if (c.next_action) {
    return { kind: 'task', what: c.next_action, at: c.next_action_at,
      who: getManager(c.next_action_mgr || c.manager_id)?.name || '' };
  }
  if (c.followup_at) return { kind: 'bot', what: c.followup_note || 'бот напишет клиенту', at: c.followup_at, who: 'бот' };
  // работа сделана, деньги не все — действие очевидно (этап 5)
  const debt = debtOf(c);
  if (debt > 0) return { kind: 'pay', what: `получить оплату ${debt.toLocaleString('ru-RU')} ₪`, at: null, who: getManager(c.manager_id)?.name || '' };
  const botLeads = c.ai_enabled && c.status === 'ai' && !c.needs_human && ['new', 'clarify'].includes(c.stage || 'new');
  if (botLeads) return { kind: 'bot', what: 'бот ведёт диалог', at: null, who: 'бот' };
  if (c.stage === 'agreed' && c.job_date && c.job_date >= localDate()) {
    return { kind: 'job', what: 'уборка', at: c.job_date + (c.job_time ? ' ' + c.job_time : ''), who: '' };
  }
  return null;
}

/**
 * Предупреждения карточки (ТЗ §7, §8.3). red — нарушение, которое должно
 * исчезнуть до конца дня; amber — повод посмотреть.
 */
export function warnings(c, k = {}) {
  const w = [];
  const add = (code, level, text) => w.push({ code, level, text });
  const active = c.stage !== 'closed';
  const calls = k.n || 0;
  const today = localDate();

  if (c.call_due_at && active && parse(c.call_due_at) <= Date.now()) add('late', 'red', 'срок звонка нарушен');
  if (c.assigned_at && !calls && !c.call_due_at && active) add('no_call', 'red', 'передана, но звонка не было');
  if (k.norec) add('norec', 'red', 'разговор без записи и без причины');
  if (c.next_action_at && c.next_action && active && parse(c.next_action_at) <= Date.now()) {
    add('task_late', 'red', 'просрочено: ' + c.next_action);
  }
  if (active && !nextAction(c)) add('no_next', 'red', 'нет следующего действия');
  if (c.stage === 'agreed' && c.job_date && c.job_date < today) add('job_passed', 'red', 'дата работ прошла — отметьте выполнение');
  if (c.stage === 'agreed' && !c.job_date) add('no_date', 'amber', 'согласовано без даты работ');
  // §7: работа выполнена, оплаты нет — задолженность; цены нет — непонятно, сколько ждать
  const debt = debtOf(c);
  if (debt > 0) add('debt', 'red', `задолженность ${debt.toLocaleString('ru-RU')} ₪`);
  else if (c.stage === 'done' && !(c.deal_sum > 0) && !(c.paid_sum > 0)) add('unpaid', 'amber', 'выполнено: внесите цену и оплату');
  if (c.stage === 'offer' && !calls) add('offer_nocall', 'amber', 'предложение без звонка');
  if (c.stage === 'offer' && c.last_in_at !== undefined) {
    const since = Math.min(hoursSince(c.last_in_at), hoursSince(c.stage_at || c.last_at));
    const lim = num('offer_wait_hours', 48);
    if (since >= lim && since !== Infinity) add('offer_silent', 'amber', `предложение без ответа ${Math.floor(since / 24) || 1} дн`);
  }
  if (c.wait_media) {
    const since = hoursSince(c.last_in_at || c.created_at);
    if (since >= num('media_wait_hours', 24) && since !== Infinity) add('media_wait', 'amber', `ждём фото/видео ${Math.round(since)} ч`);
  }
  return w;
}

/** Добавить к заявкам следующее действие и предупреждения — для доски и карточки. */
export function annotate(rows) {
  const stats = callStats(rows.map((c) => c.id));
  for (const c of rows) {
    const k = stats.get(c.id) || {};
    c.calls_n = k.n || 0;
    c.next = nextAction(c);
    c.warn = warnings(c, k);
  }
  return rows;
}

/* ─────────── Следующее действие: запись ─────────── */

export function setNext(convId, b, actor = actorName('менеджер')) {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  if (!c) throw new Error('Нет такой заявки');
  // в журнал — само действие, а не звонок по сроку: звонок закрывается записью звонка
  const was = c.next_action ? `${c.next_action} · ${c.next_action_at}`
    : c.followup_at ? `бот напишет клиенту · ${c.followup_at}` : null;

  if (b.done || b.clear) {
    db.prepare(`UPDATE conversations SET next_action=NULL, next_action_at=NULL, next_action_mgr=NULL,
      next_action_notified_at=NULL, followup_at=NULL, followup_note=NULL, followup_who=NULL WHERE id=?`).run(convId);
    audit('lead', convId, 'next_action', was, null, actor, b.done ? 'выполнено' : 'убрано');
    return;
  }
  const what = String(b.what || '').trim();
  if (b.who === 'bot') {
    const day = String(b.at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Когда боту написать клиенту?');
    db.prepare(`UPDATE conversations SET followup_at=?, followup_note=?, followup_who=NULL, nudges=0,
      next_action=NULL, next_action_at=NULL, next_action_mgr=NULL, next_action_notified_at=NULL WHERE id=?`)
      .run(day, what || null, convId);
    audit('lead', convId, 'next_action', was, `бот напишет клиенту · ${day}`, actor, what || null);
    return;
  }
  if (!what) throw new Error('Что нужно сделать?');
  const at = b.at ? new Date(b.at) : null;
  if (!at || Number.isNaN(at.getTime())) throw new Error('К какому сроку?');
  const mgr = Number(b.who) || c.manager_id || null;
  if (mgr && !getManager(mgr)) throw new Error('Нет такого менеджера');
  db.prepare(`UPDATE conversations SET next_action=?, next_action_at=?, next_action_mgr=?, next_action_notified_at=NULL,
    followup_at=NULL, followup_note=NULL, followup_who=NULL WHERE id=?`).run(what, sqlTime(at), mgr, convId);
  audit('lead', convId, 'next_action', was, `${what} · ${sqlTime(at)}${mgr ? ' · ' + getManager(mgr).name : ''}`, actor);
}

/* ─────────── Контроль дня (ТЗ §8) ─────────── */

const stageText = (c) => (c.stage === 'closed' ? 'Закрыто · ' + (CLOSE_TITLE[c.close_reason] || '') : STAGE_TITLE[c.stage || 'new']);

export function controlDay(date = localDate()) {
  const convs = db.prepare(`SELECT c.*,
      (SELECT max(created_at) FROM messages m WHERE m.conv_id=c.id AND m.direction='in') last_in_at
    FROM conversations c WHERE c.deleted_at IS NULL AND (assigned_at IS NOT NULL OR stage != 'closed')`).all();
  const handed = convs.filter((c) => c.assigned_at && localDate(parse(c.assigned_at)) === date);
  for (const c of convs) c.wait_media = waitsMedia(c);
  annotate(convs);
  const stats = callStats(handed.map((c) => c.id));

  // этапы, на которые перешли в этот день: из журнала, а не из текущего состояния
  // перенос в новую воронку — не работа менеджера, его не считаем
  const moves = db.prepare(`SELECT entity_id, new_value, at FROM audit_log WHERE field='stage' AND actor != 'перенос'
    AND at >= datetime(?, '-1 day') AND at < datetime(?, '+2 day')`).all(date, date)
    .filter((r) => localDate(parse(r.at)) === date);
  const movedTo = (v) => new Set(moves.filter((r) => r.new_value === v).map((r) => r.entity_id)).size;

  const callsOf = (c) => stats.get(c.id) || {};
  const called = handed.filter((c) => callsOf(c).n);
  const late = handed.filter((c) => {
    const due = parse(c.handoff_due_at);
    const first = parse(callsOf(c).first_at);
    return due && (first ? first > due : due <= Date.now());
  });
  const answered = handed.filter((c) => callsOf(c).answered);
  const noAnswer = handed.filter((c) => callsOf(c).n && !callsOf(c).answered);
  const repeat = handed.filter((c) => c.call_due_at && callsOf(c).n);
  const norec = handed.filter((c) => callsOf(c).norec);

  // «день закрыт» (§8.3): у каждой переданной есть звонок, у разговора — запись
  // или причина, у активной — следующее действие
  const exceptions = [];
  for (const c of handed) {
    const k = callsOf(c);
    const who = leadOf(c).name || c.name || '+' + c.phone;
    if (!k.n) exceptions.push({ id: c.id, who, text: 'нет ни одной попытки звонка' });
    if (k.norec) exceptions.push({ id: c.id, who, text: 'разговор без записи и без причины' });
    if (c.stage !== 'closed' && !c.next) exceptions.push({ id: c.id, who, text: 'нет следующего действия' });
  }

  const row = (c) => {
    const k = stats.get(c.id) || callStatsOne(c.id);
    const l = leadOf(c);
    const sla = k.first_at && c.assigned_at ? Math.round((parse(k.first_at) - parse(c.assigned_at)) / 6e4) : null;
    let lang = '';
    try { lang = dominantLang(db.prepare('SELECT direction, body, media FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 12').all(c.id).reverse()); } catch {}
    return {
      id: c.id, name: l.name || c.name || '', phone: c.phone, created_at: c.created_at,
      manager: getManager(c.manager_id)?.name || '', assigned_at: c.assigned_at, due_at: c.handoff_due_at,
      first_call_at: k.first_at || null, sla_min: sla, source: c.source || '', campaign: c.source_title || '',
      source_url: c.source_url || '', lang, service: l.service || '',
      call_status: k.last_status ? CALL_STATUS[k.last_status] : '', calls: k.n || 0, rec_url: k.last_rec ? recUrl(k.last_rec) : null,
      stage: stageText(c), price: c.deal_sum || amountOf(l.price_quote) || null, price_final: Boolean(c.deal_sum),
      job_date: c.job_date || '', next: c.next, warn: c.warn
    };
  };

  const handedIds = new Set(handed.map((c) => c.id));
  const flagged = convs.filter((c) => !handedIds.has(c.id) && c.stage !== 'closed' && c.warn.some((w) => w.level === 'red'));

  return {
    date,
    kpi: {
      handed: handed.length, called: called.length, not_called: handed.length - called.length, late: late.length,
      answered: answered.length, no_answer: noAnswer.length, repeat: repeat.length,
      offers: movedTo('offer'), agreed: movedTo('agreed'), paid: movedTo('closed:paid'), norec: norec.length
    },
    closed: handed.length > 0 && !exceptions.length,
    exceptions,
    rows: handed.sort((a, b) => String(a.assigned_at).localeCompare(String(b.assigned_at))).map(row),
    flagged: flagged.map(row),
    managers: listManagers()
  };
}

function callStatsOne(id) { return callStats([id]).get(id) || {}; }

/* ─────────── Напоминания менеджеру и вечерний отчёт ─────────── */

const whoOf = (c) => leadOf(c).name || c.name || `+${c.phone}`;

/** Срок действия наступил — напоминаем тому, кто его делает, один раз. */
async function remindTasks() {
  const due = db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL AND next_action IS NOT NULL AND next_action_at <= datetime('now')
    AND next_action_notified_at IS NULL AND stage != 'closed'`).all();
  for (const c of due) {
    db.prepare("UPDATE conversations SET next_action_notified_at=datetime('now') WHERE id=?").run(c.id);
    await notifyManagers(`📌 Пора: ${c.next_action} — ${whoOf(c)}\n${adminLink(c.id)}`,
      { convId: c.id, managerId: c.next_action_mgr }).catch(() => {});
  }
}

/** Вечерний контроль (§2.2, §8): в конце рабочего дня владельцу — итог и исключения. */
async function eveningReport() {
  if (getSetting('evening_report') !== '1') return;
  const today = localDate();
  if (getSetting('evening_report_sent') === today || isHoliday(today)) return;
  const clock = localClock();
  const win = clock && workHours()[clock.day];
  if (!Array.isArray(win)) return;
  const [h, m] = String(win[1]).split(':').map(Number);
  if (clock.min < h * 60 + (m || 0) - 15) return;           // за 15 минут до закрытия — ещё успеют поправить

  db.prepare("INSERT INTO settings(key,value) VALUES('evening_report_sent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(today);
  const d = controlDay(today);
  if (!d.kpi.handed && !d.flagged.length) return;
  const k = d.kpi;
  const lines = [
    `📋 Контроль дня ${today}: ${d.closed ? 'день закрыт ✅' : 'день не закрыт ⚠️'}`,
    `Передано менеджерам: ${k.handed}. Обзвонено: ${k.called}, не обзвонено: ${k.not_called}, с просрочкой: ${k.late}.`,
    `Ответили: ${k.answered}, нет ответа: ${k.no_answer}, повторный звонок: ${k.repeat}.`,
    `Предложений: ${k.offers}, согласовано: ${k.agreed}, оплачено: ${k.paid}.`,
    k.norec ? `Разговоры без записи и причины: ${k.norec}.` : '',
    d.exceptions.length ? 'Исключения:\n' + d.exceptions.slice(0, 10).map((e) => `• ${e.who} — ${e.text}`).join('\n') : '',
    d.flagged.length ? `Ещё ${d.flagged.length} активных заявок с красными флагами.` : '',
    adminLink(0).replace(/\?conv=0$/, '#control')
  ];
  await notifyManagers(lines.filter(Boolean).join('\n'), { ownersOnly: true }).catch(() => {});
}

export function startControl() {
  const tick = () => { remindTasks().catch((e) => console.error('напоминания:', e.message));
    eveningReport().catch((e) => console.error('вечерний отчёт:', e.message)); };
  setInterval(tick, 6e4).unref?.();
}

/* ─────────── Задачи: всё, что запланировано, одним списком ─────────── */

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Кому, когда и что сделать: звонки по сроку, действия менеджеров,
 * «бот напишет клиенту», назначенные уборки и долги. Отдельной таблицы задач
 * нет — список собирается из тех же полей, что видны в карточке, поэтому
 * не расходится с ней.
 */
export function tasksList() {
  const today = localDate();
  const convs = db.prepare(`SELECT * FROM conversations WHERE deleted_at IS NULL
    AND (status != 'closed' OR next_action IS NOT NULL OR followup_at IS NOT NULL)`).all();
  const items = [];
  const who = (id) => getManager(id)?.name || '';
  const base = (c) => {
    let l = {};
    try { l = JSON.parse(c.lead || '{}'); } catch {}
    return { conv_id: c.id, name: l.name || c.name || '', phone: c.phone, stage: c.stage, close_reason: c.close_reason,
      district: l.district || '', service: l.service || '' };
  };
  for (const c of convs) {
    if (c.call_due_at && c.status !== 'closed') {
      items.push({ ...base(c), kind: 'call', what: 'позвонить', at: c.call_due_at, timed: true,
        day: localDate(parse(c.call_due_at)), who: who(c.manager_id), manager_id: c.manager_id });
    }
    if (c.next_action) {
      const m = c.next_action_mgr || c.manager_id;
      items.push({ ...base(c), kind: 'task', what: c.next_action, at: c.next_action_at, timed: true,
        day: c.next_action_at ? localDate(parse(c.next_action_at)) : null, who: who(m), manager_id: m });
    }
    // по закрытой заявке бот клиенту не пишет — такое напоминание задачей не считаем
    if (c.followup_at && (c.status !== 'closed' || c.followup_who === 'manager')) {
      const manual = c.followup_who === 'manager';
      items.push({ ...base(c), kind: manual ? 'task' : 'bot', what: c.followup_note || (manual ? 'напомнить' : 'бот напишет клиенту'),
        at: c.followup_at, timed: false, day: c.followup_at, who: manual ? who(c.manager_id) : 'бот', manager_id: manual ? c.manager_id : null });
    }
    const debt = debtOf(c);
    if (debt > 0) {
      items.push({ ...base(c), kind: 'pay', what: `получить оплату ${debt.toLocaleString('ru-RU')} ₪`, at: null, timed: false,
        day: null, who: who(c.manager_id), manager_id: c.manager_id });
    }
  }
  // назначенные уборки — из работ, у каждой своя дата
  for (const j of db.prepare(`SELECT j.*, c.manager_id, c.stage, c.lead, c.name AS cname, c.phone AS cphone, c.close_reason
      FROM jobs j JOIN conversations c ON c.id = j.conv_id
      WHERE j.status = 'planned' AND c.deleted_at IS NULL AND j.date >= ?`).all(addDays(today, -14))) {
    let l = {};
    try { l = JSON.parse(j.lead || '{}'); } catch {}
    items.push({ conv_id: j.conv_id, name: l.name || j.cname || '', phone: j.cphone, stage: j.stage, close_reason: j.close_reason,
      district: l.district || '', service: l.service || '', kind: 'job', what: 'уборка' + (j.time ? ' в ' + j.time : ''),
      at: j.date + (j.time ? ' ' + j.time : ''), timed: false, day: j.date, who: who(j.manager_id), manager_id: j.manager_id });
  }

  const now = Date.now();
  for (const it of items) {
    it.late = it.timed ? Boolean(it.at && parse(it.at) <= now) : Boolean(it.day && it.day < today && it.kind !== 'job');
    it.bucket = !it.day ? 'nodate' : it.late || it.day < today ? 'late'
      : it.day === today ? 'today' : it.day === addDays(today, 1) ? 'tomorrow'
      : it.day <= addDays(today, 7) ? 'week' : 'later';
  }
  const order = { late: 0, today: 1, tomorrow: 2, week: 3, later: 4, nodate: 5 };
  items.sort((a, b) => order[a.bucket] - order[b.bucket] || String(a.day || '').localeCompare(String(b.day || ''))
    || String(a.at || '').localeCompare(String(b.at || '')));
  return { today, items };
}
