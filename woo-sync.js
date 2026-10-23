// Conexión con una tienda WooCommerce que ya existe:
//   · lectura del catálogo por la API REST (mismo plan e informe de calidad que el CSV),
//   · envío del stock (bandeja de salida con reintentos) para que la web siempre muestre lo real,
//   · avisos entrantes por webhook (pedidos nuevos o cancelados), firmados y sin procesarse dos veces.
// Las credenciales salen de variables de entorno, nunca de la base ni del código.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, tx } from './db.js';
import { fromRest, planFromRest, applyPlan, previewApply } from './woo-import.js';
import { autoReplenish, setOrderStatus } from './service.js';
import { bumpCatalog } from './catalog.js';

export function wooConfigFromEnv(env = process.env) {
  const url = String(env.WOO_URL || '').trim().replace(/\/+$/, '');
  return {
    url,
    key: env.WOO_KEY || '',
    secret: env.WOO_SECRET || '',
    webhookSecret: env.WOO_WEBHOOK_SECRET || '',
    push: env.WOO_PUSH_STOCK === '1',
  };
}
export const wooReady = (cfg) => !!(cfg.url && cfg.key && cfg.secret);

// ─── Cliente REST ──────────────────────────────────────────────────────────
export function createWooClient({ url, key, secret, fetch: doFetch = globalThis.fetch, timeoutMs = 20_000 }) {
  const base = `${String(url).replace(/\/+$/, '')}/wp-json/wc/v3`;
  const https = /^https:/i.test(url);
  const basic = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

  async function request(method, path, { query = {}, body } = {}) {
    const q = new URLSearchParams(query);
    if (!https) { q.set('consumer_key', key); q.set('consumer_secret', secret); } // sin HTTPS, WooCommerce pide las claves en la dirección
    const headers = { Accept: 'application/json' };
    if (https) headers.Authorization = basic;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await doFetch(`${base}${path}?${q}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new HttpError(502, `No pude conectar con WooCommerce (${e.name === 'TimeoutError' ? 'tiempo agotado' : 'sin conexión'})`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' Revisa la clave y el secreto de la API.' : '';
      throw new HttpError(502, `WooCommerce respondió ${res.status}: ${String(data?.message || 'error').slice(0, 160)}.${hint}`);
    }
    return { data, pages: Number(res.headers.get('x-wp-totalpages') || 1), total: Number(res.headers.get('x-wp-total') || 0) };
  }

  return {
    ping: async () => (await request('GET', '/products', { query: { per_page: 1 } })).total,
    listProducts: async (page = 1, perPage = 100) => {
      const r = await request('GET', '/products', { query: { page, per_page: perPage, status: 'any', orderby: 'id', order: 'asc' } });
      return { items: r.data, pages: r.pages, total: r.total };
    },
    listVariations: async (productId) => {
      const out = [];
      for (let page = 1; ; page++) {
        const r = await request('GET', `/products/${productId}/variations`, { query: { page, per_page: 100 } });
        out.push(...r.data);
        if (page >= r.pages) break;
      }
      return out;
    },
    // "123" = producto simple; "123:456" = variación 456 del producto 123.
    updateStock: async (external, qty) => {
      const [product, variation] = String(external).split(':');
      const path = variation ? `/products/${product}/variations/${variation}` : `/products/${product}`;
      await request('PUT', path, { body: { manage_stock: true, stock_quantity: qty } });
    },
  };
}

// ─── Lectura del catálogo ──────────────────────────────────────────────────
// Descarga todo, arma el plan (con el informe) y lo aplica. `progress` recibe el avance para mostrarlo en el panel.
export async function pullCatalog(db, client, { progress = () => {}, apply = true, maxPages = 500, updateStock = true } = {}) {
  const items = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, maxPages); page++) {
    const r = await client.listProducts(page);
    pages = r.pages;
    progress({ phase: 'leyendo', page, pages, items: items.length });
    for (const p of r.items) {
      items.push(fromRest(p));
      if (p.type === 'variable') {
        for (const v of await client.listVariations(p.id)) items.push(fromRest(v, p));
      }
    }
  }
  progress({ phase: 'analizando', page: pages, pages, items: items.length });
  const { plan, report } = planFromRest(items);
  if (!apply) return { report, preview: previewApply(db, plan) };
  progress({ phase: 'guardando', page: pages, pages, items: items.length });
  const applied = applyPlan(db, plan, { reason: 'Sincronización con WooCommerce', updateStock });
  return { report, applied };
}

// ─── Bandeja de salida: stock hacia WooCommerce ────────────────────────────
export async function flushOutbox(db, client, { limit = 50, maxAttempts = 5 } = {}) {
  const rows = db
    .prepare(
      `SELECT o.variant_id, o.stock, o.attempts, v.external_id FROM woo_outbox o JOIN variants v ON v.id = o.variant_id
        WHERE o.attempts < ? AND v.external_id IS NOT NULL ORDER BY o.queued_at, o.variant_id LIMIT ?`
    )
    .all(maxAttempts, limit);
  const done = db.prepare('DELETE FROM woo_outbox WHERE variant_id = ? AND stock = ?');
  const fail = db.prepare('UPDATE woo_outbox SET attempts = attempts + 1, last_error = ? WHERE variant_id = ?');
  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await client.updateStock(r.external_id, r.stock);
      // Si el stock cambió mientras se enviaba, la fila ya trae el valor nuevo y se queda para el próximo envío.
      done.run(r.variant_id, r.stock);
      sent++;
    } catch (e) {
      fail.run(String(e.message).slice(0, 200), r.variant_id);
      failed++;
      if (e instanceof HttpError && /respondió 40[13]/.test(e.message)) break; // credenciales mal: no insistir con el resto
    }
  }
  return { sent, failed, ...outboxCounts(db, maxAttempts) };
}

export function outboxCounts(db, maxAttempts = 5) {
  const r = db
    .prepare('SELECT COALESCE(SUM(attempts < ?), 0) AS pending, COALESCE(SUM(attempts >= ?), 0) AS stuck FROM woo_outbox')
    .get(maxAttempts, maxAttempts);
  return { pending: r.pending, stuck: r.stuck };
}

// ─── Enlaces de compra (chat embebido en WordPress) ────────────────────────
// Producto simple de WooCommerce: "?add-to-cart=ID" lo agrega al carrito. Una variación necesita elegir atributos, así que
// se lleva al cliente a la página del producto. Sin enlace de WooCommerce: se abre la tienda de este sistema.
export function storeLinkFor(db, variantId, qty, fallbackOrigin = '') {
  const v = db
    .prepare('SELECT v.external_id, v.size_ml, p.name, p.permalink FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?')
    .get(variantId);
  if (!v) return null;
  const q = Math.max(1, Math.min(Number(qty) || 1, 20));
  const size = v.size_ml ? ` ${v.size_ml} ml` : '';
  if (v.permalink) {
    let origin = null;
    try { origin = new URL(v.permalink).origin; } catch { /* enlace inválido */ }
    if (origin && v.external_id && !String(v.external_id).includes(':')) {
      return { url: `${origin}/?add-to-cart=${encodeURIComponent(v.external_id)}&quantity=${q}`, label: `Agregar ${v.name}${size} al carrito` };
    }
    return { url: v.permalink, label: `Elegir tamaño de ${v.name}` };
  }
  return fallbackOrigin ? { url: `${fallbackOrigin}/?q=${encodeURIComponent(v.name)}`, label: `Ver ${v.name}${size} en la tienda` } : null;
}

// ─── Webhook entrante ──────────────────────────────────────────────────────
export function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let got;
  try {
    got = Buffer.from(String(signature), 'base64');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const PAY = { cod: 'contra_entrega', bacs: 'transferencia', cheque: 'transferencia' };
const DEDUCT = new Set(['processing', 'completed', 'on-hold']);
const REVERT = new Set(['cancelled', 'refunded', 'failed']);
const localStamp = (iso) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? `${m[1]} ${m[2]}` : null;
};

function recordOrder(db, o) {
  const find = db.prepare('SELECT id, stock, cost, price, active FROM variants WHERE external_id = ?');
  const bySku = db.prepare('SELECT id, stock, cost, price, active FROM variants WHERE sku = ? COLLATE NOCASE');
  const lines = [];
  const missing = [];
  const short = [];
  for (const li of o.line_items || []) {
    const ext = li.variation_id ? `${li.product_id}:${li.variation_id}` : String(li.product_id);
    const v = find.get(ext) || (li.sku && bySku.get(li.sku));
    const qty = Math.floor(Number(li.quantity) || 0);
    if (!v) { missing.push(`${li.name || ext} ×${qty}`); continue; }
    if (qty <= 0) continue;
    const take = Math.min(qty, v.stock);
    if (take < qty) short.push(`${li.name || ext}: pedido ${qty}, había ${v.stock}`);
    if (take > 0) lines.push({ v, qty: take, price: qty ? Math.round((Number(li.total) / qty) * 100) / 100 || v.price : v.price });
  }
  const b = o.billing || {};
  const name = [b.first_name, b.last_name].filter(Boolean).join(' ').trim() || 'Cliente WooCommerce';
  return tx(db, () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('woo_pause', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run(); // WooCommerce ya descontó ese stock
    let orderId = null;
    if (lines.length) {
      const stamp = localStamp(o.date_created) || localStamp(new Date().toISOString());
      const r = db
        .prepare(
          `INSERT INTO orders (channel, customer_name, customer_email, customer_phone, delivery, address, payment_method, status, total, created_at)
           VALUES ('online', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          name.slice(0, 80), String(b.email || '').slice(0, 120) || null, String(b.phone || '').slice(0, 30) || null,
          (o.shipping_lines || []).length ? 'envio' : 'retiro', [b.address_1, b.city].filter(Boolean).join(', ').slice(0, 200) || null,
          PAY[o.payment_method] || 'tarjeta', o.status === 'completed' ? 'entregado' : 'pagado', Number(o.total) || lines.reduce((s, l) => s + l.price * l.qty, 0), stamp
        );
      orderId = Number(r.lastInsertRowid);
      const item = db.prepare('INSERT INTO order_items (order_id, variant_id, qty, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)');
      for (const l of lines) item.run(orderId, l.v.id, l.qty, l.price, l.v.cost);
      db.prepare('INSERT INTO woo_orders (woo_order_id, order_id) VALUES (?, ?)').run(String(o.id), orderId);
    }
    db.prepare("DELETE FROM settings WHERE key = 'woo_pause'").run();
    return { orderId, missing, short };
  });
}

