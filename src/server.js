import express from 'express';
import path from 'node:path';
import { db, listConversations, getConversation, history, getSetting, setSetting, addMessage, resetData } from './db.js';
import { handleIncoming, sendAsHuman, suggestReply, subscribe, emit } from './bot.js';
import * as botState from './bot.js';
import { channel, channels } from './channels/index.js';
import { saveMedia } from './media.js';
import { withinWorkHours, scheduleSetting, workHours, holidays, isHoliday, workingSeconds } from './schedule.js';
import { quote, priceList } from './pricing.js';
import { waStatus, onStatus, requestPairing, logout as waLogout, restart as waRestart } from './channels/baileys.js';
import { sttLabel } from './stt.js';
import { notifyManagers } from './notify.js';
import { aiConfigured, aiLabel } from './ai.js';

/* ─────────── Процесс не должен умирать молча ───────────
   Необработанная ошибка в обработчике событий WhatsApp роняла Node: клиент
   оставался без ответа, а сервис перезапускался хостингом без следа в диалоге.
   Лучше остаться в живых и позвать человека. */
const crashNote = (kind) => (e) => {
  console.error(`${kind}:`, e?.stack || e?.message || e);
  notifyManagers(`⚠️ Сбой в работе бота: ${String(e?.message || e).slice(0, 150)}\nЕсли клиенты пишут без ответа - ответьте вручную.`)
    .catch(() => {});
};
process.on('unhandledRejection', crashNote('необработанная ошибка'));
process.on('uncaughtException', crashNote('необработанное исключение'));

const app = express();
app.use(express.json({ limit: '25mb' }));   // фото приходят base64 из симулятора

const PORT = process.env.PORT || 3000;

/* ─────────── Доступ в админку ───────────
   В базе — телефоны и переписка клиентов, то есть персональные данные.
   Без ADMIN_PASS панель открыта всем, кто дотянется до порта. */
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

