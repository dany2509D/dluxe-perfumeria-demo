// Reportes de gerencia: ventas, márgenes, marcas, rotación del inventario y existencias sin movimiento.
// Todo se calcula en SQL sobre las líneas de los pedidos pagados. «Neto» = después del descuento del pedido y de lo devuelto.
import { HttpError } from './db.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const PAID = "o.status IN ('pagado','entregado')";
// Ingreso neto de una línea: unidades no devueltas × precio, con el descuento del pedido repartido en proporción.
const NET_UNITS = '(oi.qty - oi.returned_qty)';
const NET_REVENUE = `(${NET_UNITS} * oi.unit_price * (1.0 - CASE WHEN o.subtotal > 0 THEN o.discount / o.subtotal ELSE 0 END))`;
const NET_COST = `(${NET_UNITS} * oi.unit_cost)`;

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Período: fechas AAAA-MM-DD. Por defecto, los últimos 30 días (hoy incluido). Máximo 366 días.
export function period(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
  const end = ok(to) ? to : day(new Date());
  const start = ok(from) ? from : day(new Date(Date.parse(end) + 3600e3 * 12 - 29 * 864e5));
  if (start > end) throw new HttpError(400, 'La fecha de inicio es posterior a la de fin');
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  if (days > 366) throw new HttpError(400, 'El período no puede pasar de un año');
  return { from: start, to: end, days };
}

const FROM_LINES = `FROM order_items oi
  JOIN orders o ON o.id = oi.order_id AND ${PAID} AND date(o.created_at) BETWEEN ? AND ?
  JOIN variants v ON v.id = oi.variant_id
  JOIN products p ON p.id = v.product_id`;

const GROUPS = {
  brand: { key: "COALESCE(NULLIF(p.brand, ''), '(sin marca)')", label: 'Marca' },
  category: { key: 'p.category', label: 'Categoría' },
  kind: { key: 'p.kind', label: 'Tipo' },
  family: { key: "COALESCE(NULLIF(p.family, ''), '(sin familia)')", label: 'Familia olfativa' },
  product: { key: "p.name || CASE WHEN v.size_ml > 0 THEN ' ' || v.size_ml || ' ml' ELSE '' END", label: 'Producto' },
};

function breakdown(db, { from, to }, by, limit = 50) {
  const g = GROUPS[by];
  return db
    .prepare(
      `SELECT ${g.key} AS name, COALESCE(SUM(${NET_UNITS}), 0) AS units, COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
              COALESCE(SUM(${NET_REVENUE} - ${NET_COST}), 0) AS margin
         ${FROM_LINES} GROUP BY ${g.key} HAVING units > 0 ORDER BY revenue DESC LIMIT ?`
    )
    .all(from, to, limit)
    .map((r) => ({ ...r, revenue: round2(r.revenue), margin: round2(r.margin), margin_pct: r.revenue > 0 ? round2((r.margin / r.revenue) * 100) : 0 }));
}

