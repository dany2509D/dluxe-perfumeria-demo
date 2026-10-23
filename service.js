// Lógica de negocio. El stock nunca se escribe directo: siempre se inserta un
// movimiento y los triggers de db.js hacen el resto.
import { HttpError, tx, getSetting, setSetting } from './db.js';
import { norm, searchText } from './text.js';
import { CATEGORIES, UNCLASSIFIED, KINDS, bumpCatalog } from './catalog.js';

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
        WHERE v.active = 1 AND p.active = 1 AND v.supplier_id IS NOT NULL
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
export function createOrder(db, input, { channel = 'online', created_at = null, skipReplenish = false } = {}) {
  const isPos = channel === 'mostrador';
  const customer = input.customer || {};
  const name = isPos ? text(customer.name || 'Cliente mostrador', 'Nombre') : text(customer.name, 'Nombre', { max: 80 });
  let email = text(customer.email, 'Correo', { max: 120, required: !isPos });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'El correo no es válido');
  const phone = text(customer.phone, 'Teléfono', { max: 30, required: !isPos });
  const payment = oneOf(input.payment_method, isPos ? POS_PAYMENTS : ONLINE_PAYMENTS, 'El método de pago');

  let delivery = null;
  let address = '';
  if (!isPos) {
    delivery = oneOf(input.delivery, ['retiro', 'envio'], 'La entrega');
    if (delivery === 'envio') address = text(input.address, 'La dirección de envío', { max: 200 });
  }

  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(400, 'La bolsa está vacía');
  if (input.items.length > 50) throw new HttpError(400, 'Demasiados productos en un solo pedido');
  const lines = new Map();
  for (const it of input.items) {
    const id = int(it.variant_id, 'Producto', { min: 1 });
    const qty = int(it.qty, 'Cantidad', { min: 1, max: 99 });
    lines.set(id, (lines.get(id) || 0) + qty);
  }

  return tx(db, () => {
    const rows = [];
    for (const [variantId, qty] of lines) {
      const v = db
        .prepare(
          `SELECT v.id, v.price, v.cost, v.stock, v.size_ml, v.active AS v_active, p.name, p.active AS p_active
             FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`
        )
        .get(variantId);
      if (!v || !v.v_active || !v.p_active) throw new HttpError(404, 'Uno de los productos ya no está disponible');
      if (v.stock < qty) {
        throw new HttpError(
          409,
          v.stock === 0
            ? `${v.name} ${v.size_ml} ml está agotado`
            : `Solo quedan ${v.stock} unidades de ${v.name} ${v.size_ml} ml`
        );
      }
      rows.push({ ...v, qty });
    }

    const total = Math.round(rows.reduce((s, r) => s + r.price * r.qty, 0) * 100) / 100;
    const cols = ['channel', 'customer_name', 'customer_email', 'customer_phone', 'delivery', 'address', 'payment_method', 'total'];
    const vals = [channel, name, email || null, phone || null, delivery, address || null, payment, total];
    if (created_at) {
      cols.push('created_at');
      vals.push(created_at);
    }
    const r = db
      .prepare(`INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...vals);
    const orderId = Number(r.lastInsertRowid);

    // El trigger trg_item_sale descuenta el stock por cada línea.
    const ins = db.prepare('INSERT INTO order_items (order_id, variant_id, qty, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) ins.run(orderId, row.id, row.qty, row.price, row.cost);

    const replenished = skipReplenish ? { items: 0, purchases: 0 } : autoReplenish(db);
    return { ...getOrder(db, orderId), replenished };
  });
}

export function getOrder(db, id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw new HttpError(404, 'Pedido no encontrado');
  order.items = db
    .prepare(
      `SELECT oi.qty, oi.unit_price, v.id AS variant_id, v.size_ml, v.sku, p.name, p.brand, p.color
         FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`
    )
    .all(id);
  return order;
}

export function listOrders(db, limit = 200) {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
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

export function setOrderStatus(db, id, status) {
  oneOf(status, ['entregado', 'cancelado'], 'El estado');
  return tx(db, () => {
    const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(id);
    if (!o) throw new HttpError(404, 'Pedido no encontrado');
    if (o.status !== 'pagado') throw new HttpError(409, `El pedido ya está ${o.status}`);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id); // trg_order_cancel devuelve el stock
    return getOrder(db, id);
  });
}

// ─── Inventario ────────────────────────────────────────────────────────────
// Paginado y filtrado en SQL: con miles de variantes, el panel nunca carga todo de una vez.
const INV_SELECT = `
  SELECT v.id, v.sku, v.size_ml, v.price, v.compare_at, v.cost, v.stock, v.min_stock, v.reorder_qty, v.supplier_id, v.active,
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
    w.push("(p.search_text LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' COLLATE NOCASE)");
    const e = t.replace(/[\\%_]/g, (c) => `\\${c}`);
    a.push(`% ${e}%`, `%${e}%`);
  }
  if (filter === 'bajo') w.push('v.stock > 0 AND v.stock <= v.min_stock');
  else if (filter === 'agotado') w.push('v.stock = 0');
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
              COALESCE(SUM(v.stock = 0), 0) AS out_count,
              COALESCE(SUM(v.stock > 0 AND v.stock <= v.min_stock), 0) AS low_count,
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
};

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
    const cur = db.prepare('SELECT price, compare_at FROM variants WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Variante no encontrada');
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
export function adjustStock(db, variantId, { delta, count, reason }) {
  const why = text(reason, 'El motivo', { max: 120 });
  return tx(db, () => {
    const v = db.prepare('SELECT id, stock FROM variants WHERE id = ?').get(variantId);
    if (!v) throw new HttpError(404, 'Variante no encontrada');
    let d;
    if (count !== undefined && count !== null && count !== '') d = int(count, 'El conteo', { max: 100_000 }) - v.stock;
    else d = Number(delta);
    if (!Number.isInteger(d)) throw new HttpError(400, 'La cantidad no es válida');
    if (d === 0) throw new HttpError(400, 'El stock ya coincide, no hay nada que ajustar');
    if (v.stock + d < 0) throw new HttpError(409, `No se puede restar ${-d}: solo hay ${v.stock} en stock`);
    db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason) VALUES (?, 'ajuste', ?, ?)`).run(variantId, d, why);
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
      `SELECT m.id, m.type, m.qty, m.reason, m.balance, m.created_at, m.ref_type, m.ref_id,
              v.sku, v.size_ml, p.name
         FROM stock_movements m JOIN variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY m.id DESC LIMIT ?`
    )
    .all(...args, Math.min(Number(limit) || 150, 500));
}

// Carga masiva: "sku,cantidad[,costo]" (se puede exportar desde Excel como CSV).
export function importCsv(db, csv) {
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
  const find = db.prepare('SELECT id, sku FROM variants WHERE sku = ? COLLATE NOCASE');
  rows.forEach((r, i) => {
    const n = i + 1;
    const v = find.get(r[0] || '');
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
    const mov = db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason) VALUES (?, 'entrada', ?, 'Carga masiva (CSV)')`);
    const setCost = db.prepare('UPDATE variants SET cost = ? WHERE id = ?');
    for (const e of entries) {
      mov.run(e.id, e.qty);
      if (e.cost !== null) setCost.run(e.cost, e.id);
    }
    return { applied: entries.length, units: entries.reduce((s, e) => s + e.qty, 0) };
  });
}

