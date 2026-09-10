import { z } from 'zod';
import { getSetting } from './db.js';
import { asImage } from './media.js';
import { detectLang, LANG_NAME } from './lang.js';
import { quoteHint } from './pricing.js';
import { scheduleSetting, scheduleText } from './schedule.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';

// AI_PROVIDER=anthropic (по умолчанию) | openai — любой OpenAI-совместимый эндпоинт
const provider = (process.env.AI_PROVIDER || 'anthropic') === 'openai' ? openai : anthropic;

export const aiConfigured = () => provider.configured();
export const aiLabel = () => (provider.configured() ? provider.label() : 'заглушки');

// Пустая строка = «клиент этого не называл». Так проще, чем optional в strict-схеме.
const Lead = z.object({
  name: z.string(),
  service: z.enum(['', 'после ремонта', 'перед въездом', 'после выезда', 'генеральная', 'поддерживающая']),
  object_type: z.string(),        // квартира / дом / офис
  area_m2: z.string(),
  rooms_count: z.string(),        // сколько комнат
  bathrooms: z.string(),          // сколько санузлов
  district: z.string(),
  date: z.string(),               // как сказал клиент: «в субботу», «завтра»
  date_iso: z.string(),           // та же дата в виде ГГГГ-ММ-ДД, посчитанная от сегодняшней
  time: z.string(),               // ЧЧ:ММ, если названо время
  windows: z.enum(['', 'да', 'нет']),
  condition: z.enum(['', 'лёгкое', 'среднее', 'сильное', 'после ремонта']),
  price_quote: z.string(),        // что назвали клиенту
  stage: z.enum(['', 'новый', 'уточняем', 'назвали цену', 'готов к заказу', 'дата согласована', 'отказ'])
});

const Answer = z.object({
  // массив, а не строка: живой человек шлёт короткие сообщения подряд,
  // а не один абзац на пять строк
  messages: z.array(z.string()),
  needs_human: z.boolean(),
  handoff_reason: z.string(),
  summary: z.string(),
  lead: Lead,
  // что видно на присланных фото: помещение и его состояние
  rooms: z.array(z.object({ room: z.string(), notes: z.string() }))
});

/** Заглушка, когда ключа нет — админку всё равно можно тестировать. */
function stubReply(turns) {
  const last = (turns.at(-1)?.text || '').toLowerCase();
  const wantsHuman = /менеджер|человек|живой|позвон|скидк|жалоб|директор/.test(last);
  return {
    replies: wantsHuman
      ? ['Секунду, подключаю менеджера.']
      : ['Здравствуйте! Это демо-ответ — ключ ИИ не задан.'],
    needs_human: wantsHuman,
    handoff_reason: wantsHuman ? 'клиент просит человека' : '',
    summary: (turns.at(-1)?.text || '').slice(0, 90),
    lead: {}
  };
}

/**
 * История БД → messages для API:
 * служебные записи выбрасываем, соседние одинаковые роли склеиваем,
 * первым обязательно должен идти user.
 */
const MAX_IMAGES = 6;   // больше в один запрос слать незачем: дорого и без пользы