app.use((req, res, next) => {
  // иконки и манифест телефон запрашивает без пароля — иначе не установить на экран «Домой»
  if (/^\/(manifest\.webmanifest|icon[\w-]*\.(png|svg)|healthz)$/.test(req.path)) return next();
  if (req.path === '/webhook') return next();          // вебхук провайдера — своя проверка
  if (!ADMIN_PASS) return next();                      // пароль не задан — не запираем
  const hdr = req.headers.authorization || '';
  const [user, pass] = Buffer.from(hdr.replace(/^Basic /i, ''), 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="CRM"').status(401).send('Требуется вход');
});

// без этого браузер держит старый app.js после обновления и показывает
// ошибки от кода, которого уже нет
// проверка живости для хостинга: без пароля и без подробностей
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res, file) => {
    if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
// файлы клиентов — под тем же паролем, что и вся админка
app.use('/media', express.static(path.join(process.cwd(), 'data', 'media')));

/* ─────────── Webhook: вход из WhatsApp ─────────── */

// Проверка подписки Meta (GET hub.challenge)
app.get('/webhook', (req, res) => {
  const q = req.query;
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === (process.env.META_VERIFY_TOKEN || 'test-token')) {
    return res.status(200).send(q['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // провайдеру отвечаем сразу, обработка — асинхронно
  try {
    for (const m of channel.parse(req.body)) await handleIncoming(m);
  } catch (e) {
    console.error('webhook error:', e);
  }
});

/* ─────────── API админки ─────────── */

app.get('/api/state', (req, res) => {
  res.json({
    channel: channel.name,
    channel_ready: channel.ready(),
    ai_configured: aiConfigured(),
    ai_label: aiLabel(),
    ai_global: getSetting('ai_global') === '1',
    system_prompt: getSetting('system_prompt'),
    greeting: getSetting('greeting'),
    blocked_numbers: getSetting('blocked_numbers'),
    manager_numbers: getSetting('manager_numbers'),
    notify_on: getSetting('notify_on') === '1',
    admin_url: getSetting('admin_url') || process.env.RENDER_EXTERNAL_URL || '',
    source_map: getSetting('source_map') || '',
    ai_effort: getSetting('ai_effort') || process.env.AI_EFFORT || 'low',
    stt_label: sttLabel(),
    nudge_on: getSetting('nudge_on') === '1',
    nudge_hours: getSetting('nudge_hours'),
    nudge_repeat_hours: getSetting('nudge_repeat_hours'),
    nudge_max: getSetting('nudge_max'),
    nudge_stale_hours: getSetting('nudge_stale_hours'),
    nudge_steps_ask: getSetting('nudge_steps_ask'),
    nudge_steps_quoted: getSetting('nudge_steps_quoted'),
    confirm_on: getSetting('confirm_on') === '1',
    confirm_eve_hour: getSetting('confirm_eve_hour'),
    confirm_morning_hour: getSetting('confirm_morning_hour'),
    manager_ping_hours: getSetting('manager_ping_hours'),
    stop_words: getSetting('stop_words'),
    business_facts: getSetting('business_facts'),
    price_list: getSetting('price_list') || JSON.stringify(priceList(), null, 2),
    reply_delay: getSetting('reply_delay'),
    company: getSetting('company'),
    timezone: scheduleSetting('timezone'),
    work_hours: workHours(),
    holidays: scheduleSetting('holidays'),
    off_hours: scheduleSetting('off_hours'),
    off_hours_note: scheduleSetting('off_hours_note'),
    autoclose_days: scheduleSetting('autoclose_days'),
    working_now: withinWorkHours(),
    ai_error: botState.lastAiError,
    wip_need: Number(getSetting('wip_need') ?? 5),
    quick_replies: getSetting('quick_replies') || ''
  });
});

app.post('/api/state', (req, res) => {
  if ('ai_global' in req.body) setSetting('ai_global', req.body.ai_global ? '1' : '0');
  if ('system_prompt' in req.body) setSetting('system_prompt', String(req.body.system_prompt));
  if ('greeting' in req.body) setSetting('greeting', String(req.body.greeting));
  if ('blocked_numbers' in req.body) setSetting('blocked_numbers', String(req.body.blocked_numbers));
  if ('manager_numbers' in req.body) setSetting('manager_numbers', String(req.body.manager_numbers));
  if ('notify_on' in req.body) setSetting('notify_on', req.body.notify_on ? '1' : '0');
  if ('admin_url' in req.body) setSetting('admin_url', String(req.body.admin_url).trim());
  if ('source_map' in req.body) setSetting('source_map', String(req.body.source_map));
  if ('ai_effort' in req.body) {
    const v = String(req.body.ai_effort).toLowerCase();
    if (!['low', 'medium', 'high'].includes(v)) return res.status(400).json({ error: 'Глубина: low, medium или high' });
    setSetting('ai_effort', v);
  }
  if ('nudge_on' in req.body) setSetting('nudge_on', req.body.nudge_on ? '1' : '0');
  if ('confirm_on' in req.body) setSetting('confirm_on', req.body.confirm_on ? '1' : '0');
  for (const k of ['nudge_steps_ask', 'nudge_steps_quoted', 'stop_words']) {
    if (k in req.body) setSetting(k, String(req.body[k]).trim());
  }
  for (const k of ['nudge_hours', 'nudge_repeat_hours', 'nudge_max', 'nudge_stale_hours',
    'confirm_eve_hour', 'confirm_morning_hour', 'manager_ping_hours']) {
    if (k in req.body) setSetting(k, String(Number(req.body[k]) || 0));
  }
  if ('business_facts' in req.body) setSetting('business_facts', String(req.body.business_facts));
  if ('reply_delay' in req.body) setSetting('reply_delay', String(Number(req.body.reply_delay) || 4000));
  if ('price_list' in req.body) {
    // сохраняем только валидный JSON, иначе бот останется без прайса
    try { JSON.parse(req.body.price_list); setSetting('price_list', String(req.body.price_list)); }
    catch { return res.status(400).json({ error: 'Прайс должен быть корректным JSON' }); }
  }
  if ('wip_need' in req.body) setSetting('wip_need', String(Number(req.body.wip_need) || 0));
  if ('quick_replies' in req.body) setSetting('quick_replies', String(req.body.quick_replies));
  if ('work_hours' in req.body) {
    try { setSetting('work_hours', JSON.stringify(req.body.work_hours)); }
    catch { return res.status(400).json({ error: 'Неверный формат часов' }); }
  }
  for (const k of ['company', 'timezone', 'holidays', 'off_hours', 'off_hours_note', 'autoclose_days']) {
    if (k in req.body) setSetting(k, String(req.body[k]));
  }
  emit('conversations', null);
  res.json({ ok: true });
});

app.get('/api/conversations', (req, res) => res.json(listConversations()));

/** Сводка по заявкам за период. Всё считается из тех же диалогов, без отдельной аналитики. */
app.get('/api/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = `-${days} days`;
  const rows = db.prepare("SELECT * FROM conversations WHERE created_at >= datetime('now', ?)").all(since);
  const leads = rows.map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }));

  const count = (fn) => leads.filter(fn).length;
  const group = (pick) => {
    const m = new Map();
    for (const c of leads) { const v = pick(c); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  // Деньги в трёх состояниях: что бот прикинул, о чём договорились, что получили.
  // Средний чек считаем по согласованным суммам — оценка бота это ещё не выручка.
  const totals = (nums) => ({ sum: nums.reduce((a, b) => a + b, 0), n: nums.length });
  const nums = (rows, pick) => rows.map(pick).map((v) => Number(String(v ?? '').replace(/[^\d]/g, '')))
    .filter((n) => n > 0);
  const money = {
    quoted: totals(nums(leads, (c) => c.l.price_quote)),
    agreed: totals(nums(leads, (c) => c.deal_sum)),
    paid: totals(nums(leads, (c) => c.paid_sum))
  };
  const avgCheck = money.agreed.n ? Math.round(money.agreed.sum / money.agreed.n) : 0;

  // время до первого ответа бота
  const react = db.prepare(`
    SELECT c.id,
      (SELECT min(created_at) FROM messages m WHERE m.conv_id=c.id AND m.direction='in')  AS first_in,
      (SELECT min(created_at) FROM messages m WHERE m.conv_id=c.id AND m.direction='out' AND m.author='ai') AS first_out
    FROM conversations c WHERE c.created_at >= datetime('now', ?)`).all(since)
    .filter((r) => r.first_in && r.first_out)
    // считаем в рабочих часах: ночная пауза — не медлительность бота.
    // медиана, а не среднее: один зависший диалог не должен красить всю картину
    .map((r) => workingSeconds(new Date(r.first_in + 'Z'), new Date(r.first_out + 'Z')))
    .filter((s) => s >= 0)
    .sort((a, b) => a - b);
  const avgReply = react.length ? Math.round(react[Math.floor(react.length / 2)]) : 0;

  const photos = db.prepare(`
    SELECT count(*) n FROM messages m JOIN conversations c ON c.id = m.conv_id
    WHERE m.media IS NOT NULL AND c.created_at >= datetime('now', ?)`).get(since).n;

  // ряд по дням: без него на сводке нечего рисовать, кроме полосок
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    byDay.push({
      d,
      n: leads.filter((c) => c.created_at.slice(0, 10) === d).length,
      won: leads.filter((c) => c.created_at.slice(0, 10) === d
        && ['готов к заказу', 'дата согласована'].includes(c.l.stage)).length
    });
  }

  // предыдущий такой же период — без сравнения число само по себе ничего не говорит
  const prevRows = db.prepare(`
    SELECT * FROM conversations
    WHERE created_at >= datetime('now', ?) AND created_at < datetime('now', ?)`)
    .all(`-${days * 2} days`, since)
    .map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }));
  const prevMoney = nums(prevRows, (c) => c.deal_sum);

  // сколько напоминаний ушло и сколько из них вернули клиента в разговор
  const nudgeSent = db.prepare(`
    SELECT count(*) n FROM messages
    WHERE kind IN ('nudge','followup','confirm') AND created_at >= datetime('now', ?)`).get(since).n;
  const nudgeReplied = db.prepare(`
    SELECT count(*) n FROM messages m
    WHERE m.kind IN ('nudge','followup','confirm') AND m.created_at >= datetime('now', ?)
      AND EXISTS (SELECT 1 FROM messages r WHERE r.conv_id = m.conv_id AND r.direction = 'in'
                  AND r.id > m.id AND r.created_at <= datetime(m.created_at, '+48 hours'))`).get(since).n;

  res.json({
    days,
    nudges: { sent: nudgeSent, replied: nudgeReplied },
    by_day: byDay,
    prev: {
      total: prevRows.length,
      agreed: prevRows.filter((c) => ['готов к заказу', 'дата согласована'].includes(c.l.stage)).length,
      avg_check: prevMoney.length ? Math.round(prevMoney.reduce((a, b) => a + b, 0) / prevMoney.length) : 0
    },
    total: leads.length,
    today: count((c) => c.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)),
    need_human: count((c) => c.needs_human),
    agreed: count((c) => ['готов к заказу', 'дата согласована'].includes(c.l.stage)),
    quoted: count((c) => c.l.price_quote),
    closed: count((c) => c.status === 'closed'),
    refused: count((c) => c.l.stage === 'отказ'),
    avg_check: avgCheck,
    money,
    avg_reply_sec: avgReply,
    photos,
    by_service: group((c) => c.l.service),
    by_district: group((c) => c.l.district).slice(0, 6),
    by_stage: group((c) => c.l.stage),
    by_source: group((c) => c.source || 'не определён')
  });
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(Number(req.params.id));
  if (!conv) return res.sendStatus(404);
  res.json({ ...conv, messages: history(conv.id, 200), quote: quote(JSON.parse(conv.lead || '{}')) });
});

