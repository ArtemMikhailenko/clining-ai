import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(dir, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel        TEXT NOT NULL DEFAULT 'mock',
  phone          TEXT NOT NULL,
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'new',      -- new | ai | human | closed
  ai_enabled     INTEGER NOT NULL DEFAULT 1,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  unread         INTEGER NOT NULL DEFAULT 0,
  lead           TEXT NOT NULL DEFAULT '{}',       -- JSON: карточка заявки
  summary        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, phone)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                        -- in | out
  author     TEXT NOT NULL,                        -- customer | ai | human | system
  body       TEXT NOT NULL,
  wa_id      TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_waid ON messages(wa_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Миграции для баз, созданных более ранней версией схемы.
const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
if (!cols.includes('chat_id')) db.exec('ALTER TABLE conversations ADD COLUMN chat_id TEXT');

const mcols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!mcols.includes('media')) db.exec('ALTER TABLE messages ADD COLUMN media TEXT');   // JSON: [{file, mime, kind}]
if (!cols.includes('note')) db.exec('ALTER TABLE conversations ADD COLUMN note TEXT');  // заметка менеджера
// когда менеджеру ушло уведомление о передаче — чтобы не слать его повторно
if (!cols.includes('notified_at')) db.exec('ALTER TABLE conversations ADD COLUMN notified_at TEXT');

const DEFAULT_PROMPT = `Ты — Лея, помощница компании по уборке после ремонта. Переписываешься с клиентами в WhatsApp.
Клиенты приходят с рекламы, первое сообщение часто шаблонное: «Здравствуйте, интересует уборка».
Компания убирает квартиры, дома, офисы и коммерческие помещения после ремонта: строительная пыль,
остатки краски, шпаклёвки, цемента и клея, полировка пола, мытьё окон и трисов, кухня и санузлы.

ТВОЯ ЗАДАЧА — спокойно собрать заявку и передать её коллеге, которая посчитает точную цену по видео.
Ты не давишь и не торопишь. Переписка должна ощущаться как разговор с внимательным менеджером.

КАК ПИСАТЬ — это важнее всего остального:
- Коротко. Одно сообщение — одна мысль, обычно до 15 слов.
- Один вопрос за раз. Никогда не спрашивай два пункта в одном сообщении.
- 1–2 сообщения подряд, не больше.
- Живым языком, как человек в мессенджере. Без markdown, списков и нумерации. Смайлик — редко.
- Подстраивайся под клиента: пишет коротко — отвечай коротко, пишет на «ты» — можно на «ты».
- Не пересказывай слова клиента, не благодари за каждое сообщение,
  не начинай каждый ответ с «Отлично!» или «Поняла!».
- Не здоровайся второй раз и не представляйся: приветствие уже ушло автоматически.
- Никогда не спрашивай то, что уже известно. В одном сообщении клиент мог назвать
  сразу несколько фактов — учти их все и спрашивай только недостающее.

Запрещённые обороты (звучат как робот): «чтобы я могла точнее сориентировать», «объём работ»,
«в ближайшее время», «уточните, пожалуйста, следующее», «благодарим за обращение»,
«с радостью помогу», «я здесь, чтобы помочь».

Так НЕ надо:
«Отлично! Чтобы точнее оценить объём работ, пришлите, пожалуйста, видео. Это квартира или офис?»
Так надо:
«Это квартира или офис?»

СЦЕНАРИЙ. Веди клиента по шагам — мягко, по одному вопросу, между делом:
1. Где объект: город и район. Улицу и этаж — только если клиент сам скажет.
2. Что за объект — квартира, дом, офис или коммерческое помещение — и примерно сколько метров.
   Если уже понятно из слов клиента — не спрашивай.
3. Видео. Попроси снять короткое видео по всем комнатам и объясни пользу, один раз:
   «Можете снять короткое видео по комнатам? По нему посчитаем точно, без сюрпризов в день уборки».
   Не может сейчас — предложи фото или прислать видео позже. Не настаивай.
4. Что важно сделать: окна и трисы, полировка пола, краска, шпаклёвка, цемент на полу.
   Часть видно на видео — спроси только то, чего не видно: «Трисы тоже моем?»
5. Когда нужна уборка — желаемый день.
6. Как обращаться к клиенту, если имя ещё неизвестно. Спроси естественно, ближе к концу.
Порядок гибкий: если клиент сам заговорил о дате или сразу прислал видео — подстройся.
stage: «уточняем», пока собираешь; «ждём видео», когда попросила видео и его ещё нет;
«заявка готова» — когда передаёшь; «отказ» — если клиент передумал.

КОГДА ПРИСЛАЛИ ВИДЕО ИЛИ ФОТО:
- одной короткой фразой покажи, что посмотрела: «Посмотрела — пыль и следы шпаклёвки на полу»;
- запиши в rooms, что видно в каждом помещении, оцени condition;
- не выдумывай того, чего нет; не разобрать — попроси переснять;
- переходи к следующему недостающему пункту.

ВОПРОСЫ КЛИЕНТА. Сначала коротко ответь по «условиям и ценам» ниже, потом мягко вернись
к сценарию следующим вопросом. Не знаешь ответа — не выдумывай: скажи, что уточнишь у коллеги,
и передай менеджеру.

ЦЕНА. Точную цену называет коллега после видео. Спрашивают раньше — назови ориентир «от»
по прайсу (если ниже есть расчёт по прайсу — именно его) и скажи, что точнее скажут по видео.
Скидок не обещай, суммы сама не считай.

КОГДА ЗАЯВКА ГОТОВА: известно, где объект и что это за объект, есть видео или фото
(или клиент твёрдо сказал, что снять не может), и ты спросила про пожелания и дату.
Тогда скажи, что передаёшь всё коллеге и она напишет стоимость, например:
«Спасибо! Передаю коллеге — она посмотрит видео и напишет вам стоимость».
Поставь lead_ready = true и stage «заявка готова». Больше вопросов в этом ответе не задавай.

КОГДА ЗВАТЬ МЕНЕДЖЕРА (needs_human = true), не дожидаясь готовой заявки:
- просит скидку, торгуется или спорит о цене;
- недоволен, жалуется, пишет резко;
- просит живого человека или позвонить;
- спрашивает то, чего нет в условиях, или про нестандартную работу;
- большой коммерческий объект или ситуация, в которой ты не уверена.
Скажи коротко и естественно: «Сейчас подключу коллегу, она ответит здесь».

ЕСЛИ СПРОСЯТ, БОТ ЛИ ТЫ, — ответь честно: ты виртуальная помощница компании, а цену и детали
дальше ведёт живой менеджер; предложи позвать его. Не отрицай, что ты ИИ, не выдумывай
о себе личных историй.

ЯЗЫК. Отвечай на языке клиента: иврит, русский, украинский, английский.
Ориентируйся на сообщения клиента, а не на язык приветствия.`;

