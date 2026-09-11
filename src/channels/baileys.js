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

let sock = null;
let onMessage = null;
// SELF_TEST=1 — бот отвечает в чате «Сообщение себе», чтобы можно было
// проверить всё одному, без второго телефона
const SELF_TEST = process.env.SELF_TEST === '1';
const DEBUG = process.env.WA_DEBUG === '1';   // печатать всё, что приходит от WhatsApp
const sentIds = new Set();   // свои же отправленные — не обрабатывать повторно
const status = { state: 'offline', qr: null, me: null, error: null, pairCode: null, pairPhone: null };
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

/** Что за вложение пришло: фото, видео или документ. */
function mediaKind(msg) {
  const m = msg.message ?? {};
  if (m.imageMessage) return { kind: 'image', mime: m.imageMessage.mimetype ?? 'image/jpeg' };
  if (m.videoMessage) return { kind: 'video', mime: m.videoMessage.mimetype ?? 'video/mp4' };
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
      console.log('WhatsApp отключён:', status.error);
      // Старые ключи после разлогина бесполезны. Раньше здесь был return — и бот
      // навсегда оставался без QR до перезапуска сервера. Теперь начинаем с чистого листа.
      if (loggedOut) wipeAuth();
      setTimeout(() => live() && connect().catch((e) => console.error('WhatsApp:', e.message)), loggedOut ? 1000 : 3000);
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
      if (type !== 'notify' && !(SELF_TEST && selfChat)) continue;

      if (sentIds.has(msg.key.id)) continue;                 // это наш собственный ответ
      if (msg.key.fromMe && !(SELF_TEST && selfChat)) continue;
      if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || isJidStatusBroadcast(jid)) continue;
      const text = textOf(msg);
      const attach = mediaKind(msg);
      if (!text && !attach) continue;     // реакции, служебное, неподдерживаемые типы

      try {
        await sock.readMessages([msg.key]);   // прочитано — как у живого менеджера
      } catch {}

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
        chat_id: jid
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
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, Math.min(1200 + text.length * 25, 6000)));
      await sock.sendPresenceUpdate('paused', jid);
    } catch {}
    const res = await sock.sendMessage(jid, { text });
    if (res?.key?.id) sentIds.add(res.key.id);              // чтобы не зациклиться в чате с собой
    return { wa_id: res?.key?.id ?? null };
  },

  parse: () => []   // входящие приходят событием, а не вебхуком
};
