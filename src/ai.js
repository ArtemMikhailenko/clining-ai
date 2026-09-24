import { z } from 'zod';
import { getSetting } from './db.js';
import { asImages } from './media.js';
import { dominantLang, LANG_NAME } from './lang.js';
import { quoteHint } from './pricing.js';
import { normalizeLead, SERVICES, CONDITIONS, STAGES } from './leadnorm.js';
import { scheduleSetting, scheduleText, workHours, isHoliday } from './schedule.js';
import * as anthropic from './providers/anthropic.js';
import * as openai from './providers/openai.js';

// AI_PROVIDER=anthropic (по умолчанию) | openai — любой OpenAI-совместимый эндпоинт
const provider = (process.env.AI_PROVIDER || 'anthropic') === 'openai' ? openai : anthropic;

export const aiProvider = provider;
export const aiConfigured = () => provider.configured();
export const aiLabel = () => (provider.configured() ? provider.label() : 'заглушки');

// Пустая строка = «клиент этого не называл». Так проще, чем optional в strict-схеме.
const Lead = z.object({
  name: z.string(),
  // Значения этих полей проверяет код (leadnorm.js), а не схема: синоним или
  // слово на иврите не должны ронять весь ответ — клиент останется без реплики
  service: z.string(),            // после ремонта / перед въездом / после выезда / генеральная / поддерживающая
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
  windows: z.string(),            // да / нет
  condition: z.string(),          // лёгкое / среднее / сильное / после ремонта
  price_quote: z.string(),        // что назвали клиенту
  stage: z.string()               // новый / уточняем / ждём видео / заявка готова / назвали цену
                                  // / готов к заказу / дата согласована / отказ
});

