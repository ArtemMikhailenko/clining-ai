/**
 * Канал baileys — подключение личного номера по QR, без Docker.
 * Тот же протокол WhatsApp Web, на котором построены WAHA и Evolution API,
 * только библиотекой внутри нашего процесса.
 *
 * Это неофициальный протокол: против ToS Meta, номер могут заблокировать.
 */
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason,
  downloadMediaMessage,
  isJidGroup, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser
} from 'baileys';
import QRCode from 'qrcode';
import path from 'node:path';
import fs from 'node:fs';
import { saveMedia } from '../media.js';
import { setMessageStatus } from '../db.js';

/** Обещание с пределом по времени: зависший вызов WhatsApp не должен держать код вечно. */
const capped = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms).unref?.())]);

let sock = null;
let onMessage = null;
// SELF_TEST=1 — бот отвечает в чате «Сообщение себе», чтобы можно было
// проверить всё одному, без второго телефона
const SELF_TEST = process.env.SELF_TEST === '1';
const DEBUG = process.env.WA_DEBUG === '1';   // печатать всё, что приходит от WhatsApp
const sentIds = new Set();   // свои же отправленные — не обрабатывать повторно
const status = { state: 'offline', qr: null, me: null, error: null, pairCode: null, pairPhone: null, events: [], disk: null };

/*
 * Диагностика отвязки. «Попросил подключить заново» бывает по двум причинам:
 * WhatsApp сам отключил устройство (код 401) — или сервер перезапустился, а
 * папка data не на постоянном диске, и ключи сессии пропали. Журнал обрывов
 * и проверка диска показывают, какой из двух случаев.
 */
const EVENTS_FILE = path.join(process.cwd(), 'data', 'wa-events.json');
// Когда мы последний раз точно были на связи: пишем раз в минуту, пока онлайн.
// По нему после перезапуска узнаём сообщения, пришедшие, пока нас не было
const SEEN_FILE = path.join(process.cwd(), 'data', 'wa-last-seen');
let lastSeen = (() => { try { return Number(fs.readFileSync(SEEN_FILE, 'utf8')) || 0; } catch { return 0; } })();
const markSeen = () => { try { fs.writeFileSync(SEEN_FILE, String(Date.now())); } catch {} };
setInterval(() => { if (status.state === 'online') markSeen(); }, 60e3).unref?.();
try { status.events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')).slice(-20); } catch {}
function waEvent(kind, extra = {}) {
  const now = new Date().toISOString();
  const last = status.events.at(-1);
  // QR истёк, пока никто не сканирует (408), — повторяется каждые пару минут и
  // вытеснял из журнала главное: почему отвязалось. Повторы сворачиваем в одну строку
  if (last && last.kind === kind && last.code === (extra.code ?? null) && last.note === (extra.note ?? null) && kind !== 'start') {
    last.count = (last.count || 1) + 1;
    last.last_at = now;
  } else {
    status.events = [...status.events, { at: now, kind, ...extra }].slice(-50);
  }
  try { fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true }); fs.writeFileSync(EVENTS_FILE, JSON.stringify(status.events)); } catch {}
}
// На Render постоянный диск — отдельное устройство. Если data на том же устройстве,
// что и код, при каждом деплое или перезапуске сессия WhatsApp теряется
function checkDisk() {
  if (!process.env.RENDER) return null;
  try {
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).dev !== fs.statSync(process.cwd()).dev;
  } catch { return null; }
}
status.disk = checkDisk();
if (status.disk === false) console.error('⚠ Папка data не на постоянном диске: после перезапуска WhatsApp придётся привязывать заново');
const AUTH_DIR = path.join(process.cwd(), 'data', 'wa-auth');
// номер поколения сокета: после «Переподключить» или «Отвязать» старый сокет
// ещё успевает прислать события — они не должны менять состояние нового
let gen = 0;
const listeners = new Set();

export const waStatus = () => ({ ...status });
export const onStatus = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const pushStatus = () => { for (const fn of listeners) { try { fn(waStatus()); } catch {} } };

/** Текст (или подпись к медиа) из любого поддерживаемого вида сообщения. */
function textOf(msg) {
  const m = msg.message ?? {};
  return m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.documentMessage?.caption
    ?? m.buttonsResponseMessage?.selectedDisplayText
    ?? m.listResponseMessage?.title
    ?? null;
}

