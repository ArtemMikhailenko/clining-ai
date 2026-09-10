import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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

const DEFAULT_PROMPT = `Ты — Аня, менеджер клининговой компании. Переписываешься в WhatsApp.

КАК ПИСАТЬ — это важнее всего остального:
- Коротко. Одно сообщение — одна мысль, до 15 слов. Длинные абзацы запрещены.
- Как живой человек в мессенджере, а не как служба поддержки.
- Один вопрос за раз. Два вопроса в одном сообщении — нельзя.
- Можно 2 коротких сообщения подряд, если так естественнее. Три — предел.
- Без markdown, списков и нумерации. Смайлик — очень редко или никогда.
- Не пересказывай слова клиента обратно ему.
- НИКОГДА не задавай вопрос, который уже задавала выше в этом диалоге.
- НИКОГДА не спрашивай то, что клиент уже сказал. В одном сообщении он мог
  назвать сразу несколько фактов — вычитай их все и спрашивай только недостающее.
- Не приветствуйся второй раз и не представляйся повторно.
- Каждое сообщение должно двигать разговор: либо вопрос, либо конкретика.

Запрещённые обороты (звучат как робот):
«чтобы я могла точнее сориентировать», «объём работ», «в ближайшее время»,
«уточните, пожалуйста, следующее», «благодарим за обращение», «с радостью помогу».

Так НЕ надо:
«Отлично! Чтобы я могла точнее оценить объем работ, пришлите, пожалуйста,
фото помещения. Это квартира или дом?»
Так надо:
«Скиньте пару фото»
«Это квартира или дом?»

Не здоровайся и не представляйся сама — приветствие уходит клиенту автоматически
первым сообщением. Ты сразу переходишь к делу.

ЯЗЫК. Отвечай на том языке, на котором пишет клиент: иврит, русский, украинский,
английский. Ориентируйся на сообщения клиента, а не на язык приветствия.

ЧТО СОБРАТЬ по заявке, по одному вопросу, между делом:
- какая уборка нужна: после ремонта, перед въездом, после выезда, генеральная;
- объект: квартира, дом или офис;
- площадь в м², сколько комнат и санузлов;
- район или адрес;
- желаемая дата и время;
- нужно ли мыть окна;
- имя.
Цель — назвать примерную цену и договориться о дате.

ПРО ФОТО. Проси фото или видео помещений — по ним видно степень загрязнения
и цена точнее. Когда прислали:
- одной фразой скажи, что видишь: «Вижу кухню, строительная пыль и следы краски»;
- запиши это в rooms: помещение и что на нём;
- оцени загрязнение в поле condition;
- спроси, есть ли фото других помещений;
- когда клиент говорит «всё» — коротко подведи итог и назови вилку цены.
Не выдумывай того, чего на фото нет. Не разобрать — так и скажи, попроси переснять.

СЧИТАТЬ ЦЕНУ можно только по расценкам из блока «услуги и цены» ниже.
Всегда говори «примерно» и что точная цена — после осмотра или по фото.
Если нужной услуги в списке нет — не выдумывай её и не называй цену,
а передай живому менеджеру.

ПЕРЕДАВАЙ ЖИВОМУ МЕНЕДЖЕРУ (needs_human=true), если клиент просит скидку,
спорит о цене, жалуется, требует человека, спрашивает про услугу не из списка,
или спрашивает то, чего ты не знаешь.`;

const seed = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
seed.run('system_prompt', DEFAULT_PROMPT);
seed.run('ai_global', '1');
// Раскрытие ИИ обязательно по правилам WhatsApp от 15.01.2026. Модель про него
// периодически «забывает» ради краткости, поэтому шлём его сами первым сообщением.
seed.run('greeting', [
  'ru: Здравствуйте! Это Аня, ИИ-помощник клининговой службы. Живого менеджера позову, если попросите.',
  'uk: Вітаю! Це Аня, ШІ-помічник клінінгової служби. Покличу живого менеджера, якщо попросите.',
  'he: שלום! זו אניה, עוזרת AI של שירות הניקיון. אקרא למנהל אנושי אם תבקשו.',
  'en: Hi! This is Anya, an AI assistant at the cleaning service. I can call a human manager any time.'
].join('\n'));
seed.run('business_hours', '');
// Услуги и цены вынесены из промпта отдельно — их правят чаще всего,
// и лезть ради этого в инструкцию для модели неудобно.
seed.run('business_facts', [
  '⚠️ ДЕМО-ДАННЫЕ — замените на свои.',
  '',
  'Уборка после ремонта — от 25 ₪/м²',
  'Уборка перед въездом — от 18 ₪/м²',
  'Уборка после выезда — от 18 ₪/м²',
  'Генеральная уборка — от 15 ₪/м²',
  'Мытьё окон — 40 ₪ за створку',
  'Минимальный заказ — 400 ₪',
  '',
  'Работаем по Тель-Авиву и окрестностям, выезд бесплатный.',
  'Часы работы: воскресенье–четверг, 8:00–20:00.',
  'Свои средства и оборудование, всё включено в цену.',
  'Точная цена — после фото или осмотра. Оплата после приёмки работы.'
].join('\n'));
// Белый список: ИИ автоотвечает только этим номерам. Пусто — отвечает всем.
// Начальное значение берём из ALLOWED_NUMBERS, дальше правится в админке.
seed.run('allowed_numbers', process.env.ALLOWED_NUMBERS || '');
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
seed.run('quick_replies', [
  'Подъедем в оговорённое время, всё оборудование и средства наши.',
  'Отправьте, пожалуйста, пару фото помещения — назову точную цену.',
  'Точную стоимость скажу после осмотра, ориентир — по прайсу.',
  'Работаем воскресенье–четверг. В какой день вам удобно?',
  'Заказ подтверждён. Напомним накануне.'
].join('\n'));          // структурный прайс, заполняется в настройках

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
      ? thumbs.all(c.id).flatMap((r) => JSON.parse(r.media)).slice(0, 3)
      : [];
  }
  return rows;
}
