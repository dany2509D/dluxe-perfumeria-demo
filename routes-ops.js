// Rutas del panel para la operación diaria: caja, devoluciones, recibos, reportes, promociones, tarjetas de regalo, sets,
// avisos, facturas y fotos. Las rutas de ventas, inventario y usuarios siguen en app.js.
import { HttpError, getSetting, setSetting } from './db.js';
import * as svc from './service.js';
import * as auth from './auth.js';
import * as shifts from './shifts.js';
import * as returns from './returns.js';
import * as reports from './reports.js';
import * as pricing from './pricing.js';
import * as gift from './giftcards.js';
import * as bundles from './bundles.js';
import * as notify from './notify.js';
import * as invoicing from './invoicing.js';
import * as media from './media.js';

// Valores que el gerente puede ajustar sin tocar código.
export const POLICY = {
  require_shift: { type: 'bool', default: '0' },
  return_days: { type: 'int', default: '30', min: 0, max: 365 },
  max_manual_discount: { type: 'int', default: '10', min: 0, max: 100 },
  alert_whatsapp: { type: 'phone', default: '' },
  alert_email: { type: 'email', default: '' },
};

export function policy(db) {
  return {
    require_shift: getSetting(db, 'require_shift', POLICY.require_shift.default) === '1',
    return_days: Number(getSetting(db, 'return_days', POLICY.return_days.default)),
    max_manual_discount: Number(getSetting(db, 'max_manual_discount', POLICY.max_manual_discount.default)),
    alert_whatsapp: getSetting(db, 'alert_whatsapp', ''),
    alert_email: getSetting(db, 'alert_email', ''),
  };
}

