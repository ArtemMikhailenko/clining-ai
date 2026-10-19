/**
 * Очередь заявок по менеджерам.
 *
 * Новая заявка предлагается первому по очереди менеджеру, который принимает
 * заявки, говорит на языке клиента и ещё не набрал свою дневную норму. У него
 * есть час (offer_minutes, рабочего времени), чтобы нажать «Взять в работу»;
 * не взял — заявка уходит следующему. Когда нормы у всех выбраны, заявка
 * падает в общий список: её видят все, берёт тот, кто успел.
 *
 * Ответственный (manager_id) — тот, кто взял заявку в работу. Менять карточку
 * может только он. Если его задача просрочена на open_after_hours часов,
 * карточка открывается всем, а остальным приходит уведомление.
 *
 * Всё, что происходит с заявкой, пишется в assign_log — из него статистика.
 */
import { db, getSetting, audit } from './db.js';
import { getManager, sqlTime, langGroup, freshDuesOnTransfer } from './calls.js';
import { nextWorkStart, localDate, withinWorkHours } from './schedule.js';
import { notifyManagers, sendToPhones, adminLink, localTime } from './notify.js';

const parse = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);
const listOf = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const convOf = (id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
const whoOf = (c) => {
  let l = {};
  try { l = JSON.parse(c.lead || '{}'); } catch {}
  return `${l.name || c.name || 'клиент'}, +${c.phone}`;
};

export function logAssign(convId, managerId, kind, note = null) {
  db.prepare('INSERT INTO assign_log(conv_id, manager_id, kind, note) VALUES (?,?,?,?)').run(convId, managerId ?? null, kind, note);
}

/** Сколько заявок менеджеру уже предложили сегодня (по местной дате). */
function offersToday(managerId) {
  const today = localDate();
  return db.prepare("SELECT at FROM assign_log WHERE manager_id=? AND kind='offered' AND at >= datetime('now', '-2 days')")
    .all(managerId).filter((r) => localDate(parse(r.at)) === today).length;
}

/** Кому предложить: первый по очереди, кто принимает, подходит по языку и не набрал норму. */
export function queuePick(c, exclude = []) {
  const g = langGroup(c.lang);
  return db.prepare('SELECT * FROM managers WHERE active=1 AND daily_quota > 0 ORDER BY sort, id').all()
    .filter((m) => !exclude.includes(m.id))
    // язык не отмечен — берёт любые; язык клиента не узнали — подходит любой
    .filter((m) => { const ls = listOf(m.langs); return !ls.length || !g || ls.includes(g); })
    .find((m) => offersToday(m.id) < m.daily_quota) || null;
}

const offerDue = () => {
  const min = Math.max(5, Number(getSetting('offer_minutes')) || 60);
  return new Date(nextWorkStart(new Date()).getTime() + min * 6e4);
};

/**
 * Предложить заявку следующему по очереди. Без notify уведомление отправит
 * вызывающий (новая заявка уходит одним сообщением вместе с её текстом).
 */
export async function offerLead(convId, why = 'новая заявка', { notify = false } = {}) {
  const c = convOf(convId);
  if (!c || c.status === 'closed' || c.deleted_at || c.manager_id) return null;
  if (c.offered_to && parse(c.offer_due_at) > Date.now()) return getManager(c.offered_to);
  const tried = listOf(c.offer_tried).map(Number);
  const m = queuePick(c, tried);
  if (!m) {
    db.prepare('UPDATE conversations SET offered_to=NULL, offered_at=NULL, offer_due_at=NULL WHERE id=?').run(convId);
    if (!db.prepare("SELECT 1 FROM assign_log WHERE conv_id=? AND kind='pool'").get(convId)) {
      logAssign(convId, null, 'pool', why);
      if (notify) await notifyManagers(`📥 Заявка в общем списке — ${whoOf(c)}\nНикто из очереди её не взял. Кто первый возьмёт в работу, тот и ведёт.\n${adminLink(convId)}`,
        { owners: true }).catch(() => {});
    }
    return null;
  }
  const due = sqlTime(offerDue());
  db.prepare("UPDATE conversations SET offered_to=?, offered_at=datetime('now'), offer_due_at=?, offer_tried=? WHERE id=?")
    .run(m.id, due, [...tried, m.id].join(','), convId);
  logAssign(convId, m.id, 'offered', why);
  audit('lead', convId, 'offered_to', null, m.name, 'система', why);
  if (notify && m.phone) {
    await sendToPhones([m.phone], `🆕 Вам заявка — ${whoOf(c)}\nВозьмите в работу до ${localTime(due)}, иначе она перейдёт следующему.\n${adminLink(convId)}`);
  }
  return m;
}

/**
 * «Взять в работу». Свободную, свою или открытую после просрочки — может любой
 * менеджер; предложенную другому — только когда истёк его час. Владелец — всегда.
 */
export function takeLead(convId, user) {
  const c = convOf(convId);
  if (!c) throw new Error('Нет такой заявки');
  if (c.manager_id && c.manager_id === user.id) return c;
  const me = getManager(user.id);
  if (!me) throw new Error('Взять в работу может только менеджер из списка в настройках');
  if (user.role !== 'owner') {
    if (c.manager_id && !c.open_at) throw new Error(`Заявку ведёт ${getManager(c.manager_id)?.name || 'другой менеджер'}`);
    if (!c.manager_id && c.offered_to && c.offered_to !== user.id && parse(c.offer_due_at) > Date.now()) {
      throw new Error(`Заявка в очереди у менеджера ${getManager(c.offered_to)?.name || '—'} до ${localTime(c.offer_due_at)}. Если он не возьмёт её в работу — она перейдёт дальше`);
    }
  }
  const prev = c.manager_id;
  db.prepare(`UPDATE conversations SET manager_id=?, taken_at=datetime('now'), assigned_at=COALESCE(assigned_at, datetime('now')),
    offered_to=NULL, offer_due_at=NULL, open_at=NULL WHERE id=?`).run(user.id, convId);
  logAssign(convId, user.id, 'taken', prev ? 'после просрочки' : c.offered_to === user.id ? 'по очереди' : 'из общего списка');
  // взяли у другого после просрочки — для него это «передал»
  if (prev && prev !== user.id) { logAssign(convId, prev, 'lost', `перешла к ${me.name}`); freshDuesOnTransfer(convId, user.id, me.name); }
  audit('lead', convId, 'manager_id', getManager(prev)?.name ?? null, me.name, me.name, 'взял в работу');
  return convOf(convId);
}

/** Раз в минуту: истёкшие предложения и просроченные задачи. */
export async function queueTick() {
  // 1) предложенную заявку не взяли за отведённое время — дальше по очереди
  for (const c of db.prepare(`SELECT * FROM conversations WHERE manager_id IS NULL AND offered_to IS NOT NULL
      AND offer_due_at <= datetime('now') AND status != 'closed' AND deleted_at IS NULL`).all()) {
    const prev = getManager(c.offered_to);
    logAssign(c.id, c.offered_to, 'expired');
    db.prepare('UPDATE conversations SET offered_to=NULL, offer_due_at=NULL WHERE id=?').run(c.id);
    const m = await offerLead(c.id, `${prev?.name || 'менеджер'} не взял вовремя`, { notify: true });
    if (prev?.phone) await sendToPhones([prev.phone], `Заявку ${whoOf(c)} вы не взяли в работу вовремя — она ${m ? 'передана: ' + m.name : 'ушла в общий список'}.`);
  }

  // 2) взятая заявка, задача просрочена на N часов — открываем всем
  if (!withinWorkHours()) return;
  const lag = `-${Math.max(1, Number(getSetting('open_after_hours')) || 5)} hours`;
  for (const c of db.prepare(`SELECT * FROM conversations WHERE manager_id IS NOT NULL AND open_at IS NULL
      AND status != 'closed' AND deleted_at IS NULL
      AND ((call_due_at IS NOT NULL AND call_due_at <= datetime('now', ?))
        OR (next_action IS NOT NULL AND next_action_at IS NOT NULL AND next_action_at <= datetime('now', ?)))`).all(lag, lag)) {
    db.prepare("UPDATE conversations SET open_at=datetime('now') WHERE id=?").run(c.id);
    logAssign(c.id, c.manager_id, 'opened');
    const m = getManager(c.manager_id);
    const due = c.call_due_at || c.next_action_at;
    const phones = db.prepare(`SELECT phone FROM managers WHERE (active=1 OR role='owner') AND id != ? AND phone IS NOT NULL AND phone != ''`)
      .all(c.manager_id).map((x) => x.phone);
    await sendToPhones([...new Set(phones)], `⏰ Клиент ждёт ${c.call_due_at ? 'звонка' : 'ответа'} с ${localTime(due)} — ${whoOf(c)}\n`
      + `${m?.name || 'Ответственный'} не успел. Заявку можно взять в работу.\n${adminLink(c.id)}`);
  }
}

export function startQueue() {
  setInterval(() => queueTick().catch((e) => console.error('очередь заявок:', e.message)), 6e4).unref?.();
}

/**
 * Статистика по менеджерам за период (местные даты включительно):
 * получил — сколько заявок ему предложила очередь; взял — сколько взял в работу
 * (по очереди, из общего списка или после чужой просрочки); не взял — час истёк;
 * передал — взял, но просрочил задачу и клиента забрал другой.
 */
export function teamStats(from, to) {
  const inRange = (at) => { const d = localDate(parse(at)); return d >= from && d <= to; };
  const log = db.prepare(`SELECT * FROM assign_log WHERE at >= datetime(?, '-1 day') AND at < datetime(?, '+2 day')`)
    .all(from, to).filter((r) => inRange(r.at));
  const convs = db.prepare(`SELECT id, manager_id, taken_at, stage, close_reason, paid_sum, deal_sum, status FROM conversations
    WHERE deleted_at IS NULL AND manager_id IS NOT NULL`).all();
  const rows = db.prepare('SELECT id, name, role, active, daily_quota FROM managers ORDER BY sort, id').all().map((m) => {
    const k = (kind) => log.filter((r) => r.manager_id === m.id && r.kind === kind);
    const takenIds = new Set(k('taken').map((r) => r.conv_id));
    const mine = convs.filter((c) => c.manager_id === m.id && takenIds.has(c.id));
    const paid = mine.filter((c) => c.paid_sum > 0 || c.close_reason === 'paid');
    return {
      id: m.id, name: m.name, role: m.role, active: m.active, daily_quota: m.daily_quota,
      offered: k('offered').length, taken: takenIds.size, expired: k('expired').length, lost: k('lost').length,
      in_work: convs.filter((c) => c.manager_id === m.id && c.status !== 'closed').length,
      agreed: mine.filter((c) => ['agreed', 'done'].includes(c.stage) || c.close_reason === 'paid').length,
      paid: paid.length, revenue: paid.reduce((s, c) => s + (c.paid_sum || 0), 0),
      close_rate: takenIds.size ? Math.round(paid.length / takenIds.size * 100) : null
    };
  });
  const pool = new Set(log.filter((r) => r.kind === 'pool').map((r) => r.conv_id)).size;
  return { from, to, rows, pool };
}
