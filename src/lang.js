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
  const inbound = messages.filter((m) => m.direction === 'in' && m.body);
  const isVoice = (m) => String(m.media || '').includes('"audio"');
  // Голосовое — самый ненадёжный признак языка: его язык угадывает само
  // распознавание, и английскую речь с акцентом оно может записать кириллицей.
  // Два таких голосовых подряд перевешивали английскую переписку, и бот
  // переходил на русский посреди разговора. Поэтому если клиент хоть что-то
  // писал текстом, язык диалога решает только текст.
  const typed = inbound.filter((m) => !isVoice(m) && /\p{L}{2}/u.test(String(m.body)));
  const last = (typed.length ? typed : inbound).slice(-5);
  for (const [i, m] of last.entries()) {
    const voice = isVoice(m);
    const text = String(m.body).trim();
    // Чем свежее сообщение, тем больше вес: клиент начал на иврите и перешёл на
    // русский — отвечать надо по-русски. Но короткое «ок» не должно перевешивать
    // весь диалог, поэтому вес ещё и от длины сообщения.
    const weight = 2 ** i * (voice ? 1 : 2) * Math.min(1, text.length / 12);
    const l = detectLang(text);
    score[l] = (score[l] ?? 0) + weight;
  }
  // Пусто — значит это первое сообщение в диалоге. Возвращаем пустую строку:
  // подсказка «английский» заставляла Whisper переводить иврит вместо расшифровки.
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? '';
}

export const LANG_NAME = { he: 'иврите', uk: 'украинском', ru: 'русском', en: 'английском' };
