import { db, addMessage, getOrCreateConversation, getConversation, history, getSetting, messageExists } from './db.js';
import { generateReply } from './ai.js';
import { channel, adapterFor } from './channels/index.js';
import { detectLang } from './lang.js';
import { withinWorkHours, scheduleSetting, sweepStale, workHours, isHoliday } from './schedule.js';

const listeners = new Set();

// На время тестов бот сидит на личном номере. Чтобы реальные контакты не получали
// ответы ИИ, автоответ можно ограничить списком номеров — он правится в админке
// на лету, перезапуск не нужен. Пусто — отвечаем всем.
// mock — это симулятор, он никуда наружу не пишет, ограничивать его незачем.
function allowed(phone, ch) {
  if (ch.name === 'mock') return true;
  const list = (getSetting('allowed_numbers') || '')
    .split(/[,\s]+/).map((n) => n.replace(/\D/g, '')).filter(Boolean);
  return !list.length || list.includes(String(phone).replace(/\D/g, ''));
}
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const emit = (event, data) => {
  for (const fn of listeners) { try { fn(event, data); } catch {} }
};

/** Приветствие хранится строками вида «uk: текст»; берём подходящее, иначе первое. */
function pickGreeting(text) {
  const raw = (getSetting('greeting') || '').trim();
  if (!raw) return '';
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    const m = /^([a-z]{2}):\s*(.+)$/i.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  if (!map.size) return raw;                       // одна строка без префикса — как есть
  return map.get(detectLang(text)) ?? map.get('ru') ?? [...map.values()][0];
}

/** Можно ли назначить уборку на эту дату: рабочий день и не праздник. */
function workableDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  if (isHoliday(iso)) return false;
  const day = new Date(iso + 'T12:00:00Z').getUTCDay();
  return Array.isArray(workHours()[day]);
}

function flagHuman(convId, reason) {
  // ai_enabled=0 обязательно: иначе бот молчит (status=human), а интерфейс
  // показывает «Перехватить», и вернуть ИИ нечем
  db.prepare("UPDATE conversations SET needs_human=1, handoff_reason=?, status='human', ai_enabled=0 WHERE id=?")
    .run(reason, convId);
}

/**
 * Клиенты в мессенджере почти всегда пишут очередью коротких реплик.
 * Отвечать на каждую отдельно — значит слать дубли и жечь лимит запросов,
 * поэтому ждём, пока человек договорит, и отвечаем один раз на всю пачку.
 */
const debounceMs = () => Math.max(500, Number(getSetting('reply_delay')) || 4000);
const timers = new Map();    // conv_id → таймер отложенного ответа
const busy = new Set();      // conv_id → ответ уже генерируется

function scheduleReply(convId, ch, text) {
  clearTimeout(timers.get(convId));
  timers.set(convId, setTimeout(() => {
    timers.delete(convId);
    // если предыдущий ответ ещё идёт — не наслаиваемся, подождём и попробуем снова
    if (busy.has(convId)) return scheduleReply(convId, ch, text);
    busy.add(convId);
    respond(convId, ch, text).finally(() => busy.delete(convId));
  }, debounceMs()));
}

/** Входящее сообщение клиента: сохранить → при включённом ИИ поставить ответ в очередь. */
export async function handleIncoming({ phone, name, text, wa_id, chat_id = null, media = [] }, ch = channel) {
  if (messageExists(wa_id)) return;   // повторная доставка того же вебхука
  const conv = getOrCreateConversation(ch.name, phone, name, chat_id);
  const msg = addMessage(conv.id, { direction: 'in', author: 'customer', body: text, wa_id, media });
  db.prepare('UPDATE conversations SET unread = unread + 1 WHERE id=?').run(conv.id);
  emit('message', { conv_id: conv.id, message: msg });
  emit('conversations', null);

  const fresh = getConversation(conv.id);
  const aiOn = getSetting('ai_global') === '1' && fresh.ai_enabled === 1;
  if (!aiOn) return;

  if (!allowed(phone, ch)) {
    // номер не в белом списке: заявка видна менеджеру, но бот молчит
    db.prepare("UPDATE conversations SET needs_human=1, handoff_reason='вне белого списка тестирования', status='human', ai_enabled=0 WHERE id=?")
      .run(conv.id);
    emit('conversations', null);
    return;
  }

  scheduleReply(conv.id, ch, text);
}

