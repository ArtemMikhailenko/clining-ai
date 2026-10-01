/**
 * Менеджеры, передача заявки и звонки (ТЗ §2, §6, §7).
 *
 * Передача — это не только «нужен человек»: у заявки появляется ответственный
 * и срок, до которого он должен позвонить. Срок считается от рабочих часов:
 * ночью передали — звонок к началу следующего окна. Каждая попытка звонка
 * пишется отдельно; «не ответил» без даты следующего звонка не принимается,
 * иначе заявка тихо теряется.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, getSetting, audit } from './db.js';
import { nextWorkStart } from './schedule.js';

export const CALL_STATUS = {
  answered: 'дозвонился', no_answer: 'не ответил', busy: 'занято / сбросил',
  callback: 'просил перезвонить', wrong: 'не тот номер'
};
// после этих исходов заявка не может остаться без следующего звонка
const NEEDS_NEXT = new Set(['no_answer', 'busy', 'callback']);

export const REC_DIR = path.join(process.cwd(), 'data', 'media', 'calls');
export const REC_TYPES = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg',
  'audio/opus': 'ogg' };

/** Время в формате SQLite datetime('now'): UTC, без «T» и миллисекунд. */
export const sqlTime = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const parseTime = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')) : null);

/* ─────────── Менеджеры ─────────── */

export const listManagers = () =>
  db.prepare("SELECT * FROM managers ORDER BY role = 'owner' DESC, id").all();
export const getManager = (id) => (id ? db.prepare('SELECT * FROM managers WHERE id=?').get(id) : null);
export const cleanPhone = (v) => String(v || '').replace(/\D/g, '');

export function saveManager(m) {
  const name = String(m.name || '').trim();
  if (!name) throw new Error('Нужно имя');
  const phone = cleanPhone(m.phone);
  if (phone && phone.length < 9) throw new Error('Номер слишком короткий — с кодом страны, например 972501234567');
  const role = m.role === 'owner' ? 'owner' : 'manager';
  const active = m.active === false || m.active === 0 ? 0 : 1;
  if (m.id) {
    db.prepare('UPDATE managers SET name=?, phone=?, role=?, active=? WHERE id=?').run(name, phone || null, role, active, m.id);
    return getManager(m.id);
  }
  const r = db.prepare('INSERT INTO managers(name, phone, role, active) VALUES(?,?,?,?)').run(name, phone || null, role, active);
  return getManager(Number(r.lastInsertRowid));
}

export function deleteManager(id) {
  // заявки не теряем: они просто остаются без ответственного и попадут в «Контроль дня»
  db.prepare('UPDATE conversations SET manager_id=NULL WHERE manager_id=?').run(id);
  db.prepare('DELETE FROM managers WHERE id=?').run(id);
}

/** Кому дать заявку: из принимающих — тому, у кого меньше ждущих звонка. */
export function pickManager() {
  return db.prepare(`SELECT m.*, (SELECT count(*) FROM conversations c
      WHERE c.manager_id = m.id AND c.call_due_at IS NOT NULL AND c.status != 'closed') AS load
    FROM managers m WHERE m.active = 1 ORDER BY load, m.id LIMIT 1`).get() || null;
}

/** Номера для рассылки: ответственный, а если его нет — все, кто принимает заявки. */
export function recipients(convId, { owners = false, managerId = null } = {}) {
  const conv = convId ? db.prepare('SELECT manager_id FROM conversations WHERE id=?').get(convId) : null;
  const mine = getManager(managerId || conv?.manager_id);
  const base = mine?.phone ? [mine] : db.prepare("SELECT * FROM managers WHERE active=1 AND phone IS NOT NULL AND phone != ''").all();
  const extra = owners ? db.prepare("SELECT * FROM managers WHERE role='owner' AND phone IS NOT NULL AND phone != ''").all() : [];
  return [...new Set([...base, ...extra].map((m) => m.phone).filter(Boolean))];
}

/* ─────────── Передача и срок звонка ─────────── */

export function callDue(from = new Date()) {
  const sla = Math.max(1, Number(getSetting('call_sla_min')) || 5);
  return new Date(nextWorkStart(from).getTime() + sla * 6e4);
}

/**
 * Заявка передана человеку. Если звонка уже ждут — срок не сдвигаем: повторная
 * передача по той же заявке не должна отодвигать просрочку.
 */
export function assignHandoff(convId, { actor = 'система', why = '' } = {}) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  if (!conv || conv.status === 'closed') return null;
  if (conv.call_due_at) return getManager(conv.manager_id);

  const keep = getManager(conv.manager_id);
  const m = keep || pickManager();
  const due = sqlTime(callDue());
  db.prepare(`UPDATE conversations SET manager_id=?, assigned_at=datetime('now'), call_due_at=?, handoff_due_at=?,
    call_escalated_at=NULL WHERE id=?`).run(m?.id ?? null, due, due, convId);
  if (!keep && m) audit('lead', convId, 'manager_id', null, m.name, actor, why || 'передача менеджеру');
  audit('lead', convId, 'call_due_at', null, due, actor, why || 'передача менеджеру');
  return m;
}

