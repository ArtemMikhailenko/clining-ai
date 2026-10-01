import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { legacyStage, STAGES, CLOSE } from './stages.js';

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
// «перезвонить 15.10» — это задача человеку, а не повод боту написать клиенту
if (!cols.includes('followup_who')) db.exec('ALTER TABLE conversations ADD COLUMN followup_who TEXT');

// Журнал изменений (ТЗ §4.2, §10): кто, когда, что было и что стало.
// На этапе 1 пишут бот, перенос и менеджер без имени; учётки появятся на этапе 3.
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor     TEXT NOT NULL,
  reason    TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, id);`);

// Менеджеры (ТЗ §2, §4.1). Владелец — тоже строка: ему уходят эскалации,
// а заявки он получает, только если сам отмечен «принимает заявки».
db.exec(`CREATE TABLE IF NOT EXISTS managers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  role       TEXT NOT NULL DEFAULT 'manager',     -- manager | owner
  active     INTEGER NOT NULL DEFAULT 1,           -- принимает новые заявки
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Звонки (ТЗ §6): каждая попытка отдельной строкой, с итогом и записью
db.exec(`CREATE TABLE IF NOT EXISTS calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      INTEGER NOT NULL,
  manager_id   INTEGER,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL,          -- answered | no_answer | busy | wrong | callback
  duration_sec INTEGER,
  outcome      TEXT,
  next_call_at TEXT,
  recording    TEXT,                   -- файл в data/media/calls
  no_record_reason TEXT,
  due_at       TEXT,                   -- какой срок закрывала попытка: для отчёта о скорости
  actor        TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_conv ON calls(conv_id, id);`);

// Передача менеджеру: ответственный, когда передали, до какого времени позвонить
if (!cols.includes('manager_id')) {
  db.exec('ALTER TABLE conversations ADD COLUMN manager_id INTEGER');
  db.exec('ALTER TABLE conversations ADD COLUMN assigned_at TEXT');
  db.exec('ALTER TABLE conversations ADD COLUMN call_due_at TEXT');       // пусто — звонить не нужно
  db.exec('ALTER TABLE conversations ADD COLUMN call_escalated_at TEXT'); // просрочку уже разослали
  db.exec('ALTER TABLE conversations ADD COLUMN handoff_due_at TEXT');    // первый срок: для SLA в «Контроле дня»
}
// Следующее действие менеджера (ТЗ §4.1): что, кто, к какому сроку
if (!cols.includes('next_action')) {
  db.exec('ALTER TABLE conversations ADD COLUMN next_action TEXT');
  db.exec('ALTER TABLE conversations ADD COLUMN next_action_at TEXT');
  db.exec('ALTER TABLE conversations ADD COLUMN next_action_mgr INTEGER');
  db.exec('ALTER TABLE conversations ADD COLUMN next_action_notified_at TEXT');
  // «напомнить мне» из старого блока — это и есть действие менеджера; 06:00 UTC ≈ 9 утра в Израиле
  const moved = db.prepare(`UPDATE conversations SET next_action=COALESCE(NULLIF(followup_note,''), 'напомнить'),
      next_action_at=followup_at || ' 06:00:00', followup_at=NULL, followup_note=NULL, followup_who=NULL
    WHERE followup_who='manager' AND followup_at IS NOT NULL`).run().changes;
  if (moved) console.log(`Следующее действие: перенесено ${moved} напоминаний менеджеру`);
}
if (!cols.includes('stage_at')) db.exec('ALTER TABLE conversations ADD COLUMN stage_at TEXT');   // когда сменился этап

