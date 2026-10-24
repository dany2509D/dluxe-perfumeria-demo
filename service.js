// Lógica de negocio. El stock nunca se escribe directo: siempre se inserta un
// movimiento y los triggers de db.js hacen el resto.
import { HttpError, tx, getSetting, setSetting } from './db.js';
import { norm, searchText } from './text.js';
import { CATEGORIES, UNCLASSIFIED, KINDS, bumpCatalog } from './catalog.js';
import { expandLines } from './bundles.js';
import * as pricing from './pricing.js';
import * as gift from './giftcards.js';
import { newTrackingCode, addEvent, eventsOf, setProgress } from './tracking.js';
import { notifyOrderStep } from './notify.js';
import { recordDocument, documentsOfOrder } from './invoicing.js';
import { currentShift } from './shifts.js';
import { newReference, recordAttempt } from './payments.js';
import { pruneUnused } from './media.js';

export { CATEGORIES, KINDS };

// ─── Validación ────────────────────────────────────────────────────────────
const int = (v, name, { min = 0, max = 1_000_000 } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} no es válido`);
  return n;
};
const money = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, `${name} no es válido`);
  return Math.round(n * 100) / 100;
};
const text = (v, name, { max = 160, required = true } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new HttpError(400, `${name} es obligatorio`);
  return s.slice(0, max);
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw new HttpError(400, `${name} no es válido`);
  return v;
};

export const ONLINE_PAYMENTS = ['tarjeta', 'transferencia', 'contra_entrega'];
export const POS_PAYMENTS = ['efectivo', 'tarjeta', 'transferencia'];

// ─── Reposición automática ─────────────────────────────────────────────────
// Si una variante cae al mínimo y no tiene compra pendiente, se agrega a una
// orden de compra "pendiente" de su proveedor. Solo falta marcarla como recibida.
export function autoReplenish(db, { force = false } = {}) {
  if (!force && getSetting(db, 'auto_reorder', '1') !== '1') return { items: 0, purchases: 0 };

  const low = db
    .prepare(
      `SELECT v.id, v.supplier_id, v.reorder_qty, v.cost
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1 AND v.supplier_id IS NOT NULL AND v.is_set = 0
          AND v.stock <= v.min_stock
          AND NOT EXISTS (
            SELECT 1 FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
             WHERE pi.variant_id = v.id AND pu.status = 'pendiente')`
    )
    .all();

  const touched = new Set();
  for (const v of low) {
    let pu = db
      .prepare(`SELECT id FROM purchases WHERE supplier_id = ? AND status = 'pendiente' AND auto = 1 ORDER BY id DESC LIMIT 1`)
      .get(v.supplier_id);
    if (!pu) {
      const r = db
        .prepare(`INSERT INTO purchases (supplier_id, auto, notes) VALUES (?, 1, 'Generada automáticamente por stock bajo')`)
        .run(v.supplier_id);
      pu = { id: Number(r.lastInsertRowid) };
    }
    db.prepare('INSERT INTO purchase_items (purchase_id, variant_id, qty, unit_cost) VALUES (?, ?, ?, ?)').run(
      pu.id,
      v.id,
      Math.max(1, v.reorder_qty),
      v.cost
    );
    touched.add(pu.id);
  }
  return { items: low.length, purchases: touched.size };
}

// ─── Ventas ────────────────────────────────────────────────────────────────
// `services` (lo arma la app en cada petición) trae lo que el pedido necesita de afuera: { brand, baseUrl, fiscal, hostedPayments }.
// Sin él (pruebas, semilla) todo sigue funcionando: simplemente no se emiten facturas ni se arman enlaces.
export function createOrder(db, input, { channel = 'online', created_at = null, skipReplenish = false, actor = null, customerId = null, services = {}, manualCapPct = Infinity } = {}) {
  const isPos = channel === 'mostrador';
  const customer = input.customer || {};
  const name = isPos ? text(customer.name || 'Cliente mostrador', 'Nombre') : text(customer.name, 'Nombre', { max: 80 });
  let email = text(customer.email, 'Correo', { max: 120, required: !isPos });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'El correo no es válido');
  const phone = text(customer.phone, 'Teléfono', { max: 30, required: !isPos });
  let payment = oneOf(input.payment_method, isPos ? POS_PAYMENTS : ONLINE_PAYMENTS, 'El método de pago');

  let delivery = null;
  let address = '';
  if (!isPos) {
    delivery = oneOf(input.delivery, ['retiro', 'envio'], 'La entrega');
    if (delivery === 'envio') address = text(input.address, 'La dirección de envío', { max: 200 });
  }

  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(400, 'La bolsa está vacía');
  if (input.items.length > 50) throw new HttpError(400, 'Demasiados productos en un solo pedido');
  const wanted = new Map();
  for (const it of input.items) {
    const id = int(it.variant_id, 'Producto', { min: 1 });
    const qty = int(it.qty, 'Cantidad', { min: 1, max: 99 });
    wanted.set(id, (wanted.get(id) || 0) + qty);
  }
  const manual = isPos && input.discount && typeof input.discount === 'object' ? input.discount : null;

  return tx(db, () => {
    const { items, lines: priceLines } = expandLines(db, wanted);
    const q = pricing.quote(db, { lines: priceLines, coupon: input.coupon, channel, email, manual, day: created_at ? String(created_at).slice(0, 10) : null });
    if (manual && manualCapPct < 100 && q.subtotal > 0 && (q.discount / q.subtotal) * 100 > manualCapPct + 1e-9) {
      throw new HttpError(403, `Tu rol permite descontar hasta ${manualCapPct}%: pide autorización a un gerente`);
    }
    const subtotal = q.subtotal;
    const discount = q.discount;
    const total = round2(subtotal - discount);

    // Tarjeta de regalo: paga lo que alcance su saldo; el resto, con el método elegido.
    let card = null;
    let giftUse = 0;
    if (String(input.gift_code ?? '').trim()) {
      card = gift.usableCard(db, input.gift_code);
      giftUse = round2(Math.min(card.balance, total));
    }
    const due = round2(total - giftUse);
    if (due === 0 && giftUse > 0) payment = 'tarjeta_regalo';

    const hosted = !isPos && !!services.hostedPayments && payment === 'tarjeta' && due > 0;
    const status = hosted ? 'pendiente_pago' : 'pagado';
    const shift = isPos && actor ? currentShift(db, actor.id) : null;
    if (isPos && !shift && getSetting(db, 'require_shift', '0') === '1') throw new HttpError(409, 'Abre tu caja antes de cobrar');

    const cols = ['channel', 'customer_name', 'customer_email', 'customer_phone', 'delivery', 'address', 'payment_method', 'status', 'subtotal', 'discount', 'total',
      'gift_code', 'gift_amount', 'coupon_code', 'promo_label', 'customer_id', 'user_id', 'user_name', 'shift_id', 'tracking_code', 'notify_opt_in'];
    const vals = [channel, name, email || null, phone || null, delivery, address || null, payment, status, subtotal, discount, total,
      card?.code ?? null, giftUse, q.applied?.code ?? null, q.applied?.name ?? null, customerId, actor?.id ?? null, actor?.name ?? null, shift?.id ?? null,
      isPos ? null : newTrackingCode(db), !isPos && input.notify_opt_in ? 1 : 0];
    if (created_at) {
      cols.push('created_at');
      vals.push(created_at);
    }
    const r = db.prepare(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    const orderId = Number(r.lastInsertRowid);

    // El trigger trg_item_sale descuenta el stock por cada línea.
    const ins = db.prepare('INSERT INTO order_items (order_id, variant_id, qty, unit_price, unit_cost, bundle_variant_id, bundle_units) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of items) ins.run(orderId, row.variant_id, row.qty, row.unit_price, row.unit_cost, row.bundle_variant_id, row.bundle_units);

    if (card && giftUse > 0) gift.redeem(db, card, giftUse, orderId);
    if (q.applied?.code) pricing.consume(db, q.applied.code);

    const ev = { createdAt: created_at, userName: actor?.name || '' };
    if (!isPos) addEvent(db, orderId, 'recibido', ev);
    let payInfo = null;
    if (hosted) {
      const reference = newReference();
      recordAttempt(db, { orderId, provider: services.paymentProvider || 'hosted', reference, amount: due });
      addEvent(db, orderId, 'pago_pendiente', ev);
      payInfo = { reference, amount: due };
    }

    const replenished = skipReplenish ? { items: 0, purchases: 0 } : autoReplenish(db);
    const order = getOrder(db, orderId);
    if (status === 'pagado') afterPaid(db, order, { services, historical: !!created_at, createdAt: created_at });
    return { ...order, replenished, payment: payInfo, applied: q.applied, coupon_note: q.couponNote };
  });
}

// Lo que sigue a un pedido pagado: factura y aviso de confirmación (las ventas históricas de la semilla no avisan a nadie).
function afterPaid(db, order, { services = {}, historical = false, createdAt = null }) {
  recordDocument(db, order.id, 'factura', { cfg: services.fiscal, brand: services.brand, createdAt });
  if (!historical && order.channel === 'online') notifyOrderStep(db, order, 'recibido', { baseUrl: services.baseUrl, brand: services.brand });
}

export function getOrder(db, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  order.items = db
    .prepare(
      `SELECT oi.id, oi.qty, oi.returned_qty, oi.unit_price, oi.bundle_variant_id, oi.bundle_units, v.id AS variant_id, v.size_ml, v.sku, p.name, p.brand, p.color
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(id);
  return order;
}

