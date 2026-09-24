/**
 * Приведение карточки заявки к допустимым значениям.
 *
 * Раньше эти поля были строгими enum прямо в схеме ответа. Модель, которая ведёт
 * переписку на иврите, однажды записала тип уборки на иврите — и весь ответ не
 * прошёл проверку: клиент не получил ничего, а менеджеру ушёл JSON со стеком.
 * Синоним в одном поле не должен ломать ответ целиком, поэтому схема принимает
 * любую строку, а список допустимых значений держим здесь.
 */

export const SERVICES = ['после ремонта', 'перед въездом', 'после выезда', 'генеральная', 'поддерживающая'];
export const CONDITIONS = ['лёгкое', 'среднее', 'сильное', 'после ремонта'];
export const STAGES = ['новый', 'уточняем', 'ждём видео', 'заявка готова', 'назвали цену',
  'готов к заказу', 'дата согласована', 'отказ'];

// Ключ — допустимое значение, справа слова, по которым его узнаём.
// Иврит и английский тут не для красоты: переписка идёт на языке клиента.
const HINTS = {
  'после ремонта': ['ремонт', 'строит', 'שיפוץ', 'בנייה', 'renovation', 'construction', 'post-renovation'],
  'перед въездом': ['въезд', 'заселе', 'לפני כניסה', 'כניסה', 'move-in', 'before moving'],
  'после выезда': ['выезд', 'съезд', 'после аренды', 'אחרי יציאה', 'יציאה', 'move-out', 'after moving'],
  'генеральная': ['генерал', 'глубок', 'יסודי', 'deep', 'general'],
  'поддерживающая': ['поддерж', 'регуляр', 'текущ', 'שוטף', 'תחזוקה', 'regular', 'maintenance'],
  'лёгкое': ['лег', 'лёг', 'слабо', 'קל', 'light'],
  'среднее': ['средн', 'בינוני', 'medium', 'moderate'],
  'сильное': ['сильн', 'тяжёл', 'тяжел', 'очень гряз', 'כבד', 'heavy', 'severe']
};

const clean = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, ' ')
  .replace(/\s+/g, ' ').trim();

/** Ближайшее допустимое значение или пустая строка, если не узнали. */
export function pick(value, allowed) {
  const v = clean(value);
  if (!v) return '';
  const exact = allowed.find((a) => clean(a) === v);
  if (exact) return exact;
  // «генеральная уборка», «уборка после ремонта» — допустимое значение внутри фразы
  const inside = allowed.find((a) => v.includes(clean(a)));
  if (inside) return inside;
  const byHint = allowed.find((a) => (HINTS[a] ?? []).some((h) => v.includes(clean(h))));
  return byHint || '';
}

const YES = ['да', 'yes', 'כן', 'так', 'нужно', 'надо', 'true'];
const NO = ['нет', 'no', 'לא', 'ні', 'не нужно', 'не надо', 'false'];

/** Карточка после модели: непонятные значения обнуляем, но не роняем ответ. */
export function normalizeLead(lead = {}) {
  const out = { ...lead };
  out.service = pick(lead.service, SERVICES);
  out.condition = pick(lead.condition, CONDITIONS);
  out.stage = pick(lead.stage, STAGES);

  const w = clean(lead.windows);
  out.windows = !w ? '' : YES.some((y) => w.includes(clean(y))) ? 'да'
    : NO.some((n) => w.includes(clean(n))) ? 'нет' : '';

  // дата в карточке — либо настоящая ГГГГ-ММ-ДД, либо ничего: по ней строится расписание
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.date_iso ?? ''))) out.date_iso = '';
  return out;
}
