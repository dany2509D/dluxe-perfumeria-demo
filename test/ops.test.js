// La operación: caja, devoluciones, recibos, reportes, facturación, pagos con pasarela, fotos, lector de códigos y políticas.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startApp, variantOf, onlineOrder, stockOf } from './helpers.js';
import { flushFiscal } from '../invoicing.js';
import { expirePending } from '../payments.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const pos = (token, items, extra = {}) => t.call('/api/admin/pos/orders', { method: 'POST', token, body: { payment_method: 'efectivo', items, ...extra } });
const r2 = (n) => Math.round(n * 100) / 100;

describe('caja', () => {
  test('abrir, cobrar en efectivo y con tarjeta, retirar, y cerrar con la diferencia', async () => {
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Citrus Solar', 100);
    assert.equal((await t.call('/api/admin/shift', { token: cajero })).data.shift, null);
    assert.equal((await t.call('/api/admin/shift/open', { method: 'POST', token: cajero, body: { opening_cash: -5 } })).status, 400);
    const open = await t.call('/api/admin/shift/open', { method: 'POST', token: cajero, body: { opening_cash: 50 } });
    assert.equal(open.status, 201);
    assert.equal((await t.call('/api/admin/shift/open', { method: 'POST', token: cajero, body: { opening_cash: 10 } })).status, 409, 'una sola caja abierta por persona');
    const cash = await pos(cajero, [{ variant_id: v.id, qty: 1 }]);
    const card = await pos(cajero, [{ variant_id: v.id, qty: 1 }], { payment_method: 'tarjeta' });
    assert.equal(cash.data.shift_id, open.data.id);
    const mov = await t.call('/api/admin/shift/movement', { method: 'POST', token: cajero, body: { kind: 'retiro', amount: 20, reason: 'Pago al mensajero' } });
    assert.equal(mov.status, 200);
    assert.equal((await t.call('/api/admin/shift/movement', { method: 'POST', token: cajero, body: { kind: 'retiro', amount: 9999, reason: 'x' } })).status, 409, 'no hay tanto efectivo');
    assert.equal((await t.call('/api/admin/shift/movement', { method: 'POST', token: cajero, body: { kind: 'retiro', amount: 5, reason: '' } })).status, 400);
    const live = (await t.call('/api/admin/shift', { token: cajero })).data.shift.totals;
    assert.equal(live.cash_sales, cash.data.total);
    assert.equal(live.card_sales, card.data.total);
    assert.equal(live.tickets, 2);
    assert.equal(live.expected_cash, r2(50 + cash.data.total - 20), 'fondo + efectivo − retiros; la tarjeta no es efectivo');
    const expected = live.expected_cash;
    const close = await t.call('/api/admin/shift/close', { method: 'POST', token: cajero, body: { counted: expected - 3.5, notes: 'Faltó cambio' } });
    assert.equal(close.status, 200);
    assert.equal(close.data.status, 'cerrado');
    assert.equal(close.data.difference, -3.5);
    assert.equal(close.data.totals.expected_cash, expected, 'el cierre guarda una foto de los totales');
    assert.equal((await t.call('/api/admin/shift/close', { method: 'POST', token: cajero, body: { counted: 0 } })).status, 404, 'ya no hay caja abierta');
    const next = await pos(cajero, [{ variant_id: v.id, qty: 1 }]);
    assert.equal(next.data.shift_id, null, 'sin caja abierta, la venta no se ata a ningún turno');
  });
  test('con «caja obligatoria», no se cobra sin turno abierto', async () => {
    const gerente = await t.login('gerente');
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Citrus Solar', 100);
    assert.equal((await t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body: { require_shift: true } })).status, 200);
    assert.equal((await pos(cajero, [{ variant_id: v.id, qty: 1 }])).status, 409);
    await t.call('/api/admin/shift/open', { method: 'POST', token: cajero, body: { opening_cash: 0 } });
    assert.equal((await pos(cajero, [{ variant_id: v.id, qty: 1 }])).status, 201);
    // el gerente cierra la caja de otra persona; el cajero no ve las ajenas
    const list = (await t.call('/api/admin/shifts', { token: gerente })).data.rows;
    const mine = list.find((s) => s.status === 'abierto');
    assert.equal((await t.call(`/api/admin/shifts/${mine.id}`, { token: await t.login('bodega') })).status, 403);
    assert.equal((await t.call(`/api/admin/shifts/${mine.id}/close`, { method: 'POST', token: cajero, body: { counted: 0 } })).status, 403);
    const forced = await t.call(`/api/admin/shifts/${mine.id}/close`, { method: 'POST', token: gerente, body: { counted: mine.totals.expected_cash } });
    assert.equal(forced.status, 200);
    assert.equal(forced.data.difference, 0);
    await t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body: { require_shift: false } });
    assert.equal((await t.call('/api/admin/shifts', { token: cajero })).data.rows.every((s) => s.user_name === 'Cajero de mostrador'), true);
  });
});