// Todo lo de un pedido para la ficha del panel: líneas, historial, devoluciones, pagos y facturas.
export function getOrderDetail(db, id) {
  const order = getOrder(db, id);
  const setNames = new Map(db.prepare('SELECT v.id, p.name FROM variants v JOIN products p ON p.id = v.product_id WHERE v.is_set = 1').all().map((r) => [r.id, r.name]));
  for (const i of order.items) i.bundle_name = i.bundle_variant_id ? setNames.get(i.bundle_variant_id) || 'Set de regalo' : null;
  order.events = eventsOf(db, id);
  order.returns = db.prepare('SELECT id, amount, refund_method, reason, credit_code, user_name, created_at FROM returns WHERE order_id = ? ORDER BY id').all(id);
  order.payments = db.prepare('SELECT provider, reference, amount, status, created_at, updated_at FROM payment_attempts WHERE order_id = ? ORDER BY id').all(id);
  order.documents = documentsOfOrder(db, id);
  order.paid_amount = round2(order.total - order.gift_amount);
  return order;
}

export function listOrders(db, { limit = 200, status = '', q = '' } = {}) {
  const w = ['1 = 1'];
  const a = [];
  if (['pendiente_pago', 'pagado', 'entregado', 'cancelado'].includes(status)) { w.push('status = ?'); a.push(status); }
  const term = String(q ?? '').trim();
  if (term) {
    const e = `%${term.slice(0, 40).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    w.push("(customer_name LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ? OR tracking_code = ?)");
    a.push(e, e, term.replace(/^#/, ''), term.toUpperCase());
  }
  const orders = db.prepare(`SELECT * FROM orders WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...a, Math.max(1, Math.min(Number(limit) || 200, 500)));
  if (!orders.length) return orders;
  const items = db
    .prepare(
      `SELECT oi.order_id, oi.qty, oi.unit_price, v.size_ml, p.name
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE oi.order_id >= ? ORDER BY oi.id`
    )
    .all(orders[orders.length - 1].id);
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.order_id)) map.set(it.order_id, []);
    map.get(it.order_id).push(it);
  }
  for (const o of orders) o.items = map.get(o.id) || [];
  return orders;
}