export function setManager(convId, managerId, actor = 'менеджер') {
  const conv = db.prepare('SELECT manager_id FROM conversations WHERE id=?').get(convId);
  if (!conv) throw new Error('Нет такой заявки');
  const m = managerId ? getManager(managerId) : null;
  if (managerId && !m) throw new Error('Нет такого менеджера');
  db.prepare('UPDATE conversations SET manager_id=?, assigned_at=COALESCE(assigned_at, datetime(\'now\')) WHERE id=?')
    .run(m?.id ?? null, convId);
  audit('lead', convId, 'manager_id', getManager(conv.manager_id)?.name ?? null, m?.name ?? null, actor);
}

/** Звонок больше не нужен: вернули боту, закрыли, сняли флаг. */
export function clearCallDue(convId, actor, why) {
  const conv = db.prepare('SELECT call_due_at FROM conversations WHERE id=?').get(convId);
  if (!conv?.call_due_at) return;
  db.prepare('UPDATE conversations SET call_due_at=NULL, call_escalated_at=NULL WHERE id=?').run(convId);
  audit('lead', convId, 'call_due_at', conv.call_due_at, null, actor, why);
}

/* ─────────── Звонки ─────────── */

export function listCalls(convId) {
  return db.prepare(`SELECT k.*, m.name AS manager_name FROM calls k
    LEFT JOIN managers m ON m.id = k.manager_id WHERE k.conv_id=? ORDER BY k.id DESC`).all(convId);
}

export function logCall(convId, b, actor = 'менеджер') {
  const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  if (!conv) throw new Error('Нет такой заявки');
  const status = String(b.status || '');
  if (!CALL_STATUS[status]) throw new Error('Выберите, чем закончился звонок');

  const next = b.next_call_at ? parseTime(b.next_call_at) : null;
  if (b.next_call_at && (!next || Number.isNaN(next.getTime()))) throw new Error('Не понял дату следующего звонка');
  if (NEEDS_NEXT.has(status) && !next) throw new Error('Когда звонить снова? Без даты заявка потеряется');

  const recording = b.recording ? path.basename(String(b.recording)) : null;
  if (recording && !fs.existsSync(path.join(REC_DIR, recording))) throw new Error('Запись не загрузилась — прикрепите ещё раз');
  const noRec = String(b.no_record_reason || '').trim();
  if (status === 'answered' && !recording && !noRec) throw new Error('Разговор состоялся: прикрепите запись или напишите, почему её нет');
  // §6.2: после разговора нужен итог — иначе непонятно, что делать дальше
  if (status === 'answered' && !String(b.outcome || '').trim()) throw new Error('Напишите, о чём договорились');

  const duration = Math.max(0, Math.round(Number(b.duration_min || 0) * 60)) || null;
  const managerId = Number(b.manager_id) || conv.manager_id || null;
  const r = db.prepare(`INSERT INTO calls(conv_id, manager_id, status, duration_sec, outcome, next_call_at,
      recording, no_record_reason, due_at, actor) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(convId, managerId, status, duration, String(b.outcome || '').trim() || null,
      next ? sqlTime(next) : null, recording, noRec || null, conv.call_due_at, actor);

  // следующий звонок становится новым сроком; иначе звонить больше не нужно
  const due = next ? sqlTime(next) : null;
  db.prepare('UPDATE conversations SET call_due_at=?, call_escalated_at=NULL, manager_id=COALESCE(manager_id, ?) WHERE id=?')
    .run(due, managerId, convId);
  audit('lead', convId, 'call', null, CALL_STATUS[status], actor, String(b.outcome || '').trim() || null);
  if (due !== conv.call_due_at) audit('lead', convId, 'call_due_at', conv.call_due_at, due, actor, 'после звонка');
  return db.prepare('SELECT * FROM calls WHERE id=?').get(Number(r.lastInsertRowid));
}

/** Запись приходит отдельным запросом до сохранения звонка — сохраняем файл и отдаём имя. */
export function saveRecording(buf, mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  const ext = REC_TYPES[type];
  if (!ext) throw new Error('Нужен файл MP3, M4A, WAV или OGG');
  const maxMb = Math.max(1, Number(getSetting('rec_max_mb')) || 50);
  if (buf.length > maxMb * 1048576) throw new Error(`Файл больше ${maxMb} МБ`);
  if (!buf.length) throw new Error('Пустой файл');
  fs.mkdirSync(REC_DIR, { recursive: true });
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(REC_DIR, file), buf);
  return file;
}

/** Срок хранения записей (ТЗ §6.1): старше N дней — удаляем файл, строку звонка оставляем. */
export function sweepRecordings() {
  const days = Number(getSetting('rec_keep_days')) || 0;
  if (!days) return 0;
  const old = db.prepare(`SELECT id, recording FROM calls WHERE recording IS NOT NULL
    AND at < datetime('now', ?)`).all(`-${days} days`);
  for (const c of old) {
    try { fs.rmSync(path.join(REC_DIR, c.recording), { force: true }); } catch {}
    db.prepare("UPDATE calls SET recording=NULL, no_record_reason='удалена по сроку хранения' WHERE id=?").run(c.id);
  }
  return old.length;
}

/** Просроченные звонки, по которым ещё никого не предупредили. */
export const overdueCalls = () => db.prepare(`SELECT * FROM conversations
  WHERE call_due_at IS NOT NULL AND call_due_at <= datetime('now')
    AND call_escalated_at IS NULL AND status != 'closed'`).all();