describe('recibo', () => {
  test('el recibo trae tienda, líneas, descuento y factura de demostración', async () => {
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const sale = await pos(cajero, [{ variant_id: v.id, qty: 2 }], { coupon: 'MOSTRADOR5' });
    assert.equal(sale.status, 201);
    const rc = (await t.call(`/api/admin/orders/${sale.data.id}/receipt`, { token: cajero })).data;
    assert.equal(rc.store.short, "D'Luxe");
    assert.equal(rc.order.items[0].qty, 2);
    assert.equal(rc.order.discount, 5);
    assert.equal(rc.order.total, r2(v.price * 2 - 5));
    assert.equal(rc.tax, r2(rc.order.total - rc.order.total / 1.07));
    assert.equal(rc.fiscal_demo, true);
    assert.match(rc.order.documents[0].number, /^FE-DEMO-\d{6}$/);
    assert.equal((await t.call(`/api/admin/orders/${sale.data.id}/receipt`, { token: await t.login('bodega') })).status, 403);
  });
});

describe('devoluciones', () => {
  const returnable = (token, id) => t.call(`/api/admin/orders/${id}/returnable`, { token });
  const doReturn = (token, id, body) => t.call(`/api/admin/orders/${id}/returns`, { method: 'POST', token, body });

  test('devolver una parte en efectivo: sube el stock, baja lo vendido y sale de la caja', async () => {
    const gerente = await t.login('gerente');
    await t.call('/api/admin/shift/open', { method: 'POST', token: gerente, body: { opening_cash: 200 } });
    const v = variantOf(t.db, 'Rosa Imperial', 50);
    const sale = await pos(gerente, [{ variant_id: v.id, qty: 3 }]);
    const sold = () => t.db.prepare('SELECT sold FROM products WHERE id = (SELECT product_id FROM variants WHERE id = ?)').get(v.id).sold;
    const stock0 = stockOf(t.db, v.id);
    const sold0 = sold();
    const info = (await returnable(gerente, sale.data.id)).data;
    assert.equal(info.items[0].available, 3);
    assert.equal(info.in_window, true);
    const bad = await doReturn(gerente, sale.data.id, { reason: 'Frasco defectuoso', refund_method: 'efectivo', items: [{ order_item_id: info.items[0].id, qty: 4 }] });
    assert.equal(bad.status, 409);
    assert.equal((await doReturn(gerente, sale.data.id, { reason: '', refund_method: 'efectivo', items: [{ order_item_id: info.items[0].id, qty: 1 }] })).status, 400);
    const ok = await doReturn(gerente, sale.data.id, { reason: 'No le gustó', refund_method: 'efectivo', items: [{ order_item_id: info.items[0].id, qty: 2 }] });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.amount, r2(v.price * 2));
    assert.equal(stockOf(t.db, v.id), stock0 + 2);
    assert.equal(sold(), sold0 - 2);
    const after = (await returnable(gerente, sale.data.id)).data;
    assert.equal(after.items[0].available, 1);
    assert.equal(after.order.refunded, r2(v.price * 2));
    assert.equal(after.refundable, r2(v.price));
    const shift = (await t.call('/api/admin/shift', { token: gerente })).data.shift.totals;
    assert.equal(shift.refunds_cash, r2(v.price * 2));
    assert.equal(shift.expected_cash, r2(200 + sale.data.total - v.price * 2));
    const detail = (await t.call(`/api/admin/orders/${sale.data.id}`, { token: gerente })).data;
    assert.equal(detail.returns.length, 1);
    assert.ok(detail.documents.some((d) => d.kind === 'nota_credito' && /^NC-DEMO-/.test(d.number)));
    assert.ok(detail.events.some((e) => e.kind === 'devolucion'));
    // no se puede devolver más de lo vendido en total
    assert.equal((await doReturn(gerente, sale.data.id, { reason: 'x', refund_method: 'efectivo', items: [{ order_item_id: info.items[0].id, qty: 2 }] })).status, 409);
    // cancelar después de una devolución parcial solo repone lo que queda
    await t.call(`/api/admin/orders/${sale.data.id}/status`, { method: 'POST', token: gerente, body: { status: 'cancelado' } });
    assert.equal(stockOf(t.db, v.id), stock0 + 3, 'no se repone dos veces lo devuelto');
    assert.equal(sold(), sold0 - 3);
    await t.call('/api/admin/shift/close', { method: 'POST', token: gerente, body: { counted: 0 } });
  });
  test('efectivo exige caja abierta; un pedido sin pagar o cancelado no se devuelve; el cajero no devuelve', async () => {
    const gerente = await t.login('gerente');
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Rosa Imperial', 50);
    const sale = await pos(gerente, [{ variant_id: v.id, qty: 1 }]);
    const info = (await returnable(gerente, sale.data.id)).data;
    const body = { reason: 'Cambio de opinión', refund_method: 'efectivo', items: [{ order_item_id: info.items[0].id, qty: 1 }] };
    assert.equal((await doReturn(gerente, sale.data.id, body)).status, 409, 'sin caja abierta');
    assert.equal((await doReturn(cajero, sale.data.id, body)).status, 403);
    assert.equal((await doReturn(gerente, sale.data.id, { ...body, refund_method: 'dinero_falso' })).status, 400);
    await t.call(`/api/admin/orders/${sale.data.id}/status`, { method: 'POST', token: gerente, body: { status: 'cancelado' } });
    assert.equal((await doReturn(gerente, sale.data.id, { ...body, refund_method: 'nota_credito' })).status, 409);
  });
  test('con descuento, se devuelve lo que realmente se pagó (prorrateado)', async () => {
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Vetiver Real', 100);
    const sale = await pos(gerente, [{ variant_id: v.id, qty: 2 }], { payment_method: 'tarjeta', discount: { type: 'percent', value: 20, reason: 'Promo' } });
    const info = (await returnable(gerente, sale.data.id)).data;
    assert.equal(info.items[0].unit_refund, r2(v.price * 0.8));
    const r = await doReturn(gerente, sale.data.id, { reason: 'Otro tamaño', refund_method: 'metodo_original', items: [{ order_item_id: info.items[0].id, qty: 1 }] });
    assert.equal(r.status, 201);
    assert.equal(r.data.amount, r2(v.price * 0.8));
    const all = await doReturn(gerente, sale.data.id, { reason: 'El otro también', refund_method: 'metodo_original', items: [{ order_item_id: info.items[0].id, qty: 1 }] });
    assert.equal(r2(r.data.amount + all.data.amount), sale.data.total, 'devolverlo todo reintegra exactamente el total pagado');
  });
  test('nota de crédito: emite una tarjeta de regalo con ese saldo, usable y avisada al cliente', async () => {
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Vetiver Real', 50);
    const made = await t.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 70 }) });
    assert.equal(made.status, 201);
    const info = (await returnable(gerente, made.data.id)).data;
    assert.deepEqual(info.allowed_methods.includes('nota_credito'), true);
    const r = await doReturn(gerente, made.data.id, { reason: 'Talla equivocada', refund_method: 'nota_credito', items: [{ order_item_id: info.items[0].id, qty: 1 }] });
    assert.equal(r.status, 201);
    assert.match(r.data.credit_code, /^GC-/);
    assert.equal((await t.call('/api/gift-cards/check', { method: 'POST', body: { code: r.data.credit_code } })).data.balance, v.price);
    const mail = t.db.prepare("SELECT to_addr FROM notifications WHERE dedupe_key = ?").get(`nc:${r.data.id}:email`);
    assert.equal(mail.to_addr, 'cliente70@example.com');
    // pagar con esa tarjeta después → solo se puede devolver como nota de crédito
    const other = variantOf(t.db, 'Vetiver Real', 50);
    const paid = await t.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: other.id, qty: 1 }], { n: 71, gift_code: r.data.credit_code }) });
    assert.equal(paid.data.payment_method, 'tarjeta_regalo');
    const info2 = (await returnable(gerente, paid.data.id)).data;
    assert.deepEqual(info2.allowed_methods, ['nota_credito']);
    assert.equal((await doReturn(gerente, paid.data.id, { reason: 'x', refund_method: 'efectivo', items: [{ order_item_id: info2.items[0].id, qty: 1 }] })).status, 409);
  });
  test('fuera del plazo no se devuelve, salvo que un gerente lo autorice', async () => {
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Rosa Imperial', 100);
    const made = await t.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 72 }) });
    t.db.prepare("UPDATE orders SET created_at = datetime('now','localtime','-40 days') WHERE id = ?").run(made.data.id);
    const info = (await returnable(gerente, made.data.id)).data;
    assert.equal(info.in_window, false);
    const body = { reason: 'Regalo repetido', refund_method: 'nota_credito', items: [{ order_item_id: info.items[0].id, qty: 1 }] };
    const late = await doReturn(gerente, made.data.id, body);
    assert.equal(late.status, 409);
    assert.match(late.data.error, /plazo de devolución es de 30/);
    const forced = await doReturn(gerente, made.data.id, { ...body, override_window: true });
    assert.equal(forced.status, 201);
    const log = (await t.call('/api/admin/audit?action=devolucion', { token: gerente })).data.rows;
    assert.ok(log.some((r) => /fuera de plazo/.test(r.detail)));
    await t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body: { return_days: 90 } });
    const made2 = await t.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 73 }) });
    t.db.prepare("UPDATE orders SET created_at = datetime('now','localtime','-40 days') WHERE id = ?").run(made2.data.id);
    assert.equal((await returnable(gerente, made2.data.id)).data.in_window, true, 'el plazo es configurable');
    await t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body: { return_days: 30 } });
  });
  test('un producto dañado se devuelve sin volver al inventario', async () => {
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Rosa Imperial', 100);
    const made = await t.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 74 }) });
    const stock = stockOf(t.db, v.id);
    const info = (await returnable(gerente, made.data.id)).data;
    const r = await doReturn(gerente, made.data.id, { reason: 'Llegó roto', refund_method: 'metodo_original', items: [{ order_item_id: info.items[0].id, qty: 1, restock: false }] });
    assert.equal(r.status, 201);
    assert.equal(stockOf(t.db, v.id), stock, 'el stock no cambia');
  });
});

