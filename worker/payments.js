// Төлем түрлері (Cloudflare D1) — server/services/paymentMethods.js логикасымен бірдей.
import { badRequest, notFound } from '../server/errors.js';
import { MAX_PAYMENT_METHODS, paymentList, paymentName } from '../server/orderLines.js';
import { bump, setSetting } from './data.js';

const LIST_SQL = 'SELECT id, name FROM payment_methods WHERE deleted = 0 ORDER BY id';

/** @param {Map<string, string>} settings  баптаулар (әдепкі төлем түрі сол жерде) */
export async function listPayments(db, settings) {
  return paymentList((await db.prepare(LIST_SQL).all()).results, settings.get('default_payment_method'));
}

async function getPayment(db, settings, id) {
  const method = (await listPayments(db, settings)).find((m) => m.id === Number(id));
  if (!method) throw notFound('payment_method_not_found');
  return method;
}

export async function createPayment(db, settings, body) {
  const name = paymentName(body?.name);
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM payment_methods WHERE deleted = 0').first();
  if (n >= MAX_PAYMENT_METHODS) throw badRequest('too_many_payment_methods');
  const [inserted] = await db.batch([db.prepare('INSERT INTO payment_methods (name) VALUES (?)').bind(name), bump(db, 'types')]);
  const id = inserted.meta.last_row_id;
  if (body?.isDefault === true) {
    await setSetting(db, 'default_payment_method', id).run();
    settings.set('default_payment_method', String(id));
  }
  return getPayment(db, settings, id);
}

export async function updatePayment(db, settings, id, body) {
  await getPayment(db, settings, id);
  const stmts = [];
  if (body?.name !== undefined) {
    stmts.push(db.prepare('UPDATE payment_methods SET name = ? WHERE id = ? AND deleted = 0').bind(paymentName(body.name), Number(id)));
  }
  if (body?.isDefault === true) {
    stmts.push(setSetting(db, 'default_payment_method', Number(id)));
    settings.set('default_payment_method', String(Number(id)));
  }
  if (stmts.length) await db.batch([...stmts, bump(db, 'types')]);
  return getPayment(db, settings, id);
}

export async function removePayment(db, id) {
  const [result] = await db.batch([
    db.prepare('UPDATE payment_methods SET deleted = 1 WHERE id = ? AND deleted = 0').bind(Number(id) || 0),
    bump(db, 'types'),
  ]);
  if (!result.meta.changes) throw notFound('payment_method_not_found');
}