export function salesReport(db, fromQ, toQ) {
  const p = period(fromQ, toQ);
  const { from, to } = p;
  const lines = db.prepare(`SELECT COALESCE(SUM(${NET_UNITS}), 0) AS units, COALESCE(SUM(${NET_REVENUE}), 0) AS revenue, COALESCE(SUM(${NET_COST}), 0) AS cost ${FROM_LINES}`).get(from, to);
  const orders = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(discount), 0) AS discounts, COALESCE(SUM(refunded), 0) AS refunded
         FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ?`
    )
    .get(from, to);
  const returns = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM returns WHERE date(created_at) BETWEEN ? AND ?').get(from, to);
  const giftSold = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(initial_amount), 0) AS amount FROM gift_cards WHERE source = 'venta' AND status <> 'anulada' AND date(created_at) BETWEEN ? AND ?").get(from, to);
  const giftRedeemed = db.prepare("SELECT COALESCE(SUM(gift_amount), 0) AS amount FROM orders o WHERE " + PAID + " AND date(o.created_at) BETWEEN ? AND ?").get(from, to);

  const series = new Map(
    db
      .prepare(`SELECT date(o.created_at) AS day, COUNT(*) AS n, SUM(o.total) AS total FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ? GROUP BY day`)
      .all(from, to)
      .map((r) => [r.day, r])
  );
  const byDay = [];
  for (let i = 0; i < p.days; i++) {
    const d = day(new Date(Date.parse(from) + 3600e3 * 12 + i * 864e5));
    byDay.push({ day: d, n: series.get(d)?.n || 0, total: round2(series.get(d)?.total || 0) });
  }
  const channel = db.prepare(`SELECT o.channel AS name, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ? GROUP BY o.channel ORDER BY revenue DESC`).all(from, to);
  const payment = db.prepare(`SELECT o.payment_method AS name, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ? GROUP BY o.payment_method ORDER BY revenue DESC`).all(from, to);
  const seller = db.prepare(`SELECT COALESCE(NULLIF(o.user_name, ''), CASE WHEN o.channel = 'online' THEN '(tienda en línea)' ELSE '(sin asignar)' END) AS name, COUNT(*) AS orders, COALESCE(SUM(o.total), 0) AS revenue FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ? GROUP BY name ORDER BY revenue DESC`).all(from, to);
  const promos = db.prepare(`SELECT COALESCE(NULLIF(o.coupon_code, ''), o.promo_label) AS name, COUNT(*) AS orders, COALESCE(SUM(o.discount), 0) AS discount FROM orders o WHERE ${PAID} AND o.discount > 0 AND date(o.created_at) BETWEEN ? AND ? GROUP BY name ORDER BY discount DESC LIMIT 10`).all(from, to);

  const revenue = round2(lines.revenue);
  const margin = round2(lines.revenue - lines.cost);
  return {
    period: p,
    kpis: {
      orders: orders.n, units: lines.units, gross: round2(orders.gross), discounts: round2(orders.discounts), refunded: round2(orders.refunded),
      net: revenue, margin, margin_pct: revenue > 0 ? round2((margin / revenue) * 100) : 0, avg_ticket: orders.n ? round2(orders.gross / orders.n) : 0,
      returns_count: returns.n, returns_amount: round2(returns.amount),
      gift_sold_count: giftSold.n, gift_sold_amount: round2(giftSold.amount), gift_redeemed: round2(giftRedeemed.amount),
    },
    byDay,
    channel: channel.map((r) => ({ ...r, revenue: round2(r.revenue) })),
    payment: payment.map((r) => ({ ...r, revenue: round2(r.revenue) })),
    seller: seller.map((r) => ({ ...r, revenue: round2(r.revenue) })),
    promos: promos.map((r) => ({ ...r, discount: round2(r.discount) })),
    brands: breakdown(db, p, 'brand', 30),
    categories: breakdown(db, p, 'category', 10),
    kinds: breakdown(db, p, 'kind', 10),
    families: breakdown(db, p, 'family', 15),
    products: breakdown(db, p, 'product', 20),
  };
}

// Detalle de un reporte como filas planas, listas para exportar (CSV).
export function exportRows(db, what, fromQ, toQ) {
  const p = period(fromQ, toQ);
  if (what === 'ventas') {
    return {
      columns: ['Pedido', 'Fecha', 'Canal', 'Cliente', 'Pago', 'Subtotal', 'Descuento', 'Tarjeta de regalo', 'Total', 'Devuelto', 'Estado', 'Atendió'],
      rows: db
        .prepare(`SELECT o.id, o.created_at, o.channel, o.customer_name, o.payment_method, o.subtotal, o.discount, o.gift_amount, o.total, o.refunded, o.status, o.user_name FROM orders o WHERE ${PAID} AND date(o.created_at) BETWEEN ? AND ? ORDER BY o.id`)
        .all(p.from, p.to)
        .map((r) => Object.values(r)),
    };
  }
  if (what === 'productos') {
    return {
      columns: ['SKU', 'Producto', 'Marca', 'Categoría', 'Unidades netas', 'Ingreso neto', 'Margen'],
      rows: db
        .prepare(
          `SELECT v.sku, p.name || CASE WHEN v.size_ml > 0 THEN ' ' || v.size_ml || ' ml' ELSE '' END, p.brand, p.category, SUM(${NET_UNITS}), ROUND(SUM(${NET_REVENUE}), 2), ROUND(SUM(${NET_REVENUE} - ${NET_COST}), 2)
             ${FROM_LINES} GROUP BY v.id HAVING SUM(${NET_UNITS}) > 0 ORDER BY SUM(${NET_REVENUE}) DESC`
        )
        .all(p.from, p.to)
        .map((r) => Object.values(r)),
    };
  }
  throw new HttpError(400, 'Ese reporte no existe');
}

// Rotación: cuánto se vende de cada producto en los últimos N días frente a lo que hay en existencia.
export function rotationReport(db, { days = 90, limit = 30 } = {}) {
  const d = Math.max(7, Math.min(Number(days) || 90, 365));
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.brand, SUM(v.stock) AS stock, ROUND(SUM(v.stock * v.cost), 2) AS capital, ROUND(SUM(v.stock * v.price), 2) AS retail,
              COALESCE((SELECT SUM(oi.qty - oi.returned_qty)
                          FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status IN ('pagado','entregado') AND date(o.created_at) >= date('now','localtime', ?)
                          JOIN variants vv ON vv.id = oi.variant_id WHERE vv.product_id = p.id), 0) AS sold,
              (SELECT MAX(date(o.created_at)) FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.status IN ('pagado','entregado')
                 JOIN variants vv ON vv.id = oi.variant_id WHERE vv.product_id = p.id) AS last_sale
         FROM products p JOIN variants v ON v.product_id = p.id AND v.active = 1 AND v.is_set = 0
        WHERE p.active = 1 GROUP BY p.id HAVING stock > 0`
    )
    .all(`-${d} days`);
  const withCover = rows.map((r) => ({ ...r, per_day: round2(r.sold / d), cover_days: r.sold > 0 ? Math.round(r.stock / (r.sold / d)) : null }));
  const dead = withCover.filter((r) => r.sold === 0).sort((a, b) => b.capital - a.capital);
  const fast = withCover.filter((r) => r.sold > 0).sort((a, b) => b.sold - a.sold);
  const slow = withCover.filter((r) => r.sold > 0 && r.cover_days > 180).sort((a, b) => b.cover_days - a.cover_days);
  const lowCover = withCover.filter((r) => r.sold > 0 && r.cover_days <= 14).sort((a, b) => a.cover_days - b.cover_days);
  const historyDays = db.prepare("SELECT CAST(julianday(date('now','localtime')) - julianday(date(MIN(created_at))) AS INTEGER) + 1 AS d FROM orders WHERE status IN ('pagado','entregado')").get().d || 0;
  return {
    days: d, history_days: historyDays,
    totals: {
      products: rows.length,
      dead_count: dead.length, dead_capital: round2(dead.reduce((s, r) => s + r.capital, 0)),
      capital: round2(rows.reduce((s, r) => s + r.capital, 0)),
    },
    dead: dead.slice(0, limit), fast: fast.slice(0, limit), slow: slow.slice(0, limit), low_cover: lowCover.slice(0, limit),
  };
}

// CSV con «;» y BOM (Excel en español lo abre con las columnas bien separadas y las tildes intactas).
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    const safe = typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // evita que Excel interprete un texto como fórmula
    return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '\ufeff' + [columns, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