// Los pedidos que llegan de WooCommerce los atiende WooCommerce (sus propios correos y su facturación): aquí no se les avisa de nuevo.
const isFromWoo = (db, orderId) => !!db.prepare('SELECT 1 FROM woo_orders WHERE order_id = ?').get(orderId);

// Cancela un pedido (pagado o a la espera del pago): el stock vuelve solo (trigger), la tarjeta de regalo recupera su saldo,
// el cupón se libera y, si ya tenía factura, se emite la nota de crédito.
function cancelOrder(db, o, { actor = null, services = {}, note = '' } = {}) {
  db.prepare("UPDATE orders SET status = 'cancelado' WHERE id = ?").run(o.id); // trg_order_cancel devuelve el stock
  gift.reverseForOrder(db, o.id);
  pricing.release(db, o.coupon_code);
  addEvent(db, o.id, 'cancelado', { note, userName: actor?.name || '' });
  if (o.status === 'pagado' && db.prepare("SELECT 1 FROM fiscal_docs WHERE order_id = ? AND kind = 'factura' AND status <> 'error' LIMIT 1").get(o.id)) {
    recordDocument(db, o.id, 'nota_credito', { cfg: services.fiscal, brand: services.brand, amount: o.total });
  }
  if (o.channel === 'online' && !isFromWoo(db, o.id)) notifyOrderStep(db, getOrder(db, o.id), 'cancelado', { baseUrl: services.baseUrl, brand: services.brand });
}

export function setOrderStatus(db, id, status, { actor = null, services = {} } = {}) {
  oneOf(status, ['entregado', 'cancelado'], 'El estado');
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw new HttpError(404, 'Pedido no encontrado');
    if (o.status === 'pendiente_pago' && status === 'entregado') throw new HttpError(409, 'El pedido todavía no está pagado');
    if (!(o.status === 'pagado' || (o.status === 'pendiente_pago' && status === 'cancelado'))) throw new HttpError(409, `El pedido ya está ${o.status}`);
    if (status === 'cancelado') cancelOrder(db, o, { actor, services });
    else {
      db.prepare("UPDATE orders SET status = 'entregado' WHERE id = ?").run(id);
      addEvent(db, id, 'entregado', { userName: actor?.name || '' });
      if (o.channel === 'online' && !isFromWoo(db, id)) notifyOrderStep(db, getOrder(db, id), 'entregado', { baseUrl: services.baseUrl, brand: services.brand });
    }
    return getOrder(db, id);
  });
}

// Paso intermedio del seguimiento (preparando, listo, enviado) y aviso al cliente.
export function advanceOrder(db, id, step, { actor = null, services = {} } = {}) {
  return tx(db, () => {
    setProgress(db, id, step, actor);
    notifyOrderStep(db, getOrder(db, id), step, { baseUrl: services.baseUrl, brand: services.brand });
    return getOrderDetail(db, id);
  });
}

// La pasarela confirmó el pago de un pedido que estaba pendiente.
export function markOrderPaid(db, id, { services = {} } = {}) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o || o.status !== 'pendiente_pago') return null;
    db.prepare("UPDATE orders SET status = 'pagado' WHERE id = ?").run(id);
    addEvent(db, id, 'pago_confirmado');
    const order = getOrder(db, id);
    afterPaid(db, order, { services });
    return order;
  });
}

