import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { db, listConversations, getConversation, history, getSetting, setSetting, addMessage, resetData, applyStage, audit,
  waitsMedia, logAccess, assertHumanWrite } from './db.js';
import { stageIndex, amountOf, STAGE_TITLE, CLOSE_TITLE } from './stages.js';
import { handleIncoming, sendAsHuman, suggestReply, subscribe, emit } from './bot.js';
import * as botState from './bot.js';
import { channel, channels } from './channels/index.js';
import { saveMedia } from './media.js';
import { withinWorkHours, scheduleSetting, workHours, holidays, isHoliday, workingSeconds } from './schedule.js';
import { quote, priceList } from './pricing.js';
import { waStatus, onStatus, requestPairing, logout as waLogout, restart as waRestart } from './channels/baileys.js';
import { sttLabel } from './stt.js';
import { notifyManagers, adminLink, localTime } from './notify.js';
import { annotate, setNext, controlDay, startControl } from './control.js';
import { runAs } from './context.js';
import { ADMIN, authEnabled, sessionUser, basicUser, readCookie, setCookie, login, logout, changeOwnPassword,
  setPassword, dropSessions, recUrl, recValid } from './auth.js';
import { listFailures, retryNow, startRetries } from './integrations.js';
import { buildReport, leadList } from './report.js';
import { syncMeta, metaStatus, startMeta, accountId as metaAccount } from './meta.js';
import { ATTR_TITLE, PLATFORM_TITLE } from './attribution.js';
import { localDate } from './schedule.js';
import { listManagers, saveManager, deleteManager, getManager, setManager, assignHandoff, clearCallDue,
  listCalls, logCall, saveRecording, sweepRecordings, overdueCalls, CALL_STATUS, recordingFile, deleteRecording,
  restoreRecording, purgeTrash } from './calls.js';
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

/* ─────────── Доступ в админку (ТЗ §4.3, этап 3) ───────────
   В базе — телефоны и переписка клиентов, то есть персональные данные.
   У каждого менеджера свой вход; администратор из ADMIN_USER / ADMIN_PASS —
   аварийный вход с правами владельца. Пароля нет нигде — админка открыта,
   как раньше (только для разработки). */
const PUBLIC = /^\/(manifest\.webmanifest|icon[\w-]*\.(png|svg)|healthz|login\.html|api\/login|webhook)$/;
app.set('trust proxy', 1);                 // Render отдаёт https через прокси: нужно для Secure-cookie

