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

-- Уборки, заведённые руками: клиент позвонил, пришёл по сарафану, постоянный
-- заказчик. Без этого в расписание попадает только то, что прошло через бота.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,                     -- ГГГГ-ММ-ДД
  time       TEXT,
  name       TEXT,
  phone      TEXT,
  service    TEXT,
  area       TEXT,
  district   TEXT,
  price      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(date);

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
// чем было сообщение: обычный ответ, напоминание, подтверждение заказа — нужно для отчёта
if (!mcols.includes('kind')) db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
// статус доставки из WhatsApp: sent | delivered | read
if (!mcols.includes('status')) db.exec('ALTER TABLE messages ADD COLUMN status TEXT');
if (!cols.includes('note')) db.exec('ALTER TABLE conversations ADD COLUMN note TEXT');  // заметка менеджера
// когда менеджеру ушло уведомление о передаче — чтобы не слать его повторно
if (!cols.includes('notified_at')) db.exec('ALTER TABLE conversations ADD COLUMN notified_at TEXT');
// напоминания: когда написать («клиент просил после ремонта») и сколько дожимов уже ушло
if (!cols.includes('followup_at')) db.exec('ALTER TABLE conversations ADD COLUMN followup_at TEXT');
if (!cols.includes('followup_note')) db.exec('ALTER TABLE conversations ADD COLUMN followup_note TEXT');
if (!cols.includes('nudges')) db.exec('ALTER TABLE conversations ADD COLUMN nudges INTEGER NOT NULL DEFAULT 0');
// клиент попросил не писать — больше никаких напоминаний по своей инициативе
if (!cols.includes('nudge_stop')) db.exec('ALTER TABLE conversations ADD COLUMN nudge_stop INTEGER NOT NULL DEFAULT 0');
if (!cols.includes('last_nudge_at')) db.exec('ALTER TABLE conversations ADD COLUMN last_nudge_at TEXT');
if (!cols.includes('confirm_sent')) db.exec('ALTER TABLE conversations ADD COLUMN confirm_sent TEXT');   // eve | morning
if (!cols.includes('mgr_ping_at')) db.exec('ALTER TABLE conversations ADD COLUMN mgr_ping_at TEXT');
// Дата уборки. Пожелание клиента живёт в карточке (lead.date_iso), а здесь —
// запись, которую подтвердил человек: только она попадает в расписание.
if (!cols.includes('job_date')) db.exec('ALTER TABLE conversations ADD COLUMN job_date TEXT');
if (!cols.includes('job_time')) db.exec('ALTER TABLE conversations ADD COLUMN job_time TEXT');
// Откуда пришёл клиент: клик по рекламе приносит название объявления и ссылку
if (!cols.includes('source')) db.exec('ALTER TABLE conversations ADD COLUMN source TEXT');
if (!cols.includes('source_title')) db.exec('ALTER TABLE conversations ADD COLUMN source_title TEXT');
if (!cols.includes('source_url')) db.exec('ALTER TABLE conversations ADD COLUMN source_url TEXT');
if (!cols.includes('source_ref')) db.exec('ALTER TABLE conversations ADD COLUMN source_ref TEXT');
// весь ответ рекламной площадки целиком: по нему видно, что вообще прислала Meta
if (!cols.includes('source_raw')) db.exec('ALTER TABLE conversations ADD COLUMN source_raw TEXT');
// Деньги в трёх состояниях. Оценка бота живёт в карточке (lead.price_quote) и
// точной не является; согласованную сумму и оплату проставляет человек —
// иначе в отчёте «средний чек» считается по цифрам, которые никто не подтверждал.
if (!cols.includes('deal_sum')) db.exec('ALTER TABLE conversations ADD COLUMN deal_sum INTEGER');
if (!cols.includes('paid_sum')) db.exec('ALTER TABLE conversations ADD COLUMN paid_sum INTEGER');
if (!cols.includes('paid_at')) db.exec('ALTER TABLE conversations ADD COLUMN paid_at TEXT');

