import { db, addMessage, getOrCreateConversation, getConversation, history, getSetting, messageExists } from './db.js';
import { generateReply } from './ai.js';
import { channel, adapterFor } from './channels/index.js';
import { detectLang } from './lang.js';
import { mediaPath } from './media.js';
import fs from 'node:fs';
import { withinWorkHours, scheduleSetting, sweepStale, workHours, isHoliday } from './schedule.js';
import { quote } from './pricing.js';
import { notifyHandoff } from './notify.js';
import { transcribe, sttConfigured } from './stt.js';
import { analyzeVideo, duration, videoLimitMinutes } from './video.js';
import { aiProvider } from './ai.js';
import { dominantLang } from './lang.js';

const listeners = new Set();

// Чёрный список: этим номерам бот не отвечает, и их сообщения не попадают в заявки —
// личные контакты, сотрудники, спам. Правится в админке на лету, перезапуск не нужен.
// Сравниваем по последним 9 цифрам: так «050-123-4567» и «+972 50 123 4567» — один номер.
const tail = (v) => String(v ?? '').replace(/\D/g, '').slice(-9);
function blocked(phone) {
  const me = tail(phone);
  if (me.length < 7) return false;
  return (getSetting('blocked_numbers') || '')
    .split(/[,;\n]+/).map(tail).filter((n) => n.length >= 7)
    .includes(me);
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
  // {company} в тексте приветствия — название компании из настроек
  const fill = (s) => s.replaceAll('{company}', getSetting('company') || '');
  if (!map.size) return fill(raw);                 // одна строка без префикса — как есть
  return fill(map.get(detectLang(text)) ?? map.get('ru') ?? [...map.values()][0]);
}

/** Что увидели на видео — сразу в карточку заявки, чтобы менеджер не пересматривал. */
function applyReport(convId, report) {
  const conv = getConversation(convId);
  if (!conv) return;
  const lead = JSON.parse(conv.lead || '{}');
  lead.rooms = [...(lead.rooms ?? []), ...(report.rooms ?? [])].slice(0, 12);
  if (!lead.condition && report.condition) lead.condition = report.condition;
  if (report.works?.length) {
    const had = String(lead.works || '').split(',').map((x) => x.trim()).filter(Boolean);
    lead.works = [...new Set([...had, ...report.works])].join(', ');
  }
  db.prepare('UPDATE conversations SET lead=? WHERE id=?').run(JSON.stringify(lead), convId);
  emit('conversations', null);
}

/** Можно ли назначить уборку на эту дату: рабочий день и не праздник. */
function workableDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  if (isHoliday(iso)) return false;
  const day = new Date(iso + 'T12:00:00Z').getUTCDay();
  return Array.isArray(workHours()[day]);
}