const Answer = z.object({
  // массив, а не строка: живой человек шлёт короткие сообщения подряд,
  // а не один абзац на пять строк
  messages: z.array(z.string()),
  needs_human: z.boolean(),
  // заявка собрана, и в этом же ответе клиенту сказано, что её передают коллеге
  lead_ready: z.boolean(),
  // «напишите после ремонта», «перезвоните в январе» — дата ГГГГ-ММ-ДД, когда напомнить о себе
  follow_up_at: z.string(),
  follow_up_note: z.string(),
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
    follow_up_at: '',
    follow_up_note: '',
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
        // видео уже разобрано кадрами отдельно — в диалог идёт готовый разбор, а не кадры
        if (item.kind === 'video' && item.report) {
          const r = item.report;
          const bits = [
            r.summary,
            (r.rooms ?? []).map((x) => `${x.room}: ${x.notes}`).join('; '),
            r.works?.length ? `нужно: ${r.works.join(', ')}` : '',
            r.said ? `клиент говорит: ${r.said}` : ''
          ].filter(Boolean).join('. ');
          text = (text ? text + '\n' : '') + `[клиент прислал видео. Что на нём: ${bits}]`;
          continue;
        }
        const kind = item.kind === 'video' ? 'видео' : item.kind === 'audio' ? 'голосовое' : 'фото';
        const imgs = withImages.has(m.id) && sent < MAX_FRAMES
          ? (await asImages(item)).slice(0, MAX_FRAMES - sent) : [];
        sent += imgs.length;
        images.push(...imgs);
        // модель должна понимать, что кадры — из одного ролика, а не пачка разных фото
        // расшифровка голосового уже лежит в тексте сообщения — не дублируем пометкой
        if (item.kind === 'audio' && item.text) continue;
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
  const lang = LANG_NAME[dominantLang(messages) || 'ru'];

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
  const photos = media.filter((x) => x.kind === 'image').length;
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
    '- Во всём ответе — не больше одного вопроса, даже если сообщений два. Второй вопрос — в следующем ходе.',
    '- Не используй длинное тире «—» и многоточие «…»: пиши дефис, запятую или точку.',
    '- Не поняла сообщение — переспроси своими словами. Менеджера из-за непонятного сообщения не зови.',
    '- area_m2 — одно число общей площади в метрах. Клиент перечисляет комнаты («8 комнат по 50 м + балкон 100»)'
      + ' — сложи или спроси общую площадь, но никогда не склеивай цифры подряд.',
    '- День ты не бронируешь. Запиши пожелание клиента и скажи, что менеджер подтвердит дату.'
      + ' Не пиши «записала вас на…», «забронировала», «жду вас в субботу». Стадию «дата согласована» не ставь.',
    '- Сообщение клиента всегда доходит. Никогда не пиши «сообщение не отправилось» или «я не получила»:'
      + ' технических оправданий не выдумывай.',
    '- Короткий или странный ответ («0», точка, смайлик) — это тоже ответ. Переспроси по-человечески:'
      + ' «0 метров? наверное, опечатка - сколько примерно?». Клиент не знает площадь — предложи посчитать по комнатам.',
    '- В lead заполняй только то, что клиент назвал или что точно видно на видео и фото; остальное — пустая строка.',
    '- lead_ready = true, только когда заявка собрана и в этом же ответе ты сказала, что передаёшь её коллеге.',
    '- needs_human = true, если нужен живой менеджер; в handoff_reason — коротко почему.',
    '- Вопрос «ты бот?» сам по себе — не повод звать менеджера: ответь честно и предложи. Зови, если клиент согласился.',
    '- handoff_reason и summary пиши по-русски, даже если клиент пишет на другом языке: их читает менеджер.',
    '- summary — суть заявки одной строкой для менеджера: объект, где, что нужно, есть ли видео.',
    '- Клиент говорит «не сейчас», «после ремонта», «напишите через месяц» — поставь follow_up_at',
    '  (дата ГГГГ-ММ-ДД, посчитай от сегодняшней) и follow_up_note: своими словами, о чём напомнить.',
    '  Скажи клиенту, что напишешь в этот день. Если срок не назван — поля пустые.'
  ].join('\n');

  // Бот пишет первым: у каждого касания своя задача, иначе все напоминания
  // сводятся к «ну что там?» и клиент перестаёт их читать.
  const nudge = opts.nudge;
  const GOALS = {
    return: 'Мягко вернись к тому, на чём остановились, и переспроси одно недостающее.',
    reason: 'Дай причину вернуться к разговору: что входит в цену, сколько занимает уборка, какие дни свободны.'
      + ' Не повторяй прошлое сообщение.',
    close: 'Это последнее напоминание. Скажи, что больше не будешь писать, и попроси написать самому,'
      + ' когда станет актуально. Без обиды и без давления.'
  };
  const initiative = !nudge ? '' : [
    'СЕЙЧАС ТЫ ПИШЕШЬ ПЕРВОЙ. Одно короткое сообщение, без «извините за беспокойство» и без упрёков.',
    nudge.kind === 'followup'
      ? `Наступил день, о котором договорились${nudge.note ? `: ${nudge.note}` : ''}.`
        + ' Напомни о себе и спроси, актуальна ли уборка.'
      : '',
    nudge.kind === 'nudge'
      ? `Клиент молчит ${nudge.hours} ч. Это напоминание ${nudge.touch} из ${nudge.total}. ${GOALS[nudge.goal] ?? ''}`
        + (nudge.missing?.length ? ` Для заявки не хватает: ${nudge.missing.join(', ')}.` : '')
        + (nudge.seen ? ' Прошлое сообщение он прочитал.' : ' Возможно, он не открывал прошлое сообщение — напиши короче и проще.')
      : '',
    nudge.kind === 'confirm'
      ? (nudge.when === 'eve'
        ? `Завтра${nudge.time ? `, ${nudge.time},` : ''} у клиента уборка. Напомни и попроси подтвердить, что всё в силе.`
        : `Сегодня${nudge.time ? ` в ${nudge.time}` : ''} у клиента уборка. Коротко подтверди выезд и спроси, будет ли доступ в помещение.`)
      : ''
  ].filter(Boolean).join(' ');

  const context = [
    initiative,
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
    // менеджер уже договорился о сумме — бот не пересчитывает и не торгуется
    conv.deal_sum
      ? `СОГЛАСОВАННАЯ СТОИМОСТЬ: ${conv.deal_sum} ₪ — менеджер уже договорился с клиентом.`
        + ' Называй только её, свою оценку не повторяй. О скидках и пересчёте — зови менеджера.'
      : priceLine,
    `Телефон клиента: ${conv.phone}.`,
    known.length
      ? `Уже известно по заявке: ${known.map(([k, v]) => `${k}=${v}`).join(', ')}. Это не переспрашивай.`
      : 'По заявке пока ничего не известно.',
    videos || photos
      ? `Клиент уже присылал: ${[videos && `видео — ${videos}`, photos && `фото — ${photos}`].filter(Boolean).join(', ')}. Видео повторно не проси.`
      : 'Видео и фото клиент пока не присылал.'
  ].filter(Boolean).join('\n');

  // Одна неудача — не повод бросать клиента: пробуем ещё раз, напомнив про формат.
  // Модель иногда отвечает не по схеме, особенно на длинной переписке.
  let out, usage;
  try {
    ({ out, usage } = await provider.complete({ system, context, turns, schema: Answer }));
  } catch (e) {
    console.error('ИИ, первая попытка:', e.message);
    const retryNote = context + '\nПредыдущий ответ не прошёл проверку формата.'
      + ` Поля заполняй строго значениями из списков: service — ${SERVICES.join(' / ')};`
      + ` condition — ${CONDITIONS.join(' / ')}; stage — ${STAGES.join(' / ')}; windows — да / нет.`
      + ' Если значение не подходит ни под одно — оставь поле пустым.';
    ({ out, usage } = await provider.complete({ system, context: retryNote, turns, schema: Answer }));
  }
  out.lead = normalizeLead(out.lead || {});
  if (process.env.AI_LOG_COST) {
    console.log(`[ai] ${provider.label()} in=${usage.in} cached=${usage.cached} write=${usage.created ?? 0} out=${usage.out}`);
  }

  // некоторые модели дважды экранируют юникод — «₪» вместо «₪»
  const unescape = (t) => String(t).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  /**
   * Приводим ответ модели к виду, в котором люди пишут в мессенджере.
   * Обратные кавычки WhatsApp показывает моноширинным текстом в разрядку —
   * клиент видел «П р о с т и т е…». Длинное тире и многоточие — след «писал ИИ».
   */
  const human = (t) => {
    let out = String(t)
      .replace(/```+[a-z]*\n?/gi, '')                        // код-блок целиком
      .replace(/`/g, '')
      .replace(/[    ​]/g, ' ')      // неразрывные и тонкие пробелы
      .replace(/\s*[—–]\s*/g, ' - ')
      .replace(/…/g, '...')
      .trim();

    // Текст «в разрядку»: слова разделены двойным пробелом, буквы — одинарным.
    // Чиним до схлопывания пробелов, иначе границы слов теряются.
    const letters = out.split(/\s+/).filter(Boolean);
    if (letters.length > 6 && letters.filter((w) => w.length === 1).length / letters.length > 0.6) {
      out = out.split(/ {2,}/).map((word) => word.replace(/(\S) (?=\S)/g, '$1')).join(' ');
    }
    return out.replace(/ {2,}/g, ' ').trim();
  };

  let replies = (out.messages || []).map((t) => human(unescape(t))).filter(Boolean).slice(0, 2);
  // Один вопрос за ход. Модели (даже сильные) любят спросить два пункта сразу,
  // разнеся их по двум сообщениям, — клиенту это как анкета. Оставляем первый
  // вопрос, а пояснения без вопроса («по нему посчитаем точно») сохраняем.
  let asked = false;
  const kept = [];
  for (const reply of replies) {
    if (!reply.includes('?')) { kept.push(reply); continue; }
    // второй вопрос выбрасываем сообщением целиком: если вырезать только вопрос,
    // остаётся висящее пояснение вроде «по нему посчитаем точно»
    if (asked) continue;
    asked = true;
    let seen = false;
    const trimmed = reply.split(/(?<=[.!?…])\s+/).filter((sent) => {
      if (!sent.includes('?')) return true;
      if (seen) return false;
      seen = true;
      return true;
    }).join(' ').trim();
    if (trimmed) kept.push(trimmed);
  }
  replies = kept;
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
    follow_up_at: String(out.follow_up_at || '').trim(),
    follow_up_note: String(out.follow_up_note || '').trim(),
    handoff_reason: out.handoff_reason || '',
    summary: out.summary || '',
    lead: {
      ...Object.fromEntries(Object.entries(out.lead || {}).filter(([, v]) => v && String(v).trim())),
      ...(out.rooms?.length ? { rooms: out.rooms.filter((r) => r.room) } : {})
    }
  };
}
