-- 2: төлем түрлері (Наличка, Каспий, Банк; әдепкісі — Каспий) және әр билет жолының төлем түрі.
-- Worker бұл файлды өзі бір рет орындайды (worker/data.js, settings.schema_version бойынша).
CREATE TABLE IF NOT EXISTS payment_methods (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT    NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO payment_methods (id, name) VALUES (1, 'Наличка'), (2, 'Каспий'), (3, 'Банк');

INSERT OR IGNORE INTO settings (key, value) VALUES ('default_payment_method', '2');

-- Бұрынғы тапсырыстарда бос қалады (есепте «Көрсетілмеген»)
ALTER TABLE order_items ADD COLUMN payment_method_id INTEGER;
