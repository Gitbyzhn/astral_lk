-- Astral кезек жүйесі: Cloudflare D1 схемасы (сервер нұсқасындағы SQLite-пен бірдей).
-- Барлық сұрау IF NOT EXISTS — қайта орындалса да зиянсыз.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_types (
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

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  number     INTEGER NOT NULL,
  day        TEXT    NOT NULL,
  hour       INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'serving', 'done', 'cancelled')),
  people     INTEGER NOT NULL CHECK (people > 0),
  total      INTEGER NOT NULL CHECK (total >= 0),
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL,
  called_at  TEXT,
  done_at    TEXT,
  UNIQUE (day, number)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, id);

CREATE INDEX IF NOT EXISTS idx_orders_day ON orders (day);

CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  ticket_type_id INTEGER REFERENCES ticket_types (id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  price          INTEGER NOT NULL CHECK (price >= 0),
  qty            INTEGER NOT NULL CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id);

CREATE INDEX IF NOT EXISTS idx_items_type ON order_items (ticket_type_id);

-- Өзгеріс есептегіштері: беттер әр 10 секунд сайын осыны тексеріп, өзгеріс болса ғана деректі жүктейді
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('queue', 0), ('types', 0), ('settings', 0);

-- Құпиясөзді/сілтемені болжауға тосқауыл (IP бойынша)
CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