function flagHuman(convId, reason) {
  notifyHandoff(convId, reason);            // менеджер должен узнать сразу, а не из админки
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
  if (blocked(phone)) {
    // вложение канал уже сохранил на диск — за номером из чёрного списка не храним
    for (const it of media) for (const f of [it.file, ...(it.frames ?? [])]) fs.rm(mediaPath(f), { force: true }, () => {});
    return;
  }
  const conv = getOrCreateConversation(ch.name, phone, name, chat_id);

  // Голосовые: расшифровываем в текст, дальше бот работает с ним как с обычным
  // сообщением. Сам файл остаётся в диалоге — менеджер может послушать.
  const voices = media.filter((m) => m.kind === 'audio');
  // язык подсказываем по прошлым сообщениям клиента — так расшифровка точнее
  const hint = voices.length ? dominantLang(history(conv.id)) : '';
  for (const v of voices) {
    try { v.text = await transcribe(v.file, hint); }
    catch (e) { console.error('расшифровка голосового:', e.message); }
  }
  const said = voices.map((v) => v.text).filter(Boolean).join('\n');
  const body = [text, said].filter(Boolean).join('\n');

  const msg = addMessage(conv.id, { direction: 'in', author: 'customer', body, wa_id, media });
  db.prepare('UPDATE conversations SET unread = unread + 1 WHERE id=?').run(conv.id);
  emit('message', { conv_id: conv.id, message: msg });
  emit('conversations', null);

  const fresh = getConversation(conv.id);
  const aiOn = getSetting('ai_global') === '1' && fresh.ai_enabled === 1;
  if (!aiOn) return;

  // голос не расшифровался (сервис не настроен или сбой) — бот не угадывает, зовёт человека
  if (voices.length && !said) {
    flagHuman(conv.id, sttConfigured() ? 'не удалось расшифровать голосовое' : 'голосовое сообщение — послушайте сами');
    emit('conversations', null);
    return;
  }

  // Видео разбираем до ответа: кадры по смене сцены плюс слова клиента с этого же
  // отрезка. Ролик длиной в минуту разбирается десятки секунд — предупреждаем клиента.
  const clips = media.filter((m) => m.kind === 'video');
  if (clips.length && aiProvider.configured()) {
    const lengths = await Promise.all(clips.map((c) => duration(c.file)));
    if (Math.max(...lengths) > (Number(process.env.VIDEO_NOTE_SECONDS) || 20)) {
      const note = 'Смотрю видео, минутку';
      try {
        await adapterFor(fresh).send(fresh, note);
        addMessage(conv.id, { direction: 'out', author: 'ai', body: note });
        emit('message', { conv_id: conv.id });
      } catch {}
    }
    let long = null;
    for (const clip of clips) {
      try {
        const report = await analyzeVideo(clip, aiProvider);
        if (report?.tooLong) { long = report; continue; }
        if (report) { clip.report = report; applyReport(conv.id, report); }
      } catch (e) {
        console.error('разбор видео:', e.message);
      }
    }
    db.prepare('UPDATE messages SET media=? WHERE id=?').run(JSON.stringify(media), msg.id);
    emit('message', { conv_id: conv.id });
    if (long) {
      flagHuman(conv.id, `видео на ${long.minutes} мин — длиннее ${videoLimitMinutes()}, посмотрите сами`);
      emit('conversations', null);
      return;
    }
  }

  scheduleReply(conv.id, ch, body);
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
  // Готовая заявка — без адреса это не заявка, даже если модель поспешила
  const ready = out.lead_ready && Boolean(lead.district || lead.address);
  if (ready) lead.stage = 'заявка готова';
  // Цену считает код. Если модель записала в карточку свою сумму и она вдвое
  // больше расчёта — верим расчёту: иначе в воронке висят миллионы.
  const q = quote(lead);
  if (q) {
    const told = Number(String(lead.price_quote || '').replace(/[^\d]/g, ''));
    if (!told || told > q.total * 2) lead.price_quote = `${q.total.toLocaleString('ru-RU')} ${q.currency}`;
  }
  db.prepare('UPDATE conversations SET lead=?, summary=?, status=CASE WHEN status=\'new\' THEN \'ai\' ELSE status END WHERE id=?')
    .run(JSON.stringify(lead), out.summary || fresh.summary, conv.id);

  if (out.needs_human) flagHuman(conv.id, out.handoff_reason || 'ИИ передал диалог');
  else if (ready) flagHuman(conv.id, 'заявка готова — посмотреть видео и назвать цену');

  const replies = [...(out.replies ?? [])];

  // Суммы в тексте тоже проверяем: модель напечатала «21252500 ₪» вместо 21 250 ₪,
  // и клиент получил счёт на два миллиона. Ставки «25 ₪/м²» не трогаем.
  const MONEY = /(\d[\d\s.,]*\d|\d)\s*(₪|шек\w*|ils|nis|שקל|ש"ח)/gi;
  const amount = (m) => Number(String(m).replace(/[^\d]/g, ''));
  if (q) {
    for (let i = 0; i < replies.length; i++) {
      replies[i] = replies[i].replace(MONEY, (whole, num, cur, at, str) => {
        if (/^\s*\/?\s*(м|m)/i.test(str.slice(at + whole.length))) return whole;   // это ставка за метр
        const v = amount(num);
        return v > q.total * 2 ? `${q.total.toLocaleString('ru-RU')} ${cur}` : whole;
      });
    }
  } else if (replies.some((r) => [...r.matchAll(MONEY)].some((m) => amount(m[1]) >= 200000))) {
    // расчёта нет, а сумма запредельная для уборки — клиенту такое не отправляем
    flagHuman(conv.id, 'модель назвала подозрительную сумму — проверьте расчёт');
    addMessage(conv.id, { direction: 'out', author: 'system', body: 'Ответ не отправлен: подозрительная сумма в тексте.', error: '1' });
    emit('conversations', null);
    emit('message', { conv_id: conv.id });
    return;
  }

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
    db.prepare("UPDATE conversations SET needs_human=0, handoff_reason=NULL, unread=0, notified_at=NULL WHERE id=?").run(convId);
  } else {
    db.prepare("UPDATE conversations SET status='human', ai_enabled=0, needs_human=0, handoff_reason=NULL, unread=0, notified_at=NULL WHERE id=?").run(convId);
  }
  emit('message', { conv_id: convId, message: msg });
  emit('conversations', null);
  if (err) throw new Error(err);
  return msg;
}
