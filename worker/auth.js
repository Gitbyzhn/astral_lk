// Әкімші кіруі (Cloudflare нұсқасы): құпиясөз (PBKDF2), әкімші сілтемесі (#key=…), HMAC токен.
// Тегін жоспарда бір сұрауға CPU уақыты шектеулі, сондықтан хэш итерациясы сервер нұсқасынан аз —
// оның орнына қате әрекеттер IP бойынша шектеледі.
import { HttpError, badRequest } from '../server/errors.js';
import { constantTimeEqual, randomString } from './http.js';
import { getSettings, setSetting } from './data.js';

const ITERATIONS = 5000;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 128;
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export const generateAdminKey = (length = 24) => randomString(length, KEY_ALPHABET);

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iterations, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'pbkdf2' || !salt || !hash || typeof password !== 'string') return false;
  const actual = b64url(await pbkdf2(password, fromB64url(salt), Number(iterations)));
  return constantTimeEqual(actual, hash);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function issueToken(settings, sessionDays = 30) {
  const expiresAt = Date.now() + sessionDays * 86_400_000;
  const body = b64url(enc.encode(JSON.stringify({ exp: expiresAt, pv: Number(settings.get('password_version') || 1) })));
  return { token: `${body}.${await hmac(settings.get('auth_secret'), body)}`, expiresAt };
}

export async function verifyToken(token, settings) {
  if (typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  if (!constantTimeEqual(await hmac(settings.get('auth_secret'), body), sig)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return payload.exp > Date.now() && payload.pv === Number(settings.get('password_version') || 1);
  } catch {
    return false;
  }
}

/* ---------------------- Қате әрекеттерді шектеу (IP бойынша) ---------------------- */
async function checkLimit(db, ip) {
  const row = await db.prepare('SELECT count, reset_at FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && row.reset_at > Date.now() && row.count >= MAX_ATTEMPTS) {
    throw new HttpError(429, 'too_many_attempts', { retryAfter: Math.ceil((row.reset_at - Date.now()) / 1000) });
  }
}

const failAttempt = (db, ip) => {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO login_attempts (ip, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (ip) DO UPDATE SET
         count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END`,
    )
    .bind(ip, now + WINDOW_MS, now, now, now + WINDOW_MS)
    .run();
};

const resetAttempts = (db, ip) => db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();

/* ------------------------------------ Әрекеттер ------------------------------------ */
export async function login(ctx, password) {
  await checkLimit(ctx.db, ctx.ip);
  const settings = await getSettings(ctx.db);
  if (!(await verifyPassword(password, settings.get('admin_password')))) {
    await failAttempt(ctx.db, ctx.ip);
    throw new HttpError(401, 'wrong_password');
  }
  await resetAttempts(ctx.db, ctx.ip);
  return { ...(await issueToken(settings)), passwordIsDefault: settings.get('password_is_default') === '1' };
}

export async function loginWithKey(ctx, key) {
  await checkLimit(ctx.db, ctx.ip);
  const settings = await getSettings(ctx.db);
  if (typeof key !== 'string' || !key || !constantTimeEqual(key, settings.get('admin_key'))) {
    await failAttempt(ctx.db, ctx.ip);
    throw new HttpError(401, 'invalid_admin_link');
  }
  await resetAttempts(ctx.db, ctx.ip);
  return { ...(await issueToken(settings)), passwordIsDefault: settings.get('password_is_default') === '1' };
}

/** Әкімші сұрауы: `Authorization: Bearer <token>`. Баптауларды қайтарады. */
export async function requireAdmin(ctx, request) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const settings = await getSettings(ctx.db);
  if (!(await verifyToken(token, settings))) throw new HttpError(401, 'unauthorized');
  return settings;
}

export async function rotateAdminKey(ctx, settings) {
  const key = generateAdminKey();
  const version = Number(settings.get('password_version') || 1) + 1;
  await ctx.db.batch([setSetting(ctx.db, 'admin_key', key), setSetting(ctx.db, 'password_version', version)]);
  settings.set('admin_key', key);
  settings.set('password_version', String(version));
  return { adminKey: key, ...(await issueToken(settings)) };
}

export async function changePassword(ctx, settings, current, next) {
  await checkLimit(ctx.db, ctx.ip);
  if (!(await verifyPassword(current, settings.get('admin_password')))) {
    await failAttempt(ctx.db, ctx.ip);
    throw new HttpError(400, 'wrong_password');
  }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) throw badRequest('weak_password');
  const version = Number(settings.get('password_version') || 1) + 1;
  await ctx.db.batch([
    setSetting(ctx.db, 'admin_password', await hashPassword(next)),
    setSetting(ctx.db, 'password_version', version),
    setSetting(ctx.db, 'password_is_default', 0),
  ]);
  settings.set('password_version', String(version));
  return { ...(await issueToken(settings)), passwordIsDefault: false };
}
