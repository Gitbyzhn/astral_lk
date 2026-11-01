// D1 деректер базасы: схема, бастапқы деректер, баптаулар, өзгеріс есептегіштері.
import schemaSql from '../migrations/0001_init.sql';
import { hashPassword, generateAdminKey } from './auth.js';
import { nowIso } from './time.js';

const STATEMENTS = schemaSql
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);

const EXAMPLE_TYPES = [
  ['Ересек', 2000, '14 жастан бастап', 0, 0],
  ['Балалар', 1000, '3–13 жас', 1, 1],
  ['VIP', 5000, 'Жеке қызмет көрсету', 2, 2],
];

let ready = null;

/** Изолят басталғанда бір рет: кестелер (жоқ болса) және алғашқы деректер. */
export function ensureReady(env) {
  ready ??= init(env).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

async function init(env) {
  const db = env.DB;
  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
  const settings = await getSettings(db);
  const stmts = [];
  const put = (key, value) => stmts.push(db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, String(value)));

  if (!settings.has('auth_secret')) put('auth_secret', generateAdminKey(43));
  if (!settings.has('admin_key')) put('admin_key', generateAdminKey());
  if (!settings.has('password_version')) put('password_version', 1);
  if (!settings.has('admin_password')) {
    const initial = env.ADMIN_PASSWORD || 'admin';
    put('admin_password', await hashPassword(initial));
    put('password_is_default', initial === 'admin' ? 1 : 0);
  }
  if (!settings.has('seeded')) {
    const now = nowIso();
    for (const [name, price, description, color, sort] of EXAMPLE_TYPES) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO ticket_types (name, price, description, color, active, sort, created_at)
             SELECT ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'seeded')`,
          )
          .bind(name, price, description, color, sort, now),
      );
    }
    // «seeded» белгісі түрлерден кейін жазылады (бір транзакцияда): бірнеше изолят қатар
    // іске қосылса да мысал түрлер бір-ақ рет қосылады
    put('seeded', 1);
  }
  if (stmts.length) await db.batch(stmts);
}

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  return new Map(results.map((r) => [r.key, r.value]));
}

export const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, String(value));

/** Өзгеріс есептегішін арттыру (беттер осыны тексеріп, жаңа деректі жүктейді). */
export const bump = (db, key) => db.prepare('UPDATE meta SET value = value + 1 WHERE key = ?').bind(key);

export async function versions(db) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
