/**
 * Правила напоминаний. Здесь только решения «кому, когда и о чём» — отправку
 * делает bot.js. Так логику видно целиком и её можно проверять отдельно.
 */
import { getSetting } from './db.js';

const list = (key, fallback) => String(getSetting(key) || fallback)
  .split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

const hours = (key, fallback) => list(key, fallback).map(Number).filter((n) => n > 0);

/** «Не пишите мне» — значит больше никогда, это и вежливость, и требование площадок. */
export function isStopRequest(text = '') {
  const t = String(text).toLowerCase();
  return list('stop_words', 'не пишите\nstop').some((w) => t.includes(w.toLowerCase()));
}

/**
 * Ритм торканий. Вопрос без ответа остывает за часы, «подумаю» после названной
 * цены живёт днями — поэтому лестницы разные.
 */
export function cadence(lead = {}) {
  const quoted = Boolean(lead.price_quote) || ['назвали цену', 'готов к заказу'].includes(lead.stage);
  return quoted ? hours('nudge_steps_quoted', '24,72,168') : hours('nudge_steps_ask', '3,24,72');
}

/** Чего не хватает для заявки — об этом и напоминаем, а не «ну что там?». */
export function missingFor(lead = {}, hasMedia = false) {
  const gaps = [];
  if (!lead.district && !lead.address) gaps.push('где находится объект');
  if (!lead.object_type) gaps.push('что за объект');
  if (!lead.area_m2) gaps.push('площадь');
  if (!hasMedia) gaps.push('видео или фото помещений');
  if (!lead.date && !lead.date_iso) gaps.push('когда нужна уборка');
  return gaps;
}

/** Задача каждого следующего касания: вернуться, дать причину, закрыть. */
export function touchGoal(touch, total) {
  if (touch >= total) return 'close';
  return touch === 1 ? 'return' : 'reason';
}

/** Разброс по времени: иначе в начале рабочего дня уходит пачка и это видно как рассылку. */
const JITTER = Number(process.env.NUDGE_JITTER_MIN ?? 90);
export const jitterMinutes = (convId) => (JITTER ? (Number(convId) * 37) % JITTER : 0);

// ноль — это значение, а не «не задано»: полночь и «не напоминать» настраиваются так же
const num = (key, fallback) => {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : fallback;
};

export const confirmHours = () => ({ eve: num('confirm_eve_hour', 18), morning: num('confirm_morning_hour', 8) });

export const settings = () => ({
  on: getSetting('nudge_on') === '1',
  max: num('nudge_max', 2),
  stale: num('nudge_stale_hours', 336),
  confirmOn: getSetting('confirm_on') === '1',
  managerPing: num('manager_ping_hours', 48)
});

/** Вне 24 часов от последнего сообщения клиента: на официальном API это платный шаблон. */
export const outsideWindow = (hoursSinceIncoming) => hoursSinceIncoming > 24;