describe('reportes', () => {
  test('el reporte de ventas cuadra con la base de datos y resta lo devuelto', async () => {
    const gerente = await t.login('gerente');
    const rep = (await t.call('/api/admin/reports/sales', { token: gerente })).data;
    const rows = t.db.prepare(
      `SELECT SUM(oi.qty - oi.returned_qty) AS units,
              SUM((oi.qty - oi.returned_qty) * oi.unit_price * (1.0 - CASE WHEN o.subtotal > 0 THEN o.discount / o.subtotal ELSE 0 END)) AS net
         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status IN ('pagado','entregado') AND date(o.created_at) BETWEEN ? AND ?`
    ).get(rep.period.from, rep.period.to);
    assert.equal(rep.kpis.units, rows.units);
    assert.ok(Math.abs(rep.kpis.net - rows.net) < 0.02);
    assert.equal(rep.kpis.orders, t.db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('pagado','entregado') AND date(created_at) BETWEEN ? AND ?").get(rep.period.from, rep.period.to).n);
    assert.ok(rep.kpis.discounts > 0 && rep.kpis.returns_count >= 3 && rep.kpis.returns_amount > 0);
    assert.equal(rep.byDay.length, 30);
    assert.equal(rep.byDay.reduce((s, d) => s + d.n, 0), rep.kpis.orders);
    const brandTotal = r2(rep.brands.reduce((s, b) => s + b.revenue, 0));
    assert.ok(Math.abs(brandTotal - rep.kpis.net) < 0.1, `marcas ${brandTotal} vs neto ${rep.kpis.net}`);
    assert.ok(rep.brands[0].revenue >= rep.brands[rep.brands.length - 1].revenue);
    assert.ok(rep.seller.some((s) => s.name === 'Cajero de mostrador'));
    assert.ok(rep.kpis.margin < rep.kpis.net && rep.kpis.margin > 0);
  });
  test('período inválido, demasiado largo o al revés se rechaza; el rango se respeta', async () => {
    const gerente = await t.login('gerente');
    assert.equal((await t.call('/api/admin/reports/sales?from=2026-12-01&to=2026-01-01', { token: gerente })).status, 400);
    assert.equal((await t.call('/api/admin/reports/sales?from=2020-01-01&to=2026-12-31', { token: gerente })).status, 400);
    const past = (await t.call('/api/admin/reports/sales?from=2020-01-01&to=2020-01-31', { token: gerente })).data;
    assert.equal(past.kpis.orders, 0);
    assert.equal(past.byDay.length, 31);
  });
  test('rotación: capital parado en lo que no se vende y cobertura de lo que sí', async () => {
    const gerente = await t.login('gerente');
    const r = (await t.call('/api/admin/reports/rotation?days=30', { token: gerente })).data;
    assert.ok(r.totals.products > 10);
    assert.ok(r.dead.length >= 1 && r.dead.every((p) => p.sold === 0 && p.stock > 0));
    assert.ok(r.dead[0].capital >= r.dead[r.dead.length - 1].capital, 'lo más caro parado, primero');
    assert.ok(r.fast.length >= 1 && r.fast[0].sold >= r.fast[r.fast.length - 1].sold);
    assert.ok(r.fast.every((p) => p.cover_days === null || p.cover_days >= 0));
    assert.ok(r.history_days >= 14);
  });
  test('exportar a CSV: separador «;», acentos intactos y sin fórmulas peligrosas', async () => {
    const gerente = await t.login('gerente');
    const res = await t.call('/api/admin/reports/export?what=ventas', { token: gerente });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /ventas-/);
    const bytes = Buffer.from(await res.res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'lleva BOM para que Excel respete los acentos');
    const text = bytes.toString('utf8').replace(/^\ufeff/, '');
    assert.ok(text.startsWith('Pedido;Fecha;Canal'));
    assert.ok(text.split('\r\n').length > 20);
    const { toCsv } = await import('../reports.js');
    assert.equal(toCsv(['a'], [['=SUMA(1)'], [-5], ['ñandú; "x"']]), '\ufeffa\r\n\'=SUMA(1)\r\n-5\r\n"ñandú; ""x"""\r\n');
    assert.equal((await t.call('/api/admin/reports/export?what=otra', { token: gerente })).status, 400);
  });
  test('solo gerencia ve los reportes', async () => {
    for (const u of ['cajero', 'bodega']) assert.equal((await t.call('/api/admin/reports/sales', { token: await t.login(u) })).status, 403);
  });
});

