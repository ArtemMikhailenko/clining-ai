import express from 'express';
import path from 'node:path';
import { db, listConversations, getConversation, history, getSetting, setSetting, addMessage } from './db.js';
import { handleIncoming, sendAsHuman, suggestReply, subscribe, emit } from './bot.js';
import * as botState from './bot.js';
import { channel, channels } from './channels/index.js';
import { saveMedia } from './media.js';
import { withinWorkHours, scheduleSetting, workHours, holidays, isHoliday } from './schedule.js';
import { quote, priceList } from './pricing.js';
import { waStatus, onStatus, requestPairing, logout as waLogout, restart as waRestart } from './channels/baileys.js';
import { aiConfigured, aiLabel } from './ai.js';

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

  // средний названный чек: из строк вида «от 2250 ₪» берём число
  const money = leads.map((c) => Number(String(c.l.price_quote || '').replace(/[^\d]/g, '')))
    .filter((n) => n > 0);
  const avgCheck = money.length ? Math.round(money.reduce((a, b) => a + b, 0) / money.length) : 0;

  // время до первого ответа бота
  const react = db.prepare(`
    SELECT c.id,
      (SELECT min(created_at) FROM messages m WHERE m.conv_id=c.id AND m.direction='in')  AS first_in,
      (SELECT min(created_at) FROM messages m WHERE m.conv_id=c.id AND m.direction='out' AND m.author='ai') AS first_out
    FROM conversations c WHERE c.created_at >= datetime('now', ?)`).all(since)
    .filter((r) => r.first_in && r.first_out)
    .map((r) => (new Date(r.first_out + 'Z') - new Date(r.first_in + 'Z')) / 1000)
    .filter((s) => s >= 0);
  const avgReply = react.length ? Math.round(react.reduce((a, b) => a + b, 0) / react.length) : 0;

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
  const prevMoney = prevRows.map((c) => Number(String(c.l.price_quote || '').replace(/[^\d]/g, ''))).filter((n) => n > 0);

  res.json({
    days,
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
    avg_reply_sec: avgReply,
    photos,
    by_service: group((c) => c.l.service),
    by_district: group((c) => c.l.district).slice(0, 6),
    by_stage: group((c) => c.l.stage)
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

/** Заказы с назначенной датой — для календаря. */
app.get('/api/holidays', (req, res) => res.json(holidays()));

app.get('/api/schedule', (req, res) => {
  const rows = db.prepare("SELECT * FROM conversations WHERE status != 'closed'").all()
    .map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }))
    .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.l.date_iso || ''))
    .map((c) => ({
      id: c.id, phone: c.phone, name: c.l.name || c.name, date: c.l.date_iso, time: c.l.time || '',
      service: c.l.service || '', area: c.l.area_m2 || '', district: c.l.district || '',
      price: c.l.price_quote || '', stage: c.l.stage || '', confirmed: c.status === 'human',
      holiday: Boolean(isHoliday(c.l.date_iso))
    }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(rows);
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
  db.prepare('UPDATE conversations SET ai_enabled=?, status=?, needs_human=0, handoff_reason=NULL WHERE id=?')
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
app.post('/api/sim/incoming', async (req, res) => {
  const { from, name, text, image } = req.body || {};
  if (!from || (!text && !image)) return res.status(400).json({ error: 'нужен текст или фото' });

  let media = [];
  if (image) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(image);
    if (!m) return res.status(400).json({ error: 'фото должно быть data-URL' });
    media = [await saveMedia(Buffer.from(m[2], 'base64'), m[1], m[1].startsWith('video/') ? 'video' : 'image')];
  }
  // симулятор всегда пишет в канал mock — ответ никуда наружу не уходит,
  // даже когда боевой WhatsApp подключён
  await handleIncoming({ phone: String(from), name: name || null, text: String(text || ''), media, wa_id: 'sim-' + Date.now() }, channels.mock);
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
