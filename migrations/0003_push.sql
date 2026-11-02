-- 3: клиент телефонына хабарлама (Web Push) — талонға жазылған құрылғылар.
-- Барлық сұрау қайта орындалса да зиянсыз (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  order_id   INTEGER NOT NULL,
  endpoint   TEXT    NOT NULL,
  lang       TEXT    NOT NULL DEFAULT 'kk',
  next_sent  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  PRIMARY KEY (order_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions (endpoint);
