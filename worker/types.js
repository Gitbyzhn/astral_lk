// Билет түрлері (Cloudflare D1) — server/services/ticketTypes.js логикасымен бірдей.
import { badRequest, notFound } from '../server/errors.js';
import { nowIso } from './time.js';
import { bump } from './data.js';

const PALETTE_SIZE = 8;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 160;
const MAX_PRICE = 100_000_000;

const toType = (row) => ({
  id: row.id,
  name: row.name,
  price: row.price,
  description: row.description,
  color: row.color,
  active: row.active === 1,
  sort: row.sort,
});

function parseInput(body = {}, { partial }) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) throw badRequest('invalid_name');
    out.name = name;
  }
  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) throw badRequest('invalid_price');
    out.price = price;
  }
  if (body.description !== undefined) {
    const description = String(body.description ?? '').trim();
    if (description.length > MAX_DESCRIPTION) throw badRequest('invalid_description');
    out.description = description;
  }
  if (body.color !== undefined) {
    const color = Number(body.color);
    if (!Number.isInteger(color) || color < 0 || color >= PALETTE_SIZE) throw badRequest('invalid_color');
    out.color = color;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return out;
}

export async function listTypes(db, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM ticket_types WHERE deleted = 0 ORDER BY sort, id'
    : 'SELECT * FROM ticket_types WHERE deleted = 0 AND active = 1 ORDER BY sort, id';
  return (await db.prepare(sql).all()).results.map(toType);
}

export async function getType(db, id) {
  const row = await db.prepare('SELECT * FROM ticket_types WHERE id = ? AND deleted = 0').bind(Number(id) || 0).first();
  if (!row) throw notFound('ticket_type_not_found');
  return toType(row);
}

export async function createType(db, body) {
  const data = parseInput(body, { partial: false });
  let color = data.color;
  if (color === undefined) {
    const used = (await db.prepare('SELECT color FROM ticket_types WHERE deleted = 0').all()).results.map((r) => r.color);
    color = [...Array(PALETTE_SIZE).keys()].find((c) => !used.includes(c)) ?? used.length % PALETTE_SIZE;
  }
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO ticket_types (name, price, description, color, active, sort, created_at)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM ticket_types WHERE deleted = 0), ?)`,
      )
      .bind(data.name, data.price, data.description ?? '', color, data.active ?? 1, nowIso()),
    bump(db, 'types'),
  ]);
  return getType(db, inserted.meta.last_row_id);
}

export async function updateType(db, id, body) {
  await getType(db, id);
  const data = parseInput(body, { partial: true });
  const keys = Object.keys(data); // тек рұқсат етілген өрістер (parseInput)
  if (keys.length) {
    await db.batch([
      db.prepare(`UPDATE ticket_types SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => data[k]), Number(id)),
      bump(db, 'types'),
    ]);
  }
  return getType(db, id);
}

export async function removeType(db, id) {
  const [result] = await db.batch([
    db.prepare('UPDATE ticket_types SET deleted = 1, active = 0 WHERE id = ? AND deleted = 0').bind(Number(id) || 0),
    bump(db, 'types'),
  ]);
  if (!result.meta.changes) throw notFound('ticket_type_not_found');
}

export async function reorderTypes(db, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !Number.isInteger(id))) throw badRequest('invalid_order');
  await db.batch([
    ...ids.map((id, index) => db.prepare('UPDATE ticket_types SET sort = ? WHERE id = ? AND deleted = 0').bind(index, id)),
    bump(db, 'types'),
  ]);
  return listTypes(db, { includeInactive: true });
}