async function toTurns(messages) {
  // Картинки прикладываем только те, что пришли ПОСЛЕ нашего последнего ответа.
  // Всё, что было раньше, модель уже описала — описание лежит в её же сообщениях
  // и в карточке заявки, а повторная отправка тех же фото просто жжёт токены
  // (шесть фото — это ~6 500 лишних токенов в каждом запросе).
  const lastOutIdx = messages.map((m) => m.direction).lastIndexOf('out');
  const withImages = new Set(
    messages
      .slice(lastOutIdx + 1)
      .filter((m) => m.media)
      .slice(-MAX_IMAGES)
      .map((m) => m.id)
  );

  const turns = [];
  for (const m of messages) {
    if (m.author === 'system') continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    let text = m.author === 'human' ? `[живой менеджер] ${m.body}` : m.body;

    const images = [];
    if (m.media) {
      for (const item of JSON.parse(m.media)) {
        const img = withImages.has(m.id) ? await asImage(item) : null;
        if (img) images.push(img);
        else text = (text ? text + '\n' : '') + `[клиент прислал ${item.kind === 'video' ? 'видео' : 'фото'}]`;
      }
    }

    const prev = turns.at(-1);
    if (prev?.role === role && !images.length && !prev.images?.length) {
      prev.text += '\n' + text;
    } else {
      turns.push({ role, text, images });
    }
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

export async function generateReply(conv, messages, opts = {}) {
  const turns = await toTurns(messages);
  if (!turns.length) throw new Error('Нет сообщений клиента для ответа');

  // Провайдеры не принимают запрос, который заканчивается репликой ассистента.
  // Так бывает, когда менеджер просит подсказку после своего же ответа —
  // добавляем явную просьбу от лица оператора.
  if (turns.at(-1).role === 'assistant') {
    turns.push({ role: 'user', text: '[менеджер просит подсказать следующее сообщение клиенту]', images: [] });
  }
  if (!provider.configured()) return stubReply(turns);

  const known = Object.entries(JSON.parse(conv.lead || '{}')).filter(([, v]) => v);
  // язык определяем сами и говорим модели прямо — на инструкцию «отвечай на языке
  // клиента» модели поменьше регулярно сползают на русский
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in' && m.body);
  const lang = LANG_NAME[detectLang(lastIn?.body || '')];

  // модель не знает, какое сегодня число: без этого «завтра» и «в субботу»
  // невозможно превратить в дату, а значит нет ни расписания, ни напоминаний
  const tz = scheduleSetting('timezone');
  const now = new Date();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(now);          // ГГГГ-ММ-ДД
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'long' }).format(now);
  const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(now);

  const priceLine = quoteHint(JSON.parse(conv.lead || '{}'));
  const facts = (getSetting('business_facts') || '').trim();
  const system = [
    getSetting('system_prompt'),
    '',
    `ОТВЕЧАЙ НА ${lang.toUpperCase()} ЯЗЫКЕ. Каждое сообщение — только на ${lang}.`,
    // график берём из настроек, а не из свободного текста: иначе бот
    // обещает клиентам расписание, которого уже нет
    scheduleText(),
    opts.offHours
      ? 'СЕЙЧАС НЕРАБОЧЕЕ ВРЕМЯ. Отвечай как обычно, но в одном из сообщений коротко скажи так: '
        + `«${opts.offHoursNote}» Не повторяй это в каждом сообщении.`
      : '',
    '',
    `СЕГОДНЯ ${today}, ${weekday}, время ${clock}. Когда клиент называет день словами`
      + ' («завтра», «в субботу», «через неделю») — посчитай настоящую дату от сегодняшней'
      + ' и запиши её в date_iso как ГГГГ-ММ-ДД. В поле date оставь слова клиента.'
      + ' Если день не назван — оба поля пустые, не выдумывай.',
    '',
    priceLine,
    facts ? 'УСЛОВИЯ И ЦЕНЫ (только эти, ничего не придумывай):\n' + facts : '',
    '',
    `Телефон клиента: ${conv.phone}.`,
    known.length
      ? `Уже известно по заявке: ${known.map(([k, v]) => `${k}=${v}`).join(', ')}. Это не переспрашивай.`
      : 'По заявке пока ничего не известно.',
    '',
    'Формат ответа: reply — только текст сообщения в мессенджер, как пишет живой человек.',
    'В lead заполняй только то, что клиент действительно назвал; остальное — пустая строка.',
    'needs_human = true, если нужен живой менеджер (скидки, спор, жалоба, просьба о человеке, вопрос вне твоих знаний).'
  ].join('\n');

  const { out, usage } = await provider.complete({ system, turns, schema: Answer });
  if (process.env.AI_LOG_COST) {
    console.log(`[ai] ${provider.label()} in=${usage.in} cached=${usage.cached} out=${usage.out}`);
  }

  const replies = (out.messages || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
  if (process.env.AI_LOG_COST) {
    const long = replies.filter((r) => r.length > 160);
    if (long.length) console.log('[ai] слишком длинно:', long.map((r) => r.length).join(', '), 'символов');
  }

  return {
    replies,
    needs_human: Boolean(out.needs_human),
    handoff_reason: out.handoff_reason || '',
    summary: out.summary || '',
    lead: {
      ...Object.fromEntries(Object.entries(out.lead || {}).filter(([, v]) => v && String(v).trim())),
      ...(out.rooms?.length ? { rooms: out.rooms.filter((r) => r.room) } : {})
    }
  };
}
