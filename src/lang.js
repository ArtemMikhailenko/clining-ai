/**
 * Язык клиента. Без обращения к модели: по алфавиту, а украинский от русского
 * отличают буквы і, ї, є, ґ — и наоборот ы, э, ъ, которых в украинском нет.
 */
const UK_ONLY = /[іїєґІЇЄҐ]/;
const RU_ONLY = /[ыэъЫЭЪ]/;

export function detectLang(text = '') {
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[а-яА-ЯёЁ]/.test(text) || UK_ONLY.test(text)) {
    if (RU_ONLY.test(text)) return 'ru';
    return UK_ONLY.test(text) ? 'uk' : 'ru';
  }
  return 'en';
}

/**
 * Язык диалога, а не одного сообщения: распознанный голос путает русский
 * с украинским, поэтому у печатного текста вес больше, чем у расшифровки.
 */
export function dominantLang(messages = []) {
  const score = {};
  const last = messages.filter((m) => m.direction === 'in' && m.body).slice(-5);
  for (const m of last) {
    const voice = String(m.media || '').includes('"audio"');
    const l = detectLang(m.body);
    score[l] = (score[l] ?? 0) + (voice ? 1 : 2);
  }
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? detectLang(last.at(-1)?.body || '');
}

export const LANG_NAME = { he: 'иврите', uk: 'украинском', ru: 'русском', en: 'английском' };