// Procesa un aviso de WooCommerce ya verificado. Devuelve un resumen (siempre 200 para que WooCommerce no reintente sin motivo).
export async function handleWebhook(db, { raw, headers, client = null, updateStock = true }) {
  const topic = String(headers['x-wc-webhook-topic'] || '');
  const delivery = String(headers['x-wc-webhook-delivery-id'] || createHash('sha256').update(raw).digest('hex').slice(0, 32));
  let payload = null;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { /* el "ping" de prueba llega como formulario */ }
  if (!topic || !payload) return { status: 'pong' };

  const log = db.prepare('INSERT INTO woo_events (delivery_id, topic, woo_order_id, status, note) VALUES (?, ?, ?, ?, ?)');
  if (db.prepare('SELECT 1 FROM woo_events WHERE delivery_id = ?').get(delivery)) return { status: 'duplicado' };
  const done = (status, note = '', orderId = null) => {
    log.run(delivery, topic, orderId ?? (payload.id ? String(payload.id) : null), status, String(note).slice(0, 500) || null);
    return { status, note: note || undefined };
  };

  if (topic === 'order.created' || topic === 'order.updated') {
    const known = db.prepare('SELECT order_id FROM woo_orders WHERE woo_order_id = ?').get(String(payload.id));
    if (known) {
      if (REVERT.has(payload.status)) {
        const cur = db.prepare('SELECT status FROM orders WHERE id = ?').get(known.order_id);
        if (cur?.status === 'pagado') {
          setOrderStatus(db, known.order_id, 'cancelado');
          return done('revertido', `Pedido #${known.order_id} cancelado: el stock volvió al inventario`);
        }
        return done('ignorado', 'El pedido ya estaba entregado o cancelado: el stock no se devuelve solo');
      }
      if (payload.status === 'completed') {
        const cur = db.prepare('SELECT status FROM orders WHERE id = ?').get(known.order_id);
        if (cur?.status === 'pagado') setOrderStatus(db, known.order_id, 'entregado');
        return done('actualizado', `Pedido #${known.order_id} entregado`);
      }
      return done('ignorado', 'Pedido ya registrado');
    }
    if (!DEDUCT.has(payload.status)) return done('ignorado', `Estado "${payload.status}": todavía no descuenta stock`);
    const r = recordOrder(db, payload);
    if (r.orderId) autoReplenish(db);
    const notes = [r.missing.length && `Sin enlazar: ${r.missing.join(', ')}`, r.short.length && `Faltante: ${r.short.join('; ')}`].filter(Boolean).join(' · ');
    return done(r.orderId ? 'descontado' : 'sin_productos', notes, String(payload.id));
  }

  if ((topic === 'product.created' || topic === 'product.updated') && payload.id) {
    const items = [fromRest(payload)];
    if (payload.type === 'variable') {
      if (!client) return done('ignorado', 'Producto variable: falta la conexión REST para leer sus variaciones');
      for (const v of await client.listVariations(payload.id)) items.push(fromRest(v, payload));
    }
    const { plan } = planFromRest(items);
    const r = applyPlan(db, plan, { reason: 'Sincronización con WooCommerce', updateStock });
    bumpCatalog(db);
    return done('sincronizado', `${r.products.created + r.products.updated} producto(s), ${r.stock_adjusted} ajuste(s) de stock`);
  }
  return done('ignorado', `Tema "${topic}" sin acción`);
}
