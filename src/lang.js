/**
 * Язык клиента по его тексту. Без обращения к модели: определяется по алфавиту,
 * а украинский от русского отличают буквы і, ї, є, ґ.
 */
export function detectLang(text = '') {
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[іїєґІЇЄҐ]/.test(text)) return 'uk';
  if (/[а-яА-ЯёЁ]/.test(text)) return 'ru';
  return 'en';
}

export const LANG_NAME = { he: 'иврите', uk: 'украинском', ru: 'русском', en: 'английском' };
