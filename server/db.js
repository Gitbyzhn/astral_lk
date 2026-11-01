import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * Схема нұсқалары. Жаңа өзгеріс керек болса — тізімнің соңына жаңа элемент қосылады,
 * бұрынғылары ешқашан өзгертілмейді (PRAGMA user_version арқылы бақыланады).
 */
const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE ticket_types (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    price       INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
    description TEXT    NOT NULL DEFAULT '',
    color       INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,
    deleted     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
  );

  CREATE TABLE orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT    NOT NULL UNIQUE,
    number     INTEGER NOT NULL,
    day        TEXT    NOT NULL,
    hour       INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting', 'serving', 'done', 'cancelled')),
    people     INTEGER NOT NULL CHECK (people > 0),
    total      INTEGER NOT NULL CHECK (total >= 0),
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    called_at  TEXT,
    done_at    TEXT,
    UNIQUE (day, number)
  );
  CREATE INDEX idx_orders_status ON orders (status, id);
  CREATE INDEX idx_orders_day ON orders (day);

  CREATE TABLE order_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    ticket_type_id INTEGER REFERENCES ticket_types (id) ON DELETE SET NULL,
    name           TEXT    NOT NULL,
    price          INTEGER NOT NULL CHECK (price >= 0),
    qty            INTEGER NOT NULL CHECK (qty > 0)
  );
  CREATE INDEX idx_items_order ON order_items (order_id);
  CREATE INDEX idx_items_type ON order_items (ticket_type_id);
  `,
];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/**
 * @param {string} [file] SQLite файлының жолы немесе ':memory:' (тесттер үшін)
 */
export function openDatabase(file = path.join(config.dataDir, 'astral.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
