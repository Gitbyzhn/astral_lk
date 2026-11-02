import { badRequest, notFound } from '../errors.js';
import { MAX_PAYMENT_METHODS, effectiveDefault, paymentList, paymentName } from '../orderLines.js';

/**
 * Төлем түрлері: Наличка, Каспий, Банк… Біреуі әдепкі — кассада алдын ала таңдалып тұрады.
 * Жойылғаны бұрынғы есептерде атауымен сақталуы үшін тек белгіленеді (deleted = 1).
 */
export function createPaymentMethods(db, settings) {
  const listStmt = db.prepare('SELECT id, name FROM payment_methods WHERE deleted = 0 ORDER BY id');
  const byId = db.prepare('SELECT id FROM payment_methods WHERE id = ? AND deleted = 0');
  const insert = db.prepare('INSERT INTO payment_methods (name) VALUES (?)');
  const rename = db.prepare('UPDATE payment_methods SET name = ? WHERE id = ? AND deleted = 0');
  const softDelete = db.prepare('UPDATE payment_methods SET deleted = 1 WHERE id = ? AND deleted = 0');

  const list = () => paymentList(listStmt.all(), settings.get('default_payment_method'));

  function get(id) {
    const method = list().find((m) => m.id === Number(id));
    if (!method) throw notFound('payment_method_not_found');
    return method;
  }

  return {
    list,
    get,
    defaultId: () => effectiveDefault(listStmt.all(), settings.get('default_payment_method')),
    exists: (id) => Boolean(byId.get(Number(id))),

    create(body) {
      const name = paymentName(body?.name);
      if (listStmt.all().length >= MAX_PAYMENT_METHODS) throw badRequest('too_many_payment_methods');
      const id = Number(insert.run(name).lastInsertRowid);
      if (body?.isDefault === true) settings.set('default_payment_method', id);
      return get(id);
    },

    update(id, body) {
      get(id);
      if (body?.name !== undefined) rename.run(paymentName(body.name), Number(id));
      if (body?.isDefault === true) settings.set('default_payment_method', Number(id));
      return get(id);
    },

    remove(id) {
      if (!softDelete.run(Number(id)).changes) throw notFound('payment_method_not_found');
    },
  };
}
