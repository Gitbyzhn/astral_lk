import { badRequest } from '../errors.js';

export const DEFAULT_BUSINESS_NAME = 'Astral Labyrinth';

/** Кілт-мән түріндегі қарапайым баптаулар қоймасы. */
export function createSettings(db, { timeZone = 'Asia/Almaty', publicUrl = null } = {}) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );

  const get = (key, fallback = null) => getStmt.get(key)?.value ?? fallback;
  const set = (key, value) => void setStmt.run(key, String(value));

  return {
    get,
    set,

    /** Клиентке де көрінетін баптаулар. */
    publicInfo() {
      // pushKey — клиент телефонына хабарлама жазылымы үшін (VAPID ашық кілті)
      return { businessName: get('business_name', DEFAULT_BUSINESS_NAME), timeZone, publicUrl, pushKey: get('vapid_public') };
    },

    update(body) {
      if (body?.businessName !== undefined) {
        const name = String(body.businessName ?? '').trim().replace(/\s+/g, ' ');
        if (!name || name.length > 60) throw badRequest('invalid_business_name');
        set('business_name', name);
      }
      return this.publicInfo();
    },
  };
}