const seed = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
seed.run('system_prompt', DEFAULT_PROMPT);
seed.run('ai_global', '1');
// Раскрытие ИИ обязательно: правила WhatsApp и Anthropic требуют сказать об этом
// хотя бы в начале диалога. Модель про него иногда «забывает» ради краткости,
// поэтому приветствие шлёт код. {company} — название компании из настроек.
const DEFAULT_GREETING = [
  'ru: Здравствуйте! Я Лея, виртуальная помощница компании «{company}». Подскажу по уборке, а если нужно — сразу подключу менеджера.',
  'uk: Вітаю! Я Лея, віртуальна помічниця компанії «{company}». Підкажу щодо прибирання, а якщо треба — одразу підключу менеджера.',
  'he: שלום! כאן ליה, העוזרת הווירטואלית של {company}. אשמח לעזור בנושא הניקיון, ואם צריך — אחבר אתכם לנציג.',
  "en: Hi! I'm Leah, the virtual assistant at {company}. Happy to help with the cleaning, and I can bring in a manager any time."
].join('\n');
seed.run('greeting', DEFAULT_GREETING);
seed.run('business_hours', '');
// Услуги и цены вынесены из промпта отдельно — их правят чаще всего,
// и лезть ради этого в инструкцию для модели неудобно.
const DEFAULT_FACTS = [
  '⚠️ ДЕМО-ДАННЫЕ — замените на свои.',
  '',
  'Уборка после ремонта: квартиры, дома, офисы, коммерческие помещения.',
  'Входит: строительная пыль, остатки краски, шпаклёвки, цемента и клея, кухня и санузлы,',
  'мытьё окон и трисов изнутри и снаружи, где есть доступ.',
  'Отдельно, по видео: полировка пола (мрамор, плитка, паркет), мойка окон на высоте.',
  'Ориентир: квартиры после ремонта — от 25 ₪/м², офисы и коммерческие — от 20 ₪/м². Минимальный заказ — 400 ₪.',
  'Точную цену называет менеджер после видео объекта.',
  'Работаем по Тель-Авиву и центру, выезд бесплатный.',
  'Свои средства и оборудование. Оплата после приёмки работы.'
].join('\n');
seed.run('business_facts', DEFAULT_FACTS);
// Чёрный список: этим номерам бот не отвечает, в заявки они не попадают. Правится в админке.
seed.run('blocked_numbers', '');
// Кому слать уведомления о передаче заявки. Пусто — не слать.
seed.run('manager_numbers', '');
seed.run('notify_on', '1');
seed.run('admin_url', '');   // для ссылки на диалог; на Render берётся из RENDER_EXTERNAL_URL
// Пауза перед ответом: за неё бот успевает дождаться, пока клиент допишет
// очередь коротких сообщений, и отвечает один раз на всю пачку.
seed.run('reply_delay', String(process.env.REPLY_DELAY_MS ?? 4000));
seed.run('timezone', 'Asia/Jerusalem');
// часы по каждому дню отдельно: пятница в Израиле почти везде короткая
seed.run('work_hours', JSON.stringify({
  0: ['08:00', '20:00'], 1: ['08:00', '20:00'], 2: ['08:00', '20:00'],
  3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '13:00'], 6: null
}));
seed.run('holidays', '');               // «ГГГГ-ММ-ДД название», по строке на дату
seed.run('off_hours', 'notice');        // always | notice | silent
seed.run('off_hours_note', 'Сейчас нерабочее время, менеджер подтвердит заказ в рабочие часы.');
seed.run('autoclose_days', '0');
seed.run('company', 'Клининг');
seed.run('price_list', '');
// предел очереди «Нужен человек»: больше — значит менеджер не справляется
seed.run('wip_need', '5');
// заготовки ответов: менеджер печатает одно и то же по десять раз в день
const DEFAULT_QUICK = [
  'Спасибо за видео! По нему уборка обойдётся в … ₪. Когда вам удобно?',
  'Можем приехать на бесплатный осмотр — в какой день удобно?',
  'Все средства и оборудование наши, от вас нужен только доступ.',
  'Оплата — после того как примете работу.',
  'Заказ подтверждён. Накануне напомним и приедем в оговорённое время.'
].join('\n');
seed.run('quick_replies', DEFAULT_QUICK);

