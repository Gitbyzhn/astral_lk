import crypto from 'node:crypto';
import { HttpError, badRequest } from './errors.js';

const SCRYPT_N = 16384;
const KEY_LENGTH = 32;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 128;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Құпиясөзді қайта-қайта болжауға тосқауыл: бір IP-ден 15 минутта 10 қате әрекет. */
function createLimiter({ max = 10, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (entry && entry.resetAt > now && entry.count >= max) {
        throw new HttpError(429, 'too_many_attempts', { retryAfter: Math.ceil((entry.resetAt - now) / 1000) });
      }
    },
    fail(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

/**
 * Әкімші кіруі: бір құпиясөз, HMAC қолтаңбалы токен.
 * Құпиясөз өзгерсе (password_version) — бұрынғы барлық токендер жарамсыз болады.
 */
export function createAuth({ settings, initialPassword, sessionDays }) {
  if (!settings.get('auth_secret')) settings.set('auth_secret', crypto.randomBytes(32).toString('base64url'));
  if (!settings.get('admin_password')) {
    settings.set('admin_password', hashPassword(initialPassword));
    settings.set('password_version', '1');
    settings.set('password_is_default', initialPassword === 'admin' ? '1' : '0');
  }

  const limiter = createLimiter();
  const secret = () => settings.get('auth_secret');
  const passwordVersion = () => Number(settings.get('password_version', '1'));
  const isDefault = () => settings.get('password_is_default') === '1';

  const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

  function issueToken() {
    const expiresAt = Date.now() + sessionDays * 86_400_000;
    const body = Buffer.from(JSON.stringify({ exp: expiresAt, pv: passwordVersion() })).toString('base64url');
    return { token: `${body}.${sign(body)}`, expiresAt };
  }

  function verifyToken(token) {
    if (typeof token !== 'string') return false;
    const [body, sig] = token.split('.');
    if (!body || !sig) return false;
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return payload.exp > Date.now() && payload.pv === passwordVersion();
    } catch {
      return false;
    }
  }

  return {
    isDefault,

    login(password, ip) {
      limiter.check(ip);
      if (typeof password !== 'string' || !verifyPassword(password, settings.get('admin_password'))) {
        limiter.fail(ip);
        throw new HttpError(401, 'wrong_password');
      }
      limiter.reset(ip);
      return { ...issueToken(), passwordIsDefault: isDefault() };
    },

    changePassword(current, next, ip) {
      limiter.check(ip);
      if (typeof current !== 'string' || !verifyPassword(current, settings.get('admin_password'))) {
        limiter.fail(ip);
        throw new HttpError(400, 'wrong_password');
      }
      if (typeof next !== 'string' || next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
        throw badRequest('weak_password');
      }
      settings.set('admin_password', hashPassword(next));
      settings.set('password_version', String(passwordVersion() + 1));
      settings.set('password_is_default', '0');
      return { ...issueToken(), passwordIsDefault: false };
    },

    /** Express middleware: `Authorization: Bearer <token>` міндетті. */
    require(req, _res, next) {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!verifyToken(token)) return next(new HttpError(401, 'unauthorized'));
      next();
    },
  };
}

export const PASSWORD_LIMITS = { min: MIN_PASSWORD, max: MAX_PASSWORD };