app.use((req, res, next) => {
  if (PUBLIC.test(req.path)) return next();
  const user = authEnabled() ? (sessionUser(readCookie(req)) || basicUser(req)) : ADMIN;
  if (!user) {
    if (/^\/(api|media|rec)\//.test(req.path)) return res.status(401).json({ error: 'Нужно войти', login: true });
    return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
  }
  req.user = user;
  runAs(user, next);
});

/* Права (ТЗ §4.3). Владелец может всё; менеджер работает с заявками, но
   настройки, учётки, журналы, удаление и обслуживание — только владельцу.
   Чужую заявку менеджер сначала берёт себе — это видно в журнале. */
const OWNER_ONLY = [
  ['POST', /^\/api\/state$/], ['POST', /^\/api\/managers$/], ['DELETE', /^\/api\/managers\/\d+$/],
  ['*', /^\/api\/maintenance\//], ['POST', /^\/api\/wa\/(pair|logout|restart)$/], ['POST', /^\/api\/sim\//],
  ['GET', /^\/api\/logs\//], ['POST', /^\/api\/logs\//], ['POST', /^\/api\/conversations\/\d+\/(delete|restore)$/],
  ['GET', /^\/api\/conversations\/deleted$/], ['*', /^\/api\/calls\/\d+\/recording/],
  ['*', /^\/api\/report/], ['*', /^\/api\/meta\//], ['*', /^\/api\/spend/]
];
const CONV_WRITE = /^\/api\/conversations\/(\d+)\/(lead|note|send|mode|stage|flag|reviewed|next|calls|status)$/;

app.use((req, res, next) => {
  const u = req.user;
  if (!u || u.role === 'owner') return next();
  // автоответы ИИ менеджер может включить и выключить сам — это работа, а не настройка
  const aiToggle = req.path === '/api/state' && Object.keys(req.body || {}).join() === 'ai_global';
  if (!aiToggle && OWNER_ONLY.some(([m, re]) => (m === '*' || m === req.method) && re.test(req.path))) {
    return res.status(403).json({ error: 'Это может только владелец' });
  }
  const w = req.method === 'POST' && CONV_WRITE.exec(req.path);
  if (w) {
    const conv = getConversation(Number(w[1]));
    if (conv?.manager_id && conv.manager_id !== u.id) {
      const who = getManager(conv.manager_id)?.name || 'другой менеджер';
      return res.status(403).json({ error: `Заявку ведёт ${who}. Чтобы работать с ней, нажмите «Взять себе»`, take: true });
    }
    // оплаченная сделка — итог для отчётов: исправляет её только владелец
    if (conv?.close_reason === 'paid' && ['lead', 'stage'].includes(w[2])) {
      return res.status(403).json({ error: 'Оплаченную сделку исправляет владелец' });
    }
  }
  next();
});

app.post('/api/login', (req, res) => {
  try {
    const { token, user } = login(req.body?.login, req.body?.password, { ip: req.ip, ua: req.headers['user-agent'] });
    setCookie(req, res, token);
    res.json({ user });
  } catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/api/logout', (req, res) => {
  logAccess('logout', { ip: req.ip });
  logout(readCookie(req));
  setCookie(req, res, null);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ ...req.user, auth: authEnabled() }));
app.post('/api/me/password', (req, res) => {
  try {
    changeOwnPassword(req.user, req.body?.old, req.body?.password);
    // смена пароля выкидывает все сессии — эту открываем заново
    const { token } = login(req.user.login, req.body?.password, { ip: req.ip, ua: req.headers['user-agent'] });
    setCookie(req, res, token);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
// файлы клиентов — под тем же входом, что и вся админка. Записи разговоров
// отдельно: только по подписанной ссылке, и каждое прослушивание в журнале
app.use('/media/calls', (req, res) => res.sendStatus(404));
app.use('/media', express.static(path.join(process.cwd(), 'data', 'media')));
app.get('/rec/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!recValid(id, req.query.exp, req.query.sig)) return res.status(403).send('Ссылка устарела — откройте карточку заново');
  const r = recordingFile(id);
  if (!r) return res.sendStatus(404);
  // плеер дочитывает файл кусками — в журнал пишем только начало прослушивания
  const range = String(req.headers.range || '');
  if (!range || /^bytes=0-/.test(range)) logAccess('recording_listen', { object: 'call', objectId: id, ip: req.ip });
  res.sendFile(r.file);
});

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
    media_required: getSetting('media_required') || '',
    call_sla_min: Number(getSetting('call_sla_min')) || 5,
    rec_max_mb: Number(getSetting('rec_max_mb')) || 50,
    rec_keep_days: Number(getSetting('rec_keep_days')) || 0,
    offer_wait_hours: Number(getSetting('offer_wait_hours')) || 48,
    media_wait_hours: Number(getSetting('media_wait_hours')) || 24,
    evening_report: getSetting('evening_report') === '1',
    managers: listManagers(),
    me: req.user,
    me_auth: authEnabled(),
    meta_ad_account: getSetting('meta_ad_account') || '',
    meta_account: metaAccount(),
    meta_spend_since: getSetting('meta_spend_since') || '',
    amounts_with_vat: (getSetting('amounts_with_vat') ?? '1') === '1',
    vat_rate: Number(getSetting('vat_rate')) || 18,
    attr_title: ATTR_TITLE, platform_title: PLATFORM_TITLE,
    call_status: CALL_STATUS,
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
  if ('media_required' in req.body) setSetting('media_required', String(req.body.media_required));
  if ('evening_report' in req.body) setSetting('evening_report', req.body.evening_report ? '1' : '0');
  if ('amounts_with_vat' in req.body) setSetting('amounts_with_vat', req.body.amounts_with_vat ? '1' : '0');
  if ('vat_rate' in req.body) setSetting('vat_rate', String(Math.min(30, Math.max(0, Number(req.body.vat_rate) || 0))));
  if ('meta_ad_account' in req.body) setSetting('meta_ad_account', String(req.body.meta_ad_account || '').trim().replace(/^act_/, ''));
  if ('meta_spend_since' in req.body) {
    const d = String(req.body.meta_spend_since || '').trim();
    if (!d || /^\d{4}-\d{2}-\d{2}$/.test(d)) setSetting('meta_spend_since', d);
  }
  for (const [k, lo, hi] of [['call_sla_min', 1, 240], ['rec_max_mb', 1, 200], ['rec_keep_days', 0, 3650],
    ['offer_wait_hours', 1, 720], ['media_wait_hours', 1, 720]]) {
    if (k in req.body) setSetting(k, String(Math.min(hi, Math.max(lo, Math.round(Number(req.body[k]) || 0)))));
  }
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

app.get('/api/conversations/deleted', (req, res) => {
  res.json(db.prepare(`SELECT id, phone, name, lead, stage, close_reason, deleted_at, deleted_by, delete_reason
    FROM conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).all());
});
app.get('/api/conversations', (req, res) => res.json(annotate(listConversations())));

/** Сводка по заявкам за период. Всё считается из тех же диалогов, без отдельной аналитики. */
app.get('/api/stats', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = `-${days} days`;
  const rows = db.prepare("SELECT * FROM conversations WHERE deleted_at IS NULL AND created_at >= datetime('now', ?)").all(since);
  const leads = rows.map((c) => ({ ...c, l: JSON.parse(c.lead || '{}') }));

  const count = (fn) => leads.filter(fn).length;
  // «дошла до этапа» — значит стоит на нём или прошла дальше, включая оплаченные
  const reached = (c, stage) => c.close_reason === 'paid'
    || (c.stage !== 'closed' && stageIndex(c.stage) >= stageIndex(stage));
  const stageName = (c) => (c.stage === 'closed' ? 'Закрыто · ' + (CLOSE_TITLE[c.close_reason] || '—') : STAGE_TITLE[c.stage || 'new']);
  const group = (pick) => {
    const m = new Map();
    for (const c of leads) { const v = pick(c); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  // Деньги в трёх состояниях: что бот прикинул, о чём договорились, что получили.
  // Средний чек считаем по согласованным суммам — оценка бота это ещё не выручка.
  const totals = (nums) => ({ sum: nums.reduce((a, b) => a + b, 0), n: nums.length });
  // суммы разбираем аккуратно: «от 20 ₪/м², минимум 1500 ₪» — это 1500, а не 201 500
  const nums = (rows, pick) => rows.map(pick).map(amountOf).filter((n) => n > 0);
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
    FROM conversations c WHERE c.deleted_at IS NULL AND c.created_at >= datetime('now', ?)`).all(since)
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
      won: leads.filter((c) => c.created_at.slice(0, 10) === d && reached(c, 'agreed')).length
    });
  }

  // предыдущий такой же период — без сравнения число само по себе ничего не говорит
  const prevRows = db.prepare(`
    SELECT * FROM conversations
    WHERE deleted_at IS NULL AND created_at >= datetime('now', ?) AND created_at < datetime('now', ?)`)
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
      agreed: prevRows.filter((c) => reached(c, 'agreed')).length,
      avg_check: prevMoney.length ? Math.round(prevMoney.reduce((a, b) => a + b, 0) / prevMoney.length) : 0
    },
    total: leads.length,
    today: count((c) => c.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)),
    need_human: count((c) => c.needs_human),
    agreed: count((c) => reached(c, 'agreed')),
    quoted: count((c) => reached(c, 'offer')),
    paid: count((c) => c.close_reason === 'paid'),
    closed: count((c) => c.status === 'closed'),
    refused: count((c) => c.close_reason === 'lost'),
    review: count((c) => c.review),
    avg_check: avgCheck,
    money,
    avg_reply_sec: avgReply,
    photos,
    by_service: group((c) => c.l.service),
    by_district: group((c) => c.l.district).slice(0, 6),
    by_stage: group(stageName),
    by_source: group((c) => c.source || 'не определён')
  });
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = getConversation(Number(req.params.id));
  if (!conv) return res.sendStatus(404);
  conv.last_in_at = db.prepare("SELECT max(created_at) t FROM messages WHERE conv_id=? AND direction='in'").get(conv.id).t;
  conv.wait_media = waitsMedia(conv);
  annotate([conv]);
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
  const stageMoves = [];
  try {
    // окончательная цена, дата работ и оплата — только от человека (ТЗ §4.3)
    for (const k of ['job_date', 'job_time', 'deal_sum', 'paid_sum', 'paid_at']) if (k in req.body) assertHumanWrite(k);
  } catch (e) { return res.status(403).json({ error: e.message }); }
  // источник — атрибуция рекламы: менять можно, но только с причиной (ТЗ §4.3, §5.1)
  if ('source' in req.body && String(req.body.source ?? '').trim() !== String(conv.source ?? '')
      && !String(req.body.source_reason ?? '').trim()) {
    return res.status(400).json({ error: 'Укажите причину смены источника', need_reason: 'source' });
  }
  for (const k of LEAD_FIELDS) {
    if (k in req.body) {
      const v = String(req.body[k] ?? '').trim();
      if (String(lead[k] ?? '') !== v) audit('lead', id, 'lead.' + k, lead[k] ?? null, v || null, 'менеджер');
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
    audit('lead', id, 'job_date', [conv.job_date, conv.job_time].filter(Boolean).join(' ') || null,
      [jd, jt].filter(Boolean).join(' ') || null, 'менеджер');
    if (jd && lead.stage !== 'отказ') lead.stage = 'дата согласована';
    if (!jd && lead.stage === 'дата согласована') lead.stage = 'готов к заказу';
    stageMoves.push(jd ? ['agreed', 'менеджер поставил дату записи'] : null);
  }
  // Деньги проставляет человек: «согласовано» — то, о чём договорились,
  // «оплачено» — то, что реально получили. Оценка бота остаётся в карточке отдельно.
  for (const k of ['deal_sum', 'paid_sum']) {
    if (!(k in req.body)) continue;
    const n = Number(String(req.body[k] ?? '').replace(/[^\d]/g, ''));
    db.prepare(`UPDATE conversations SET ${k}=? WHERE id=?`).run(n > 0 ? n : null, id);
    audit('lead', id, k, conv[k], n > 0 ? n : null, 'менеджер');
    // окончательная цена от менеджера — это и есть «предложение отправлено»;
    // оплата закрывает сделку как оплаченную
    if (k === 'deal_sum' && n > 0) stageMoves.push(['offer', 'менеджер назвал окончательную цену']);
    if (k === 'paid_sum' && n > 0) stageMoves.push(['closed:paid', 'внесена оплата']);
  }
  if ('paid_at' in req.body) {
    const d = String(req.body.paid_at ?? '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'Дата оплаты — ГГГГ-ММ-ДД' });
    db.prepare('UPDATE conversations SET paid_at=? WHERE id=?').run(d || null, id);
    audit('lead', id, 'paid_at', conv.paid_at, d || null, 'менеджер');
  }
  // Напоминание можно поправить руками: клиент позвонил и перенёс сроки,
  // а бот об этом не знает — в переписке этого не было.
  if ('followup_who' in req.body) {
    const w = String(req.body.followup_who ?? '').trim();
    db.prepare('UPDATE conversations SET followup_who=? WHERE id=?').run(w === 'manager' ? 'manager' : null, id);
  }
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
    // source_raw (что прислала Meta) не трогаем никогда — правится только отображаемое имя
    const src = String(req.body.source ?? '').trim() || null;
    db.prepare('UPDATE conversations SET source=? WHERE id=?').run(src, id);
    const why = String(req.body.source_reason ?? '').trim() || null;
    audit('lead', id, 'source', conv.source, src, 'менеджер', why);
    // источник указал человек — атрибуция «вручную»; что прислала Meta, остаётся в source_raw
    if (src !== (conv.source ?? null)) {
      db.prepare("UPDATE conversations SET attr_status='manual', attr_reason=? WHERE id=?").run(why, id);
      audit('lead', id, 'attr_status', conv.attr_status, 'manual', 'менеджер', why);
    }
  }
  db.prepare('UPDATE conversations SET lead=? WHERE id=?').run(JSON.stringify(lead), id);

  // этап двигается только вперёд: поставили цену на уже согласованной заявке —
  // она не откатывается в «предложение»
  for (const move of stageMoves.filter(Boolean)) {
    const cur = getConversation(id);
    const [to, close] = move[0].split(':');
    const ahead = to === 'closed' || cur.stage === 'closed' || stageIndex(to) > stageIndex(cur.stage);
    if (ahead && !(cur.stage === 'closed' && cur.close_reason === 'paid')) {
      applyStage(id, to, { close: close || null, actor: 'менеджер', why: move[1] });
    }
  }
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
  const rows = db.prepare("SELECT * FROM conversations WHERE deleted_at IS NULL AND status != 'closed' AND job_date IS NOT NULL AND job_date != ''").all()
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
  const wishes = db.prepare("SELECT * FROM conversations WHERE deleted_at IS NULL AND status != 'closed' AND (job_date IS NULL OR job_date = '')").all()
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
  if (ai) clearCallDue(id, 'менеджер', 'диалог вернули боту');
  addMessage(id, { direction: 'out', author: 'system', body: ai ? 'ИИ снова ведёт диалог' : 'Диалог перехвачен менеджером' });
  emit('conversations', null);
  emit('message', { conv_id: id });
  res.json(getConversation(id));
});