const needStages = !cols.includes('stage');
if (needStages) {
  db.exec('ALTER TABLE conversations ADD COLUMN stage TEXT');
  db.exec('ALTER TABLE conversations ADD COLUMN close_reason TEXT');   // paid | lost | unq_regular | unq_staff
  db.exec('ALTER TABLE conversations ADD COLUMN lost_reason TEXT');
  db.exec('ALTER TABLE conversations ADD COLUMN review TEXT');         // почему перенос нужно проверить руками
}
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
// Архив делится на корзины: свои сотрудники, «не сейчас, но лид живой» и отказ.
// Одной кучей «закрыто» пользоваться нельзя — там вперемешку и коллеги, и клиенты.
if (!cols.includes('archive')) {
  db.exec('ALTER TABLE conversations ADD COLUMN archive TEXT');
  // что уже закрыто, кладём в «отказ»: разобрать по корзинам можно перетаскиванием
  db.exec("UPDATE conversations SET archive='refused' WHERE status='closed'");
}
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

СНАЧАЛА ВЫЯСНИ, НАША ЛИ ЭТО ЗАЯВКА. Компания сейчас делает только уборку после
ремонта. Первым вопросом мягко уточни, что нужно: «Уборка после ремонта или обычная,
бытовая?» Если из первого сообщения и так ясно (написал «после ремонта», прислал фото
стройпыли) — не спрашивай, иди дальше по сценарию.

- УБОРКА ПОСЛЕ РЕМОНТА — работаем, веди по сценарию ниже.
- ОБЫЧНАЯ, БЫТОВАЯ УБОРКА (генеральная, поддерживающая, раз в неделю, после
  гостей, перед въездом без ремонта) — скажи честно и доброжелательно:
  «Сейчас мы делаем только уборку после ремонта. Как только появится обычная
  уборка, мы вам напишем». Поставь route = «обычная уборка», больше вопросов
  не задавай и менеджера не зови: заявка уходит в архив, в «Обычные уборки».
- ЧЕЛОВЕК ИЩЕТ РАБОТУ (спрашивает про вакансии, «нужны ли работники», присылает
  резюме) — скажи, что передашь контакт, и поставь route = «ищет работу».
  Это не клиент: менеджера не зови, вопросов по уборке не задавай.

СЦЕНАРИЙ (только для уборки после ремонта). Веди клиента по шагам — мягко,
по одному вопросу, между делом:
1. Где объект: достаточно города. Район, улицу и этаж не выспрашивай - адрес
   уточнит менеджер перед выездом, клиента это только задерживает.
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
  'Работаем по всему Израилю, выезжаем в любой город: Хайфа, Иерусалим, Беэр-Шева, Эйлат - куда угодно.',
  'На вопрос «вы работаете в таком-то городе» отвечай просто «да, работаем», без оговорок и без «уточню у менеджера».',
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
seed.run('source_map', '');
// ТЗ §2.2: срок первого звонка после передачи, минут
seed.run('call_sla_min', '5');
// записи разговоров: предел размера файла и срок хранения (0 — хранить всегда)
seed.run('rec_max_mb', '50');
seed.run('rec_keep_days', '0');
// §7: через сколько часов тишины поднимать флаг; вечерний отчёт владельцу
seed.run('offer_wait_hours', '48');
seed.run('media_wait_hours', '24');
seed.run('evening_report', '1');
// ТЗ §2.1: для каких видов уборки фото/видео обязательны. Без них заявка
// остаётся в «Уточнении» с флагом «Ждём фото/видео»
seed.run('media_required', 'после ремонта, перед въездом, после выезда, генеральная');
// Глубина обдумывания ответа: low | medium | high. Правится в админке на лету.
// По умолчанию high: переписка с живым клиентом дороже сэкономленных центов,
// а на низкой модель теряет нить в длинном диалоге.
seed.run('ai_effort', 'high');   // для ссылки на диалог; на Render берётся из RENDER_EXTERNAL_URL
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
  system_prompt: ['26de0a12bb145470', 'a9c5722304df87fb', '00be20aa4629945c', '55a44e45be23e8ae',
    '5ed39dacff13d58d', '8e94eb2c1620c96e'],
  greeting: ['a6e77eadcb2e6ac0'],
  business_facts: ['9fa01d5721b12cc7', '9f58cbaa33cc3f94', '40de58dc7e5046b9', 'e6cfd0b06d1e9579',
    '554bfdf1d3fb381b'],
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