/**
 * Откуда пришёл клиент. Клик по рекламе в Facebook или Instagram приносит
 * вместе с первым сообщением карточку объявления: заголовок, ссылку и
 * идентификатор клика. Без этого в CRM все лиды выглядят одинаково.
 */
function refOf(msg) {
  const m = msg.message ?? {};
  const ctx = m.extendedTextMessage?.contextInfo ?? m.imageMessage?.contextInfo
    ?? m.videoMessage?.contextInfo ?? m.audioMessage?.contextInfo ?? m.documentMessage?.contextInfo ?? null;
  const ad = ctx?.externalAdReply;
  const entry = ctx?.entryPointConversionSource || '';
  if (!ad && !entry) return null;

  const url = ad?.sourceUrl || '';
  let utm = '';
  try { utm = new URL(url).searchParams.get('utm_source') || ''; } catch {}
  // sourceApp: FB | IG; entryPointConversionSource: ctwa_ad, sources, id_link…
  const app = ad?.sourceApp || ctx?.entryPointConversionApp || '';
  // приходит и «FB», и «facebook» — без учёта регистра получалось «Реклама Реклама»
  const APPS = { fb: 'Facebook', facebook: 'Facebook', ig: 'Instagram', instagram: 'Instagram', whatsapp: 'WhatsApp' };
  const label = APPS[String(app).toLowerCase()] || utm
    || (entry.includes('ctwa') ? 'Реклама' : entry === 'id_link' ? 'Ссылка' : entry ? entry : 'Реклама');

  return {
    source: ad ? `Реклама ${label}`.trim() : label,
    title: ad?.title || ad?.body || '',
    url,
    ref: ad?.ctwaClid || ad?.sourceId || '',
    // сырые поля — чтобы было по чему настроить справочник кампаний
    raw: {
      title: ad?.title || '', body: ad?.body || '', sourceUrl: url,
      sourceId: ad?.sourceId || '', sourceType: ad?.sourceType || '', sourceApp: app,
      ctwaClid: ad?.ctwaClid || '', entry, at: new Date().toISOString()
    }
  };
}

/** Что за вложение пришло: фото, видео или документ. */
function mediaKind(msg) {
  const m = msg.message ?? {};
  if (m.imageMessage) return { kind: 'image', mime: m.imageMessage.mimetype ?? 'image/jpeg' };
  if (m.videoMessage) return { kind: 'video', mime: m.videoMessage.mimetype ?? 'video/mp4' };
  if (m.audioMessage) return { kind: 'audio', mime: m.audioMessage.mimetype ?? 'audio/ogg' };   // голосовое
  if (m.documentMessage?.mimetype?.startsWith('image/')) {
    return { kind: 'image', mime: m.documentMessage.mimetype };   // фото, отправленное файлом
  }
  return null;
}

/** Настоящий телефон: на @lid цифры из jid — это не номер. */
function phoneOf(key) {
  const jid = key.remoteJid ?? '';
  if (!jid.endsWith('@lid')) return jid.split('@')[0];
  const alt = key.remoteJidAlt ?? key.senderPn ?? '';
  return alt ? alt.split('@')[0] : jid.split('@')[0];
}

const wipeAuth = () => fs.rmSync(AUTH_DIR, { recursive: true, force: true });