/**
 * Смена этапа вручную (ТЗ §3). Проигранной сделке нужна причина — без неё
 * сервер отказывает, иначе отчёт по потерям пустой. Ручная смена этапа
 * означает, что менеджер посмотрел заявку, поэтому пометка «проверить» снимается.
 */
app.post('/api/conversations/:id/stage', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.sendStatus(404);
  try {
    applyStage(id, String(req.body.stage), {
      close: req.body.close ?? null, lostReason: req.body.reason ?? null, actor: 'менеджер', why: req.body.reason ?? null
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  db.prepare('UPDATE conversations SET review=NULL WHERE id=?').run(id);
  emit('conversations', null);
  res.json(getConversation(id));
});

/** Флаг «нужен менеджер» — признак, а не этап: ставится и снимается отдельно. */
app.post('/api/conversations/:id/flag', (req, res) => {
  const id = Number(req.params.id);
  const conv = getConversation(id);
  if (!conv) return res.sendStatus(404);
  const on = Boolean(req.body.needs_human);
  db.prepare('UPDATE conversations SET needs_human=?, handoff_reason=? WHERE id=?')
    .run(on ? 1 : 0, on ? (conv.handoff_reason || 'передано менеджеру вручную') : null, id);
  audit('lead', id, 'needs_human', conv.needs_human, on ? 1 : 0, 'менеджер');
  if (on) assignHandoff(id, { actor: 'менеджер', why: 'отмечено вручную' });
  else clearCallDue(id, 'менеджер', 'флаг «нужен менеджер» снят');
  emit('conversations', null);
  res.json(getConversation(id));
});

/** Пометка «проверить после переноса» снята — заявку посмотрели. */
app.post('/api/conversations/:id/reviewed', (req, res) => {
  const id = Number(req.params.id);
  const conv = getConversation(id);
  if (!conv) return res.sendStatus(404);
  db.prepare('UPDATE conversations SET review=NULL WHERE id=?').run(id);
  audit('lead', id, 'review', conv.review, null, 'менеджер');
  emit('conversations', null);
  res.json(getConversation(id));
});

/** История этапов и ключевых полей — для карточки. */
/**
 * Единая история карточки (ТЗ §4.2): изменения полей, звонки, системные события
 * и — по желанию — переписка. Каждая запись с автором и временем.
 */
app.get('/api/conversations/:id/timeline', (req, res) => {
  const id = Number(req.params.id);
  const items = [];
  for (const a of db.prepare("SELECT * FROM audit_log WHERE entity='lead' AND entity_id=?").all(id)) {
    items.push({ at: a.at, type: 'change', field: a.field, old: a.old_value, new: a.new_value, who: a.actor, reason: a.reason });
  }
  for (const k of listCalls(id, signRecUrl)) {
    items.push({ at: k.at, type: 'call', status: CALL_STATUS[k.status] || k.status, who: k.actor || k.manager_name,
      duration: k.duration_sec, outcome: k.outcome, next: k.next_call_at, rec_url: k.rec_url,
      rec_deleted: k.rec_deleted_at ? `удалена: ${k.rec_deleted_by || ''}` : null, no_rec: k.no_record_reason, call_id: k.id });
  }
  const withMsgs = req.query.messages === '1';
  for (const m of db.prepare('SELECT id, created_at, direction, author, author_name, body, kind FROM messages WHERE conv_id=? ORDER BY id').all(id)) {
    if (m.author === 'system' || withMsgs) {
      const who = m.author === 'customer' ? 'клиент' : m.author === 'ai' ? 'бот' : m.author_name || (m.author === 'human' ? 'менеджер' : 'система');
      items.push({ at: m.created_at, type: m.author === 'system' ? 'event' : 'message', who, text: m.body, dir: m.direction });
    }
  }
  // в одну секунду бывает несколько изменений: внутри секунды — порядок записи в журнал
  items.forEach((x, i) => { x.seq = i; });
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.seq - a.seq);
  res.json(items.slice(0, 500));
});

/* Мягкое удаление (ТЗ §4.3): заявка уходит из работы, но остаётся в базе и журнале */
app.post('/api/conversations/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Укажите причину удаления' });
  const conv = getConversation(id);
  if (!conv || conv.deleted_at) return res.sendStatus(404);
  db.prepare("UPDATE conversations SET deleted_at=datetime('now'), deleted_by=?, delete_reason=?, call_due_at=NULL WHERE id=?")
    .run(req.user.name, reason, id);
  audit('lead', id, 'deleted', null, 'удалена', 'менеджер', reason);
  logAccess('lead_delete', { object: 'lead', objectId: id, detail: reason, ip: req.ip });
  emit('conversations', null);
  res.json({ ok: true });
});
app.post('/api/conversations/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  const conv = getConversation(id);
  if (!conv?.deleted_at) return res.sendStatus(404);
  db.prepare('UPDATE conversations SET deleted_at=NULL, deleted_by=NULL, delete_reason=NULL WHERE id=?').run(id);
  audit('lead', id, 'deleted', 'удалена', null, 'менеджер', 'восстановлена');
  logAccess('lead_restore', { object: 'lead', objectId: id, ip: req.ip });
  emit('conversations', null);
  res.json(getConversation(id));
});

