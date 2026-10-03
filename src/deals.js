/**
 * Сделки, работы и оплаты (этап 5, ТЗ §10).
 *
 * Сделка — это заявка (conversations). Работа — выезд на уборку с датой и
 * итогом: выполнено, перенесено или отменено, с причиной. Оплата — отдельный
 * платёж: сумма, способ, дата; их может быть несколько (предоплата + остаток).
 * В заявке paid_sum и paid_at остаются как итог по оплатам — на них построены
 * воронка, отчёт и контроль.
 */
import { db, audit, applyStage, assertHumanWrite, getConversation } from './db.js';
import { actorName, currentUser } from './context.js';
import { stageIndex } from './stages.js';

export const PAY_METHODS = { cash: 'наличные', transfer: 'перевод', bit: 'Bit', card: 'карта', check: 'чек', other: 'другое' };
export const WORK_STATUS = { planned: 'назначена', done: 'выполнена', moved: 'перенесена', cancelled: 'отменена' };

const day = (v) => String(v || '').slice(0, 10);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₪`;

/* ─────────── Оплаты ─────────── */

export const listPayments = (convId) =>
  db.prepare('SELECT * FROM payments WHERE conv_id=? ORDER BY paid_at DESC, id DESC').all(convId);

/** Итог по живым платежам — в заявку, чтобы отчёты и воронка видели одну цифру. */
function recalcPaid(convId) {
  const r = db.prepare(`SELECT COALESCE(sum(amount),0) total, max(paid_at) last FROM payments
    WHERE conv_id=? AND deleted_at IS NULL`).get(convId);
  db.prepare('UPDATE conversations SET paid_sum=?, paid_at=? WHERE id=?').run(r.total || null, r.last || null, convId);
  return r.total;
}

/** Сколько клиент ещё должен: работа выполнена, а оплачено меньше окончательной цены. */
export function debtOf(c) {
  const done = c.stage === 'done' || (c.stage === 'closed' && c.close_reason === 'paid');
  if (!done || !(c.deal_sum > 0)) return 0;
  return Math.max(0, c.deal_sum - (c.paid_sum || 0));
}

export function addPayment(convId, b) {
  assertHumanWrite('оплата');
  const c = getConversation(convId);
  if (!c) throw new Error('Нет такой заявки');
  const amount = Math.round(Number(String(b.amount ?? '').replace(/[^\d.]/g, '')));
  if (!(amount > 0)) throw new Error('Сумма оплаты больше нуля');
  const method = PAY_METHODS[b.method] ? b.method : 'other';
  const paidAt = isDay(b.paid_at) ? b.paid_at : new Intl.DateTimeFormat('sv-SE').format(new Date());
  db.prepare('INSERT INTO payments(conv_id, amount, method, paid_at, note, created_by) VALUES(?,?,?,?,?,?)')
    .run(convId, amount, method, paidAt, String(b.note || '').trim() || null, actorName('менеджер'));
  const total = recalcPaid(convId);
  audit('lead', convId, 'payment', null, `${money(amount)} · ${PAY_METHODS[method]} · ${paidAt}`, 'менеджер');
  // полностью оплачено (или цена не указана, а деньги пришли) — сделка закрыта как оплаченная;
  // предоплата сделку не закрывает: остаток виден как задолженность после работ
  const full = !(c.deal_sum > 0) || total >= c.deal_sum;
  if (full && !(c.stage === 'closed' && c.close_reason === 'paid')) {
    applyStage(convId, 'closed', { close: 'paid', actor: 'менеджер', why: 'внесена оплата' });
  }
  return { total, full };
}

export function deletePayment(convId, paymentId, reason) {
  assertHumanWrite('оплата');
  const p = db.prepare('SELECT * FROM payments WHERE id=? AND conv_id=? AND deleted_at IS NULL').get(paymentId, convId);
  if (!p) throw new Error('Нет такой оплаты');
  if (!String(reason || '').trim()) throw new Error('Укажите причину');
  db.prepare("UPDATE payments SET deleted_at=datetime('now'), deleted_by=?, delete_reason=? WHERE id=?")
    .run(actorName('менеджер'), String(reason).trim(), paymentId);
  const total = recalcPaid(convId);
  audit('lead', convId, 'payment', `${money(p.amount)} · ${p.paid_at}`, null, 'менеджер', String(reason).trim());
  // оплата отменена — сделка уже не «оплачена»: возвращаем на «выполнено»
  const c = getConversation(convId);
  if (c.close_reason === 'paid' && (c.deal_sum > 0 ? total < c.deal_sum : total <= 0)) {
    applyStage(convId, 'done', { actor: 'менеджер', why: 'оплата отменена: ' + String(reason).trim() });
  }
  return { total };
}

/* ─────────── Работы ─────────── */

export const listWorks = (convId) =>
  db.prepare("SELECT * FROM jobs WHERE conv_id=? ORDER BY date DESC, id DESC").all(convId);

const planned = (convId) =>
  db.prepare("SELECT * FROM jobs WHERE conv_id=? AND status='planned' ORDER BY id DESC LIMIT 1").get(convId);

/**
 * Дату записи поставили или поменяли в карточке. Новая дата у уже назначенной
 * работы — это перенос: старая строка остаётся с пометкой, история не теряется.
 */
export function syncWorkDate(convId, date, time) {
  const c = getConversation(convId);
  const cur = planned(convId);
  const by = actorName('менеджер');
  if (!isDay(date)) {
    if (cur) {
      db.prepare("UPDATE jobs SET status='cancelled', status_reason='дату записи сняли в карточке' WHERE id=?").run(cur.id);
      audit('lead', convId, 'work', `${cur.date} ${cur.time || ''}`.trim(), 'отменена', 'менеджер', 'дату записи сняли');
    }
    return;
  }
  if (cur && cur.date === date && (cur.time || '') === (time || '')) return;
  if (cur && cur.date === date) {
    db.prepare('UPDATE jobs SET time=? WHERE id=?').run(time || null, cur.id);
    return;
  }
  if (cur) db.prepare("UPDATE jobs SET status='moved', status_reason='дату изменили в карточке' WHERE id=?").run(cur.id);
  let l = {};
  try { l = JSON.parse(c.lead || '{}'); } catch {}
  db.prepare(`INSERT INTO jobs(date, time, name, phone, service, area, district, price, conv_id, status, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,'planned',?)`)
    .run(date, time || null, l.name || c.name, c.phone, l.service || null, l.area_m2 || null, l.district || null,
      c.deal_sum ? String(c.deal_sum) : null, convId, by);
}

export function workDone(convId, jobId) {
  assertHumanWrite('работа');
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND conv_id=?").get(jobId, convId);
  if (!j) throw new Error('Нет такой работы');
  if (j.status === 'done') return;
  db.prepare("UPDATE jobs SET status='done', done_at=datetime('now') WHERE id=?").run(jobId);
  audit('lead', convId, 'work', WORK_STATUS[j.status], `выполнена ${j.date}`, 'менеджер');
  const c = getConversation(convId);
  if (c.stage !== 'closed' && stageIndex(c.stage) < stageIndex('done')) {
    applyStage(convId, 'done', { actor: 'менеджер', why: 'работа выполнена' });
  }
}

export function workMove(convId, jobId, { date, time, reason }) {
  assertHumanWrite('работа');
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND conv_id=?").get(jobId, convId);
  if (!j) throw new Error('Нет такой работы');
  if (!isDay(date)) throw new Error('Новая дата — ГГГГ-ММ-ДД');
  if (!String(reason || '').trim()) throw new Error('Укажите причину переноса');
  db.prepare("UPDATE jobs SET status='moved', status_reason=? WHERE id=?").run(String(reason).trim(), jobId);
  db.prepare(`INSERT INTO jobs(date, time, name, phone, service, area, district, price, conv_id, status, created_by)
    SELECT ?, ?, name, phone, service, area, district, price, conv_id, 'planned', ? FROM jobs WHERE id=?`)
    .run(date, time || j.time || null, actorName('менеджер'), jobId);
  db.prepare('UPDATE conversations SET job_date=?, job_time=?, confirm_sent=NULL WHERE id=?').run(date, time || j.time || null, convId);
  audit('lead', convId, 'job_date', `${j.date} ${j.time || ''}`.trim(), `${date} ${time || j.time || ''}`.trim(), 'менеджер', String(reason).trim());
}

export function workCancel(convId, jobId, reason) {
  assertHumanWrite('работа');
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND conv_id=?").get(jobId, convId);
  if (!j) throw new Error('Нет такой работы');
  if (!String(reason || '').trim()) throw new Error('Укажите причину отмены');
  db.prepare("UPDATE jobs SET status='cancelled', status_reason=? WHERE id=?").run(String(reason).trim(), jobId);
  db.prepare('UPDATE conversations SET job_date=NULL, job_time=NULL, confirm_sent=NULL WHERE id=?').run(convId);
  audit('lead', convId, 'work', `${j.date} ${j.time || ''}`.trim(), 'отменена', 'менеджер', String(reason).trim());
}

/* ─────────── Клиент и его сделки ─────────── */

export function contactDeals(c) {
  if (!c?.contact_id) return [];
  return db.prepare(`SELECT id, created_at, stage, close_reason, deal_sum, paid_sum, job_date, source, campaign_name,
      ad_name, source_title, attr_status, deleted_at, manager_id
    FROM conversations WHERE contact_id=? ORDER BY id DESC`).all(c.contact_id);
}

/** Повторный заказ, о котором клиент сказал по телефону, — новая сделка вручную. */
export function newDealFrom(convId) {
  const c = getConversation(convId);
  if (!c) throw new Error('Нет такой заявки');
  const u = currentUser();
  const id = Number(db.prepare(`INSERT INTO conversations(channel, phone, phone_raw, name, chat_id, stage, contact_id,
      prev_deal_id, status, ai_enabled, manager_id, assigned_at, attr_status, attr_reason, platform, lead)
    VALUES(?,?,?,?,?,'new',?,?,'human',0,?,datetime('now'),'manual','повторный заказ — заведён вручную','organic',?)`)
    .run(c.channel, c.phone, c.phone_raw || c.phone, c.name, c.chat_id, c.contact_id, c.id, u?.id || c.manager_id || null,
      JSON.stringify({ name: (() => { try { return JSON.parse(c.lead || '{}').name || undefined; } catch { return undefined; } })() }))
    .lastInsertRowid);
  audit('lead', id, 'deal', `сделка #${c.id}`, `новая сделка #${id}`, 'менеджер', 'повторный заказ');
  return id;
}

/** Переписка по всем сделкам клиента: история общая, сделки — разные. */
export function contactMessages(c, limit = 200) {
  const ids = c?.contact_id
    ? db.prepare('SELECT id FROM conversations WHERE contact_id=?').all(c.contact_id).map((r) => r.id)
    : [c.id];
  return db.prepare(`SELECT * FROM messages WHERE conv_id IN (${ids.map(() => '?').join(',')})
    ORDER BY id DESC LIMIT ?`).all(...ids, limit).reverse();
}
