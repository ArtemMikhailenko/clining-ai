/**
 * Журнал сбоев внешних сервисов и очередь повтора (этап 3).
 *
 * Раньше сбой отправки уведомления менеджеру оставался строчкой в логах хостинга:
 * менеджер не узнавал о заявке, и никто не узнавал, что он не узнал. Теперь
 * каждый сбой виден владельцу, а уведомления команде повторяются сами.
 * Сообщения клиенту не повторяем: через полчаса оно уже неуместно, такой
 * диалог сразу уходит менеджеру.
 */
import { db } from './db.js';
import { channel } from './channels/index.js';

const BACKOFF_MIN = [1, 5, 15, 60];        // после пятой попытки — «не удалось»

export function logFailure(kind, { target = null, convId = null, payload = null, error = '', retry = false } = {}) {
  try {
    db.prepare(`INSERT INTO integration_log(kind, target, conv_id, payload, error, status, next_try_at)
      VALUES(?,?,?,?,?,?, CASE WHEN ? THEN datetime('now', '+1 minutes') END)`)
      .run(kind, target, convId, payload == null ? null : JSON.stringify(payload), String(error).slice(0, 500),
        retry ? 'retry' : 'failed', retry ? 1 : 0);
  } catch (e) {
    console.error('журнал сбоев:', e.message);
  }
}

async function attempt(row) {
  const p = JSON.parse(row.payload || '{}');
  if (row.kind === 'notify') {
    await channel.send({ phone: row.target, chat_id: null, channel: channel.name }, p.text);
    return;
  }
  throw new Error('этот сбой повторить нельзя');
}

export async function retryQueue() {
  const due = db.prepare(`SELECT * FROM integration_log WHERE status='retry' AND next_try_at <= datetime('now')
    ORDER BY id LIMIT 20`).all();
  for (const r of due) {
    try {
      await attempt(r);
      db.prepare("UPDATE integration_log SET status='done', done_at=datetime('now'), attempts=attempts+1 WHERE id=?").run(r.id);
    } catch (e) {
      const n = r.attempts + 1;
      const wait = BACKOFF_MIN[n - 1];
      db.prepare(`UPDATE integration_log SET attempts=?, error=?, status=?, next_try_at=${wait ? "datetime('now', ?)" : 'NULL'} WHERE id=?`)
        .run(...[n, String(e.message).slice(0, 500), wait ? 'retry' : 'failed', ...(wait ? [`+${wait} minutes`] : []), r.id]);
    }
  }
}

/** Владелец жмёт «Повторить» — сразу в очередь, счётчик попыток с нуля. */
export function retryNow(id) {
  const r = db.prepare('SELECT * FROM integration_log WHERE id=?').get(id);
  if (!r) throw new Error('Нет такой записи');
  if (r.kind !== 'notify') throw new Error('Этот сбой повторить нельзя — он показан для сведения');
  db.prepare("UPDATE integration_log SET status='retry', attempts=0, next_try_at=datetime('now') WHERE id=?").run(id);
}

export const listFailures = (limit = 200) => db.prepare(`SELECT l.*, c.name AS conv_name, c.phone AS conv_phone
  FROM integration_log l LEFT JOIN conversations c ON c.id = l.conv_id ORDER BY l.id DESC LIMIT ?`).all(limit);

export function startRetries() {
  setInterval(() => retryQueue().catch((e) => console.error('очередь повтора:', e.message)), 6e4).unref?.();
}
