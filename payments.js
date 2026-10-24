// Pagos en línea con pasarela externa.
//
// Hoy el pago con tarjeta de la demostración es simulado: se da por pagado al confirmar. Una pasarela real funciona distinto: la
// tienda reserva el pedido, manda al cliente a la página de pago de la pasarela y espera el aviso de que se pagó (o se rechazó).
// Aquí está esa mecánica completa; lo único que cambia entre pasarelas es el paso «crear el cobro», que depende de cada una.
//
//   PAYMENTS_PROVIDER=instant      (por defecto) el pago con tarjeta se da por hecho, como siempre. Simulado.
//   PAYMENTS_PROVIDER=demo-hosted  página de pago de ejemplo dentro de esta misma app (para ver el recorrido). Simulado.
//   PAYMENTS_PROVIDER=http         un servicio propio (por ejemplo un flujo de n8n) crea el cobro en la pasarela real:
//                                  PAYMENTS_CREATE_URL recibe { reference, amount, currency, description, customer, return_url, cancel_url }
//                                  y responde { url } (la página de pago). Cuando el cliente paga, ese servicio avisa a
//                                  POST /api/payments/webhook con { reference, status: "pagado"|"fallido" } y la firma
//                                  X-Signature: sha256=HMAC(PAYMENTS_WEBHOOK_SECRET, cuerpo).
// Mientras el pago está pendiente, el pedido ya descontó el stock (queda reservado). Si no se paga en PAYMENT_HOLD_MINUTES
// (30 por defecto), se cancela solo y el stock vuelve.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './db.js';

export const paymentConfigFromEnv = (env = process.env) => ({
  provider: ['demo-hosted', 'http'].includes(env.PAYMENTS_PROVIDER) ? env.PAYMENTS_PROVIDER : 'instant',
  createUrl: env.PAYMENTS_CREATE_URL || '',
  secret: env.PAYMENTS_WEBHOOK_SECRET || '',
  holdMinutes: Number(env.PAYMENT_HOLD_MINUTES) > 0 ? Number(env.PAYMENT_HOLD_MINUTES) : 30,
});

// ¿Este pago pasa por una pasarela externa (el pedido queda pendiente hasta que se pague)?
export const isHosted = (cfg) => cfg.provider === 'demo-hosted' || (cfg.provider === 'http' && /^https?:\/\//i.test(cfg.createUrl));

export const newReference = () => `PAY-${randomBytes(9).toString('hex').toUpperCase()}`;

export function recordAttempt(db, { orderId, provider, reference, amount }) {
  db.prepare('INSERT INTO payment_attempts (order_id, provider, reference, amount) VALUES (?, ?, ?, ?)').run(orderId, provider, reference, amount);
}

// Paso «crear el cobro»: devuelve la dirección a la que se manda al cliente para pagar.
export async function startCheckout(cfg, { reference, amount, currency, description, customer, baseUrl, orderCode, fetchImpl = fetch }) {
  const returnUrl = `${baseUrl}/#pedido/${orderCode}`;
  if (cfg.provider === 'demo-hosted') {
    return { url: `${baseUrl}/pago-demo.html?ref=${encodeURIComponent(reference)}&amount=${amount.toFixed(2)}&back=${encodeURIComponent(returnUrl)}` };
  }
  const res = await fetchImpl(cfg.createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, amount, currency, description, customer, return_url: returnUrl, cancel_url: returnUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`La pasarela respondió HTTP ${res.status}`);
  const out = await res.json().catch(() => ({}));
  if (!/^https:\/\//.test(out.url || '')) throw new Error('La pasarela no devolvió la página de pago');
  return { url: out.url };
}

export function verifySignature(raw, header, secret) {
  if (!secret || !header) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(header));
  return want.length === got.length && timingSafeEqual(want, got);
}

// Aplica el resultado de un pago. Es idempotente: avisar dos veces lo mismo no hace nada la segunda vez.
// `onPaid(order)` y `onFailed(order)` los pone la app (avisos, factura, cancelación).
export function settle(db, reference, status, { onPaid, onFailed, onLate = () => {} }) {
  if (!['pagado', 'fallido'].includes(status)) throw new HttpError(400, 'El estado del pago no es válido');
  const at = db.prepare('SELECT * FROM payment_attempts WHERE reference = ?').get(String(reference ?? ''));
  if (!at) throw new HttpError(404, 'Pago no encontrado');
  if (at.status !== 'pendiente') return { ok: true, repeated: true, status: at.status, order_id: at.order_id };
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(at.order_id);
  db.prepare("UPDATE payment_attempts SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, at.id);
  if (status === 'pagado') {
    if (order?.status === 'pendiente_pago') onPaid(at.order_id);
    else onLate(at.order_id); // la pasarela cobró un pedido que ya no esperaba el pago (venció o se canceló): hay que devolver ese dinero
  } else if (order?.status === 'pendiente_pago') onFailed(at.order_id);
  return { ok: true, repeated: false, status, order_id: at.order_id };
}

// Pedidos que llevan demasiado tiempo esperando el pago: se cancelan y el stock vuelve.
export function expirePending(db, cfg, { onExpired }) {
  const old = db
    .prepare(`SELECT id, order_id FROM payment_attempts WHERE status = 'pendiente' AND datetime(created_at, '+${Math.floor(cfg.holdMinutes)} minutes') < datetime('now','localtime')`)
    .all();
  for (const a of old) {
    db.prepare("UPDATE payment_attempts SET status = 'vencido', updated_at = datetime('now','localtime') WHERE id = ?").run(a.id);
    if (db.prepare("SELECT 1 FROM orders WHERE id = ? AND status = 'pendiente_pago'").get(a.order_id)) onExpired(a.order_id);
  }
  return old.length;
}