// El pago no se completó (rechazado o vencido): el pedido se cancela y el stock reservado vuelve.
export function failOrderPayment(db, id, { services = {}, note = 'El pago no se completó' } = {}) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o || o.status !== 'pendiente_pago') return null;
    cancelOrder(db, o, { services, note });
    return getOrder(db, id);
  });
}

// ─── Inventario ────────────────────────────────────────────────────────────
// Paginado y filtrado en SQL: con miles de variantes, el panel nunca carga todo de una vez.
const INV_SELECT = `
  SELECT v.id, v.sku, v.barcode, v.is_set, v.size_ml, v.price, v.compare_at, v.cost, v.stock, v.min_stock, v.reorder_qty, v.supplier_id, v.active,
         p.id AS product_id, p.name, p.brand, p.category, p.subcategory, p.kind, p.family, p.color, p.image, p.is_new,
         p.active AS product_active, s.name AS supplier_name,
         EXISTS (SELECT 1 FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
                  WHERE pi.variant_id = v.id AND pu.status = 'pendiente') AS on_order
    FROM variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN suppliers s ON s.id = v.supplier_id`;

const INV_SORTS = {
  nombre: 'p.search_text, v.size_ml, v.id',
  'stock-asc': 'v.stock ASC, p.search_text, v.size_ml',
  'stock-desc': 'v.stock DESC, p.search_text, v.size_ml',
  sku: 'v.sku COLLATE NOCASE',
};

export function listInventory(db, { q = '', filter = 'todos', category = '', brand = '', kind = '', page = 1, limit = 50, sort = 'nombre', sellable = false } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  for (const t of norm(q).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6)) {
    w.push("(p.search_text LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' COLLATE NOCASE OR v.barcode = ?)");
    const e = t.replace(/[\\%_]/g, (c) => `\\${c}`);
    a.push(`% ${e}%`, `%${e}%`, t);
  }
  if (filter === 'bajo') w.push('v.is_set = 0 AND v.stock > 0 AND v.stock <= v.min_stock');
  else if (filter === 'agotado') w.push('v.is_set = 0 AND v.stock = 0');
  else if (filter === 'encamino') w.push("EXISTS (SELECT 1 FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id WHERE pi.variant_id = v.id AND pu.status = 'pendiente')");
  else if (filter === 'oculto') w.push('(v.active = 0 OR p.active = 0)');
  if (sellable) w.push('v.active = 1 AND p.active = 1');
  if (category) { w.push('p.category = ? COLLATE NOCASE'); a.push(category); }
  if (brand) { w.push('p.brand = ? COLLATE NOCASE'); a.push(brand); }
  if (kind) { w.push('p.kind = ? COLLATE NOCASE'); a.push(kind); }
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM variants v JOIN products p ON p.id = v.product_id WHERE ${cond}`).get(...a).n;
  const rows = db
    .prepare(`${INV_SELECT} WHERE ${cond} ORDER BY ${INV_SORTS[sort] || INV_SORTS.nombre} LIMIT ? OFFSET ?`)
    .all(...a, lim, (pg - 1) * lim);
  return { rows, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
}

export function getInventoryRow(db, id) {
  const row = db.prepare(`${INV_SELECT} WHERE v.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Variante no encontrada');
  return row;
}

// Conteos para las etiquetas del panel (stock bajo, agotados, ocultos…).
export function inventoryCounts(db) {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(v.is_set = 0 AND v.stock = 0), 0) AS out_count,
              COALESCE(SUM(v.is_set = 0 AND v.stock > 0 AND v.stock <= v.min_stock), 0) AS low_count,
              COALESCE(SUM(v.active = 0 OR p.active = 0), 0) AS hidden_count
         FROM variants v JOIN products p ON p.id = v.product_id`
    )
    .get();
}

const VARIANT_FIELDS = {
  price: (v) => money(v, 'El precio'),
  compare_at: (v) => (v === null || v === '' || v === undefined ? null : money(v, 'El precio normal')),
  cost: (v) => money(v, 'El costo'),
  min_stock: (v) => int(v, 'El stock mínimo', { max: 10_000 }),
  reorder_qty: (v) => int(v, 'La cantidad de reposición', { min: 1, max: 10_000 }),
  supplier_id: (v) => (v === null || v === '' ? null : int(v, 'El proveedor', { min: 1 })),
  active: (v) => (v ? 1 : 0),
  barcode: (v) => barcodeOf(v),
};

// Código de barras (EAN/UPC u otro): de 4 a 32 letras, números, punto, guion o guion bajo. Vacío = sin código.
export function barcodeOf(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9._-]{4,32}$/.test(s)) throw new HttpError(400, 'El código de barras debe tener de 4 a 32 letras o números');
  return s;
}

export function updateVariant(db, id, body) {
  const sets = [];
  const vals = [];
  for (const [key, parse] of Object.entries(VARIANT_FIELDS)) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(parse(body[key]));
    }
  }
  if (!sets.length) throw new HttpError(400, 'No hay cambios que guardar');
  return tx(db, () => {
    const cur = db.prepare('SELECT price, compare_at, is_set FROM variants WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Variante no encontrada');
    if (cur.is_set && Object.keys(body).some((k) => k !== 'active')) throw new HttpError(409, 'Un set de regalo se edita en la sección Sets');
    if ('barcode' in body) {
      const code = barcodeOf(body.barcode);
      if (code && db.prepare('SELECT 1 FROM variants WHERE id <> ? AND (barcode = ? OR sku = ? COLLATE NOCASE)').get(id, code, code)) throw new HttpError(409, 'Ese código de barras ya lo usa otro producto');
    }
    const price = 'price' in body ? VARIANT_FIELDS.price(body.price) : cur.price;
    const compare = 'compare_at' in body ? VARIANT_FIELDS.compare_at(body.compare_at) : cur.compare_at;
    if (compare !== null && compare !== undefined && compare <= price) {
      throw new HttpError(400, 'El precio normal (tachado) debe ser mayor que el precio de oferta');
    }
    const r = db.prepare(`UPDATE variants SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    if (!r.changes) throw new HttpError(404, 'Variante no encontrada');
    const replenished = autoReplenish(db);
    return { ok: true, replenished };
  });
}

