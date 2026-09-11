import { z } from 'zod';
import { getSetting } from './db.js';
import { asImages } from './media.js';
import { detectLang, LANG_NAME } from './lang.js';
import { quoteHint } from './pricing.js';
import { scheduleSetting, scheduleText, workHours, isHoliday } from './schedule.js';
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
  object_type: z.string(),        // квартира / дом / офис / коммерческое помещение
  area_m2: z.string(),
  rooms_count: z.string(),        // сколько комнат
  bathrooms: z.string(),          // сколько санузлов
  district: z.string(),           // город и район
  address: z.string(),            // улица, этаж, лифт — если клиент сам назвал
  works: z.string(),              // что сделать сверх уборки: полировка пола, окна, трисы, краска, шпаклёвка
  date: z.string(),               // как сказал клиент: «в субботу», «завтра»
  date_iso: z.string(),           // та же дата в виде ГГГГ-ММ-ДД, посчитанная от сегодняшней
  time: z.string(),               // ЧЧ:ММ, если названо время
  windows: z.enum(['', 'да', 'нет']),
  condition: z.enum(['', 'лёгкое', 'среднее', 'сильное', 'после ремонта']),
  price_quote: z.string(),        // что назвали клиенту
  stage: z.enum(['', 'новый', 'уточняем', 'ждём видео', 'заявка готова', 'назвали цену',
    'готов к заказу', 'дата согласована', 'отказ'])
});