// ─── Productos ─────────────────────────────────────────────────────────────
const imageUrl = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\/img\/[\w./-]+$/.test(s) || /^https:\/\/[^\s"'<>]{4,500}$/.test(s)) return s;
  throw new HttpError(400, 'La imagen debe ser una ruta /img/... o una dirección https');
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

export function createProduct(db, body, { skuPrefix = 'DLX' } = {}) {
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
      const vr = db
        .prepare(
          `INSERT INTO variants (product_id, sku, size_ml, price, compare_at, cost, min_stock, reorder_qty, supplier_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(pid, sku, v.size, v.price, v.compare_at, v.cost, v.min_stock, v.reorder_qty, v.supplier_id);
      if (v.stock > 0) {
        db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason) VALUES (?, 'entrada', ?, 'Inventario inicial')`).run(
          Number(vr.lastInsertRowid),
          v.stock
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
      `SELECT p.id, p.name, p.brand, p.category, p.subcategory, p.kind, p.family, p.image, p.is_new, p.active, p.permalink,
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

export function setPurchaseStatus(db, id, status) {
  oneOf(status, ['recibida', 'cancelada'], 'El estado');
  return tx(db, () => {
    const pu = db.prepare('SELECT status FROM purchases WHERE id = ?').get(id);
    if (!pu) throw new HttpError(404, 'Compra no encontrada');
    if (pu.status !== 'pendiente') throw new HttpError(409, `La compra ya está ${pu.status}`);
    db.prepare('UPDATE purchases SET status = ? WHERE id = ?').run(status, id); // trg_purchase_receive suma el stock
    return { ok: true };
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────
function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dashboard(db) {
  const active = `status <> 'cancelado'`;
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
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND p.active = 1`
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
        WHERE v.active = 1 AND p.active = 1 AND v.stock <= v.min_stock
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
