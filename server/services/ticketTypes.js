import { badRequest, notFound } from '../errors.js';
import { nowIso } from '../time.js';

export const PALETTE_SIZE = 8;
const MAX_NAME = 60;
const MAX_DESCRIPTION = 160;
const MAX_PRICE = 100_000_000;

const toType = (row) =>
  row && {
    id: row.id,
    name: row.name,
    price: row.price,
    description: row.description,
    color: row.color,
    active: row.active === 1,
    sort: row.sort,
  };

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

/** Билет түрлері: атауы, бағасы, түсі. Өшірілгені есептерде сақталуы үшін тек жасырылады. */
export function createTicketTypes(db) {
  const listAll = db.prepare('SELECT * FROM ticket_types WHERE deleted = 0 ORDER BY sort, id');
  const listActive = db.prepare('SELECT * FROM ticket_types WHERE deleted = 0 AND active = 1 ORDER BY sort, id');
  const byId = db.prepare('SELECT * FROM ticket_types WHERE id = ? AND deleted = 0');
  const usedColors = db.prepare('SELECT color FROM ticket_types WHERE deleted = 0');
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), -1) AS s FROM ticket_types WHERE deleted = 0');
  const insert = db.prepare(`
    INSERT INTO ticket_types (name, price, description, color, active, sort, created_at)
    VALUES (@name, @price, @description, @color, @active, @sort, @created_at)
  `);
  const softDelete = db.prepare('UPDATE ticket_types SET deleted = 1, active = 0 WHERE id = ? AND deleted = 0');
  const setSort = db.prepare('UPDATE ticket_types SET sort = ? WHERE id = ? AND deleted = 0');

  /** Әлі ешкім қолданбаған бірінші түс, бәрі бос болмаса — кезекпен. */
  function nextColor() {
    const used = usedColors.all().map((r) => r.color);
    for (let c = 0; c < PALETTE_SIZE; c++) if (!used.includes(c)) return c;
    return used.length % PALETTE_SIZE;
  }

  const api = {
    list({ includeInactive = false } = {}) {
      return (includeInactive ? listAll : listActive).all().map(toType);
    },

    get(id) {
      const row = byId.get(Number(id));
      if (!row) throw notFound('ticket_type_not_found');
      return toType(row);
    },

    create(body) {
      const data = parseInput(body, { partial: false });
      const info = insert.run({
        name: data.name,
        price: data.price,
        description: data.description ?? '',
        color: data.color ?? nextColor(),
        active: data.active ?? 1,
        sort: maxSort.get().s + 1,
        created_at: nowIso(),
      });
      return api.get(info.lastInsertRowid);
    },

    update(id, body) {
      api.get(id);
      const data = parseInput(body, { partial: true });
      const keys = Object.keys(data);
      if (keys.length) {
        const sets = keys.map((k) => `${k} = @${k}`).join(', ');
        db.prepare(`UPDATE ticket_types SET ${sets} WHERE id = @id`).run({ ...data, id: Number(id) });
      }
      return api.get(id);
    },

    remove(id) {
      if (softDelete.run(Number(id)).changes === 0) throw notFound('ticket_type_not_found');
    },

    reorder(ids) {
      if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id))) throw badRequest('invalid_order');
      db.transaction(() => ids.forEach((id, index) => setSort.run(index, id)))();
      return api.list({ includeInactive: true });
    },

    /** Алғашқы іске қосуда көрнекілік үшін бірнеше мысал түр. */
    seedExamples() {
      if (listAll.all().length) return;
      [
        { name: 'Ересек', price: 2000, description: '14 жастан бастап' },
        { name: 'Балалар', price: 1000, description: '3–13 жас' },
        { name: 'VIP', price: 5000, description: 'Жеке қызмет көрсету' },
      ].forEach((t) => api.create(t));
    },
  };
  return api;
}