async function connect() {
  const my = ++gen;
  const live = () => my === gen;
  const hadCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
  if (my === 1) waEvent('start', { note: hadCreds ? 'сервер запущен, сессия на месте' : 'сервер запущен без сессии WhatsApp' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Baileys по умолчанию сыплет в stdout логи синхронизации контактов и истории
  // («failed to find key … to decode mutation») — к переписке это отношения не имеет
  const quiet = { level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

  sock = makeWASocket({
    version,
    auth: state,
    logger: quiet,
    // без этого WhatsApp помечает устройство как онлайн и перестаёт слать пуши на телефон
    markOnlineOnConnect: false,
    browser: ['CRM заявок', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (!live()) return;
    if (u.qr) {
      if (status.state !== 'qr') waEvent('qr', { note: hadCreds ? 'ключи были, но не подошли' : 'ключей сессии нет — нужна привязка' });
      status.state = 'qr';
      status.error = null;
      status.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      pushStatus();
    }
    if (u.connection === 'open') {
      status.state = 'online';
      status.qr = null;
      status.error = null;
      status.pairCode = null;
      status.pairPhone = null;
      status.me = sock.user?.id?.split(':')[0] ?? null;
      waEvent('open');
      // lastSeen НЕ обновляем сразу: догрузка пропущенного придёт следом и должна
      // сравниваться с моментом до перезапуска. Обновит таймер через минуту
      setTimeout(() => { lastSeen = Date.now(); markSeen(); }, 90e3).unref?.();
      console.log('WhatsApp подключён:', status.me,
        DEBUG ? `| id=${sock.user?.id} lid=${sock.user?.lid ?? '—'}` : '');
      pushStatus();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      status.state = loggedOut ? 'logged_out' : 'reconnecting';
      status.error = loggedOut ? 'Номер отвязан на телефоне — привяжите заново' : (u.lastDisconnect?.error?.message ?? null);
      status.qr = null;
      status.pairCode = null;          // код привязан к сокету: после обрыва он недействителен
      if (loggedOut) status.me = null;
      pushStatus();
      console.log('WhatsApp отключён:', code, status.error);
      waEvent(loggedOut ? 'logout' : 'close', { code: code ?? null, note: u.lastDisconnect?.error?.message ?? null });
      // Старые ключи после разлогина бесполезны. Раньше здесь был return — и бот
      // навсегда оставался без QR до перезапуска сервера. Теперь начинаем с чистого листа.
      if (loggedOut) wipeAuth();
      setTimeout(() => live() && connect().catch((e) => console.error('WhatsApp:', e.message)), loggedOut ? 1000 : 3000);
    }
  });

  // доставлено/прочитано: по этому видно, дошло ли сообщение и читает ли клиент
  sock.ev.on('messages.update', (updates) => {
    if (!live()) return;
    const MAP = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
    for (const u of updates) {
      const st = MAP[u.update?.status];
      if (st && u.key?.id) { try { setMessageStatus(u.key.id, st); } catch {} }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!live()) return;
    // свой идентификатор может прийти и как обычный номер, и как @lid —
    // поэтому сверяем ещё и по цифрам номера
    const digits = (v) => String(v ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const mine = new Set([
      jidNormalizedUser(sock.user?.id ?? ''),
      jidNormalizedUser(sock.user?.lid ?? '')
    ].filter(Boolean));
    const myDigits = digits(sock.user?.id);

    for (const msg of messages) {
      const jid = msg.key.remoteJid ?? '';
      const selfChat = mine.has(jidNormalizedUser(jid)) || (Boolean(myDigits) && digits(jid) === myDigits);

      if (DEBUG) {
        console.log(`[wa] upsert type=${type} jid=${jid} fromMe=${msg.key.fromMe} self=${selfChat}` +
          ` kinds=${Object.keys(msg.message ?? {}).join(',') || '—'} text=${JSON.stringify((textOf(msg) ?? '').slice(0, 40))}`);
      }

      // 'append' — обычно догрузка истории, но свои сообщения из чата с собой
      // прилетают именно так, поэтому для них делаем исключение
      // Сообщения, пришедшие, пока сервер перезапускался (деплой), WhatsApp отдаёт
      // после переподключения тоже как 'append' — раньше они терялись. Берём те,
      // что новее момента, когда мы последний раз точно были на связи
      const ts = Number(msg.messageTimestamp ?? 0) * 1000;
      // не старше 6 часов: после долгой отвязки не отвечаем на то, что уже неактуально
      const missed = type === 'append' && !msg.key.fromMe && lastSeen && ts >= lastSeen - 120e3
        && ts >= Date.now() - 6 * 3600e3 && ts <= Date.now() + 60e3;
      if (type !== 'notify' && !missed && !(SELF_TEST && selfChat)) continue;

      if (sentIds.has(msg.key.id)) continue;                 // это наш собственный ответ
      // Менеджер ответил клиенту прямо с телефона. Раньше такие сообщения
      // выбрасывались: в CRM их не было, а бот не знал, что человек уже ответил,
      // и мог написать следом своё. Теперь они попадают в переписку.
      const byHand = Boolean(msg.key.fromMe) && !(SELF_TEST && selfChat);
      if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)) continue;
      const text = textOf(msg);
      const attach = mediaKind(msg);
      if (!text && !attach) continue;     // реакции, служебное, неподдерживаемые типы

      if (!byHand) {
        try {
          await sock.readMessages([msg.key]);   // прочитано — как у живого менеджера
        } catch {}
      }

      let media = [];
      if (attach) {
        try {
          // видео — потоком сразу на диск, чтобы тяжёлый ролик не держать целиком в памяти
          const data = await downloadMediaMessage(msg, attach.kind === 'video' ? 'stream' : 'buffer', {},
            { reuploadRequest: sock.updateMediaMessage });
          media = [await saveMedia(data, attach.mime, attach.kind)];
        } catch (e) {
          console.error('не скачалось вложение:', e.message);
        }
      }

      await onMessage({
        phone: phoneOf(msg.key),
        name: msg.pushName ?? null,
        text: text ?? '',
        media,
        wa_id: msg.key.id ?? null,
        chat_id: jid,
        ref: refOf(msg),
        fromMe: byHand
      });
    }
  });
}

/**
 * Привязка без QR: пользователь вводит в WhatsApp 8-символьный код.
 * Нужна, когда админка открыта на том же телефоне — свой экран камерой не отсканировать.
 */
export async function requestPairing(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 9) throw new Error('Нужен номер в международном формате, например +972 50 123 4567');
  if (status.state === 'online') throw new Error('WhatsApp уже подключён');
  if (!sock || status.state !== 'qr') throw new Error('Соединение ещё поднимается — попробуйте через пару секунд');
  if (sock.authState?.creds?.registered) throw new Error('Сессия уже привязана — отвяжите номер, чтобы подключить другой');
  const raw = await sock.requestPairingCode(digits);
  status.pairCode = raw.match(/.{1,4}/g).join('-');
  status.pairPhone = digits;
  pushStatus();
  return status.pairCode;
}

/** Отвязать номер: устройство пропадает из «Связанных устройств», появляется новый QR. */
export async function logout() {
  const old = sock;
  gen++;                                   // события старого сокета больше не в счёт
  try { await old?.logout(); } catch {}
  try { old?.end(undefined); } catch {}
  wipeAuth();
  Object.assign(status, { state: 'offline', qr: null, me: null, error: null, pairCode: null, pairPhone: null });
  pushStatus();
  await connect();
}

/** Переподключиться с теми же ключами — если сообщения перестали приходить. */
export async function restart() {
  const old = sock;
  gen++;
  try { old?.end(undefined); } catch {}
  Object.assign(status, { state: 'reconnecting', qr: null, error: null, pairCode: null });
  pushStatus();
  await connect();
}

export const baileys = {
  name: 'baileys',
  ready: () => status.state === 'online',

  async init(handler) {
    onMessage = handler;
    await connect();
  },

  async send(conv, text) {
    if (!sock || status.state !== 'online') throw new Error('WhatsApp не подключён (состояние: ' + status.state + ')');
    const jid = conv.chat_id || `${String(conv.phone).replace(/\D/g, '')}@s.whatsapp.net`;
    // «печатает…» и пауза по длине текста: мгновенный ответ в миллисекунду —
    // ровно тот роботизированный паттерн, по которому ловит антиспам
    try {
      await capped(sock.presenceSubscribe(jid), 5000);
      await capped(sock.sendPresenceUpdate('composing', jid), 5000);
      await new Promise((r) => setTimeout(r, Math.min(1200 + text.length * 25, 6000)));
      await capped(sock.sendPresenceUpdate('paused', jid), 5000);
    } catch {}
    // Бывало, что сообщение уже доставлено, а sendMessage так и не возвращался: код ждал
    // вечно, напоминание не записывалось, и через 10 минут тот же клиент получал его снова.
    // Не дождались за 30 секунд — считаем отправленным без подтверждения, повторно не шлём
    const res = await capped(sock.sendMessage(jid, { text }), 30000).catch((e) => {
      if (e.message === 'TIMEOUT') { console.error('WhatsApp не подтвердил отправку за 30 с:', jid); return { unconfirmed: true }; }
      throw e;
    });
    if (res?.key?.id) sentIds.add(res.key.id);              // чтобы не зациклиться в чате с собой
    return { wa_id: res?.key?.id ?? null };
  },

  parse: () => []   // входящие приходят событием, а не вебхуком
};
