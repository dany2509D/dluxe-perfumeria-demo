// Seguimiento de pedidos: la línea de tiempo de cada pedido (recibido → preparando → listo/enviado → entregado) y la consulta
// pública. Quien consulta necesita el código de seguimiento del pedido (largo, imposible de adivinar) o, si no lo tiene, el número
// del pedido junto con el correo o el teléfono con el que se compró.
import { randomBytes } from 'node:crypto';
import { HttpError } from './db.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newTrackingCode(db) {
  for (let i = 0; i < 6; i++) {
    const code = [...randomBytes(10)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    if (!db.prepare('SELECT 1 FROM orders WHERE tracking_code = ?').get(code)) return code;
  }
  throw new HttpError(500, 'No se pudo generar el código de seguimiento');
}

export function addEvent(db, orderId, kind, { note = '', userName = '', createdAt = null } = {}) {
  const cols = ['order_id', 'kind', 'note', 'user_name'];
  const vals = [orderId, kind, String(note).slice(0, 200), String(userName).slice(0, 80)];
  if (createdAt) { cols.push('created_at'); vals.push(createdAt); }
  db.prepare(`INSERT INTO order_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
}

export const eventsOf = (db, orderId) => db.prepare('SELECT kind, note, user_name, created_at FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);

export const LABELS = {
  recibido: 'Pedido recibido',
  pago_pendiente: 'Esperando el pago',
  pago_confirmado: 'Pago confirmado',
  pago_tardio: 'Pago recibido fuera de tiempo',
  preparando: 'Preparando tu pedido',
  listo: 'Listo para retirar en tienda',
  enviado: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  devolucion: 'Devolución registrada',
};

// Pasos que el personal marca a mano, en orden. «entregado» y «cancelado» se marcan con el estado del pedido.
export const PROGRESS_STEPS = ['preparando', 'listo', 'enviado'];

export function setProgress(db, orderId, step, actor) {
  if (!PROGRESS_STEPS.includes(step)) throw new HttpError(400, 'El paso no es válido');
  const o = db.prepare('SELECT id, status, delivery, channel FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new HttpError(404, 'Pedido no encontrado');
  if (o.status !== 'pagado') throw new HttpError(409, o.status === 'pendiente_pago' ? 'El pedido todavía no está pagado' : `El pedido ya está ${o.status}`);
  if (o.channel !== 'online') throw new HttpError(409, 'Los pedidos del mostrador no tienen seguimiento');
  if (step === 'listo' && o.delivery !== 'retiro') throw new HttpError(409, 'Este pedido es con envío a domicilio: márcalo como «En camino»');
  if (step === 'enviado' && o.delivery !== 'envio') throw new HttpError(409, 'Este pedido es para retirar en tienda: márcalo como «Listo para retirar»');
  const done = new Set(eventsOf(db, orderId).map((e) => e.kind));
  if (done.has(step)) throw new HttpError(409, 'Ese paso ya está registrado');
  const order = [...PROGRESS_STEPS];
  const later = order.slice(order.indexOf(step) + 1).some((s) => done.has(s));
  if (later) throw new HttpError(409, 'Ese pedido ya pasó por un paso posterior');
  addEvent(db, orderId, step, { userName: actor?.name || '' });
  return { ok: true };
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

function publicView(db, o) {
  const items = db
    .prepare(
      `SELECT oi.qty, oi.unit_price, oi.bundle_variant_id, v.size_ml, p.name, p.id AS product_id, p.image, p.color
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(o.id);
  const events = eventsOf(db, o.id);
  const route = o.delivery === 'envio' ? ['recibido', 'preparando', 'enviado', 'entregado'] : ['recibido', 'preparando', 'listo', 'entregado'];
  const reached = new Set(events.map((e) => e.kind));
  if (o.status === 'entregado') for (const k of route) reached.add(k);
  return {
    id: o.id, status: o.status, delivery: o.delivery, channel: o.channel, created_at: o.created_at, first_name: String(o.customer_name).split(/\s+/)[0],
    payment_pending: o.status === 'pendiente_pago',
    totals: { subtotal: o.subtotal, discount: o.discount, gift: o.gift_amount, total: o.total, refunded: o.refunded },
    items: items.map((i) => ({ name: i.name, size_ml: i.size_ml, qty: i.qty, unit_price: i.unit_price, product_id: i.product_id, image: i.image, color: i.color })),
    steps: o.status === 'cancelado' ? [] : route.map((k) => ({ kind: k, label: LABELS[k], done: reached.has(k), at: events.find((e) => e.kind === k)?.created_at || null })),
    cancelled: o.status === 'cancelado',
    events: events.map((e) => ({ kind: e.kind, label: LABELS[e.kind] || e.kind, note: e.kind === 'devolucion' ? e.note : '', at: e.created_at })),
  };
}

// code: código de seguimiento. O bien order + contact (correo o teléfono).
export function publicTrack(db, { code = '', order = null, contact = '' }) {
  let o = null;
  const c = String(code ?? '').trim().toUpperCase();
  if (c) {
    if (!/^[A-Z0-9]{10}$/.test(c)) throw new HttpError(404, 'No encontramos ese pedido. Revisa el código.');
    o = db.prepare('SELECT * FROM orders WHERE tracking_code = ?').get(c);
  } else {
    const id = Number(order);
    const who = String(contact ?? '').trim();
    if (!Number.isInteger(id) || id < 1 || !who) throw new HttpError(400, 'Escribe el número de pedido y el correo o teléfono con el que compraste');
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    const mail = who.includes('@') && String(row?.customer_email ?? '').toLowerCase() === who.toLowerCase();
    const d = digits(who);
    const phone = d.length >= 7 && digits(row?.customer_phone).endsWith(d.slice(-8));
    if (row && row.channel === 'online' && (mail || phone)) o = row;
  }
  if (!o || o.channel !== 'online') throw new HttpError(404, 'No encontramos ese pedido. Revisa los datos.');
  return publicView(db, o);
}
