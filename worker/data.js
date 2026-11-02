// D1 деректер базасы: схема (нұсқалары бойынша), бастапқы деректер, баптаулар, өзгеріс есептегіштері.
import schema1 from '../migrations/0001_init.sql';
import schema2 from '../migrations/0002_payments_kassa.sql';
import { hashPassword, generateAdminKey } from './auth.js';
import { nowIso } from './time.js';

const split = (sql) =>
  sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);

/** Схема нұсқалары: жаңасы тізім соңына қосылады, бұрынғылары өзгертілмейді. */
const MIGRATIONS = [schema1, schema2].map(split);
const ADD_COLUMN = /^ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN/i;

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

async function schemaVersion(db) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first();
    return Number(row?.value ?? 0);
  } catch {
    return 0; // жаңа база — кестелер әлі жоқ
  }
}

/**
 * Жетіспейтін схема нұсқаларын орындайды. Бар деректер өзгермейді.
 * Бірнеше изолят қатар бастаса да қауіпсіз: кестелер IF NOT EXISTS, жазбалар INSERT OR IGNORE,
 * ал бағанды екінші рет қосу қатесі («duplicate column») елеусіз қалдырылады.
 */
async function migrate(db) {
  for (let v = await schemaVersion(db); v < MIGRATIONS.length; v++) {
    const plain = MIGRATIONS[v].filter((sql) => !ADD_COLUMN.test(sql));
    if (plain.length) await db.batch(plain.map((sql) => db.prepare(sql)));
    for (const sql of MIGRATIONS[v].filter((s) => ADD_COLUMN.test(s))) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        if (!/duplicate column/i.test(String(err?.message))) throw err;
      }
    }
    await setSetting(db, 'schema_version', v + 1).run();
  }
}

async function init(env) {
  const db = env.DB;
  await migrate(db);
  const settings = await getSettings(db);
  const stmts = [];
  const put = (key, value) => stmts.push(db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(key, String(value)));

  if (!settings.has('auth_secret')) put('auth_secret', generateAdminKey(43));
  if (!settings.has('admin_key')) put('admin_key', generateAdminKey());
  if (!settings.has('cashier_key')) put('cashier_key', generateAdminKey());
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