// Закрытая заявка никого не ждёт: флаг «нужен человек» на ней — след прошлого,
// из-за которого в архиве висело «ждёт 15 ч». Дёшево и идемпотентно.
db.exec("UPDATE conversations SET needs_human=0 WHERE status='closed' AND needs_human=1");


// Перенос в новую воронку — один раз, при появлении колонки stage.
// Каждое решение пишется в журнал, спорные получают пометку review.
if (needStages) {
  const before = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const tally = {};
  for (const c of db.prepare('SELECT * FROM conversations').all()) {
    const r = legacyStage(c);
    db.prepare('UPDATE conversations SET stage=?, close_reason=?, lost_reason=?, review=? WHERE id=?')
      .run(r.stage, r.close, r.lost_reason, r.review, c.id);
    if (r.stage === 'closed') db.prepare("UPDATE conversations SET status='closed', needs_human=0 WHERE id=?").run(c.id);
    const label = r.close ? `closed:${r.close}` : r.stage;
    db.prepare(`INSERT INTO audit_log(entity, entity_id, field, old_value, new_value, actor, reason)
      VALUES('lead', ?, 'stage', ?, ?, 'перенос', ?)`)
      .run(c.id, `${c.status}/${JSON.parse(c.lead || '{}').stage || ''}`, label, r.review || r.lost_reason);
    tally[label] = (tally[label] || 0) + 1;
  }
  const after = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`Перенос в новую воронку: ${before} заявок → ${after}`, JSON.stringify(tally));
  if (before !== after) console.error('ВНИМАНИЕ: количество заявок до и после переноса не совпадает');
}

// Номера из старого поля «Номера менеджеров» становятся менеджерами.
// Один раз: если список уже заводили руками, ничего не трогаем.
if (!db.prepare('SELECT count(*) n FROM managers').get().n) {
  const old = db.prepare("SELECT value FROM settings WHERE key='manager_numbers'").get()?.value || '';
  const phones = [...new Set(old.split(/[,;\n]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 9))];
  phones.forEach((ph, i) => db.prepare('INSERT INTO managers(name, phone) VALUES(?, ?)')
    .run(phones.length > 1 ? `Менеджер ${i + 1}` : 'Менеджер', ph));
  if (phones.length) console.log(`Менеджеры: перенесено ${phones.length} номеров из настроек`);
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
    .prepare("INSERT INTO conversations(channel, phone, name, chat_id, stage) VALUES(?,?,?,?,'new')")
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
/** Запись в журнал изменений. Значения храним строками, как увидит человек. */
export function audit(entity, entityId, field, oldValue, newValue, actor, reason = null) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return;
  db.prepare(`INSERT INTO audit_log(entity, entity_id, field, old_value, new_value, actor, reason)
    VALUES(?,?,?,?,?,?,?)`).run(entity, entityId, field,
    oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), actor, reason);
}

const stageLabel = (stage, close) => (stage === 'closed' && close ? `closed:${close}` : stage || '');
const ARCHIVE_OF = { lost: 'refused', unq_regular: 'later', unq_staff: 'staff', paid: null };

/**
 * Сменить этап заявки. Закрытие проставляет status='closed' — на нём держатся
 * расписание, дожим и отчёты; переоткрытие отдаёт диалог человеку.
 * Каждая смена пишется в журнал с автором и причиной.
 */