/* Записи разговоров: удалить и вернуть — только владелец, с причиной */
app.delete('/api/calls/:id/recording', (req, res) => {
  try { deleteRecording(Number(req.params.id), req.body?.reason); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/calls/:id/recording/restore', (req, res) => {
  try { restoreRecording(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ─────────── Реклама и отчёт (этап 4, ТЗ §5, §9) ─────────── */
app.get('/api/report', (req, res) => res.json(buildReport(req.query)));
app.post('/api/report/leads', (req, res) => res.json(leadList(req.body?.ids)));
app.get('/api/meta/status', (req, res) => res.json(metaStatus()));
app.post('/api/meta/sync', async (req, res) => {
  try { res.json(await syncMeta()); } catch (e) { res.status(400).json({ error: e.message }); }
});
/* Расход, внесённый руками: пока нет доступа к кабинету или для другой площадки */
app.get('/api/spend', (req, res) => {
  res.json(db.prepare("SELECT * FROM ad_spend WHERE source='manual' ORDER BY date DESC, id DESC LIMIT 200").all());
});
app.post('/api/spend', (req, res) => {
  const b = req.body || {};
  const date = String(b.date || '');
  const amount = Number(String(b.amount ?? '').replace(',', '.'));
  const campaign = String(b.campaign_name || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Дата — ГГГГ-ММ-ДД' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма расхода больше нуля' });
  if (!campaign) return res.status(400).json({ error: 'К какой кампании относится расход?' });
  const r = db.prepare(`INSERT INTO ad_spend(date, campaign_name, spend, currency, source, note, created_by)
    VALUES(?,?,?,'ILS','manual',?,?)`).run(date, campaign, amount, String(b.note || '').trim() || null, req.user?.name || null);
  audit('spend', Number(r.lastInsertRowid), 'spend', null, `${date} · ${campaign} · ${amount}`, 'менеджер');
  res.json({ ok: true });
});
app.delete('/api/spend/:id', (req, res) => {
  const row = db.prepare("SELECT * FROM ad_spend WHERE id=? AND source='manual'").get(Number(req.params.id));
  if (!row) return res.sendStatus(404);
  db.prepare('DELETE FROM ad_spend WHERE id=?').run(row.id);
  audit('spend', row.id, 'spend', `${row.date} · ${row.campaign_name} · ${row.spend}`, null, 'менеджер', 'удалён');
  res.json({ ok: true });
});

/* Журналы для владельца: изменения, доступ, сбои */
app.get('/api/logs/audit', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`SELECT a.*, c.name AS conv_name, c.phone AS conv_phone FROM audit_log a
    LEFT JOIN conversations c ON a.entity='lead' AND c.id=a.entity_id
    ${q ? "WHERE a.actor LIKE ? OR a.field LIKE ? OR a.new_value LIKE ? OR a.old_value LIKE ? OR c.phone LIKE ? OR c.name LIKE ?" : ''}
    ORDER BY a.id DESC LIMIT 300`).all(...(q ? Array(6).fill(`%${q}%`) : []));
  res.json(rows);
});
app.get('/api/logs/access', (req, res) => {
  res.json(db.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT 300').all());
});
app.get('/api/logs/failures', (req, res) => res.json(listFailures()));
app.post('/api/logs/failures/:id/retry', (req, res) => {
  try { retryNow(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/conversations/:id/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 100')
    .all('lead', Number(req.params.id)));
});

/* ─────────── Менеджеры и звонки (ТЗ §2, §6) ─────────── */

app.get('/api/managers', (req, res) => res.json(listManagers()));
app.post('/api/managers', (req, res) => {
  try {
    const b = req.body || {};
    if (b.password && !String(b.login || '').trim()) throw new Error(`У «${b.name || 'менеджера'}» нужен логин, чтобы задать пароль`);
    const m = saveManager(b);
    if (b.password) {
      setPassword(m.id, String(b.password));
      audit('manager', m.id, 'password', null, 'задан новый', 'менеджер');
      logAccess('password_set', { object: 'manager', objectId: m.id, detail: m.name });
    }
    emit('conversations', null);
    res.json(getManager(m.id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/managers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user?.id) return res.status(400).json({ error: 'Себя удалить нельзя' });
  const m = getManager(id);
  dropSessions(id);
  deleteManager(id);
  if (m) audit('manager', id, 'deleted', m.name, null, 'менеджер');
  emit('conversations', null);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/manager', (req, res) => {
  const id = Number(req.params.id);
  const to = Number(req.body.manager_id) || null;
  const u = req.user;
  // менеджер может взять заявку себе; передать другому — только свою или ничью
  if (u?.role !== 'owner') {
    const cur = getConversation(id)?.manager_id;
    if (to !== u.id && cur && cur !== u.id) return res.status(403).json({ error: 'Передать чужую заявку может её менеджер или владелец' });
  }
  try { setManager(id, to); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  emit('conversations', null);
  res.json(getConversation(id));
});

app.post('/api/conversations/:id/next', (req, res) => {
  const id = Number(req.params.id);
  try { setNext(id, req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  emit('conversations', null);
  res.json(getConversation(id));
});

/** «Контроль дня» (ТЗ §8): по дате в часовом поясе компании. */
app.get('/api/control', (req, res) => {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : localDate();
  res.json(controlDay(d));
});

const signRecUrl = (callId) => recUrl(callId);
app.get('/api/conversations/:id/calls', (req, res) => res.json(listCalls(Number(req.params.id), signRecUrl)));
app.post('/api/conversations/:id/calls', (req, res) => {
  const id = Number(req.params.id);
  try { logCall(id, req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  emit('conversations', null);
  res.json({ conv: getConversation(id), calls: listCalls(id, signRecUrl) });
});

// запись разговора — сырым телом: JSON с base64 на 50 МБ раздувает память
app.post('/api/recordings', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
  try { res.json({ file: saveRecording(req.body, req.headers['content-type']) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  logAccess('data_reset', { detail: `диалогов ${gone.conversations}, сообщений ${gone.messages}`, ip: req.ip });
  emit('conversations', null);
  console.log(`Данные стёрты: диалогов ${gone.conversations}, сообщений ${gone.messages}, файлов ${gone.files}`);
  res.json(gone);
});

/**
 * Резервная копия: база и присланные файлы одним архивом. Диск Render на этом
 * тарифе не бэкапится, и до этой кнопки данные клиента жили в единственном
 * экземпляре. Базу снимаем через VACUUM INTO — это целостный снимок даже
 * посреди записи, в отличие от копирования файла. Ключи WhatsApp в архив
 * не кладём: с ними можно увести сессию номера.
 */
app.get('/api/maintenance/export', (req, res) => {
  logAccess('backup_export', { ip: req.ip });
  const dataDir = path.join(process.cwd(), 'data');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  const snap = path.join(tmp, 'app.db');
  try {
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  } catch (e) {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
    return res.status(500).json({ error: 'не удалось снять копию базы: ' + e.message });
  }
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: scheduleSetting('timezone') }).format(new Date());
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="backup-${stamp}.tar.gz"`);

  const args = ['-czf', '-', '-C', tmp, 'app.db'];
  if (fs.existsSync(path.join(dataDir, 'media'))) args.push('-C', dataDir, 'media');
  const tar = spawn('tar', args);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d) => console.error('архив:', String(d).trim()));
  tar.on('close', (code) => {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
    if (code) console.error('резервная копия: tar завершился с кодом', code);
    else console.log('Резервная копия выгружена');
  });
  req.on('close', () => { if (tar.exitCode === null) tar.kill(); });
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
    wa_id: 'sim-' + Date.now(), ref: req.body.ref || null,
    fromMe: req.body.fromMe === true }, channels.mock);
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

/* Просроченный звонок (ТЗ §7): ответственному и владельцу, один раз на срок.
   Новый срок (следующий звонок) снова включает контроль. */
setInterval(async () => {
  for (const c of overdueCalls()) {
    db.prepare("UPDATE conversations SET call_escalated_at=datetime('now') WHERE id=?").run(c.id);
    let l = {};
    try { l = JSON.parse(c.lead || '{}'); } catch {}
    const m = getManager(c.manager_id);
    await notifyManagers(`⏰ Просрочен звонок: ${l.name || c.name || 'клиент'}, +${c.phone}`
      + `\nСрок был ${localTime(c.call_due_at)}${m ? `, ответственный ${m.name}` : ', ответственный не назначен'}`
      + `\n${adminLink(c.id)}`, { convId: c.id, owners: true }).catch(() => {});
    emit('conversations', null);
  }
}, 6e4).unref?.();
setInterval(() => { sweepRecordings(); purgeTrash(); }, 36e5).unref?.();
startRetries();
startMeta();
startControl();

app.listen(PORT, async () => {
  console.log(`\n  Админка:    http://localhost:${PORT}`);
  console.log(`  Симулятор:  http://localhost:${PORT}/sim.html`);
  console.log(`  Webhook:    POST http://localhost:${PORT}/webhook`);
  if (!authEnabled()) console.log('  ⚠ ADMIN_PASS не задан и учёток нет — админка открыта без пароля\n');
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
