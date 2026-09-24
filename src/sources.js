/**
 * С какого объявления пришёл клиент.
 *
 * WhatsApp отдаёт по клику из рекламы карточку объявления: заголовок, ссылку,
 * id и ctwa_clid — но не название кампании, как оно записано в кабинете Meta.
 * Поэтому здесь простой справочник: строки вида «ключ = Название». Ключ ищем
 * во всём, что пришло вместе с обращением — в заголовке объявления, в ссылке,
 * в id, в метке и в первом сообщении клиента. Совпало — в заявке появляется
 * человеческое название кампании, а не «Реклама Facebook».
 */
import { getSetting } from './db.js';

/**
 * Строки «ключ = Название». Комментарий — строка, начинающаяся с //: решётка
 * занята, с неё начинаются метки вроде #ig1. Разделитель ищем последний:
 * ключом бывает кусок ссылки с собственным «=» (utm_campaign=windows).
 */
export function parseMap(text) {
  return String(text || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .map((l) => {
      const m = /^(.+)[=:]\s*(.+)$/.exec(l);
      return m ? { key: m[1].trim().toLowerCase(), name: m[2].trim() } : null;
    })
    .filter((x) => x && x.key && x.name);
}

/** Всё, где имеет смысл искать ключ кампании. */
const haystack = (src, text) => [
  src?.title, src?.body, src?.url, src?.ref, src?.source, text
].filter(Boolean).join(' \n ').toLowerCase();

/**
 * Название кампании по справочнику. Первое совпадение выигрывает — порядок
 * строк в настройках задаёт приоритет, если ключи пересекаются.
 */
export function labelFor(src, text = '', map = getSetting('source_map')) {
  const hay = haystack(src, text);
  return parseMap(map).find((r) => hay.includes(r.key))?.name || '';
}