export function applyStage(convId, next, { close = null, lostReason = null, actor = 'система', why = null } = {}) {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
  if (!c) return null;
  if (!STAGES.includes(next)) throw new Error('Неизвестный этап: ' + next);
  if (next === 'closed' && !CLOSE.includes(close)) throw new Error('Закрытой заявке нужен подстатус');
  if (next === 'closed' && close === 'lost' && !String(lostReason ?? '').trim()) {
    throw new Error('Проигранной заявке нужна причина');
  }
  const set = {
    stage: next,
    stage_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    close_reason: next === 'closed' ? close : null,
    lost_reason: next === 'closed' && close === 'lost' ? String(lostReason).trim() : null,
    archive: next === 'closed' ? ARCHIVE_OF[close] : null
  };
  // закрытую заявку обзванивать не нужно — срок звонка снимаем вместе с флагом
  if (next === 'closed') { set.status = 'closed'; set.needs_human = 0; set.call_due_at = null; set.call_escalated_at = null; }
  else if (c.status === 'closed') set.status = 'human';
  const keys = Object.keys(set);
  db.prepare(`UPDATE conversations SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...keys.map((k) => set[k]), convId);
  audit('lead', convId, 'stage', stageLabel(c.stage, c.close_reason), stageLabel(next, set.close_reason),
    actor, why || set.lost_reason);
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(convId);
}

export function resetData() {
  const convs = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const msgs = db.prepare('SELECT count(*) n FROM messages').get().n;
  const jobs = db.prepare('SELECT count(*) n FROM jobs').get().n;
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM jobs; DELETE FROM audit_log; DELETE FROM calls;');
  try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','conversations','jobs')"); } catch {}
  let files = 0;
  const mediaDir = path.join(dir, 'media');
  if (!fs.existsSync(mediaDir)) return { conversations: convs, messages: msgs, jobs, files: 0 };
  for (const f of fs.readdirSync(mediaDir, { withFileTypes: true }).filter((x) => x.isFile())) {
    try { fs.rmSync(path.join(mediaDir, f.name)); files++; } catch {}
  }
  return { conversations: convs, messages: msgs, jobs, files };
}

export const mediaRequired = () =>
  new Set(String(getSetting('media_required') || '').split(',').map((x) => x.trim()).filter(Boolean));

/**
 * Флаг «Ждём фото/видео» (ТЗ §2.1): заявка ещё в работе до предложения, вид
 * уборки требует материала, а клиент не прислал ни фото, ни видео. Бот может
 * сам поставить стадию «ждём видео» — это тоже флаг.
 */
export function waitsMedia(c, need = mediaRequired()) {
  if (!['new', 'clarify'].includes(c.stage || 'new')) return false;
  let l = {};
  try { l = JSON.parse(c.lead || '{}'); } catch {}
  const visual = c.visual_count ?? db.prepare(`SELECT count(*) n FROM messages WHERE conv_id=? AND direction='in'
    AND (media LIKE '%"kind":"image"%' OR media LIKE '%"kind":"video"%')`).get(c.id).n;
  if (visual > 0) return false;
  return l.stage === 'ждём видео' || need.has(l.service);
}

export const getConversation = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

export function listConversations() {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      -- когда клиент написал в последний раз: по нему считаем, сколько он уже ждёт
      (SELECT max(created_at) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'in') AS last_in_at,
      (SELECT count(*) FROM messages m WHERE m.conv_id = c.id AND m.media IS NOT NULL) AS media_count,
      (SELECT count(*) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'in'
        AND (m.media LIKE '%"kind":"image"%' OR m.media LIKE '%"kind":"video"%')) AS visual_count
    FROM conversations c
    ORDER BY c.needs_human DESC, c.last_at DESC
  `).all();

  // превью фото прямо на карточке: для клининга снимок помещения — главный контекст
  const thumbs = db.prepare(`
    SELECT media FROM messages WHERE conv_id = ? AND media IS NOT NULL ORDER BY id DESC LIMIT 3`);
  const need = mediaRequired();
  for (const c of rows) {
    c.wait_media = waitsMedia(c, need);
    c.thumbs = c.media_count
      ? thumbs.all(c.id).flatMap((r) => JSON.parse(r.media)).filter((x) => x.kind !== 'audio').slice(0, 3)
      : [];
  }
  return rows;
}
