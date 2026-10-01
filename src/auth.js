/**
 * Вход в админку (ТЗ §4.3, этап 3). У каждого менеджера и владельца свой логин;
 * пароль хранится только хэшем (scrypt). Сессия — случайный токен в cookie,
 * в базе лежит его хэш: утечка базы не даёт войти.
 *
 * Администратор из переменных ADMIN_USER / ADMIN_PASS остаётся аварийным
 * входом с правами владельца — так после обновления никто не теряет доступ.
 */
import crypto from 'node:crypto';
import { db, logAccess } from './db.js';

export const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
export const ADMIN = { id: 0, name: 'Администратор', role: 'owner', login: ADMIN_USER };
const SESSION_DAYS = 30;
const COOKIE = 'sid';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Пароль не задан нигде — режим разработки: админка открыта, как и раньше. */
export const authEnabled = () => Boolean(ADMIN_PASS)
  || Boolean(db.prepare("SELECT 1 FROM managers WHERE pass IS NOT NULL AND pass != ''").get());

export function userById(id) {
  if (id === 0) return ADMIN;
  const m = db.prepare('SELECT id, name, role, login FROM managers WHERE id=? AND pass IS NOT NULL').get(id);
  return m || null;
}

/* Перебор паролей: не больше 10 попыток с адреса за 15 минут */
const tries = new Map();
function throttled(ip) {
  const now = Date.now();
  const t = (tries.get(ip) || []).filter((x) => now - x < 9e5);
  tries.set(ip, t);
  return t.length >= 10;
}

export function login(loginName, password, { ip, ua } = {}) {
  if (throttled(ip)) throw new Error('Слишком много попыток. Подождите 15 минут');
  const name = String(loginName || '').trim();
  let user = null;
  if (ADMIN_PASS && same(name.toLowerCase(), ADMIN_USER.toLowerCase()) && same(password, ADMIN_PASS)) user = ADMIN;
  else {
    const m = db.prepare('SELECT * FROM managers WHERE lower(login)=lower(?)').get(name);
    if (m?.pass && checkPassword(password, m.pass)) user = { id: m.id, name: m.name, role: m.role, login: m.login };
  }
  if (!user) {
    tries.get(ip)?.push(Date.now()) ?? tries.set(ip, [Date.now()]);
    logAccess('login_failed', { detail: name, ip, user: null });
    throw new Error('Неверный логин или пароль');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions(token_hash, user_id, expires_at, ip, ua) VALUES(?,?,datetime('now', ?),?,?)`)
    .run(sha(token), user.id, `+${SESSION_DAYS} days`, ip || null, String(ua || '').slice(0, 200));
  if (user.id) db.prepare("UPDATE managers SET last_login_at=datetime('now') WHERE id=?").run(user.id);
  logAccess('login', { ip, user });
  return { token, user };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
}

/** Выйти везде: после смены пароля или удаления менеджера. */
export const dropSessions = (userId) => db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);

export function sessionUser(token) {
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at > datetime('now')").get(sha(token));
  if (!s) return null;
  const user = userById(s.user_id);
  if (!user) return null;
  // скользящий срок: кто работает каждый день, не вылетает раз в месяц
  if (Date.now() - new Date(s.seen_at.replace(' ', 'T') + 'Z') > 36e5) {
    db.prepare(`UPDATE sessions SET seen_at=datetime('now'), expires_at=datetime('now', ?) WHERE token_hash=?`)
      .run(`+${SESSION_DAYS} days`, s.token_hash);
  }
  return user;
}

export function setPassword(userId, password) {
  if (String(password).length < 6) throw new Error('Пароль — минимум 6 символов');
  db.prepare('UPDATE managers SET pass=? WHERE id=?').run(hashPassword(password), userId);
  dropSessions(userId);
}

export function changeOwnPassword(user, oldPw, newPw) {
  if (!user?.id) throw new Error('Пароль администратора задаётся в настройках хостинга (ADMIN_PASS)');
  const m = db.prepare('SELECT pass FROM managers WHERE id=?').get(user.id);
  if (!checkPassword(oldPw, m?.pass)) throw new Error('Текущий пароль неверный');
  setPassword(user.id, newPw);
}

export function readCookie(req, name = COOKIE) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax`
    + `${secure ? '; Secure' : ''}; Max-Age=${token ? SESSION_DAYS * 86400 : 0}`);
}

/** Старый вход через окно браузера (Basic) — для администратора, пока все не перешли. */
export function basicUser(req) {
  if (!ADMIN_PASS) return null;
  const hdr = req.headers.authorization || '';
  if (!/^Basic /i.test(hdr)) return null;
  const [u, ...rest] = Buffer.from(hdr.replace(/^Basic /i, ''), 'base64').toString().split(':');
  return same(u, ADMIN_USER) && same(rest.join(':'), ADMIN_PASS) ? ADMIN : null;
}

/* Подпись короткоживущих ссылок на записи разговоров (ТЗ §6.1) */
const SIGN_KEY = crypto.createHash('sha256').update('rec:' + (ADMIN_PASS || process.env.RENDER_SERVICE_ID || 'local')).digest();
export const signRec = (id, exp) => crypto.createHmac('sha256', SIGN_KEY).update(`${id}.${exp}`).digest('base64url').slice(0, 22);
export function recUrl(callId, minutes = 60) {
  const exp = Math.floor(Date.now() / 1000) + minutes * 60;
  return `/rec/${callId}?exp=${exp}&sig=${signRec(callId, exp)}`;
}
export function recValid(id, exp, sig) {
  return Number(exp) > Date.now() / 1000 && same(signRec(id, exp), String(sig || ''));
}