const Answer = z.object({
  // массив, а не строка: живой человек шлёт короткие сообщения подряд,
  // а не один абзац на пять строк
  messages: z.array(z.string()),
  needs_human: z.boolean(),
  // заявка собрана, и в этом же ответе клиенту сказано, что её передают коллеге
  lead_ready: z.boolean(),
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
    lead_ready: false,
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
const MAX_FRAMES = 8;   // картинок всего в запросе: из одного видео берём до 4 кадров

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
  let sent = 0;
  for (const m of messages) {
    if (m.author === 'system') continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    let text = m.author === 'human' ? `[живой менеджер] ${m.body}` : m.body;

    const images = [];
    if (m.media) {
      for (const item of JSON.parse(m.media)) {
        const kind = item.kind === 'video' ? 'видео' : 'фото';
        const imgs = withImages.has(m.id) && sent < MAX_FRAMES
          ? (await asImages(item)).slice(0, MAX_FRAMES - sent) : [];
        sent += imgs.length;
        images.push(...imgs);
        // модель должна понимать, что кадры — из одного ролика, а не пачка разных фото
        const note = imgs.length && item.kind === 'video' ? '[клиент прислал видео, ниже кадры из него]' : `[клиент прислал ${kind}]`;
        text = (text ? text + '\n' : '') + note;
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

const ON_DAY = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];

/** Когда коллеги снова на связи: «завтра с 08:00» звучит по-человечески, «в рабочие часы» — нет. */
function nextOpening(tz) {
  const hours = workHours();
  const now = new Date();
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 864e5);
    const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);
    const wd = new Date(iso + 'T12:00:00Z').getUTCDay();
    const h = hours[wd];
    if (!Array.isArray(h) || isHoliday(iso)) continue;
    if (i === 0 && hm >= h[0]) continue;            // сегодня уже открывались
    return `${i === 0 ? 'сегодня' : i === 1 ? 'завтра' : ON_DAY[wd]} с ${h[0]}`;
  }
  return 'в рабочее время';
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
  const media = messages.flatMap((m) => (m.direction === 'in' && m.media ? JSON.parse(m.media) : []));
  const videos = media.filter((x) => x.kind === 'video').length;
  const photos = media.length - videos;
  // приветствие код шлёт сам; модель его не видит и без подсказки здоровается второй раз
  const firstReply = !messages.some((m) => m.direction === 'out' && m.author !== 'system');

  // Постоянная часть: промпт, график, условия и правила ответа. Она одинакова во всех
  // запросах и кэшируется провайдером — повторное чтение стоит десятую часть цены.
  // Всё изменчивое (время, язык, данные заявки) идёт отдельным блоком после неё:
  // раньше время с минутами стояло посередине промпта и сбрасывало кэш каждую минуту.
  const system = [
    getSetting('system_prompt'),
    '',
    scheduleText(),
    '',
    facts ? 'УСЛОВИЯ И ЦЕНЫ (только эти, ничего не придумывай):\n' + facts : '',
    '',
    'ФОРМАТ ОТВЕТА:',
    '- messages — 1–2 коротких сообщения в мессенджер, как пишет живой человек. Не больше двух.',
    '- В lead заполняй только то, что клиент назвал или что точно видно на видео и фото; остальное — пустая строка.',
    '- lead_ready = true, только когда заявка собрана и в этом же ответе ты сказала, что передаёшь её коллеге.',
    '- needs_human = true, если нужен живой менеджер; в handoff_reason — коротко почему.',
    '- Вопрос «ты бот?» сам по себе — не повод звать менеджера: ответь честно и предложи. Зови, если клиент согласился.',
    '- handoff_reason и summary пиши по-русски, даже если клиент пишет на другом языке: их читает менеджер.',
    '- summary — суть заявки одной строкой для менеджера: объект, где, что нужно, есть ли видео.'
  ].join('\n');

  const context = [
    `ОТВЕЧАЙ НА ${lang.toUpperCase()} ЯЗЫКЕ. Каждое сообщение — только на ${lang}.`,
    firstReply
      ? 'Это твой первый ответ. Прямо перед ним клиенту уже ушло приветствие: ты представилась и сказала,'
        + ' что ты виртуальная помощница. Не здоровайся и не представляйся ещё раз — сразу к делу.'
      : '',
    // о нерабочем времени — только при передаче коллеге: в начале разговора это звучит как автоответчик
    opts.offHours
      ? `СЕЙЧАС НЕРАБОЧЕЕ ВРЕМЯ, коллеги ответят ${nextOpening(tz)}. Об этом не говори, пока просто ведёшь диалог.`
        + ` Когда передаёшь заявку или зовёшь менеджера — скажи своими словами: «${opts.offHoursNote}» и когда ответят.`
      : '',
    `СЕГОДНЯ ${today}, ${weekday}, время ${clock}. Когда клиент называет день словами`
      + ' («завтра», «в субботу», «через неделю») — посчитай настоящую дату от сегодняшней'
      + ' и запиши её в date_iso как ГГГГ-ММ-ДД. В поле date оставь слова клиента.'
      + ' Если день не назван — оба поля пустые, не выдумывай.',
    priceLine,
    `Телефон клиента: ${conv.phone}.`,
    known.length
      ? `Уже известно по заявке: ${known.map(([k, v]) => `${k}=${v}`).join(', ')}. Это не переспрашивай.`
      : 'По заявке пока ничего не известно.',
    videos || photos
      ? `Клиент уже присылал: ${[videos && `видео — ${videos}`, photos && `фото — ${photos}`].filter(Boolean).join(', ')}. Видео повторно не проси.`
      : 'Видео и фото клиент пока не присылал.'
  ].filter(Boolean).join('\n');

  const { out, usage } = await provider.complete({ system, context, turns, schema: Answer });
  if (process.env.AI_LOG_COST) {
    console.log(`[ai] ${provider.label()} in=${usage.in} cached=${usage.cached} out=${usage.out}`);
  }

  // некоторые модели дважды экранируют юникод — «₪» вместо «₪»
  const unescape = (t) => String(t).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  const replies = (out.messages || []).map(unescape).filter(Boolean).slice(0, 2);
  // страховка: если модель всё же поздоровалась после автоприветствия — убираем повтор
  const GREET = /^(здравствуйте|добрый (день|вечер)|доброе утро|привет|вітаю|доброго дня|שלום|hi|hello)[!,.\s—-]*/i;
  if (firstReply && replies.length && GREET.test(replies[0])) {
    const rest = replies[0].replace(GREET, '').trim();
    if (rest) replies[0] = rest[0].toUpperCase() + rest.slice(1); else replies.shift();
  }
  if (process.env.AI_LOG_COST) {
    const long = replies.filter((r) => r.length > 160);
    if (long.length) console.log('[ai] слишком длинно:', long.map((r) => r.length).join(', '), 'символов');
  }

  return {
    replies,
    needs_human: Boolean(out.needs_human),
    lead_ready: Boolean(out.lead_ready),
    handoff_reason: out.handoff_reason || '',
    summary: out.summary || '',
    lead: {
      ...Object.fromEntries(Object.entries(out.lead || {}).filter(([, v]) => v && String(v).trim())),
      ...(out.rooms?.length ? { rooms: out.rooms.filter((r) => r.room) } : {})
    }
  };
}