// Ajuste manual: por diferencia (delta) o por conteo físico (count).
export function adjustStock(db, variantId, { delta, count, reason, actor = null }) {
  const why = text(reason, 'El motivo', { max: 120 });
  return tx(db, () => {
    const v = db.prepare('SELECT id, stock, is_set FROM variants WHERE id = ?').get(variantId);
    if (!v) throw new HttpError(404, 'Variante no encontrada');
    if (v.is_set) throw new HttpError(409, 'El stock de un set se calcula con los productos que incluye: ajusta esos productos');
    let d;
    if (count !== undefined && count !== null && count !== '') d = int(count, 'El conteo', { max: 100_000 }) - v.stock;
    else d = Number(delta);
    if (!Number.isInteger(d)) throw new HttpError(400, 'La cantidad no es válida');
    if (d === 0) throw new HttpError(400, 'El stock ya coincide, no hay nada que ajustar');
    if (v.stock + d < 0) throw new HttpError(409, `No se puede restar ${-d}: solo hay ${v.stock} en stock`);
    db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason, user_name) VALUES (?, 'ajuste', ?, ?, ?)`).run(variantId, d, why, actor?.name ?? null);
    const replenished = autoReplenish(db);
    return { delta: d, stock: v.stock + d, replenished };
  });
}

export function listMovements(db, { variantId = null, type = '', limit = 150 } = {}) {
  const where = [];
  const args = [];
  if (variantId) {
    where.push('m.variant_id = ?');
    args.push(variantId);
  }
  if (['entrada', 'salida', 'ajuste'].includes(type)) {
    where.push('m.type = ?');
    args.push(type);
  }
  return db
    .prepare(
      `SELECT m.id, m.type, m.qty, m.reason, m.balance, m.created_at, m.ref_type, m.ref_id, m.user_name,
              v.sku, v.size_ml, p.name
         FROM stock_movements m JOIN variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY m.id DESC LIMIT ?`
    )
    .all(...args, Math.min(Number(limit) || 150, 500));
}

// Carga masiva: "sku,cantidad[,costo]" (se puede exportar desde Excel como CSV).
export function importCsv(db, csv, { actor = null } = {}) {
  const lines = String(csv ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) throw new HttpError(400, 'El archivo está vacío');
  const delim = lines[0].includes(';') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const rows = lines.map((l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, '')));
  if (!/^\d+$/.test(rows[0][1] ?? '')) rows.shift(); // encabezado

  const errors = [];
  const entries = [];
  const find = db.prepare('SELECT id, sku FROM variants WHERE (sku = ? COLLATE NOCASE OR barcode = ?) AND is_set = 0');
  rows.forEach((r, i) => {
    const n = i + 1;
    const v = find.get(r[0] || '', r[0] || '');
    const qty = Number(r[1]);
    if (!v) return errors.push(`Fila ${n}: el SKU "${r[0] ?? ''}" no existe`);
    if (!Number.isInteger(qty) || qty <= 0) return errors.push(`Fila ${n}: la cantidad debe ser un entero mayor a 0`);
    let cost = null;
    if (r[2] !== undefined && r[2] !== '') {
      cost = Number(r[2].replace(',', '.'));
      if (!Number.isFinite(cost) || cost < 0) return errors.push(`Fila ${n}: el costo no es válido`);
    }
    entries.push({ id: v.id, sku: v.sku, qty, cost });
  });
  if (errors.length) throw Object.assign(new HttpError(400, 'El archivo tiene errores, no se aplicó nada'), { details: errors });
  if (!entries.length) throw new HttpError(400, 'No hay filas para importar');

  return tx(db, () => {
    const mov = db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason, user_name) VALUES (?, 'entrada', ?, 'Carga masiva (CSV)', ?)`);
    const setCost = db.prepare('UPDATE variants SET cost = ? WHERE id = ?');
    for (const e of entries) {
      mov.run(e.id, e.qty, actor?.name ?? null);
      if (e.cost !== null) setCost.run(e.cost, e.id);
    }
    return { applied: entries.length, units: entries.reduce((s, e) => s + e.qty, 0) };
  });
}