export function registerOps(kit) {
  const { admin, db, brand, services, notifyCfg, fiscalCfg, payCfg, withDemoUsers } = kit;
  const can = auth.can;

  // ─── Lector de códigos ────────────────────────────────────────────────
  admin('GET', '/api/admin/lookup', (c) => {
    const row = svc.lookupCode(db, c.query.get('code'));
    if (!can(c.user, 'costos')) { delete row.cost; delete row.supplier_id; delete row.supplier_name; delete row.reorder_qty; }
    return row;
  }, { perm: ['pos', 'inventario'] });

  // ─── Precio de la venta de mostrador (para el ticket en pantalla) ─────
  admin('POST', '/api/admin/pos/quote', (c) => {
    const wanted = new Map();
    for (const it of Array.isArray(c.body.items) ? c.body.items.slice(0, 50) : []) {
      const id = Number(it.variant_id);
      const qty = Math.min(99, Math.max(1, Math.floor(Number(it.qty) || 0)));
      if (Number.isInteger(id) && id > 0) wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    const manual = c.body.discount && typeof c.body.discount === 'object' ? c.body.discount : null;
    const cap = can(c.user, 'descuento_libre') ? 100 : can(c.user, 'descuento_manual') ? Number(getSetting(db, 'max_manual_discount', '10')) : 0;
    if (manual && cap <= 0) throw new HttpError(403, 'No tienes permiso para dar descuentos');
    const q = pricing.quote(db, { lines: bundles.priceLinesOf(db, wanted), coupon: c.body.coupon, channel: 'mostrador', manual });
    if (manual && cap < 100 && q.subtotal > 0 && (q.discount / q.subtotal) * 100 > cap + 1e-9) throw new HttpError(403, `Tu rol permite descontar hasta ${cap}%: pide autorización a un gerente`);
    let giftOut = null;
    if (String(c.body.gift_code ?? '').trim()) {
      const card = gift.usableCard(db, c.body.gift_code);
      giftOut = { code: card.code, balance: card.balance, applied: Math.min(card.balance, q.total) };
    }
    return { subtotal: q.subtotal, discount: q.discount, total: q.total, applied: q.applied, coupon_note: q.couponNote, gift: giftOut, due: Math.round((q.total - (giftOut?.applied || 0)) * 100) / 100, max_discount_pct: cap };
  }, { perm: 'pos' });

  // ─── Caja ─────────────────────────────────────────────────────────────
  admin('GET', '/api/admin/shift', (c) => {
    const s = shifts.currentShift(db, c.user.id);
    return { shift: s ? shifts.shiftView(db, s) : null, require_shift: policy(db).require_shift };
  }, { perm: 'caja' });
  admin('POST', '/api/admin/shift/open', (c) => {
    c.status = 201;
    const s = shifts.openShift(db, c.user, c.body.opening_cash);
    c.log('caja.abrir', 'caja', s.id, `fondo ${s.opening_cash}`);
    return s;
  }, { perm: 'caja' });
  admin('POST', '/api/admin/shift/movement', (c) => {
    const s = shifts.addMovement(db, c.user, c.body);
    c.log(`caja.${c.body.kind}`, 'caja', s.id, `${c.body.amount} · ${String(c.body.reason ?? '').slice(0, 80)}`);
    return s;
  }, { perm: 'caja' });
  admin('POST', '/api/admin/shift/close', (c) => {
    const s = shifts.closeShift(db, c.user, c.body);
    c.log('caja.cerrar', 'caja', s.id, `esperado ${s.expected_cash} · contado ${s.counted_cash} · diferencia ${s.difference}`);
    return s;
  }, { perm: 'caja' });
  admin('GET', '/api/admin/shifts', (c) =>
    shifts.listShifts(db, { userId: can(c.user, 'caja_todas') ? Number(c.query.get('user_id')) || null : c.user.id, page: c.query.get('page') || 1 }),
    { perm: 'caja' }
  );
  admin('GET', '/api/admin/shifts/:id', (c) => {
    const s = shifts.getShift(db, Number(c.params.id));
    if (s.user_id !== c.user.id && !can(c.user, 'caja_todas')) throw new HttpError(403, 'No tienes permiso para ver la caja de otra persona');
    return s;
  }, { perm: 'caja' });
  admin('POST', '/api/admin/shifts/:id/close', (c) => {
    const s = shifts.closeShift(db, c.user, { ...c.body, shiftId: Number(c.params.id) });
    c.log('caja.cerrar_ajena', 'caja', s.id, `de ${s.user_name} · diferencia ${s.difference}`);
    return s;
  }, { perm: 'caja_todas' });

  // ─── Pedidos: ficha, avance y recibo ──────────────────────────────────
  admin('GET', '/api/admin/orders/:id', (c) => svc.getOrderDetail(db, Number(c.params.id)), { perm: 'pedidos' });
  admin('POST', '/api/admin/orders/:id/progress', (c) => {
    const o = svc.advanceOrder(db, Number(c.params.id), c.body.step, { actor: c.user, services: services(c) });
    c.log(`pedido.${c.body.step}`, 'pedido', c.params.id);
    return o;
  }, { perm: 'pedidos' });
  admin('GET', '/api/admin/orders/:id/receipt', (c) => {
    const o = svc.getOrderDetail(db, Number(c.params.id));
    return {
      store: { name: brand.name, short: brand.short, address: brand.address, phone: brand.phone, email: brand.email, country: brand.country, hours: brand.hours, tax_name: brand.taxName, tax_rate: brand.taxRate, tax_included: brand.taxIncluded },
      order: o,
      fiscal_demo: fiscalCfg.provider === 'demo',
      tax: brand.taxRate > 0 && brand.taxIncluded ? Math.round((o.total - o.total / (1 + brand.taxRate)) * 100) / 100 : 0,
      url: o.tracking_code ? `${services(c).baseUrl}/#seguimiento/${o.tracking_code}` : '',
    };
  }, { perm: ['pos', 'pedidos'] });

  // ─── Devoluciones ─────────────────────────────────────────────────────
  admin('GET', '/api/admin/orders/:id/returnable', (c) => returns.returnable(db, Number(c.params.id)), { perm: 'devoluciones' });
  admin('POST', '/api/admin/orders/:id/returns', (c) => {
    c.status = 201;
    const r = returns.createReturn(db, Number(c.params.id), c.body, { actor: c.user, fiscal: fiscalCfg, brand, baseUrl: services(c).baseUrl, canOverride: can(c.user, 'descuento_libre') });
    c.log('devolucion.crear', 'pedido', c.params.id, `$${r.amount.toFixed(2)} · ${r.refund_method}${c.body.override_window ? ' · fuera de plazo' : ''}`);
    return r;
  }, { perm: 'devoluciones' });
  admin('GET', '/api/admin/returns', (c) => returns.listReturns(db, { page: c.query.get('page') || 1 }), { perm: 'devoluciones' });

  // ─── Reportes ─────────────────────────────────────────────────────────
  admin('GET', '/api/admin/reports/sales', (c) => reports.salesReport(db, c.query.get('from'), c.query.get('to')), { perm: 'reportes' });
  admin('GET', '/api/admin/reports/rotation', (c) => reports.rotationReport(db, { days: c.query.get('days') }), { perm: 'reportes' });
  admin('GET', '/api/admin/reports/export', (c) => {
    const { columns, rows } = reports.exportRows(db, c.query.get('what'), c.query.get('from'), c.query.get('to'));
    const name = `${c.query.get('what')}-${c.query.get('from') || 'inicio'}-${c.query.get('to') || 'hoy'}.csv`.replace(/[^\w.-]/g, '_');
    c.log('reporte.exportar', 'reporte', '', name);
    c.reply(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }, Buffer.from(reports.toCsv(columns, rows), 'utf8'));
  }, { perm: 'reportes' });

  // ─── Promociones y cupones ────────────────────────────────────────────
  admin('GET', '/api/admin/promotions', () => ({ promotions: pricing.listPromotions(db), brands: svc.listBrands(db).map((b) => b.name), categories: svc.CATEGORIES, kinds: svc.KINDS }), { perm: 'promociones' });
  admin('POST', '/api/admin/promotions', (c) => {
    c.status = 201;
    const r = pricing.createPromotion(db, c.body);
    c.log('promocion.crear', 'promocion', r.id, `${c.body.name}${c.body.code ? ` (${String(c.body.code).toUpperCase()})` : ''}`);
    return r;
  }, { perm: 'promociones' });
  admin('PATCH', '/api/admin/promotions/:id', (c) => {
    const r = pricing.updatePromotion(db, Number(c.params.id), c.body);
    c.log('promocion.editar', 'promocion', c.params.id, Object.keys(c.body).join(', '));
    return r;
  }, { perm: 'promociones' });
  admin('DELETE', '/api/admin/promotions/:id', (c) => {
    const r = pricing.removePromotion(db, Number(c.params.id));
    c.log(r.removed ? 'promocion.eliminar' : 'promocion.desactivar', 'promocion', c.params.id);
    return r;
  }, { perm: 'promociones' });

  // ─── Tarjetas de regalo ───────────────────────────────────────────────
  admin('GET', '/api/admin/gift-cards', (c) => gift.listCards(db, { q: c.query.get('q') || '', status: c.query.get('status') || '', page: c.query.get('page') || 1 }), { perm: 'regalos' });
  admin('GET', '/api/admin/gift-cards/:id', (c) => gift.cardDetail(db, Number(c.params.id)), { perm: 'regalos' });
  // Venta de una tarjeta en el mostrador: se cobra como cualquier venta y, si es en efectivo, entra a la caja del turno.
  admin('POST', '/api/admin/gift-cards', (c) => {
    c.status = 201;
    const method = ['efectivo', 'tarjeta', 'transferencia'].includes(c.body.payment_method) ? c.body.payment_method : null;
    if (!method) throw new HttpError(400, 'Indica cómo pagó el cliente');
    const shift = shifts.currentShift(db, c.user.id);
    if (!shift && policy(db).require_shift) throw new HttpError(409, 'Abre tu caja antes de cobrar');
    const card = gift.issueCard(db, { amount: c.body.amount, buyer: c.body.buyer, recipient: c.body.recipient, message: c.body.message, paymentMethod: method, user: c.user, shiftId: shift?.id ?? null });
    c.log('regalo.vender', 'tarjeta', card.id, `$${card.initial_amount.toFixed(2)} · ${method}`);
    notifyGiftCard(db, card, services(c));
    return card;
  }, { perm: 'regalos' });
  admin('POST', '/api/admin/gift-cards/:id/status', (c) => {
    const card = gift.setCardStatus(db, Number(c.params.id), c.body.status);
    c.log(`regalo.${c.body.status}`, 'tarjeta', card.id);
    if (c.body.status === 'activa') notifyGiftCard(db, card, services(c));
    return card;
  }, { perm: 'regalos' });

  // ─── Sets de regalo ───────────────────────────────────────────────────
  admin('GET', '/api/admin/sets', () => ({ sets: bundles.listSets(db) }), { perm: 'sets' });
  admin('POST', '/api/admin/sets', (c) => {
    c.status = 201;
    const r = bundles.createSet(db, c.body, { skuPrefix: brand.skuPrefix });
    c.log('set.crear', 'producto', r.product_id, String(c.body.name ?? '').slice(0, 80));
    return r;
  }, { perm: 'sets' });
  admin('PATCH', '/api/admin/sets/:id', (c) => {
    const r = bundles.updateSet(db, Number(c.params.id), c.body);
    c.log('set.editar', 'producto', c.params.id, Object.keys(c.body).join(', '));
    return r;
  }, { perm: 'sets' });

  // ─── Avisos ───────────────────────────────────────────────────────────
  admin('GET', '/api/admin/notifications', (c) => ({
    ...notify.listNotifications(db, { status: c.query.get('status') || '', channel: c.query.get('channel') || '', page: c.query.get('page') || 1, brand, baseUrl: services(c).baseUrl }),
    mode: notify.notifyReady(notifyCfg) ? 'webhook' : 'simulado',
    settings: policy(db),
    waiting: db.prepare('SELECT COUNT(*) AS n FROM stock_alerts WHERE notified_at IS NULL').get().n,
  }), { perm: 'notificaciones' });
  admin('POST', '/api/admin/notifications/flush', async (c) => notify.flush(db, notifyCfg, { brand, baseUrl: services(c).baseUrl }), { perm: 'notificaciones' });
  admin('POST', '/api/admin/notifications/:id/retry', (c) => notify.retry(db, Number(c.params.id)), { perm: 'notificaciones' });
  admin('POST', '/api/admin/notifications/test', (c) => {
    const r = notify.sendTest(db, { channel: c.body.channel, to: c.body.to });
    c.log('aviso.prueba', 'aviso', r.id, `${c.body.channel}`);
    return r;
  }, { perm: 'notificaciones' });
  admin('GET', '/api/admin/stock-alerts', () => ({
    rows: db
      .prepare(
        `SELECT p.id AS product_id, p.name, COALESCE(v.size_ml, 0) AS size_ml, COUNT(*) AS waiting, COALESCE(v.stock, (SELECT SUM(stock) FROM variants WHERE product_id = p.id)) AS stock
           FROM stock_alerts a JOIN products p ON p.id = a.product_id LEFT JOIN variants v ON v.id = a.variant_id
          WHERE a.notified_at IS NULL GROUP BY p.id, a.variant_id ORDER BY waiting DESC LIMIT 50`
      )
      .all(),
  }), { perm: 'inventario' });

  // ─── Facturas electrónicas ────────────────────────────────────────────
  admin('GET', '/api/admin/fiscal', (c) => ({
    ...invoicing.listDocuments(db, { kind: c.query.get('kind') || '', status: c.query.get('status') || '', q: c.query.get('q') || '', page: c.query.get('page') || 1 }),
    provider: fiscalCfg.provider,
  }), { perm: 'facturas' });
  admin('POST', '/api/admin/fiscal/flush', async () => invoicing.flushFiscal(db, fiscalCfg, { brand }), { perm: 'facturas' });
  admin('POST', '/api/admin/fiscal/:id/retry', (c) => invoicing.retryDocument(db, Number(c.params.id)), { perm: 'facturas' });

  // ─── Fotos ────────────────────────────────────────────────────────────
  admin('POST', '/api/admin/media', (c) => {
    c.status = 201;
    const m = media.saveImage(db, c.raw, c.query.get('name') || '');
    c.log('foto.subir', 'foto', m.id, `${Math.round(m.size / 1024)} KB`);
    return m;
  }, { perm: 'productos', raw: true, limit: media.MAX_BYTES + 1024 });

  // ─── Configuración de la tienda ───────────────────────────────────────
  admin('GET', '/api/admin/policy', () => ({ ...policy(db), demo_users: !!withDemoUsers, payments: payCfg.provider, fiscal: fiscalCfg.provider, notify: notify.notifyReady(notifyCfg) ? 'webhook' : 'simulado' }), { perm: 'configuracion' });
  admin('PATCH', '/api/admin/policy', (c) => {
    const changed = [];
    for (const [key, def] of Object.entries(POLICY)) {
      if (!(key in c.body)) continue;
      let v = c.body[key];
      if (def.type === 'bool') v = v ? '1' : '0';
      else if (def.type === 'int') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < def.min || n > def.max) throw new HttpError(400, `${key} debe ser un número entero entre ${def.min} y ${def.max}`);
        v = String(n);
      } else if (def.type === 'phone') {
        v = String(v ?? '').trim();
        if (v && !notify.phoneDigits(v)) throw new HttpError(400, 'El número de WhatsApp no es válido (incluye el código de país, por ejemplo 507…)');
        v = v ? notify.phoneDigits(v) : '';
      } else if (def.type === 'email') {
        v = String(v ?? '').trim();
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'El correo no es válido');
      }
      setSetting(db, key, v);
      changed.push(key);
    }
    if (!changed.length) throw new HttpError(400, 'No hay cambios que guardar');
    c.log('ajustes.politica', 'ajustes', '', changed.join(', '));
    return policy(db);
  }, { perm: 'configuracion' });
}

// Cuando una tarjeta de regalo queda activa: el código le llega al comprador y, por correo, a quien la recibe.
export function notifyGiftCard(db, card, services = {}) {
  if (card.status !== 'activa') return;
  const base = { amount: card.initial_amount, code: card.code, expires_at: card.expires_at, message: card.message };
  if (card.recipient_email) notify.enqueue(db, { channel: 'email', to: card.recipient_email, template: 'tarjeta_regalo', payload: { ...base, to: card.recipient_name, from: card.buyer_name }, key: `gc:${card.id}:to` });
  if (card.buyer_email) notify.enqueue(db, { channel: 'email', to: card.buyer_email, template: 'tarjeta_regalo_comprador', payload: { ...base, name: card.buyer_name, recipient: card.recipient_name }, key: `gc:${card.id}:buyer` });
}
