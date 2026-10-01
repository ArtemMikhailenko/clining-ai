/**
 * Воронка по ТЗ §3. Этап — это продвижение сделки: Новая → Уточнение →
 * Предложение отправлено → Согласовано/назначено → Выполнено → Закрыто.
 *
 * Раньше колонки смешивали этап и того, кто ведёт диалог («нужен человек»,
 * «у менеджера», «ИИ уточняет»). Это не этапы, а признаки — они остаются
 * флагами на карточке, но больше не решают, где заявка в воронке.
 */

export const STAGES = ['new', 'clarify', 'offer', 'agreed', 'done', 'closed'];
export const STAGE_TITLE = {
  new: 'Новая', clarify: 'Уточнение', offer: 'Предложение отправлено',
  agreed: 'Согласовано / назначено', done: 'Выполнено', closed: 'Закрыто'
};

// Подстатусы закрытой заявки. Неквалифицированные разделены на две корзины:
// для отчёта это один подстатус, для работы менеджера — разные очереди.
export const CLOSE = ['paid', 'lost', 'unq_regular', 'unq_staff'];
export const CLOSE_TITLE = {
  paid: 'оплачено', lost: 'проиграно',
  unq_regular: 'неквалифицировано · обычная уборка', unq_staff: 'неквалифицировано · сотрудник'
};

const ORDER = { new: 0, clarify: 1, offer: 2, agreed: 3, done: 4, closed: 5 };
export const stageIndex = (s) => ORDER[s] ?? 0;

/**
 * Сумма из строки цены. Раньше из строки выбрасывалось всё, кроме цифр, и
 * «от 20 ₪/м², минимум 1500 ₪» превращалось в 201 500 — эти числа попадали
 * в «в воронке» и средние. Теперь берём первую сумму в шекелях, а ставки за
 * квадратный метр суммой не считаем.
 */
export function amountOf(v) {
  if (typeof v === 'number') return v > 0 ? Math.round(v) : 0;
  const s = String(v ?? '').replace(/[   ]/g, ' ');
  // диапазон «2 400 – 2 600 ₪»: для сумм в воронке берём нижнюю границу
  const range = s.match(/(\d[\d ,.]*\d)\s*[–—-]\s*\d[\d ,.]*\d\s*(?:₪|шек\w*|ils|nis|ש"ח|שקל\w*)(?!\s*\/)/i);
  if (range) {
    const n = Number(range[1].replace(/[ ,]/g, ''));
    if (n > 0) return n;
  }
  const re = /(\d[\d ,.]*\d|\d)\s*(?:₪|шек\w*|ils|nis|ש"ח|שקל\w*)(?!\s*\/\s*(?:м|m|מ))/gi;
  let m;
  while ((m = re.exec(s))) {
    const raw = m[1].replace(/ /g, '').replace(/,(?=\d{3}\b)/g, '').replace(/\.(?=\d{3}\b)/g, '');
    const n = Number(raw.replace(',', '.'));
    if (n > 0) return Math.round(n);
  }
  // одно голое число без валюты — тоже сумма: так её вводят руками
  const bare = s.trim().match(/^\d[\d ]*$/);
  return bare ? Number(bare[0].replace(/ /g, '')) : 0;
}

/**
 * Этап для заявки, созданной до новой воронки (ТЗ §11). Где перенос
 * неоднозначен, заявка получает пометку review — её нужно проверить руками,
 * а не угадывать.
 */
export function legacyStage(c) {
  let lead = {};
  try { lead = JSON.parse(c.lead || '{}'); } catch {}
  const st = lead.stage || '';
  const out = { stage: 'clarify', close: null, lost_reason: null, review: null };
  const close = (reason, extra = {}) => Object.assign(out, { stage: 'closed', close: reason }, extra);

  if (amountOf(c.paid_sum) > 0) return close('paid');

  if (c.status === 'closed' || st === 'отказ') {
    if (c.archive === 'staff') return close('unq_staff');
    if (c.archive === 'later') return close('unq_regular');
    if (c.status === 'closed') return close('lost', { lost_reason: 'перенесено из архива «Отказ»' });
    // бот счёл отказом, но заявку никто не закрывал
    return close('lost', {
      lost_reason: 'клиент отказался (по оценке бота)',
      review: c.needs_human ? 'бот счёл отказом, но звал менеджера' : null
    });
  }

  if (c.job_date) return Object.assign(out, { stage: 'agreed' });
  if (['готов к заказу', 'дата согласована'].includes(st)) {
    return Object.assign(out, { stage: 'agreed', review: 'согласовано без даты записи' });
  }
  if (st === 'назвали цену') {
    return Object.assign(out, { stage: 'offer', review: amountOf(c.deal_sum) > 0 ? null : 'ориентир называл бот, окончательной цены нет' });
  }
  const collected = Object.entries(lead).some(([k, v]) => k !== 'stage' && v && String(v).trim());
  return Object.assign(out, { stage: collected || st ? 'clarify' : 'new' });
}