// ─── Productos ─────────────────────────────────────────────────────────────
const imageUrl = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\/img\/[\w./-]+$/.test(s) || /^\/api\/media\/\d{1,9}$/.test(s) || /^https:\/\/[^\s"'<>]{4,500}$/.test(s)) return s;
  throw new HttpError(400, 'La imagen debe ser una foto subida, una ruta /img/... o una dirección https');
};
const linkUrl = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\/[^\s"'<>]{4,500}$/.test(s)) return s;
  throw new HttpError(400, 'El enlace del producto no es válido');
};

const PRODUCT_FIELDS = {
  name: (v) => text(v, 'El nombre', { max: 120 }),
  brand: (v) => text(v, 'La marca', { max: 60, required: false }),
  category: (v) => oneOf(v, [...CATEGORIES, UNCLASSIFIED], 'La categoría'),
  subcategory: (v) => text(v, 'La subcategoría', { max: 30, required: false }) || null,
  kind: (v) => oneOf(v, KINDS, 'El tipo'),
  family: (v) => text(v, 'La familia olfativa', { max: 40, required: false }),
  notes: (v) => text(v, 'Las notas', { max: 160, required: false }),
  description: (v) => text(v, 'La descripción', { max: 1200, required: false }),
  image: imageUrl,
  permalink: linkUrl,
  is_new: (v) => (v ? 1 : 0),
  active: (v) => (v ? 1 : 0),
};

function refreshSearchText(db, id) {
  const p = db.prepare('SELECT id, name, brand, category, subcategory, kind, family, notes FROM products WHERE id = ?').get(id);
  if (p) db.prepare('UPDATE products SET search_text = ? WHERE id = ?').run(searchText(p), id);
}

export function createProduct(db, body, { skuPrefix = 'DLX', actor = null } = {}) {
  const f = {
    name: PRODUCT_FIELDS.name(body.name),
    brand: PRODUCT_FIELDS.brand(body.brand),
    category: PRODUCT_FIELDS.category(body.category ?? 'Unisex'),
    subcategory: PRODUCT_FIELDS.subcategory(body.subcategory),
    kind: PRODUCT_FIELDS.kind(body.kind ?? 'Perfume'),
    family: PRODUCT_FIELDS.family(body.family),
    notes: PRODUCT_FIELDS.notes(body.notes),
    description: PRODUCT_FIELDS.description(body.description),
    image: PRODUCT_FIELDS.image(body.image),
    permalink: PRODUCT_FIELDS.permalink(body.permalink),
    is_new: PRODUCT_FIELDS.is_new(body.is_new),
  };
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#c9a24b';
  if (!Array.isArray(body.variants) || !body.variants.length) throw new HttpError(400, 'Agrega al menos un tamaño');
  const sizes = new Set();

  const variants = body.variants.map((v) => {
    const size = int(v.size_ml ?? 0, 'El tamaño (ml)', { min: 0, max: 1000 });
    if (sizes.has(size)) throw new HttpError(400, `El tamaño ${size ? `${size} ml` : 'único'} está repetido`);
    sizes.add(size);
    const price = money(v.price, 'El precio');
    const compare = VARIANT_FIELDS.compare_at(v.compare_at);
    if (compare !== null && compare <= price) throw new HttpError(400, 'El precio normal (tachado) debe ser mayor que el precio de oferta');
    return {
      size,
      price,
      compare_at: compare,
      cost: money(v.cost ?? 0, 'El costo'),
      stock: int(v.stock ?? 0, 'El stock inicial', { max: 100_000 }),
      min_stock: int(v.min_stock ?? 3, 'El stock mínimo', { max: 10_000 }),
      reorder_qty: int(v.reorder_qty ?? 12, 'La cantidad de reposición', { min: 1, max: 10_000 }),
      supplier_id: v.supplier_id ? int(v.supplier_id, 'El proveedor', { min: 1 }) : null,
      sku: v.sku ? text(v.sku, 'El SKU', { max: 40 }) : null,
      barcode: barcodeOf(v.barcode),
    };
  });

  return tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO products (name, brand, category, subcategory, kind, family, notes, description, color, image, permalink, is_new)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.name, f.brand, f.category, f.subcategory, f.kind, f.family, f.notes, f.description, color, f.image, f.permalink, f.is_new);
    const pid = Number(r.lastInsertRowid);
    for (const v of variants) {
      const sku = v.sku || `${skuPrefix}-${String(pid).padStart(5, '0')}-${v.size || 'U'}`;
      if (db.prepare('SELECT 1 FROM variants WHERE sku = ? COLLATE NOCASE').get(sku)) throw new HttpError(409, `El SKU ${sku} ya existe`);
      if (v.barcode && db.prepare('SELECT 1 FROM variants WHERE barcode = ? OR sku = ? COLLATE NOCASE').get(v.barcode, v.barcode)) throw new HttpError(409, `El código de barras ${v.barcode} ya lo usa otro producto`);
      const vr = db
        .prepare(
          `INSERT INTO variants (product_id, sku, size_ml, price, compare_at, cost, min_stock, reorder_qty, supplier_id, barcode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(pid, sku, v.size, v.price, v.compare_at, v.cost, v.min_stock, v.reorder_qty, v.supplier_id, v.barcode);
      if (v.stock > 0) {
        db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason, user_name) VALUES (?, 'entrada', ?, 'Inventario inicial', ?)`).run(
          Number(vr.lastInsertRowid),
          v.stock,
          actor?.name ?? null
        );
      }
    }
    refreshSearchText(db, pid);
    autoReplenish(db);
    bumpCatalog(db);
    return { id: pid };
  });
}