describe('facturación electrónica (proveedor de demostración)', () => {
  test('cada venta pagada tiene su factura numerada en orden y nunca se repite el número', async () => {
    const gerente = await t.login('gerente');
    const list = (await t.call('/api/admin/fiscal?limit=100', { token: gerente })).data;
    assert.equal(list.provider, 'demo');
    assert.ok(list.counts.simulada >= 60);
    const numbers = t.db.prepare("SELECT number FROM fiscal_docs WHERE kind = 'factura'").all().map((r) => r.number);
    assert.equal(new Set(numbers).size, numbers.length);
    const v = variantOf(t.db, 'Citrus Solar', 100);
    const sale = await pos(gerente, [{ variant_id: v.id, qty: 1 }]);
    const detail = (await t.call(`/api/admin/orders/${sale.data.id}`, { token: gerente })).data;
    assert.equal(detail.documents.length, 1);
    assert.match(detail.documents[0].number, /^FE-DEMO-\d{6}$/);
    assert.equal(detail.documents[0].status, 'simulada');
  });
  test('cancelar un pedido ya facturado emite la nota de crédito que lo anula', async () => {
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Citrus Solar', 100);
    const sale = await pos(gerente, [{ variant_id: v.id, qty: 1 }]);
    await t.call(`/api/admin/orders/${sale.data.id}/status`, { method: 'POST', token: gerente, body: { status: 'cancelado' } });
    const docs = (await t.call(`/api/admin/orders/${sale.data.id}`, { token: gerente })).data.documents;
    assert.deepEqual(docs.map((d) => d.kind), ['factura', 'nota_credito']);
    assert.equal(docs[1].amount, sale.data.total);
  });
  test('con el proveedor «webhook» los documentos quedan pendientes y se envían firmados a la integración', async () => {
    const t5 = await startApp({ fiscal: { provider: 'webhook', url: 'https://n8n.example/webhook/factura', secret: 'f1rma' } });
    try {
      const v = variantOf(t5.db, 'Citrus Solar', 100);
      const sale = await t5.call('/api/admin/pos/orders', { method: 'POST', token: await t5.login('admin'), body: { payment_method: 'tarjeta', items: [{ variant_id: v.id, qty: 1 }] } });
      assert.equal(sale.status, 201);
      assert.equal(t5.db.prepare('SELECT status FROM fiscal_docs WHERE order_id = ?').get(sale.data.id).status, 'pendiente');
      const calls = [];
      const cfg = { provider: 'webhook', url: 'https://n8n.example/webhook/factura', secret: 'f1rma' };
      const bad = await flushFiscal(t5.db, cfg, { brand: t5.app.brand, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
      assert.equal(bad.failed, 1, 'la respuesta sin número no cuenta como emitida');
      assert.equal(t5.db.prepare('SELECT status FROM fiscal_docs WHERE order_id = ?').get(sale.data.id).status, 'error');
      const ok = await flushFiscal(t5.db, cfg, { brand: t5.app.brand, fetchImpl: async (url, init) => { calls.push(init); return { ok: true, json: async () => ({ number: '0001-ABC', auth_code: 'CUFE-XYZ', url: 'https://pac.example/doc/1' }) }; } });
      assert.equal(ok.sent, 1);
      assert.equal(calls[0].headers['X-Signature'], `sha256=${createHmac('sha256', 'f1rma').update(calls[0].body).digest('hex')}`);
      const doc = JSON.parse(calls[0].body);
      assert.equal(doc.kind, 'factura');
      assert.equal(doc.lines[0].qty, 1);
      assert.equal(doc.tax.rate, 0.07);
      assert.equal(doc.total, sale.data.total);
      const row = t5.db.prepare('SELECT status, number, auth_code FROM fiscal_docs WHERE order_id = ?').get(sale.data.id);
      assert.deepEqual([row.status, row.number, row.auth_code], ['emitida', '0001-ABC', 'CUFE-XYZ']);
    } finally { t5.close(); }
  });
  test('si la facturación está apagada no se emite nada, pero la venta sigue', async () => {
    const t6 = await startApp({ fiscal: { provider: 'off' } });
    try {
      const v = variantOf(t6.db, 'Citrus Solar', 100);
      const sale = await t6.call('/api/admin/pos/orders', { method: 'POST', token: await t6.login('admin'), body: { payment_method: 'efectivo', items: [{ variant_id: v.id, qty: 1 }] } });
      assert.equal(sale.status, 201);
      assert.equal(t6.db.prepare('SELECT COUNT(*) n FROM fiscal_docs').get().n, 0);
    } finally { t6.close(); }
  });
});

describe('pagos con pasarela', () => {
  let h;
  before(async () => { h = await startApp({ payments: { provider: 'demo-hosted', secret: 'pagos-secreto', holdMinutes: 30 }, publicUrl: 'https://tienda.example' }); });
  after(() => h.close());
  const buy = (n, extra = {}) => {
    const v = variantOf(h.db, 'Cedro & Cuero', 50);
    return h.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n, payment_method: 'tarjeta', notify_opt_in: true, ...extra }) });
  };

  test('con tarjeta el pedido queda pendiente, reserva el stock y lleva al cliente a pagar', async () => {
    const v = variantOf(h.db, 'Cedro & Cuero', 50);
    const stock = stockOf(h.db, v.id);
    const r = await buy(80);
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'pendiente_pago');
    assert.equal(stockOf(h.db, v.id), stock - 1, 'reservado');
    assert.match(r.data.payment.url, /^https:\/\/tienda\.example\/pago-demo\.html\?ref=PAY-/);
    assert.ok(r.data.payment.url.includes(encodeURIComponent(`https://tienda.example/#pedido/${r.data.tracking_code}`)));
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM notifications WHERE dedupe_key LIKE ?").get(`ord:${r.data.id}:%`).n, 0, 'sin avisos hasta que se pague');
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM fiscal_docs WHERE order_id = ?").get(r.data.id).n, 0, 'ni factura');
    const track = (await h.call(`/api/track?code=${r.data.tracking_code}`)).data;
    assert.equal(track.payment_pending, true);
    const admin = await h.login('admin');
    assert.equal((await h.call(`/api/admin/orders/${r.data.id}/status`, { method: 'POST', token: admin, body: { status: 'entregado' } })).status, 409);
    assert.equal((await h.call(`/api/admin/orders/${r.data.id}/progress`, { method: 'POST', token: admin, body: { step: 'preparando' } })).status, 409);
  });
  test('al pagarse queda pagado, se factura y se avisa; avisar dos veces no repite nada', async () => {
    const r = await buy(81);
    const ref = r.data.payment.reference;
    const done = await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: ref, result: 'pagado' } });
    assert.equal(done.status, 200);
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'pagado');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM fiscal_docs WHERE order_id = ?').get(r.data.id).n, 1);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM notifications WHERE dedupe_key LIKE ?").get(`ord:${r.data.id}:recibido:%`).n, 2);
    const again = await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: ref, result: 'pagado' } });
    assert.equal(again.data.repeated, true);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM fiscal_docs WHERE order_id = ?').get(r.data.id).n, 1, 'una sola factura');
    const flip = await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: ref, result: 'fallido' } });
    assert.equal(flip.data.repeated, true);
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'pagado', 'un aviso tardío de fallo no deshace un pago');
    assert.ok((await h.call(`/api/track?code=${r.data.tracking_code}`)).data.events.some((e) => e.kind === 'pago_confirmado'));
  });
  test('un pago rechazado cancela el pedido y devuelve el stock', async () => {
    const v = variantOf(h.db, 'Cedro & Cuero', 50);
    const stock = stockOf(h.db, v.id);
    const r = await buy(82);
    assert.equal(stockOf(h.db, v.id), stock - 1);
    await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: r.data.payment.reference, result: 'fallido' } });
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'cancelado');
    assert.equal(stockOf(h.db, v.id), stock);
    assert.equal(h.db.prepare("SELECT status FROM payment_attempts WHERE order_id = ?").get(r.data.id).status, 'fallido');
  });
  test('si no se paga a tiempo, el pedido vence y el stock vuelve', async () => {
    const v = variantOf(h.db, 'Cedro & Cuero', 50);
    const stock = stockOf(h.db, v.id);
    const r = await buy(83);
    h.db.prepare("UPDATE payment_attempts SET created_at = datetime('now','localtime','-31 minutes') WHERE order_id = ?").run(r.data.id);
    const admin = await h.login('admin');
    await h.call('/api/admin/orders', { token: admin }); // revisar los pedidos barre los vencidos
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'cancelado');
    assert.equal(stockOf(h.db, v.id), stock);
    assert.equal(h.db.prepare("SELECT status FROM payment_attempts WHERE order_id = ?").get(r.data.id).status, 'vencido');
    assert.equal(expirePending(h.db, { holdMinutes: 30 }, { onExpired: () => {} }), 0, 'ya no queda nada por vencer');
  });
  test('quien deja muchos pedidos esperando el pago llega a un tope: no puede agotar el stock sin pagar', async () => {
    const hx = await startApp({ payments: { provider: 'demo-hosted', secret: 'x', holdMinutes: 30 }, publicUrl: 'https://tienda.example' });
    try {
      const v = hx.db.prepare("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Té Blanco' AND p.kind = 'Perfume' AND v.size_ml = 50").get();
      hx.db.prepare('UPDATE variants SET stock = 40 WHERE id = ?').run(v.id);
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await hx.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 200 + i, payment_method: 'tarjeta' }) })).status);
      assert.ok(statuses.includes(429), `alguno se frena: ${statuses}`);
      assert.ok(statuses.indexOf(429) >= 1, 'los primeros sí pasan');
      assert.ok(hx.db.prepare("SELECT COUNT(*) n FROM orders WHERE status = 'pendiente_pago'").get().n <= 8, 'los pedidos reservados quedan acotados');
    } finally { hx.close(); }
  });
  test('si la pasarela cobra un pedido que ya venció, el pedido sigue cancelado y queda anotado para devolver el dinero', async () => {
    const r = await buy(86);
    const admin = await h.login('admin');
    await h.call(`/api/admin/orders/${r.data.id}/status`, { method: 'POST', token: admin, body: { status: 'cancelado' } });
    const late = await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: r.data.payment.reference, result: 'pagado' } });
    assert.equal(late.status, 200);
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'cancelado');
    const ev = h.db.prepare("SELECT note FROM order_events WHERE order_id = ? AND kind = 'pago_tardio'").get(r.data.id);
    assert.match(ev.note, /devolver el dinero/);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM fiscal_docs WHERE order_id = ? AND kind = 'factura'").get(r.data.id).n, 0, 'no se factura un pedido cancelado');
  });
  test('transferencia y contra entrega no pasan por la pasarela', async () => {
    const r = await buy(84, { payment_method: 'transferencia' });
    assert.equal(r.data.status, 'pagado');
    assert.equal(r.data.payment, null);
  });
  test('el aviso firmado de una pasarela real: sin firma o con firma falsa se rechaza', async () => {
    const r = await buy(85);
    const body = JSON.stringify({ reference: r.data.payment.reference, status: 'pagado' });
    const send = (sig) => fetch(`${h.base}/api/payments/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Signature': sig } : {}) }, body });
    assert.equal((await send(null)).status, 401);
    assert.equal((await send('sha256=' + '0'.repeat(64))).status, 401);
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'pendiente_pago');
    const ok = await send(`sha256=${createHmac('sha256', 'pagos-secreto').update(body).digest('hex')}`);
    assert.equal(ok.status, 200);
    assert.equal(h.db.prepare('SELECT status FROM orders WHERE id = ?').get(r.data.id).status, 'pagado');
    assert.equal((await h.call('/api/payments/demo/complete', { method: 'POST', body: { reference: 'PAY-NOEXISTE', result: 'pagado' } })).status, 404);
  });
  test('con el cobro por defecto (instantáneo) la ruta de demostración no existe', async () => {
    assert.equal((await t.call('/api/payments/demo/complete', { method: 'POST', body: { reference: 'x', result: 'pagado' } })).status, 404);
    assert.equal((await t.call('/api/payments/mode')).data.hosted, false);
  });
  test('con el proveedor «http», si la pasarela falla el pedido se cancela y se devuelve el stock', async () => {
    const t7 = await startApp({ payments: { provider: 'http', createUrl: 'http://127.0.0.1:1/crear', secret: 's' } });
    try {
      const v = variantOf(t7.db, 'Cedro & Cuero', 50);
      const stock = stockOf(t7.db, v.id);
      const r = await t7.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 90, payment_method: 'tarjeta' }) });
      assert.equal(r.status, 502);
      assert.equal(stockOf(t7.db, v.id), stock, 'el stock reservado volvió');
      assert.equal(t7.db.prepare("SELECT status FROM orders ORDER BY id DESC LIMIT 1").get().status, 'cancelado');
    } finally { t7.close(); }
  });
});

describe('pedidos que llegan de WooCommerce', () => {
  test('al entregarlos o cancelarlos desde aquí no se les manda un segundo aviso (WooCommerce ya atiende a ese cliente)', async () => {
    const { handleWebhook } = await import('../woo-sync.js');
    const v = variantOf(t.db, 'Citrus Solar', 100);
    t.db.prepare("UPDATE variants SET external_id = '9001' WHERE id = ?").run(v.id);
    const payload = { id: 5001, status: 'processing', total: '95.00', date_created: '2026-10-23T10:00:00', billing: { first_name: 'Carla', last_name: 'Woo', email: 'carla@example.com', phone: '6000-5555' }, payment_method: 'bacs', line_items: [{ product_id: 9001, variation_id: 0, quantity: 1, total: '95.00', name: 'Citrus Solar' }] };
    const res = await handleWebhook(t.db, { raw: Buffer.from(JSON.stringify(payload)), headers: { 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'entrega-5001' }, updateStock: true });
    assert.equal(res.status, 'descontado');
    const orderId = t.db.prepare("SELECT order_id FROM woo_orders WHERE woo_order_id = '5001'").get().order_id;
    const before = t.db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
    const admin = await t.login('admin');
    assert.equal((await t.call(`/api/admin/orders/${orderId}/status`, { method: 'POST', token: admin, body: { status: 'cancelado' } })).status, 200);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM notifications').get().n, before, 'ni correo ni WhatsApp');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM fiscal_docs WHERE order_id = ?').get(orderId).n, 0, 'ni factura: WooCommerce factura por su lado');
  });
});

describe('fotos de productos', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  test('subir una foto, mostrarla con caché largo y asignarla a un producto', async () => {
    const bodega = await t.login('bodega');
    const up = await t.call('/api/admin/media?name=frasco.png', { method: 'POST', token: bodega, raw: png, contentType: 'image/png' });
    assert.equal(up.status, 201);
    assert.match(up.data.url, /^\/api\/media\/\d+$/);
    const got = await t.call(up.data.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await got.res.arrayBuffer()).equals(png), true);
    const upd = await t.call('/api/admin/products/1', { method: 'PATCH', token: bodega, body: { image: up.data.url } });
    assert.equal(upd.status, 200);
    assert.equal((await t.call('/api/products/1')).data.image, up.data.url);
    assert.equal((await t.call('/api/admin/products/1', { method: 'PATCH', token: bodega, body: { image: '/api/media/abc' } })).status, 400);
  });
  test('solo imágenes reales: SVG, HTML o archivos disfrazados se rechazan, y hay tope de tamaño', async () => {
    const bodega = await t.login('bodega');
    const up = (raw, contentType = 'image/png') => t.call('/api/admin/media', { method: 'POST', token: bodega, raw, contentType });
    assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 400);
    assert.equal((await up(Buffer.from('<html><script>alert(1)</script></html>'))).status, 400, 'aunque diga ser PNG');
    assert.equal((await up(Buffer.alloc(0))).status, 400);
    assert.equal((await up(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1_600_000)]))).status, 413);
    assert.equal((await t.call('/api/media/99999')).status, 404);
    assert.equal((await t.call('/api/admin/media', { method: 'POST', token: await t.login('cajero'), raw: png })).status, 403);
  });
  test('reemplazar la foto limpia las que quedaron sin uso (las recientes se respetan)', async () => {
    const { pruneUnused } = await import('../media.js');
    t.db.prepare("INSERT INTO media (mime, bytes, size, created_at) VALUES ('image/png', ?, 70, datetime('now','localtime','-3 hours'))").run(png);
    const orphan = t.db.prepare('SELECT MAX(id) AS id FROM media').get().id;
    const fresh = Number((t.db.prepare("INSERT INTO media (mime, bytes, size) VALUES ('image/png', ?, 70)").run(png)).lastInsertRowid);
    assert.ok(pruneUnused(t.db) >= 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM media WHERE id = ?').get(orphan).n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM media WHERE id = ?').get(fresh).n, 1, 'la de hace un minuto sigue, por si alguien la está guardando');
  });
});

describe('lector de códigos de barras', () => {
  test('el SKU o el código de barras llevan al producto; lo desconocido da 404', async () => {
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const bar = t.db.prepare('SELECT barcode FROM variants WHERE id = ?').get(v.id).barcode;
    assert.match(bar, /^745\d{10}$/);
    const bySku = await t.call(`/api/admin/lookup?code=${v.sku.toLowerCase()}`, { token: cajero });
    const byBar = await t.call(`/api/admin/lookup?code=${bar}`, { token: cajero });
    assert.equal(bySku.data.id, v.id);
    assert.equal(byBar.data.id, v.id);
    assert.ok(!('cost' in byBar.data), 'el cajero no ve costos');
    assert.equal((await t.call('/api/admin/lookup?code=0000000', { token: cajero })).status, 404);
    assert.equal((await t.call('/api/admin/lookup?code=', { token: cajero })).status, 400);
  });
  test('el código de barras de los datos de ejemplo es un EAN-13 válido', () => {
    const rows = t.db.prepare('SELECT barcode FROM variants WHERE barcode IS NOT NULL').all();
    assert.ok(rows.length > 50);
    for (const { barcode } of rows.slice(0, 40)) {
      const d = [...barcode].map(Number);
      const sum = d.slice(0, 12).reduce((s, x, i) => s + x * (i % 2 ? 3 : 1), 0);
      assert.equal(d[12], (10 - (sum % 10)) % 10);
    }
  });
  test('asignar un código de barras: formato, y que no lo tenga otro producto ni sea el SKU de otro', async () => {
    const bodega = await t.login('bodega');
    const a = variantOf(t.db, 'Cedro & Cuero', 50);
    const b = variantOf(t.db, 'Vetiver Real', 50);
    const set = (id, barcode) => t.call(`/api/admin/variants/${id}`, { method: 'PATCH', token: bodega, body: { barcode } });
    assert.equal((await set(a.id, '12')).status, 400);
    assert.equal((await set(a.id, 'con espacios')).status, 400);
    assert.equal((await set(a.id, '7501234567890')).status, 200);
    assert.equal((await set(b.id, '7501234567890')).status, 409);
    assert.equal((await set(b.id, a.sku)).status, 409, 'no puede coincidir con el SKU de otro');
    assert.equal((await set(a.id, '')).status, 200, 'vaciarlo lo quita');
  });
  test('la carga masiva acepta SKU o código de barras', async () => {
    const bodega = await t.login('bodega');
    const v = variantOf(t.db, 'Gotas de Luna', 50);
    const bar = t.db.prepare('SELECT barcode FROM variants WHERE id = ?').get(v.id).barcode;
    assert.match(bar, /^745/);
    const stock = stockOf(t.db, v.id);
    const r = await t.call('/api/admin/import', { method: 'POST', token: bodega, body: { csv: `sku;cantidad\n${bar};3\n${v.sku};2` } });
    assert.equal(r.status, 200);
    assert.equal(stockOf(t.db, v.id), stock + 5);
  });
});

describe('políticas de la tienda', () => {
  test('el gerente las ve y las cambia con validación; el cajero no', async () => {
    const gerente = await t.login('gerente');
    const p = (await t.call('/api/admin/policy', { token: gerente })).data;
    assert.equal(p.return_days, 30);
    assert.equal(p.payments, 'instant');
    assert.equal(p.fiscal, 'demo');
    const patch = (body) => t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body });
    assert.equal((await patch({ return_days: -1 })).status, 400);
    assert.equal((await patch({ return_days: 400 })).status, 400);
    assert.equal((await patch({ max_manual_discount: 150 })).status, 400);
    assert.equal((await patch({ alert_whatsapp: 'abc' })).status, 400);
    assert.equal((await patch({ alert_email: 'sin-arroba' })).status, 400);
    assert.equal((await patch({})).status, 400);
    assert.equal((await patch({ max_manual_discount: 5 })).data.max_manual_discount, 5);
    assert.equal((await t.call('/api/admin/policy', { token: await t.login('cajero') })).status, 403);
    // el tope del cajero cambia en el acto
    const cajero = await t.login('cajero');
    const v = variantOf(t.db, 'Vetiver Real', 100);
    assert.equal((await pos(cajero, [{ variant_id: v.id, qty: 1 }], { discount: { type: 'percent', value: 8, reason: 'x' } })).status, 403);
    await patch({ max_manual_discount: 10 });
    assert.equal((await pos(cajero, [{ variant_id: v.id, qty: 1 }], { discount: { type: 'percent', value: 8, reason: 'x' } })).status, 201);
  });
  test('reiniciar la demostración conserva usuarios y políticas, y deja los datos de ejemplo completos', async () => {
    const admin = await t.login('admin');
    await t.call('/api/admin/policy', { method: 'PATCH', token: admin, body: { return_days: 45 } });
    const users = (await t.call('/api/admin/users', { token: admin })).data.users.length;
    assert.equal((await t.call('/api/admin/reset', { method: 'POST', token: admin, body: {} })).status, 200);
    assert.equal((await t.call('/api/admin/users', { token: admin })).data.users.length, users);
    assert.equal((await t.call('/api/admin/policy', { token: admin })).data.return_days, 45);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM variants WHERE is_set = 1').get().n, 3);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM promotions').get().n, 4);
    assert.equal(t.db.prepare("SELECT balance FROM gift_cards WHERE code = 'GC-DEMO-0050'").get().balance, 50);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM returns').get().n, 0);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM fiscal_docs WHERE kind = 'factura'").get().n, t.db.prepare("SELECT COUNT(*) n FROM orders WHERE status IN ('pagado','entregado')").get().n, 'cada venta de ejemplo trae su factura');
    assert.equal(t.db.prepare('SELECT MIN(number) n FROM fiscal_docs').get().n, 'FE-DEMO-000001', 'la numeración vuelve a empezar');
    assert.equal(t.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});