const DEFAULT_PROMPT = `Ты — Лея, помощница компании по уборке после ремонта. Переписываешься с клиентами в WhatsApp.
Клиенты приходят с рекламы, первое сообщение часто шаблонное: «Здравствуйте, интересует уборка».
Компания убирает квартиры, дома, офисы и коммерческие помещения после ремонта: строительная пыль,
остатки краски, шпаклёвки, цемента и клея, машинная очистка пола, мытьё окон и трисов, кухня и санузлы.

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
4. Что важно сделать: окна и трисы, машинная очистка пола, краска, шпаклёвка, цемент на полу.
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
- просит то, чего нет в условиях и в прайсе (например оплату по часам);
- большой коммерческий объект или ситуация, в которой ты не уверена.
Скажи коротко и естественно: «Сейчас подключу коллегу, она ответит здесь».

НЕ ПОВТОРЯЙ СВОИ ВОПРОСЫ. Посмотри, о чём уже спрашивала в переписке и что уже
записано в заявке: город, тип объекта, площадь. Клиент ответил — иди дальше по
сценарию. Не ответил — не переспрашивай тем же вопросом, просто жди.

НЕ СПЕШИ ПЕРЕДАВАТЬ. Другой тип уборки — не повод звать человека: генеральная,
поддерживающая, перед въездом и после выезда это обычные услуги из прайса.
Клиент считает в часах («4 часа раз в две недели») — не отказывай и не передавай
сразу: скажи, что считаем по площади, спроси метраж и назови ориентир по прайсу.
Менеджер нужен, только если клиенту важна именно почасовая оплата.
Прежде чем передать, собери хотя бы город, тип объекта и площадь — иначе менеджер
получит пустую заявку и будет спрашивать то же самое заново. Если сомневаешься,
задай ещё один вопрос по делу, а передавай только когда упёрлась в условия.

ЕСЛИ СПРОСЯТ, БОТ ЛИ ТЫ, — ответь честно: ты виртуальная помощница компании, а цену и детали
дальше ведёт живой менеджер; предложи позвать его. Не отрицай, что ты ИИ, не выдумывай
о себе личных историй.

ЯЗЫК. Отвечай на языке ПОСЛЕДНЕГО сообщения клиента: иврит, русский, украинский,
английский. Клиент пишет на иврите — отвечаешь на иврите, даже когда передаёшь
диалог коллеге и когда объясняешь, что услуга другая. Перешёл на русский — переходи
и ты. Язык приветствия и язык этой инструкции ни на что не влияют.`;

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
  'Отдельно, по видео: машинная очистка пола, мойка окон на высоте.',
  'Другие виды полировки (мрамор, паркет, кристаллизация) - только после согласования с менеджером.',
  'Ориентир: квартиры после ремонта — от 25 ₪/м², офисы и коммерческие — от 20 ₪/м². Минимальный заказ — 400 ₪.',
  'Точную цену называет менеджер после видео объекта.',
  'Работаем по всему Израилю, выезжаем в любой город - уточнять это у менеджера не нужно.',
  'Основная зона Ашдод - Хадера, туда выезжаем чаще всего.',
  'Свои средства и оборудование. Оплата после приёмки работы.'
].join('\n');
seed.run('business_facts', DEFAULT_FACTS);
// Чёрный список: этим номерам бот не отвечает, в заявки они не попадают. Правится в админке.
seed.run('blocked_numbers', '');
// Кому слать уведомления о передаче заявки. Пусто — не слать.
seed.run('manager_numbers', '');
seed.run('notify_on', '1');
seed.run('admin_url', '');
// справочник кампаний: «ключ = Название». Ключ ищется в объявлении и первом сообщении
seed.run('source_map', '');   // для ссылки на диалог; на Render берётся из RENDER_EXTERNAL_URL
// Дожим: если клиент замолчал после цены, бот сам напомнит о себе. Только в рабочие часы.
seed.run('nudge_on', '1');
seed.run('nudge_hours', '20');          // через сколько часов тишины первое напоминание
seed.run('nudge_repeat_hours', '72');   // через сколько после него второе
seed.run('nudge_max', '2');             // больше двух раз не напоминаем
seed.run('nudge_stale_hours', '336');   // молчит дольше двух недель — напоминать поздно
// Ритм торканий зависит от того, где остановились: вопрос без ответа остывает быстрее,
// чем «подумаю» после цены. Часы от последнего сообщения бота.
seed.run('nudge_steps_ask', '3,24,72');
seed.run('nudge_steps_quoted', '24,72,168');
// Подтверждение заказа накануне и утром — меньше срывов выезда
seed.run('confirm_on', '1');
seed.run('confirm_eve_hour', '18');
seed.run('confirm_morning_hour', '8');
// Диалоги, которые ведёт менеджер, бот не дожимает — напоминает самому менеджеру
seed.run('manager_ping_hours', '48');
seed.run('stop_words', [
  'не пишите', 'не пиши', 'не писать', 'отпишитесь', 'отписаться', 'хватит писать',
  'перестаньте писать', 'не беспокойте', 'не турбуйте', 'stop', 'unsubscribe',
  'תפסיקו לכתוב', 'אל תכתבו', 'להסיר אותי'
].join('\n'));
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
  system_prompt: ['26de0a12bb145470', 'a9c5722304df87fb', '00be20aa4629945c', '55a44e45be23e8ae'],
  greeting: ['a6e77eadcb2e6ac0'],
  business_facts: ['9fa01d5721b12cc7', '9f58cbaa33cc3f94', '40de58dc7e5046b9', 'e6cfd0b06d1e9579'],
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