export function updateProduct(db, id, body) {
  const sets = [];
  const vals = [];
  for (const [key, parse] of Object.entries(PRODUCT_FIELDS)) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(parse(body[key]));
    }
  }
  if (!sets.length) throw new HttpError(400, 'No hay cambios que guardar');
  return tx(db, () => {
    const r = db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    if (!r.changes) throw new HttpError(404, 'Producto no encontrado');
    refreshSearchText(db, id);
    if ('image' in body) pruneUnused(db); // la foto que se reemplazó ya no ocupa lugar
    bumpCatalog(db);
    return { ok: true };
  });
}

// Lista de productos para el panel (paginada, con totales de stock).
export function listProductsAdmin(db, { q = '', category = '', kind = '', brand = '', status = '', page = 1, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  for (const t of norm(q).split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6)) {
    w.push("p.search_text LIKE ? ESCAPE '\\'");
    a.push(`% ${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (category) { w.push('p.category = ? COLLATE NOCASE'); a.push(category); }
  if (kind) { w.push('p.kind = ? COLLATE NOCASE'); a.push(kind); }
  if (brand) { w.push('p.brand = ? COLLATE NOCASE'); a.push(brand); }
  if (status === 'oculto') w.push('p.active = 0');
  else if (status === 'visible') w.push('p.active = 1');
  else if (status === 'sin_clasificar') w.push(`p.category = '${UNCLASSIFIED}'`);
  else if (status === 'sin_imagen') w.push("(p.image IS NULL OR p.image = '')");
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${cond}`).get(...a).n;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.brand, p.category, p.subcategory, p.kind, p.family, p.notes, p.description, p.color, p.image, p.is_new, p.active, p.permalink,
              COUNT(v.id) AS sizes, COALESCE(SUM(v.stock), 0) AS stock, MIN(v.price) AS min_price, GROUP_CONCAT(v.size_ml, ',') AS size_list
         FROM products p LEFT JOIN variants v ON v.product_id = p.id AND v.active = 1
        WHERE ${cond} GROUP BY p.id ORDER BY p.search_text LIMIT ? OFFSET ?`
    )
    .all(...a, lim, (pg - 1) * lim);
  return { rows, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
}

export function listBrands(db) {
  return db
    .prepare("SELECT brand AS name, COUNT(*) AS products FROM products WHERE active = 1 AND brand <> '' GROUP BY brand ORDER BY brand COLLATE NOCASE")
    .all();
}

// ─── Compras a proveedores ─────────────────────────────────────────────────
export function listSuppliers(db) {
  return db.prepare('SELECT * FROM suppliers ORDER BY name').all();
}

export function listPurchases(db) {
  const rows = db
    .prepare(
      `SELECT pu.*, s.name AS supplier_name FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
        ORDER BY (pu.status = 'pendiente') DESC, pu.id DESC LIMIT 100`
    )
    .all();
  const itemsStmt = db.prepare(
    `SELECT pi.qty, pi.unit_cost, v.sku, v.size_ml, p.name
       FROM purchase_items pi JOIN variants v ON v.id = pi.variant_id JOIN products p ON p.id = v.product_id
      WHERE pi.purchase_id = ? ORDER BY pi.id`
  );
  for (const pu of rows) {
    pu.items = itemsStmt.all(pu.id);
    pu.total = Math.round(pu.items.reduce((s, i) => s + i.qty * i.unit_cost, 0) * 100) / 100;
  }
  return rows;
}

export function createPurchase(db, body) {
  const supplierId = int(body.supplier_id, 'El proveedor', { min: 1 });
  if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Agrega al menos un producto');
  const merged = new Map();
  for (const it of body.items) {
    const vid = int(it.variant_id, 'Producto', { min: 1 });
    const qty = int(it.qty, 'Cantidad', { min: 1, max: 100_000 });
    const cost = money(it.unit_cost, 'El costo');
    const prev = merged.get(vid);
    merged.set(vid, { qty: (prev?.qty || 0) + qty, cost });
  }
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw new HttpError(404, 'Proveedor no encontrado');
    const r = db
      .prepare('INSERT INTO purchases (supplier_id, notes) VALUES (?, ?)')
      .run(supplierId, text(body.notes, 'Las notas', { max: 160, required: false }) || null);
    const pid = Number(r.lastInsertRowid);
    for (const [vid, { qty, cost }] of merged) {
      if (!db.prepare('SELECT 1 FROM variants WHERE id = ?').get(vid)) throw new HttpError(404, 'Producto no encontrado');
      db.prepare('INSERT INTO purchase_items (purchase_id, variant_id, qty, unit_cost) VALUES (?, ?, ?, ?)').run(pid, vid, qty, cost);
    }
    return { id: pid };
  });
}

export function setPurchaseStatus(db, id, status, { actor = null } = {}) {
  oneOf(status, ['recibida', 'cancelada'], 'El estado');
  return tx(db, () => {
    const pu = db.prepare('SELECT status FROM purchases WHERE id = ?').get(id);
    if (!pu) throw new HttpError(404, 'Compra no encontrada');
    if (pu.status !== 'pendiente') throw new HttpError(409, `La compra ya está ${pu.status}`);
    db.prepare('UPDATE purchases SET status = ? WHERE id = ?').run(status, id); // trg_purchase_receive suma el stock
    if (actor) db.prepare("UPDATE stock_movements SET user_name = ? WHERE ref_type = 'purchase' AND ref_id = ? AND user_name IS NULL").run(actor.name, id);
    return { ok: true };
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────
function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dashboard(db) {
  const active = `status IN ('pagado','entregado')`;
  const today = db
    .prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM orders WHERE ${active} AND date(created_at) = date('now','localtime')`)
    .get();
  const month = db
    .prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM orders WHERE ${active} AND date(created_at) >= date('now','localtime','-29 days')`)
    .get();
  const margin = db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty * (oi.unit_price - oi.unit_cost)),0) AS margin
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.${active} AND date(o.created_at) >= date('now','localtime','-29 days')`
    )
    .get();
  const byDay = new Map(
    db
      .prepare(
        `SELECT date(created_at) AS day, SUM(total) AS total, COUNT(*) AS n FROM orders
          WHERE ${active} AND date(created_at) >= date('now','localtime','-13 days') GROUP BY day`
      )
      .all()
      .map((r) => [r.day, r])
  );
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDay(d);
    series.push({ day: key, total: byDay.get(key)?.total || 0, n: byDay.get(key)?.n || 0 });
  }
  const inventory = db
    .prepare(
      `SELECT COALESCE(SUM(v.stock * v.cost),0) AS cost_value, COALESCE(SUM(v.stock * v.price),0) AS retail_value,
              COALESCE(SUM(v.stock),0) AS units,
              COALESCE(SUM(v.stock = 0),0) AS out_count,
              COALESCE(SUM(v.stock > 0 AND v.stock <= v.min_stock),0) AS low_count
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND p.active = 1 AND v.is_set = 0`
    )
    .get();
  const top = db
    .prepare(
      `SELECT p.name, SUM(oi.qty) AS units, SUM(oi.qty * oi.unit_price) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE o.${active} AND date(o.created_at) >= date('now','localtime','-29 days')
        GROUP BY p.id ORDER BY units DESC, revenue DESC LIMIT 5`
    )
    .all();
  const channels = db
    .prepare(
      `SELECT channel, COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM orders
        WHERE ${active} AND date(created_at) >= date('now','localtime','-29 days') GROUP BY channel`
    )
    .all();
  const alerts = db
    .prepare(
      `SELECT v.id, v.sku, v.size_ml, v.stock, v.min_stock, p.name,
              EXISTS (SELECT 1 FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
                       WHERE pi.variant_id = v.id AND pu.status = 'pendiente') AS on_order
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.active = 1 AND p.active = 1 AND v.is_set = 0 AND v.stock <= v.min_stock
        ORDER BY v.stock ASC, p.name LIMIT 10`
    )
    .all();
  const pendingPurchases = db.prepare(`SELECT COUNT(*) AS n FROM purchases WHERE status = 'pendiente'`).get().n;
  return {
    today,
    month: { ...month, margin: margin.margin },
    series,
    inventory,
    top,
    channels,
    alerts,
    pendingPurchases,
    autoReorder: getSetting(db, 'auto_reorder', '1') === '1',
  };
}

export function getSettings(db) {
  return { auto_reorder: getSetting(db, 'auto_reorder', '1') === '1' };
}

export function updateSettings(db, body) {
  if ('auto_reorder' in body) setSetting(db, 'auto_reorder', body.auto_reorder ? '1' : '0');
  return getSettings(db);
}

// Lector de códigos del mostrador: el código que llega es un SKU o un código de barras. Devuelve la fila de inventario vendible.
export function lookupCode(db, code) {
  const c = String(code ?? '').trim();
  if (!c) throw new HttpError(400, 'Escribe o escanea un código');
  const row = db.prepare('SELECT v.id FROM variants v WHERE (v.sku = ? COLLATE NOCASE OR v.barcode = ?) ORDER BY (v.sku = ? COLLATE NOCASE) DESC LIMIT 1').get(c, c, c);
  if (!row) throw new HttpError(404, `No hay ningún producto con el código ${c.slice(0, 40)}`);
  return getInventoryRow(db, row.id);
}