/** Черновик ответа для менеджера: показать, но не отправлять. */
app.post('/api/conversations/:id/suggest', async (req, res) => {
  try {
    res.json({ text: await suggestReply(Number(req.params.id)) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * Правка карточки заявки руками. ИИ заполняет её из переписки, но ошибается
 * и не слышит того, что сказали по телефону, — последнее слово за менеджером.
 */
const LEAD_FIELDS = ['name', 'service', 'object_type', 'area_m2', 'rooms_count', 'bathrooms',
  'district', 'address', 'works', 'date', 'date_iso', 'time', 'windows', 'condition', 'price_quote', 'stage'];

app.post('/api/conversations/:id/lead', (req, res) => {
  const id = Number(req.params.id);
  const conv = getConversation(id);
  if (!conv) return res.sendStatus(404);

  const lead = JSON.parse(conv.lead || '{}');
  for (const k of LEAD_FIELDS) {
    if (k in req.body) {
      const v = String(req.body[k] ?? '').trim();
      if (v) lead[k] = v; else delete lead[k];
    }
  }
  if (lead.date_iso && !/^\d{4}-\d{2}-\d{2}$/.test(lead.date_iso)) {
    return res.status(400).json({ error: 'Дата должна быть в виде ГГГГ-ММ-ДД' });
  }

  // Запись на уборку подтверждает человек: дату из карточки бот только предлагает.
  // Поставили дату — заявка переходит в «дата согласована», сняли — возвращается.
  if ('job_date' in req.body || 'job_time' in req.body) {
    const jd = String(req.body.job_date ?? conv.job_date ?? '').trim();
    if (jd && !/^\d{4}-\d{2}-\d{2}$/.test(jd)) {
      return res.status(400).json({ error: 'Дата должна быть в виде ГГГГ-ММ-ДД' });
    }
    const jt = String(req.body.job_time ?? conv.job_time ?? '').trim();
    db.prepare('UPDATE conversations SET job_date=?, job_time=?, confirm_sent=CASE WHEN job_date IS ? THEN confirm_sent ELSE NULL END WHERE id=?')
      .run(jd || null, jt || null, jd || null, id);
    if (jd && lead.stage !== 'отказ') lead.stage = 'дата согласована';
    if (!jd && lead.stage === 'дата согласована') lead.stage = 'готов к заказу';
  }
  // Деньги проставляет человек: «согласовано» — то, о чём договорились,
  // «оплачено» — то, что реально получили. Оценка бота остаётся в карточке отдельно.
  for (const k of ['deal_sum', 'paid_sum']) {
    if (!(k in req.body)) continue;
    const n = Number(String(req.body[k] ?? '').replace(/[^\d]/g, ''));
    db.prepare(`UPDATE conversations SET ${k}=? WHERE id=?`).run(n > 0 ? n : null, id);
  }
  if ('paid_at' in req.body) {
    const d = String(req.body.paid_at ?? '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Дата оплаты — ГГГГ-ММ-ДД' });
    db.prepare('UPDATE conversations SET paid_at=? WHERE id=?').run(d || null, id);
  }
  // Напоминание можно поправить руками: клиент позвонил и перенёс сроки,
  // а бот об этом не знает — в переписке этого не было.
  if ('followup_at' in req.body || 'followup_note' in req.body) {
    const at = String(req.body.followup_at ?? conv.followup_at ?? '').trim();
    if (at && !/^\d{4}-\d{2}-\d{2}$/.test(at)) {
      return res.status(400).json({ error: 'Дата напоминания — ГГГГ-ММ-ДД' });
    }
    const note = String(req.body.followup_note ?? conv.followup_note ?? '').trim();
    db.prepare('UPDATE conversations SET followup_at=?, followup_note=?, nudges=0 WHERE id=?')
      .run(at || null, at ? (note || null) : null, id);
  }
  if ('source' in req.body) {
    db.prepare('UPDATE conversations SET source=? WHERE id=?').run(String(req.body.source ?? '').trim() || null, id);
  }
  db.prepare('UPDATE conversations SET lead=? WHERE id=?').run(JSON.stringify(lead), id);
  emit('conversations', null);
  res.json({ ...getConversation(id), quote: quote(lead) });
});

/** Внутренняя заметка менеджера — клиенту не уходит. */
app.post('/api/conversations/:id/note', (req, res) => {
  db.prepare('UPDATE conversations SET note=? WHERE id=?').run(String(req.body.note ?? ''), Number(req.params.id));
  emit('conversations', null);
  res.json({ ok: true });
});

/**
 * Что реально приходило с рекламы: по этому списку настраивается справочник
 * кампаний. Без него пришлось бы угадывать, как Meta называет объявление.
 */
app.get('/api/sources', (req, res) => {
  const rows = db.prepare(`
    SELECT source, source_title, source_url, source_ref, source_raw,
           count(*) n, max(created_at) last_at
    FROM conversations WHERE source IS NOT NULL
    GROUP BY source, source_title
    ORDER BY n DESC, last_at DESC LIMIT 40`).all();
  res.json(rows.map((r) => ({ ...r, raw: r.source_raw ? JSON.parse(r.source_raw) : null })));
});

/** Заказы с назначенной датой — для календаря. */
app.get('/api/holidays', (req, res) => res.json(holidays()));

const JOB_FIELDS = ['date', 'time', 'name', 'phone', 'service', 'area', 'district', 'price', 'note'];

/** Уборка, заведённая руками: клиент позвонил или пришёл по сарафану. */
app.post('/api/jobs', (req, res) => {
  const v = Object.fromEntries(JOB_FIELDS.map((k) => [k, String(req.body?.[k] ?? '').trim() || null]));
  if (!v.date || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
    return res.status(400).json({ error: 'Нужна дата в виде ГГГГ-ММ-ДД' });
  }
  const { lastInsertRowid } = db.prepare(`INSERT INTO jobs(${JOB_FIELDS.join(',')})
    VALUES(${JOB_FIELDS.map(() => '?').join(',')})`).run(...JOB_FIELDS.map((k) => v[k]));
  emit('conversations', null);
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(lastInsertRowid));
});

app.post('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!cur) return res.sendStatus(404);
  const v = Object.fromEntries(JOB_FIELDS.map((k) =>
    [k, (k in req.body ? String(req.body[k] ?? '').trim() : cur[k]) || null]));
  if (!v.date || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
    return res.status(400).json({ error: 'Нужна дата в виде ГГГГ-ММ-ДД' });
  }
  db.prepare(`UPDATE jobs SET ${JOB_FIELDS.map((k) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...JOB_FIELDS.map((k) => v[k]), id);
  emit('conversations', null);
  res.json(db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
});

app.delete('/api/jobs/:id', (req, res) => {
  db.prepare('DELETE FROM jobs WHERE id=?').run(Number(req.params.id));
  emit('conversations', null);
  res.json({ ok: true });
});

app.get('/api/schedule', (req, res) => {
  // в расписание попадает только подтверждённая запись (job_date), а не
  // пожелание клиента из карточки: «хочу в субботу» — это ещё не заказ
  const rows = db.prepare("SELECT * FROM conversations WHERE status != 'closed' AND job_date IS NOT NULL AND job_date != ''").all()
    .map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.job_date || ''))
    .map((c) => ({
      id: c.id, phone: c.phone, name: c.l.name || c.name, date: c.job_date, time: c.job_time || '',
      service: c.l.service || '', area: c.l.area_m2 || '', district: c.l.district || '',
      price: c.l.price_quote || '', stage: c.l.stage || '', confirmed: true,
      holiday: Boolean(isHoliday(c.job_date))
    }))
    .map((r) => ({ ...r, kind: 'conv' }));

  // уборки, заведённые руками — их в переписке нет
  const manual = db.prepare('SELECT * FROM jobs').all().map((j) => ({
    id: j.id, kind: 'manual', phone: j.phone || '', name: j.name || '',
    date: j.date, time: j.time || '', service: j.service || '', area: j.area || '',
    district: j.district || '', price: j.price || '', note: j.note || '',
    stage: '', confirmed: true, holiday: Boolean(isHoliday(j.date))
  }));

  // пожелания клиентов: дата названа боту, но менеджер её ещё не подтвердил.
  // Показываем в календаре отдельно — чтобы день не выглядел свободным
  const wishes = db.prepare("SELECT * FROM conversations WHERE status != 'closed' AND (job_date IS NULL OR job_date = '')").all()
    .map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.l.date_iso || '') && c.l.stage !== 'отказ')
    .map((c) => ({
      id: c.id, kind: 'wish', phone: c.phone, name: c.l.name || c.name, date: c.l.date_iso,
      time: c.l.time || '', service: c.l.service || '', area: c.l.area_m2 || '',
      district: c.l.district || '', price: c.l.price_quote || '', stage: c.l.stage || '',
      confirmed: false, holiday: Boolean(isHoliday(c.l.date_iso))
    }));

  res.json([...rows, ...manual, ...wishes]
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)));
});

app.post('/api/conversations/:id/read', (req, res) => {
  db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run(Number(req.params.id));
  emit('conversations', null);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/send', async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  try {
    res.json(await sendAsHuman(Number(req.params.id), text, Boolean(req.body.keep_ai)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Перехват / возврат ИИ
app.post('/api/conversations/:id/mode', (req, res) => {
  const id = Number(req.params.id);
  const ai = Boolean(req.body.ai_enabled);
  // вернули боту — значит передачу отработали: следующее уведомление снова придёт
  db.prepare('UPDATE conversations SET ai_enabled=?, status=?, needs_human=0, handoff_reason=NULL, notified_at=NULL WHERE id=?')
    .run(ai ? 1 : 0, ai ? 'ai' : 'human', id);
  addMessage(id, { direction: 'out', author: 'system', body: ai ? 'ИИ снова ведёт диалог' : 'Диалог перехвачен менеджером' });
  emit('conversations', null);
  emit('message', { conv_id: id });
  res.json(getConversation(id));
});

/**
 * Перевод заявки между колонками доски. Колонка — это не отдельное поле,
 * а комбинация владельца диалога (ИИ или человек) и стадии воронки,
 * поэтому раскладываем её здесь, в одном месте.
 */
const COLUMN_ACTIONS = {
  need:    { ai: 0, status: 'human', needs: 1, reason: 'передано менеджеру вручную' },
  // возврат в работу откатывает и стадию: иначе карточка со стадией «договорились»
  // осталась бы в своей колонке и перетаскивание выглядело бы сломанным
  manager: { ai: 0, status: 'human', needs: 0, stage: 'уточняем' },
  ai:      { ai: 1, status: 'ai',    needs: 0, stage: 'уточняем' },
  quoted:  { stage: 'назвали цену' },
  agreed:  { stage: 'дата согласована' },
  closed:  { status: 'closed' }
};

app.post('/api/conversations/:id/column', (req, res) => {
  const id = Number(req.params.id);
  const act = COLUMN_ACTIONS[String(req.body.column)];
  if (!act) return res.status(400).json({ error: 'Неизвестная колонка' });

  const conv = getConversation(id);
  if (!conv) return res.sendStatus(404);

  if ('ai' in act) {
    db.prepare('UPDATE conversations SET ai_enabled=?, status=?, needs_human=?, handoff_reason=? WHERE id=?')
      .run(act.ai, act.status, act.needs, act.reason ?? null, id);
  }
  if (act.status === 'closed') {
    db.prepare("UPDATE conversations SET status='closed' WHERE id=?").run(id);
  }
  if (act.stage) {
    // стадия живёт внутри карточки заявки — её же заполняет ИИ
    const lead = { ...JSON.parse(conv.lead || '{}'), stage: act.stage };
    db.prepare('UPDATE conversations SET lead=? WHERE id=?').run(JSON.stringify(lead), id);
    // вернуть из «закрыто» обратно в работу
    if (conv.status === 'closed') db.prepare("UPDATE conversations SET status='human' WHERE id=?").run(id);
  }
  emit('conversations', null);
  res.json(getConversation(id));
});

app.post('/api/conversations/:id/status', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE conversations SET status=? WHERE id=?').run(String(req.body.status), id);
  emit('conversations', null);
  res.json(getConversation(id));
});

/* ─────────── Симулятор клиента ─────────── */
/**
 * Стереть переписку и заявки перед запуском рекламы. Настройки, прайс и
 * привязка WhatsApp остаются — иначе после сброса бота пришлось бы настраивать заново.
 */
app.post('/api/maintenance/reset', (req, res) => {
  if (String(req.body?.confirm ?? '') !== 'СТЕРЕТЬ') {
    return res.status(400).json({ error: 'Не подтверждено' });
  }
  const gone = resetData();
  emit('conversations', null);
  console.log(`Данные стёрты: диалогов ${gone.conversations}, сообщений ${gone.messages}, файлов ${gone.files}`);
  res.json(gone);
});

app.post('/api/sim/incoming', async (req, res) => {
  const { from, name, text, image } = req.body || {};
  if (!from || (!text && !image)) return res.status(400).json({ error: 'нужен текст или фото' });

  let media = [];
  if (image) {
    // mime у голосовых идёт с кодеком: «audio/ogg; codecs=opus»
    const m = /^data:([^,]+?);base64,(.+)$/s.exec(image);
    if (!m) return res.status(400).json({ error: 'фото должно быть data-URL' });
    const kind = m[1].startsWith('video/') ? 'video' : m[1].startsWith('audio/') ? 'audio' : 'image';
    media = [await saveMedia(Buffer.from(m[2], 'base64'), m[1], kind)];
  }
  // симулятор всегда пишет в канал mock — ответ никуда наружу не уходит,
  // даже когда боевой WhatsApp подключён
  await handleIncoming({ phone: String(from), name: name || null, text: String(text || ''), media,
    wa_id: 'sim-' + Date.now(), ref: req.body.ref || null }, channels.mock);
  const conv = db.prepare('SELECT * FROM conversations WHERE channel=? AND phone=?').get('mock', String(from));
  res.json({ ok: true, conv_id: conv?.id, messages: conv ? history(conv.id, 200) : [] });
});

/* ─────────── Live-обновления ─────────── */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  const off = subscribe((event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`));
  const offWa = onStatus((st) => res.write(`event: wa\ndata: ${JSON.stringify(st)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { off(); offWa(); clearInterval(ping); });
});

/* ─────────── Состояние подключения WhatsApp (QR для baileys) ─────────── */
app.get('/api/wa/status', (req, res) => {
  res.json(channel.name === 'baileys' ? waStatus() : { state: channel.ready() ? 'online' : 'not_configured', qr: null });
});

/* Управление привязкой: код по номеру (когда QR не отсканировать), отвязка, переподключение */
const onlyBaileys = (fn) => async (req, res) => {
  if (channel.name !== 'baileys') return res.status(400).json({ error: 'Привязка номера доступна только для CHANNEL=baileys' });
  try { res.json((await fn(req)) ?? { ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
};
app.post('/api/wa/pair', onlyBaileys(async (req) => ({ code: await requestPairing(req.body?.phone) })));
app.post('/api/wa/logout', onlyBaileys(() => waLogout()));
app.post('/api/wa/restart', onlyBaileys(() => waRestart()));

/* Сторож связи. Клиент не должен узнавать о том, что бот отключился, раньше нас:
   сообщения в это время копятся на стороне WhatsApp и приходят пачкой через часы. */
let offlineSince = null, warnedAt = 0, restartedAt = 0;
setInterval(() => {
  if (channel.name !== 'baileys') return;
  const st = waStatus();
  if (st.state === 'online') {
    if (offlineSince) console.log('WhatsApp снова в сети');
    offlineSince = null; warnedAt = 0; restartedAt = 0;
    return;
  }
  offlineSince ??= Date.now();
  const mins = Math.round((Date.now() - offlineSince) / 6e4);
  if (mins >= 10 && Date.now() - warnedAt > 36e5) {
    warnedAt = Date.now();
    notifyManagers(`⚠️ WhatsApp не в сети ${mins} мин (${st.state}). Бот не отвечает клиентам.`
      + (st.qr ? ' Нужна новая привязка номера.' : '')).catch(() => {});
  }
  // разлогин чинится только новым QR, перезапуск тут не поможет
  if (mins >= 15 && !st.qr && st.state !== 'logged_out' && Date.now() - restartedAt > 18e5) {
    restartedAt = Date.now();
    console.log('WhatsApp: перезапускаем подключение');
    waRestart().catch((e) => console.error('перезапуск подключения:', e.message));
  }
}, 6e4).unref?.();

app.listen(PORT, async () => {
  console.log(`\n  Админка:    http://localhost:${PORT}`);
  console.log(`  Симулятор:  http://localhost:${PORT}/sim.html`);
  console.log(`  Webhook:    POST http://localhost:${PORT}/webhook`);
  if (!ADMIN_PASS) console.log('  ⚠ ADMIN_PASS не задан — админка открыта без пароля\n');
  console.log(`  Канал: ${channel.name} | ИИ: ${aiLabel()}\n`);

  // каналы, которые держат постоянное соединение (baileys), поднимаются здесь
  if (channel.init) {
    try {
      await channel.init(handleIncoming);
    } catch (e) {
      console.error('Не удалось поднять канал ' + channel.name + ':', e.message);
    }
  }
});
