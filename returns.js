// Devoluciones: el cliente devuelve una parte o todo de un pedido ya pagado.
//   · Se devuelve el precio que realmente pagó (si el pedido tuvo descuento, se prorratea).
//   · El producto vuelve al inventario, salvo que llegue dañado (se anota sin reponer el stock).
//   · El dinero sale por una de tres vías: efectivo de la caja, el mismo método de pago (se hace aparte, en el banco) o una nota de
//     crédito: una tarjeta de regalo con ese saldo.
//   · Un pedido pagado con tarjeta de regalo solo se devuelve como nota de crédito.
import { HttpError, tx, getSetting } from './db.js';
import { addEvent } from './tracking.js';
import { issueCard } from './giftcards.js';
import { recordDocument } from './invoicing.js';
import { enqueue } from './notify.js';
import { currentShift } from './shifts.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const REFUND_METHODS = ['efectivo', 'metodo_original', 'nota_credito'];

export const returnDays = (db) => Math.max(0, Number(getSetting(db, 'return_days', '30')) || 0);

// Lo que se puede devolver de un pedido, línea por línea, con el valor que se reintegra por unidad.
export function returnable(db, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new HttpError(404, 'Pedido no encontrado');
  const ratio = o.subtotal > 0 ? o.discount / o.subtotal : 0;
  const items = db
    .prepare(
      `SELECT oi.id, oi.variant_id, oi.qty, oi.returned_qty, oi.unit_price, oi.unit_cost, oi.bundle_variant_id, oi.bundle_units, v.sku, v.size_ml, p.name
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(orderId)
    .map((i) => ({ ...i, unit_refund: round2(i.unit_price * (1 - ratio)), available: i.qty - i.returned_qty }));
  const days = db.prepare("SELECT CAST(julianday(date('now','localtime')) - julianday(date(?)) AS INTEGER) AS d").get(o.created_at).d;
  const window = returnDays(db);
  const refundable = round2(o.total - o.refunded);
  return {
    order: { id: o.id, status: o.status, channel: o.channel, payment_method: o.payment_method, total: o.total, refunded: o.refunded, gift_amount: o.gift_amount, customer_name: o.customer_name, created_at: o.created_at },
    items, days_since: days, window_days: window, in_window: days <= window, refundable,
    allowed_methods: o.gift_amount > 0 ? ['nota_credito'] : o.channel === 'mostrador' && o.payment_method === 'efectivo' ? ['efectivo', 'nota_credito'] : ['metodo_original', 'nota_credito', 'efectivo'],
    can_return: ['pagado', 'entregado'].includes(o.status) && refundable > 0 && items.some((i) => i.available > 0),
  };
}

// body: { items: [{ order_item_id, qty, restock }], reason, refund_method, override_window }
export function createReturn(db, orderId, body, { actor, fiscal, brand, baseUrl = '', canOverride = false }) {
  const reason = String(body.reason ?? '').trim().slice(0, 160);
  if (!reason) throw new HttpError(400, 'Indica el motivo de la devolución');
  const method = body.refund_method;
  if (!REFUND_METHODS.includes(method)) throw new HttpError(400, 'La forma de devolver el dinero no es válida');
  if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Elige qué productos se devuelven');

  return tx(db, () => {
    const info = returnable(db, orderId);
    if (!['pagado', 'entregado'].includes(info.order.status)) throw new HttpError(409, `No se puede devolver un pedido ${info.order.status === 'cancelado' ? 'cancelado' : 'sin pagar'}`);
    if (!info.in_window && !(body.override_window && canOverride)) {
      throw new HttpError(409, `Pasaron ${info.days_since} días: el plazo de devolución es de ${info.window_days}${canOverride ? '. Un gerente puede autorizarla.' : ''}`);
    }
    if (!info.allowed_methods.includes(method)) {
      throw new HttpError(409, info.order.gift_amount > 0 ? 'Este pedido se pagó con tarjeta de regalo: solo se devuelve como nota de crédito' : 'Esa forma de devolución no aplica a este pedido');
    }
    const lines = [];
    const seen = new Set();
    for (const raw of body.items) {
      const id = Number(raw.order_item_id);
      const qty = Number(raw.qty);
      const item = info.items.find((i) => i.id === id);
      if (!item) throw new HttpError(400, 'Uno de los productos no pertenece a este pedido');
      if (seen.has(id)) throw new HttpError(400, 'Un producto está repetido');
      seen.add(id);
      if (!Number.isInteger(qty) || qty < 1) throw new HttpError(400, 'La cantidad a devolver no es válida');
      if (qty > item.available) throw new HttpError(409, `De ${item.name}${item.size_ml ? ` ${item.size_ml} ml` : ''} solo se pueden devolver ${item.available}`);
      lines.push({ item, qty, restock: raw.restock === false || raw.restock === 0 ? 0 : 1 });
    }
    let amount = round2(lines.reduce((s, l) => s + l.qty * l.item.unit_refund, 0));
    amount = Math.min(amount, info.refundable); // por centavos de redondeo, nunca más de lo que se pagó
    if (amount <= 0) throw new HttpError(400, 'No hay nada que reintegrar');

    let shiftId = null;
    if (method === 'efectivo') {
      const shift = actor ? currentShift(db, actor.id) : null;
      if (!shift) throw new HttpError(409, 'Para devolver efectivo abre tu caja: ese dinero sale de ella');
      shiftId = shift.id;
    } else if (actor) {
      shiftId = currentShift(db, actor.id)?.id ?? null;
    }

    const r = db
      .prepare('INSERT INTO returns (order_id, user_id, user_name, shift_id, reason, refund_method, amount) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(orderId, actor?.id ?? null, actor?.name ?? '', shiftId, reason, method, amount);
    const returnId = Number(r.lastInsertRowid);
    const insItem = db.prepare('INSERT INTO return_items (return_id, order_item_id, variant_id, qty, unit_refund, unit_cost, restock) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const mov = db.prepare("INSERT INTO stock_movements (variant_id, type, qty, reason, ref_type, ref_id, user_name) VALUES (?, 'entrada', ?, ?, 'return', ?, ?)");
    for (const { item, qty, restock } of lines) {
      insItem.run(returnId, item.id, item.variant_id, qty, item.unit_refund, item.unit_cost, restock);
      db.prepare('UPDATE order_items SET returned_qty = returned_qty + ? WHERE id = ?').run(qty, item.id);
      db.prepare('UPDATE products SET sold = MAX(0, sold - ?) WHERE id = (SELECT product_id FROM variants WHERE id = ?)').run(qty, item.variant_id);
      if (restock) mov.run(item.variant_id, qty, `Devolución #${returnId} del pedido #${orderId}`, returnId, actor?.name ?? null);
    }
    db.prepare('UPDATE orders SET refunded = round(refunded + ?, 2) WHERE id = ?').run(amount, orderId);

    let credit = null;
    if (method === 'nota_credito') {
      const o = db.prepare('SELECT customer_name, customer_email, customer_phone, notify_opt_in FROM orders WHERE id = ?').get(orderId);
      credit = issueCard(db, { amount, buyer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone }, recipient: { name: o.customer_name, email: o.customer_email }, message: `Nota de crédito por la devolución del pedido #${orderId}`, source: 'nota_credito', paymentMethod: null, user: actor, shiftId });
      db.prepare('UPDATE returns SET credit_code = ? WHERE id = ?').run(credit.code, returnId);
      const expires = credit.expires_at;
      if (o.customer_email) enqueue(db, { channel: 'email', to: o.customer_email, template: 'tarjeta_regalo_comprador', payload: { name: o.customer_name, amount, recipient: 'tu nota de crédito', code: credit.code, expires_at: expires }, key: `nc:${returnId}:email` });
      if (o.notify_opt_in && o.customer_phone) enqueue(db, { channel: 'whatsapp', to: o.customer_phone, template: 'tarjeta_regalo_comprador', payload: { name: o.customer_name, amount, recipient: 'tu nota de crédito', code: credit.code, expires_at: expires }, key: `nc:${returnId}:wa` });
    }
    addEvent(db, orderId, 'devolucion', { note: `Se devolvieron ${lines.reduce((s, l) => s + l.qty, 0)} artículo(s) · $${amount.toFixed(2)}`, userName: actor?.name || '' });
    const doc = recordDocument(db, orderId, 'nota_credito', { cfg: fiscal, brand, returnId, amount });
    return { id: returnId, amount, refund_method: method, credit_code: credit?.code ?? null, shift_id: shiftId, fiscal_doc_id: doc };
  });
}

export function listReturns(db, { orderId = null, page = 1, limit = 40 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 40, 100));
  const pg = Math.max(1, Number(page) || 1);
  const where = orderId ? 'WHERE r.order_id = ?' : '';
  const a = orderId ? [orderId] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM returns r ${where}`).get(...a).n;
  const rows = db
    .prepare(
      `SELECT r.*, o.customer_name,
              (SELECT SUM(qty) FROM return_items WHERE return_id = r.id) AS units
         FROM returns r JOIN orders o ON o.id = r.order_id ${where} ORDER BY r.id DESC LIMIT ? OFFSET ?`
    )
    .all(...a, lim, (pg - 1) * lim);
  return { rows, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
}