/** Собственно ответ: вызывается один раз на всю пачку сообщений клиента. */
async function respond(convId, ch, text) {
  const fresh = getConversation(convId);
  if (!fresh) return;
  // за время паузы менеджер мог перехватить диалог
  if (getSetting('ai_global') !== '1' || fresh.ai_enabled !== 1) return;

  const conv = fresh;

  // ночью и в выходные живого менеджера нет: либо бот предупреждает об этом,
  // либо молчит и заявка ждёт утра
  const offHours = !withinWorkHours();
  const mode = scheduleSetting('off_hours');
  if (offHours && mode === 'silent') {
    db.prepare("UPDATE conversations SET needs_human=1, handoff_reason='пришло в нерабочее время' WHERE id=?")
      .run(conv.id);
    emit('conversations', null);
    return;
  }

  emit('typing', { conv_id: conv.id });

  let out;
  try {
    out = await generateReply(fresh, history(conv.id), {
      offHours: offHours && mode === 'notice',
      offHoursNote: scheduleSetting('off_hours_note') || 'Менеджер подтвердит заказ в рабочие часы.'
    });
  } catch (e) {
    lastAiError = { message: e.message, at: new Date().toISOString() };
    flagHuman(conv.id, 'сбой ИИ: ' + e.message);
    addMessage(conv.id, { direction: 'out', author: 'system', body: 'ИИ не смог ответить: ' + e.message, error: '1' });
    emit('conversations', null);
    emit('message', { conv_id: conv.id });
    return;
  }

  lastAiError = null;                 // ответ прошёл — прошлая ошибка неактуальна

  // Дату заказа проверяем кодом: модель может записать день, который сама же
  // отклонила, и он уедет в календарь на выходной или праздник.
  if (out.lead?.date_iso && !workableDay(out.lead.date_iso)) {
    out.lead.date_iso = '';
    if (out.lead.stage === 'дата согласована') out.lead.stage = 'уточняем';
  }

  const lead = { ...JSON.parse(fresh.lead || '{}'), ...Object.fromEntries(Object.entries(out.lead || {}).filter(([, v]) => v)) };
  db.prepare('UPDATE conversations SET lead=?, summary=?, status=CASE WHEN status=\'new\' THEN \'ai\' ELSE status END WHERE id=?')
    .run(JSON.stringify(lead), out.summary || fresh.summary, conv.id);

  if (out.needs_human) flagHuman(conv.id, out.handoff_reason || 'ИИ передал диалог');

  const replies = [...(out.replies ?? [])];

  // первый наш ответ в диалоге предваряем приветствием с раскрытием ИИ:
  // это требование правил WhatsApp, его нельзя оставлять на усмотрение модели
  const alreadyWrote = db
    .prepare("SELECT 1 FROM messages WHERE conv_id=? AND direction='out' AND author IN ('ai','human') LIMIT 1")
    .get(conv.id);
  if (!alreadyWrote) {
    const greeting = pickGreeting(text);
    if (greeting) replies.unshift(greeting);
  }

  // несколько коротких сообщений подряд — так пишут люди; между ними пауза,
  // сама отправка уже показывает «печатает…»
  for (const [i, body] of replies.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 700));
    let wa = null, err = null;
    try {
      wa = (await adapterFor(fresh).send(fresh, body)).wa_id;
    } catch (e) {
      err = e.message;
      flagHuman(conv.id, 'не отправилось в WhatsApp: ' + e.message);
    }
    const sent = addMessage(conv.id, { direction: 'out', author: 'ai', body, wa_id: wa, error: err });
    emit('message', { conv_id: conv.id, message: sent });
    if (err) break;
  }
  emit('conversations', null);
}

/**
 * Ручной ответ оператора. По умолчанию забирает диалог себе (ИИ замолкает) —
 * но иногда надо просто вставить реплику и оставить бота работать, для этого keepAi.
 */
// раз в час подчищаем заявки, по которым давно нет движения
setInterval(() => {
  const n = sweepStale();
  if (n) emit('conversations', null);
}, 36e5).unref?.();

/**
 * Черновик ответа для живого менеджера. Ничего не отправляет: менеджер
 * читает, правит и решает сам. Работает и когда ИИ на диалоге выключен.
 */
export async function suggestReply(convId) {
  const conv = getConversation(convId);
  if (!conv) throw new Error('Диалог не найден');
  const out = await generateReply(conv, history(convId));
  return (out.replies ?? []).join('\n');
}

/** Последний сбой ИИ — чтобы админка не молчала, когда бот перестал отвечать. */
export let lastAiError = null;
export const clearAiError = () => { lastAiError = null; };

export async function sendAsHuman(convId, text, keepAi = false) {
  const conv = getConversation(convId);
  if (!conv) throw new Error('Диалог не найден');
  let wa = null, err = null;
  try {
    wa = (await adapterFor(conv).send(conv, text)).wa_id;
  } catch (e) { err = e.message; }
  const msg = addMessage(convId, { direction: 'out', author: 'human', body: text, wa_id: wa, error: err });
  if (keepAi) {
    db.prepare("UPDATE conversations SET needs_human=0, handoff_reason=NULL, unread=0 WHERE id=?").run(convId);
  } else {
    db.prepare("UPDATE conversations SET status='human', ai_enabled=0, needs_human=0, handoff_reason=NULL, unread=0 WHERE id=?").run(convId);
  }
  emit('message', { conv_id: convId, message: msg });
  emit('conversations', null);
  if (err) throw new Error(err);
  return msg;
}
