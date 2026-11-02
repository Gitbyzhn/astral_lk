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

/** Әкімші сілтемесінің кілті: 24 таңба (~143 бит) — болжап табу мүмкін емес. */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generateAdminKey(length = 24) {
  const limit = 256 - (256 % KEY_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
    }
  }
  return out;
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

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
 * Кіру: әкімші (құпиясөз немесе әкімші сілтемесі) және кассир (касса сілтемесі), HMAC қолтаңбалы токен.
 * Әкімші құпиясөзі/сілтемесі өзгерсе (password_version) — әкімшінің бұрынғы токендері жарамсыз болады,
 * касса сілтемесі жаңарса (cashier_version) — кассирлердің токендері.
 */
export function createAuth({ settings, initialPassword, sessionDays }) {
  if (!settings.get('auth_secret')) settings.set('auth_secret', crypto.randomBytes(32).toString('base64url'));
  if (!settings.get('admin_password')) {
    settings.set('admin_password', hashPassword(initialPassword));
    settings.set('password_version', '1');
    settings.set('password_is_default', initialPassword === 'admin' ? '1' : '0');
  }

  // Әкімші сілтемесі (/admin#key=…): аккаунтсыз, құпиясөзсіз кіру үшін
  if (!settings.get('admin_key')) settings.set('admin_key', generateAdminKey());
  // Касса сілтемесі (/kassa#key=…): кассир тек билет береді және сатылымды көреді
  if (!settings.get('cashier_key')) settings.set('cashier_key', generateAdminKey());

  const limiter = createLimiter();
  const secret = () => settings.get('auth_secret');
  const passwordVersion = () => Number(settings.get('password_version', '1'));
  const cashierVersion = () => Number(settings.get('cashier_version', '1'));
  const isDefault = () => settings.get('password_is_default') === '1';

  const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

  /** @param {'admin' | 'cashier'} role */
  function issueToken(role = 'admin') {
    const expiresAt = Date.now() + sessionDays * 86_400_000;
    const payload = role === 'cashier' ? { exp: expiresAt, r: 'cashier', cv: cashierVersion() } : { exp: expiresAt, pv: passwordVersion() };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${sign(body)}`, expiresAt, role };
  }

  /** Токеннің рөлі: 'admin' | 'cashier', жарамсыз болса — null. */
  function tokenRole(token) {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!(payload.exp > Date.now())) return null;
      if (payload.r === 'cashier') return payload.cv === cashierVersion() ? 'cashier' : null;
      return payload.pv === passwordVersion() ? 'admin' : null;
    } catch {
      return null;
    }
  }

  const bearer = (req) => {
    const header = req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  };

  return {
    isDefault,

    login(password, ip) {
      limiter.check(ip);
      if (typeof password !== 'string' || !verifyPassword(password, settings.get('admin_password'))) {
        limiter.fail(ip);
        throw new HttpError(401, 'wrong_password');
      }
      limiter.reset(ip);
      return { ...issueToken('admin'), passwordIsDefault: isDefault() };
    },

    /** Сілтеме арқылы кіру: әкімші кілті → әкімші, касса кілті → кассир. */
    loginWithKey(key, ip) {
      limiter.check(ip);
      let role = null;
      if (typeof key === 'string' && key) {
        if (sameSecret(key, settings.get('admin_key'))) role = 'admin';
        else if (sameSecret(key, settings.get('cashier_key'))) role = 'cashier';
      }
      if (!role) {
        limiter.fail(ip);
        throw new HttpError(401, 'invalid_admin_link');
      }
      limiter.reset(ip);
      return role === 'admin' ? { ...issueToken('admin'), passwordIsDefault: isDefault() } : issueToken('cashier');
    },

    adminKey: () => settings.get('admin_key'),
    cashierKey: () => settings.get('cashier_key'),

    /** Жаңа сілтеме: ескісі жұмыс істемей қалады, барлық құрылғылар шығарылады (осы құрылғыдан басқа). */
    rotateAdminKey() {
      settings.set('admin_key', generateAdminKey());
      settings.set('password_version', String(passwordVersion() + 1));
      return { adminKey: settings.get('admin_key'), ...issueToken('admin') };
    },

    /** Жаңа касса сілтемесі: ескісі өшеді, кассирлердің барлық құрылғылары шығарылады. */
    rotateCashierKey() {
      settings.set('cashier_key', generateAdminKey());
      settings.set('cashier_version', String(cashierVersion() + 1));
      return { cashierKey: settings.get('cashier_key') };
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
      return { ...issueToken('admin'), passwordIsDefault: false };
    },

    /** Express middleware: тек әкімші (`Authorization: Bearer <token>`). Кассир токені → 403. */
    require(req, _res, next) {
      const role = tokenRole(bearer(req));
      if (!role) return next(new HttpError(401, 'unauthorized'));
      if (role !== 'admin') return next(new HttpError(403, 'forbidden'));
      req.role = role;
      next();
    },

    /** Express middleware: әкімші немесе кассир (касса беттері). */
    requireStaff(req, _res, next) {
      const role = tokenRole(bearer(req));
      if (!role) return next(new HttpError(401, 'unauthorized'));
      req.role = role;
      next();
    },
  };
}

export const PASSWORD_LIMITS = { min: MIN_PASSWORD, max: MAX_PASSWORD };