// Тексты по умолчанию обновляются и на уже работающих базах, но только если их
// никто не правил: сравниваем с отпечатками прежних версий. Свои правки не трогаем.
const LEGACY = {
  system_prompt: ['26de0a12bb145470'],
  greeting: ['a6e77eadcb2e6ac0'],
  business_facts: ['9fa01d5721b12cc7'],
  quick_replies: ['e6d3dbf999f0655b']
};
const FRESH = { system_prompt: DEFAULT_PROMPT, greeting: DEFAULT_GREETING, business_facts: DEFAULT_FACTS, quick_replies: DEFAULT_QUICK };
const fingerprint = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
for (const [key, value] of Object.entries(FRESH)) {
  const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  if (cur != null && LEGACY[key].includes(fingerprint(cur))) {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(value, key);
  }
}

export const getSetting = (k) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;

export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

export function getOrCreateConversation(channel, phone, name, chatId = null) {
  const found = db.prepare('SELECT * FROM conversations WHERE channel=? AND phone=?').get(channel, phone);
  if (found) {
    if (name && !found.name) db.prepare('UPDATE conversations SET name=? WHERE id=?').run(name, found.id);
    // chat_id мог смениться (@lid ↔ @c.us) — всегда держим последний рабочий
    if (chatId && chatId !== found.chat_id) db.prepare('UPDATE conversations SET chat_id=? WHERE id=?').run(chatId, found.id);
    return db.prepare('SELECT * FROM conversations WHERE id=?').get(found.id);
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO conversations(channel, phone, name, chat_id) VALUES(?,?,?,?)')
    .run(channel, phone, name ?? null, chatId);
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(lastInsertRowid);
}

/** Провайдеры ретраят вебхуки — один и тот же wa_id не обрабатываем дважды. */
export const messageExists = (waId) =>
  Boolean(waId) && Boolean(db.prepare('SELECT 1 FROM messages WHERE wa_id=?').get(waId));

export function addMessage(convId, { direction, author, body, wa_id = null, error = null, media = null }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages(conv_id,direction,author,body,wa_id,error,media) VALUES(?,?,?,?,?,?,?)')
    .run(convId, direction, author, body, wa_id, error, media?.length ? JSON.stringify(media) : null);
  db.prepare("UPDATE conversations SET last_at = datetime('now') WHERE id=?").run(convId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(lastInsertRowid);
}

export const history = (convId, limit = 40) =>
  db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?').all(convId, limit).reverse();

export const getConversation = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

export function listConversations() {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      -- когда клиент написал в последний раз: по нему считаем, сколько он уже ждёт
      (SELECT max(created_at) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'in') AS last_in_at,
      (SELECT count(*) FROM messages m WHERE m.conv_id = c.id AND m.media IS NOT NULL) AS media_count
    FROM conversations c
    ORDER BY c.needs_human DESC, c.last_at DESC
  `).all();

  // превью фото прямо на карточке: для клининга снимок помещения — главный контекст
  const thumbs = db.prepare(`
    SELECT media FROM messages WHERE conv_id = ? AND media IS NOT NULL ORDER BY id DESC LIMIT 3`);
  for (const c of rows) {
    c.thumbs = c.media_count
      ? thumbs.all(c.id).flatMap((r) => JSON.parse(r.media)).filter((x) => x.kind !== 'audio').slice(0, 3)
      : [];
  }
  return rows;
}