export function addMessage(convId, { direction, author, body, wa_id = null, error = null, media = null, kind = null }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages(conv_id,direction,author,body,wa_id,error,media,kind) VALUES(?,?,?,?,?,?,?,?)')
    .run(convId, direction, author, body, wa_id, error, media?.length ? JSON.stringify(media) : null, kind);
  db.prepare("UPDATE conversations SET last_at = datetime('now') WHERE id=?").run(convId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(lastInsertRowid);
}

/** Статус доставки приходит от WhatsApp отдельным событием, уже после отправки. */
export const setMessageStatus = (waId, status) =>
  db.prepare('UPDATE messages SET status=? WHERE wa_id=?').run(status, waId);

export const history = (convId, limit = 40) =>
  db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?').all(convId, limit).reverse();

/**
 * Источник обращения. Пишем только первый раз: человек приходит по рекламе
 * один раз, дальше он просто пишет в тот же чат, и перетирать метку нельзя.
 */
export function setSource(convId, src) {
  if (!src?.source) return;
  const cur = db.prepare('SELECT source FROM conversations WHERE id=?').get(convId);
  if (cur?.source) return;
  db.prepare('UPDATE conversations SET source=?, source_title=?, source_url=?, source_ref=?, source_raw=? WHERE id=?')
    .run(src.source, src.title || null, src.url || null, src.ref || null,
      src.raw ? JSON.stringify(src.raw) : null, convId);
}

/**
 * Стереть переписку и заявки, сохранив настройки, прайс и привязку WhatsApp.
 * Нужно перед запуском рекламы: тестовые диалоги портят и воронку, и отчёты.
 */
export function resetData() {
  const convs = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const msgs = db.prepare('SELECT count(*) n FROM messages').get().n;
  const jobs = db.prepare('SELECT count(*) n FROM jobs').get().n;
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM jobs;');
  try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','conversations','jobs')"); } catch {}
  let files = 0;
  const mediaDir = path.join(dir, 'media');
  if (!fs.existsSync(mediaDir)) return { conversations: convs, messages: msgs, jobs, files: 0 };
  for (const f of fs.readdirSync(mediaDir, { withFileTypes: true }).filter((x) => x.isFile())) {
    try { fs.rmSync(path.join(mediaDir, f.name)); files++; } catch {}
  }
  return { conversations: convs, messages: msgs, jobs, files };
}

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
