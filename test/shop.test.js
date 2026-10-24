// La tienda: ofertas y cupones, sets de regalo, tarjetas de regalo, seguimiento, avisos, «avísame», cuentas y buscador guiado.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, customer, variantOf, onlineOrder, stockOf, cents } from './helpers.js';
import { splitPrice } from '../bundles.js';
import { discountFor } from '../pricing.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const quote = (items, extra = {}) => t.call('/api/cart/quote', { method: 'POST', body: { items, ...extra } });
const order = (items, extra = {}) => t.call('/api/orders', { method: 'POST', body: onlineOrder(items, extra) });

describe('ofertas y cupones', () => {
  test('la oferta automática de una marca se aplica sola, pero no a lo que ya está en oferta', async () => {
    const normal = variantOf(t.db, 'Té Blanco', 50); // Atelier Sol, sin oferta
    const onSale = variantOf(t.db, 'Citrus Solar', 50); // Atelier Sol, ya con precio tachado
    assert.ok(onSale.compare_at > onSale.price);
    const a = await quote([{ variant_id: normal.id, qty: 1 }]);
    assert.equal(a.status, 200);
    assert.equal(a.data.discount, Math.round(normal.price * 0.15 * 100) / 100);
    assert.match(a.data.applied.name, /Atelier Sol/);
    const b = await quote([{ variant_id: onSale.id, qty: 1 }]);
    assert.equal(b.data.discount, 0, 'lo que ya está en oferta no se descuenta dos veces');
    assert.equal(b.data.applied, null);
  });
  test('un cupón descuenta; si hay una oferta mejor, gana la mejor y se avisa', async () => {
    const other = variantOf(t.db, 'Cedro & Cuero', 50);
    const c1 = await quote([{ variant_id: other.id, qty: 1 }], { coupon: 'bienvenida10' });
    assert.equal(c1.data.discount, Math.round(other.price * 10) / 100);
    assert.equal(c1.data.applied.code, 'BIENVENIDA10');
    const atelier = variantOf(t.db, 'Té Blanco', 50);
    const c2 = await quote([{ variant_id: atelier.id, qty: 1 }], { coupon: 'BIENVENIDA10' });
    assert.match(c2.data.applied.name, /Atelier Sol/, '15% automático gana al 10% del cupón');
    assert.match(c2.data.coupon_note, /descuenta más/);
  });
  test('códigos inexistentes, de otro canal o que no aplican dan un motivo claro', async () => {
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const ask = (coupon) => quote([{ variant_id: v.id, qty: 1 }], { coupon });
    assert.match((await ask('NOEXISTE')).data.error, /no existe/);
    assert.match((await ask('MOSTRADOR5')).data.error, /mostrador/);
    const kid = variantOf(t.db, 'Gotas de Luna', 30);
    const r = await quote([{ variant_id: kid.id, qty: 1 }], { coupon: 'BIENVENIDA10' });
    assert.equal(r.status, 200, 'sí aplica a lo infantil');
  });
  test('«llévate 2 por $50»: por cada pareja completa se paga $50', async () => {
    const a = variantOf(t.db, 'Gotas de Luna', 30);
    const b = variantOf(t.db, 'Bosque Mágico', 30);
    const q = await quote([{ variant_id: a.id, qty: 1 }, { variant_id: b.id, qty: 1 }]);
    assert.equal(q.data.discount, Math.round((a.price + b.price - 50) * 100) / 100);
    assert.equal(q.data.total, 50);
    const one = await quote([{ variant_id: a.id, qty: 1 }]);
    assert.equal(one.data.discount, 0, 'con una sola unidad no hay pareja');
    const four = await quote([{ variant_id: a.id, qty: 2 }, { variant_id: b.id, qty: 2 }]);
    assert.equal(four.data.total, 100, 'dos parejas');
  });
  test('discountFor: porcentaje, monto fijo y mínimo de compra', () => {
    const lines = [{ brand: 'X', category: 'Damas', kind: 'Perfume', qty: 2, price: 30, on_sale: false, is_set: false }];
    const base = { scope: 'todo', scope_value: '', min_total: 0, skip_sale: 1 };
    assert.equal(discountFor({ ...base, kind: 'percent', amount: 10 }, lines).amount, 6);
    assert.equal(discountFor({ ...base, kind: 'fixed', amount: 100 }, lines).amount, 60, 'nunca más que lo que se compra');
    assert.equal(discountFor({ ...base, kind: 'percent', amount: 10, min_total: 100 }, lines).amount, 0);
    assert.equal(discountFor({ ...base, kind: 'percent', amount: 10, scope: 'marca', scope_value: 'y' }, lines).amount, 0);
    assert.equal(discountFor({ ...base, kind: 'percent', amount: 10, scope: 'marca', scope_value: 'x' }, lines).amount, 6, 'sin distinguir mayúsculas');
  });
  test('el pedido guarda subtotal, descuento y cupón; un cupón de una vez por cliente no se repite; cancelar lo libera', async () => {
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const first = await order([{ variant_id: v.id, qty: 1 }], { coupon: 'BIENVENIDA10', n: 7 });
    assert.equal(first.status, 201);
    assert.equal(first.data.subtotal, v.price);
    assert.equal(first.data.discount, Math.round(v.price * 10) / 100);
    assert.equal(first.data.total, Math.round((v.price - first.data.discount) * 100) / 100);
    assert.equal(first.data.coupon_code, 'BIENVENIDA10');
    assert.equal(t.db.prepare("SELECT uses FROM promotions WHERE code = 'BIENVENIDA10'").get().uses, 1);
    const again = await order([{ variant_id: v.id, qty: 1 }], { coupon: 'BIENVENIDA10', n: 7 });
    assert.equal(again.status, 400);
    assert.match(again.data.error, /Ya usaste/);
    const admin = await t.login('admin');
    await t.call(`/api/admin/orders/${first.data.id}/status`, { method: 'POST', token: admin, body: { status: 'cancelado' } });
    assert.equal(t.db.prepare("SELECT uses FROM promotions WHERE code = 'BIENVENIDA10'").get().uses, 0);
    assert.equal((await order([{ variant_id: v.id, qty: 1 }], { coupon: 'BIENVENIDA10', n: 7 })).status, 201, 'cancelado, vuelve a poder usarlo');
  });
  test('descuento manual en el mostrador: el cajero hasta el tope; el gerente sin tope; todo queda anotado', async () => {
    const cajero = await t.login('cajero');
    const gerente = await t.login('gerente');
    const v = variantOf(t.db, 'Vetiver Real', 100);
    const pos = (token, discount) => t.call('/api/admin/pos/orders', { method: 'POST', token, body: { payment_method: 'efectivo', items: [{ variant_id: v.id, qty: 1 }], discount } });
    assert.equal((await pos(cajero, { type: 'percent', value: 25, reason: 'Cliente frecuente' })).status, 403);
    const ok = await pos(cajero, { type: 'percent', value: 8, reason: 'Cliente frecuente' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.discount, Math.round(v.price * 8) / 100);
    assert.match(ok.data.promo_label, /Cliente frecuente/);
    assert.equal((await pos(gerente, { type: 'percent', value: 40, reason: 'Liquidación' })).status, 201);
    assert.equal((await pos(gerente, { type: 'percent', value: 140, reason: 'x' })).status, 400);
    const log = (await t.call('/api/admin/audit?action=venta&limit=5', { token: gerente })).data.rows;
    assert.ok(log.some((r) => /descuento/.test(r.detail)));
  });
  test('administrar promociones: crear, validar, editar y desactivar lo ya usado', async () => {
    const admin = await t.login('admin');
    const make = (body) => t.call('/api/admin/promotions', { method: 'POST', token: admin, body });
    assert.equal((await make({ name: '', kind: 'percent', amount: 10 })).status, 400);
    assert.equal((await make({ name: 'X', kind: 'percent', amount: 150 })).status, 400);
    assert.equal((await make({ name: 'X', kind: 'bundle', amount: 10, buy_qty: 1 })).status, 400);
    assert.equal((await make({ name: 'X', kind: 'percent', amount: 10, scope: 'marca' })).status, 400, 'falta la marca');
    assert.equal((await make({ name: 'Fin antes que inicio', kind: 'percent', amount: 10, starts_at: '2030-02-01', ends_at: '2030-01-01' })).status, 400);
    const made = await make({ name: 'Prueba 20', code: 'prueba20', kind: 'percent', amount: 20, max_uses: 1 });
    assert.equal(made.status, 201);
    assert.equal((await make({ name: 'Repetida', code: 'PRUEBA20', kind: 'percent', amount: 5 })).status, 409);
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    assert.equal((await order([{ variant_id: v.id, qty: 1 }], { coupon: 'PRUEBA20', n: 20 })).status, 201);
    assert.match((await order([{ variant_id: v.id, qty: 1 }], { coupon: 'PRUEBA20', n: 21 })).data.error, /agotó/);
    const list = (await t.call('/api/admin/promotions', { token: admin })).data.promotions;
    assert.equal(list.find((p) => p.code === 'PRUEBA20').state, 'agotada');
    const del = await t.call(`/api/admin/promotions/${made.data.id}`, { method: 'DELETE', token: admin });
    assert.deepEqual([del.data.removed, del.data.deactivated], [false, true], 'una promoción usada no se borra');
    assert.equal((await t.call('/api/admin/promotions', { token: await t.login('cajero') })).status, 403);
  });
  test('ofertas vigentes visibles para la tienda', async () => {
    const r = await t.call('/api/offers');
    assert.ok(r.data.offers.length >= 3);
    assert.deepEqual(r.data.offers.filter((o) => o.code).map((o) => o.code), ['BIENVENIDA10'], 'de los cupones solo se anuncia el marcado para mostrarse: MOSTRADOR5 sigue siendo secreto');
    assert.ok(r.data.offers.filter((o) => !o.code).length >= 2, 'y las ofertas automáticas');
  });
});

describe('sets de regalo', () => {
  const sets = () => t.db.prepare("SELECT v.id, v.price, v.compare_at, v.stock, p.id AS pid, p.name FROM variants v JOIN products p ON p.id = v.product_id WHERE v.is_set = 1 ORDER BY v.id").all();
  const comps = (id) => t.db.prepare('SELECT bi.component_variant_id AS id, bi.qty, v.stock FROM bundle_items bi JOIN variants v ON v.id = bi.component_variant_id WHERE bi.bundle_variant_id = ?').all(id);

  test('la demostración trae sets; su stock es el del componente más escaso y la ficha dice qué incluye', async () => {
    const all = sets();
    assert.equal(all.length, 3);
    for (const s of all) {
      assert.equal(s.stock, Math.min(...comps(s.id).map((c) => Math.floor(c.stock / c.qty))));
      assert.ok(s.compare_at > s.price, 'el set cuesta menos que sus productos por separado');
    }
    const p = await t.call(`/api/products/${all[0].pid}`);
    assert.equal(p.data.kind, 'Estuche');
    assert.ok(p.data.bundle.length >= 2 && p.data.bundle[0].name);
    assert.deepEqual(Object.keys(p.data.variants[0]).sort(), ['compare_at', 'id', 'price', 'size_ml', 'stock']);
  });
  test('splitPrice reparte el precio sin perder ni inventar centavos', () => {
    for (const [price, parts] of [[135, [[46, 1], [70, 1], [48, 1]]], [99.99, [[10, 3], [33.33, 1]]], [10, [[3, 1], [3, 1], [3, 1]]], [149, [[82, 1], [96, 1]]]]) {
      const rows = splitPrice(parts.map(([p, q], i) => ({ variant_id: i + 1, qty: q, price: p })), price);
      const total = rows.reduce((s, r) => s + cents(r.unit_price) * r.qty, 0);
      assert.equal(total, cents(price), `set de ${price}`);
    }
  });
  test('vender un set descuenta cada componente, reparte el precio y el stock del set baja', async () => {
    const s = sets()[0];
    const before = comps(s.id).map((c) => [c.id, stockOf(t.db, c.id)]);
    const res = await order([{ variant_id: s.id, qty: 2 }], { n: 30 });
    assert.equal(res.status, 201);
    assert.equal(res.data.total, s.price * 2);
    const sum = res.data.items.reduce((acc, i) => acc + cents(i.unit_price) * i.qty, 0);
    assert.equal(sum, cents(s.price * 2), 'las líneas suman exactamente el precio de los sets');
    assert.ok(res.data.items.every((i) => i.bundle_variant_id === s.id));
    for (const [id, was] of before) assert.equal(stockOf(t.db, id), was - 2 * comps(s.id).find((c) => c.id === id).qty);
    assert.equal(stockOf(t.db, s.id), Math.min(...comps(s.id).map((c) => Math.floor(stockOf(t.db, c.id) / c.qty))));
    // cancelar devuelve todo
    await t.call(`/api/admin/orders/${res.data.id}/status`, { method: 'POST', token: await t.login('admin'), body: { status: 'cancelado' } });
    for (const [id, was] of before) assert.equal(stockOf(t.db, id), was);
  });
  test('un set no se vende más de lo que alcanza, ni junto con sus piezas sueltas por encima de las existencias', async () => {
    const s = sets()[1];
    const over = await order([{ variant_id: s.id, qty: s.stock + 1 }], { n: 31 });
    assert.equal(over.status, 409);
    const piece = comps(s.id)[0];
    const pieceStock = stockOf(t.db, piece.id);
    const mix = await order([{ variant_id: s.id, qty: 1 }, { variant_id: piece.id, qty: pieceStock }], { n: 32 });
    assert.equal(mix.status, 409);
    assert.match(mix.data.error, /No alcanzan las existencias/);
    assert.equal(stockOf(t.db, piece.id), pieceStock, 'nada se guardó a medias');
  });
  test('el stock de un set no se ajusta a mano ni se edita como una variante común', async () => {
    const admin = await t.login('admin');
    const s = sets()[0];
    assert.equal((await t.call(`/api/admin/variants/${s.id}/adjust`, { method: 'POST', token: admin, body: { delta: 5, reason: 'x' } })).status, 409);
    assert.equal((await t.call(`/api/admin/variants/${s.id}`, { method: 'PATCH', token: admin, body: { price: 10 } })).status, 409);
  });
  test('crear y editar sets: validaciones y recálculo', async () => {
    const admin = await t.login('admin');
    const a = variantOf(t.db, 'Citrus Solar', 100);
    const b = variantOf(t.db, 'Vainilla Dorada', 100);
    const make = (body) => t.call('/api/admin/sets', { method: 'POST', token: admin, body });
    assert.equal((await make({ name: 'Solo uno', price: 10, components: [{ variant_id: a.id, qty: 1 }] })).status, 400, 'necesita al menos dos productos');
    assert.equal((await make({ name: 'Caro', price: a.price + b.price + 1, components: [{ variant_id: a.id, qty: 1 }, { variant_id: b.id, qty: 1 }] })).status, 400);
    assert.equal((await make({ name: 'Con otro set', price: 20, components: [{ variant_id: sets()[0].id, qty: 1 }, { variant_id: b.id, qty: 1 }] })).status, 400);
    const ok = await make({ name: 'Set de prueba', price: a.price + b.price - 20, components: [{ variant_id: a.id, qty: 1 }, { variant_id: b.id, qty: 1 }] });
    assert.equal(ok.status, 201);
    const row = t.db.prepare('SELECT price, compare_at, stock FROM variants WHERE id = ?').get(ok.data.variant_id);
    assert.equal(row.compare_at, a.price + b.price);
    assert.equal(row.stock, Math.min(stockOf(t.db, a.id), stockOf(t.db, b.id)));
    assert.equal((await t.call(`/api/admin/sets/${ok.data.product_id}`, { method: 'PATCH', token: admin, body: { price: a.price + b.price - 30 } })).status, 200);
    assert.equal(t.db.prepare('SELECT price FROM variants WHERE id = ?').get(ok.data.variant_id).price, a.price + b.price - 30);
    assert.equal((await t.call('/api/admin/sets', { token: await t.login('cajero') })).status, 403);
  });
  test('las existencias y el valor del inventario no cuentan los sets (sería contar dos veces)', async () => {
    const admin = await t.login('admin');
    const dash = (await t.call('/api/admin/dashboard', { token: admin })).data;
    const units = t.db.prepare('SELECT SUM(v.stock) AS n FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND p.active = 1 AND v.is_set = 0').get().n;
    assert.equal(dash.inventory.units, units);
    const alerts = (await t.call('/api/admin/inventory?filter=agotado&limit=200', { token: admin })).data.rows;
    assert.ok(alerts.every((r) => !r.is_set));
  });
});

describe('tarjetas de regalo', () => {
  test('consultar el saldo: el código de ejemplo vale; uno falso no, y adivinar se frena', async () => {
    const t4 = await startApp(); // aparte: frenar la conexión no debe afectar a las demás pruebas
    try {
      const ok = await t4.call('/api/gift-cards/check', { method: 'POST', body: { code: 'gc-demo-0050' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.balance, 50);
      for (let i = 0; i < 10; i++) assert.equal((await t4.call('/api/gift-cards/check', { method: 'POST', body: { code: `GC-FALSO-000${i}` } })).status, 400);
      assert.equal((await t4.call('/api/gift-cards/check', { method: 'POST', body: { code: 'GC-DEMO-0050' } })).status, 429, 'demasiados códigos incorrectos');
    } finally { t4.close(); }
  });
  test('pagar con tarjeta: cubre lo que alcance, el resto va por otro método; cancelar devuelve el saldo', async () => {
    const t2 = await startApp();
    try {
      const v = variantOf(t2.db, 'Vetiver Real', 50);
      const cheap = variantOf(t2.db, 'Gotas de Luna', 30);
      const small = await t2.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: cheap.id, qty: 1 }], { gift_code: 'GC-DEMO-0050', n: 40 }) });
      assert.equal(small.status, 201);
      assert.equal(small.data.gift_amount, cheap.price);
      assert.equal(small.data.payment_method, 'tarjeta_regalo', 'cubierto por completo');
      const card = () => t2.db.prepare("SELECT balance FROM gift_cards WHERE code = 'GC-DEMO-0050'").get().balance;
      assert.equal(card(), Math.round((50 - cheap.price) * 100) / 100);
      const big = await t2.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { gift_code: 'GC-DEMO-0050', n: 41, payment_method: 'transferencia' }) });
      assert.equal(big.data.gift_amount, Math.round((50 - cheap.price) * 100) / 100, 'solo lo que quedaba');
      assert.equal(big.data.payment_method, 'transferencia');
      assert.equal(card(), 0);
      assert.equal((await t2.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { gift_code: 'GC-DEMO-0050', n: 42 }) })).status, 400, 'sin saldo');
      await t2.call(`/api/admin/orders/${small.data.id}/status`, { method: 'POST', token: await t2.login('admin'), body: { status: 'cancelado' } });
      assert.equal(card(), cheap.price, 'el saldo de la cancelación vuelve');
      assert.equal(t2.db.prepare("SELECT COUNT(*) n FROM gift_card_uses WHERE kind = 'reverso'").get().n, 1);
    } finally { t2.close(); }
  });
  test('adivinar códigos de tarjeta de regalo a través del pedido también se frena', async () => {
    const t8 = await startApp();
    try {
      const v = variantOf(t8.db, 'Cedro & Cuero', 50);
      const attempt = (n) => t8.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { gift_code: `GC-ADIV-${String(n).padStart(4, '0')}`, n: 90 }) });
      for (let i = 0; i < 10; i++) assert.equal((await attempt(i)).status, 400);
      const r = await attempt(11);
      assert.equal(r.status, 429);
      assert.match(r.data.error, /tarjeta de regalo incorrectos/);
      assert.equal((await t8.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 91 }) })).status, 201, 'sin código de tarjeta, el pedido normal sigue pasando');
    } finally { t8.close(); }
  });
  test('comprar una tarjeta: con tarjeta queda activa; por transferencia espera confirmación del personal', async () => {
    const buyer = { name: 'Ana Compradora', email: 'ana@example.com', phone: '+507 6111-1111' };
    const recipient = { name: 'Luis', email: 'luis@example.com' };
    assert.equal((await t.call('/api/gift-cards', { method: 'POST', body: { amount: 2, buyer, recipient, payment_method: 'tarjeta' } })).status, 400, 'monto mínimo');
    assert.equal((await t.call('/api/gift-cards', { method: 'POST', body: { amount: 25, buyer: { name: 'x' }, payment_method: 'tarjeta' } })).status, 400, 'falta el correo');
    const paid = await t.call('/api/gift-cards', { method: 'POST', body: { amount: 40, buyer, recipient, message: '¡Feliz cumpleaños!', payment_method: 'tarjeta' } });
    assert.equal(paid.status, 201);
    assert.match(paid.data.code, /^GC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await t.call('/api/gift-cards/check', { method: 'POST', body: { code: paid.data.code } })).data.balance, 40);
    const wire = await t.call('/api/gift-cards', { method: 'POST', body: { amount: 60, buyer, recipient, payment_method: 'transferencia' } });
    assert.equal(wire.data.pending, true);
    assert.equal(wire.data.code, null, 'el código no se muestra hasta que se confirme el pago');
    const admin = await t.login('admin');
    const row = t.db.prepare("SELECT id, code FROM gift_cards WHERE status = 'pendiente'").get();
    assert.match((await t.call('/api/gift-cards/check', { method: 'POST', body: { code: row.code } })).data.error, /no es válido/);
    const act = await t.call(`/api/admin/gift-cards/${row.id}/status`, { method: 'POST', token: admin, body: { status: 'activa' } });
    assert.equal(act.status, 200);
    assert.equal((await t.call('/api/gift-cards/check', { method: 'POST', body: { code: row.code } })).data.balance, 60);
    // avisos: al comprador y a quien recibe (por correo)
    const mails = t.db.prepare("SELECT to_addr, template FROM notifications WHERE template LIKE 'tarjeta_regalo%' ORDER BY id").all();
    assert.ok(mails.some((m) => m.to_addr === 'luis@example.com' && m.template === 'tarjeta_regalo'));
    assert.ok(mails.some((m) => m.to_addr === 'ana@example.com' && m.template === 'tarjeta_regalo_comprador'));
  });
  test('el mostrador vende tarjetas: en efectivo suma a la caja del turno', async () => {
    const cajero = await t.login('cajero');
    await t.call('/api/admin/shift/open', { method: 'POST', token: cajero, body: { opening_cash: 100 } });
    const sold = await t.call('/api/admin/gift-cards', { method: 'POST', token: cajero, body: { amount: 30, payment_method: 'efectivo', buyer: { name: 'Cliente' }, recipient: { name: 'Otro' } } });
    assert.equal(sold.status, 201);
    const shift = (await t.call('/api/admin/shift', { token: cajero })).data.shift;
    assert.equal(shift.totals.gift_cards_cash, 30);
    assert.equal(shift.totals.expected_cash, 130);
    const admin = await t.login('admin');
    const list = (await t.call('/api/admin/gift-cards?q=GC-', { token: admin })).data;
    assert.ok(list.rows.length >= 3 && list.outstanding > 0);
    const anul = await t.call(`/api/admin/gift-cards/${sold.data.id}/status`, { method: 'POST', token: admin, body: { status: 'anulada' } });
    assert.equal(anul.status, 200);
    assert.match((await t.call('/api/gift-cards/check', { method: 'POST', body: { code: sold.data.code } })).data.error, /no es válido/);
    await t.call('/api/admin/shift/close', { method: 'POST', token: cajero, body: { counted: 100 } });
  });
});

describe('seguimiento del pedido y avisos', () => {
  test('un pedido en línea trae un código de seguimiento y cada paso queda en su línea de tiempo', async () => {
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const made = await order([{ variant_id: v.id, qty: 1 }], { n: 50, delivery: 'retiro', notify_opt_in: true });
    assert.match(made.data.tracking_code, /^[A-Z2-9]{10}$/);
    const track = await t.call(`/api/track?code=${made.data.tracking_code}`);
    assert.equal(track.status, 200);
    assert.deepEqual(track.data.steps.map((s) => [s.kind, s.done]), [['recibido', true], ['preparando', false], ['listo', false], ['entregado', false]]);
    assert.ok(!JSON.stringify(track.data).includes('cliente50@example.com') && !JSON.stringify(track.data).includes('6000'), 'sin datos personales');
    const admin = await t.login('gerente');
    const step = (s) => t.call(`/api/admin/orders/${made.data.id}/progress`, { method: 'POST', token: admin, body: { step: s } });
    assert.equal((await step('enviado')).status, 409, 'es para retirar, no para envío');
    assert.equal((await step('listo')).status, 200);
    assert.equal((await step('listo')).status, 409, 'ya registrado');
    assert.equal((await step('preparando')).status, 409, 'ya pasó a un paso posterior');
    const after = (await t.call(`/api/track?code=${made.data.tracking_code}`)).data;
    assert.equal(after.steps.find((s) => s.kind === 'listo').done, true);
    await t.call(`/api/admin/orders/${made.data.id}/status`, { method: 'POST', token: admin, body: { status: 'entregado' } });
    assert.ok((await t.call(`/api/track?code=${made.data.tracking_code}`)).data.steps.every((s) => s.done));
  });
  test('consultar con éxito no gasta el cupo; solo las consultas que no encuentran nada se frenan', async () => {
    const t9 = await startApp();
    try {
      const v = variantOf(t9.db, 'Cedro & Cuero', 50);
      const made = await t9.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 95 }) });
      for (let i = 0; i < 45; i++) assert.equal((await t9.call(`/api/track?code=${made.data.tracking_code}`)).status, 200, 'se puede mirar el pedido las veces que haga falta (la pantalla se actualiza sola mientras espera el pago)');
      for (let i = 0; i < 20; i++) assert.equal((await t9.call(`/api/track?order=${made.data.id}&contact=0000000${i}`)).status, 404);
      const blocked = await t9.call(`/api/track?order=${made.data.id}&contact=99999999`);
      assert.equal(blocked.status, 429);
      assert.equal((await t9.call(`/api/track?code=${made.data.tracking_code}`)).status, 429, 'la conexión queda frenada un rato');
    } finally { t9.close(); }
  });
  test('también se consulta con el número de pedido y el correo o teléfono; con datos que no coinciden, no', async () => {
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const made = await order([{ variant_id: v.id, qty: 1 }], { n: 51, delivery: 'envio', address: 'Calle 1' });
    assert.equal((await t.call(`/api/track?order=${made.data.id}&contact=cliente51@example.com`)).status, 200);
    assert.equal((await t.call(`/api/track?order=${made.data.id}&contact=6000-0000`)).status, 200);
    assert.equal((await t.call(`/api/track?order=${made.data.id}&contact=otro@example.com`)).status, 404);
    assert.equal((await t.call(`/api/track?order=${made.data.id}`)).status, 400);
    assert.equal((await t.call('/api/track?code=ZZZZZZZZZZ')).status, 404);
    assert.equal((await t.call('/api/track?code=corto')).status, 404);
    const enviado = await t.call(`/api/admin/orders/${made.data.id}/progress`, { method: 'POST', token: await t.login('admin'), body: { step: 'enviado' } });
    assert.equal(enviado.status, 200);
  });
  test('los avisos: correo siempre que haya uno, WhatsApp solo si el cliente lo aceptó; quedan simulados con su texto', async () => {
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const withWa = await order([{ variant_id: v.id, qty: 1 }], { n: 52, notify_opt_in: true });
    const noWa = await order([{ variant_id: v.id, qty: 1 }], { n: 53 });
    const mine = (id) => t.db.prepare("SELECT channel, status, to_addr FROM notifications WHERE dedupe_key LIKE ?").all(`ord:${id}:recibido:%`);
    assert.deepEqual(mine(withWa.data.id).map((n) => n.channel).sort(), ['email', 'whatsapp']);
    assert.deepEqual(mine(noWa.data.id).map((n) => n.channel), ['email']);
    assert.ok(mine(withWa.data.id).every((n) => n.status === 'simulado'));
    assert.equal(mine(withWa.data.id).find((n) => n.channel === 'whatsapp').to_addr, '50760000000', 'número con código de país');
    const admin = await t.login('admin');
    const list = (await t.call('/api/admin/notifications?limit=100', { token: admin })).data;
    assert.equal(list.mode, 'simulado');
    const row = list.rows.find((n) => n.channel === 'whatsapp' && n.text.includes(`#${withWa.data.id}`));
    assert.match(row.text, /pedido #\d+ por \$/);
    assert.match(row.text, new RegExp(`#seguimiento/${withWa.data.tracking_code}|${withWa.data.tracking_code}`));
  });
  test('«avísame cuando llegue»: se pide solo si está agotado, y al volver el stock sale el aviso una sola vez', async () => {
    const admin = await t.login('admin');
    const v = variantOf(t.db, 'Ámbar Nocturno', 50); // la demo lo deja agotado
    const pid = t.db.prepare('SELECT product_id FROM variants WHERE id = ?').get(v.id).product_id;
    assert.equal(stockOf(t.db, v.id), 0);
    const ask = (body) => t.call(`/api/products/${pid}/notify`, { method: 'POST', body: { variant_id: v.id, ...body } });
    assert.equal((await ask({ channel: 'email', contact: 'mal' })).status, 400);
    assert.equal((await ask({ channel: 'whatsapp', contact: '6000-1111' })).status, 400, 'sin aceptar que le escriban');
    assert.equal((await ask({ channel: 'email', contact: 'espera@example.com', name: 'Eva' })).status, 201);
    assert.equal((await ask({ channel: 'email', contact: 'espera@example.com' })).status, 201, 'repetido: no duplica');
    assert.equal((await ask({ channel: 'whatsapp', contact: '6000-1111', consent: true })).status, 201);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM stock_alerts WHERE notified_at IS NULL').get().n, 2);
    const inStock = variantOf(t.db, 'Cedro & Cuero', 50);
    const pid2 = t.db.prepare('SELECT product_id FROM variants WHERE id = ?').get(inStock.id).product_id;
    assert.equal((await t.call(`/api/products/${pid2}/notify`, { method: 'POST', body: { variant_id: inStock.id, channel: 'email', contact: 'a@b.co' } })).status, 409, 'ya hay existencias');
    assert.equal((await t.call('/api/admin/stock-alerts', { token: admin })).data.rows[0].waiting, 2);
    await t.call(`/api/admin/variants/${v.id}/adjust`, { method: 'POST', token: admin, body: { delta: 5, reason: 'Llegó mercancía' } });
    const sent = t.db.prepare("SELECT channel, to_addr, template FROM notifications WHERE template = 'stock_disponible' ORDER BY id").all();
    assert.deepEqual(sent.map((n) => n.channel).sort(), ['email', 'whatsapp']);
    assert.equal(sent.find((n) => n.channel === 'whatsapp').to_addr, '50760001111');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM stock_alerts WHERE notified_at IS NULL').get().n, 0);
    await t.call(`/api/admin/variants/${v.id}/adjust`, { method: 'POST', token: admin, body: { delta: -5, reason: 'Corrección' } });
    await t.call(`/api/admin/variants/${v.id}/adjust`, { method: 'POST', token: admin, body: { delta: 5, reason: 'Otra vez' } });
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM notifications WHERE template = 'stock_disponible'").get().n, 2, 'no se avisa dos veces');
  });
  test('alerta de stock bajo al encargado: solo si hay contacto configurado y una vez al día por producto', async () => {
    const admin = await t.login('admin');
    const gerente = await t.login('gerente');
    const v = t.db.prepare("SELECT v.id, v.stock, v.min_stock FROM variants v WHERE v.is_set = 0 AND v.stock > v.min_stock + 3 AND v.active = 1 LIMIT 1").get();
    const count = () => t.db.prepare("SELECT COUNT(*) n FROM notifications WHERE template = 'stock_bajo'").get().n;
    const lower = (to) => t.call(`/api/admin/variants/${v.id}/adjust`, { method: 'POST', token: admin, body: { count: to, reason: 'Conteo' } });
    await lower(v.min_stock);
    assert.equal(count(), 0, 'sin contacto configurado no se avisa');
    await lower(v.min_stock + 5);
    assert.equal((await t.call('/api/admin/policy', { method: 'PATCH', token: gerente, body: { alert_whatsapp: '6999-1234', alert_email: 'jefe@example.com' } })).status, 200);
    await lower(v.min_stock);
    assert.equal(count(), 2, 'WhatsApp y correo');
    await lower(v.min_stock + 5);
    await lower(v.min_stock);
    assert.equal(count(), 2, 'mismo día, mismo producto: una sola vez');
    const text = (await t.call('/api/admin/notifications?limit=100', { token: admin })).data.rows.find((n) => n.template === 'stock_bajo').text;
    assert.match(text, /Alerta de inventario/);
  });
  test('con NOTIFY_WEBHOOK_URL los avisos salen firmados, se reintentan y pasan a error tras varios fallos', async () => {
    const sent = [];
    const t3 = await startApp({ notify: { url: 'https://n8n.example/webhook/avisos', secret: 's3cret' } });
    try {
      assert.equal(t3.db.prepare("SELECT value FROM settings WHERE key = 'notify_mode'").get().value, 'webhook');
      const v = variantOf(t3.db, 'Cedro & Cuero', 50);
      const made = await t3.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 60, notify_opt_in: true }) });
      assert.equal(made.status, 201);
      const pending = t3.db.prepare("SELECT status FROM notifications WHERE dedupe_key LIKE ?").all(`ord:${made.data.id}:recibido:%`);
      assert.deepEqual(pending.map((p) => p.status), ['pendiente', 'pendiente']);
      const { flush } = await import('../notify.js');
      const { createHmac } = await import('node:crypto');
      const cfg = { url: 'https://n8n.example/webhook/avisos', secret: 's3cret' };
      const ok = await flush(t3.db, cfg, { brand: t3.app.brand, fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200 }; } });
      assert.equal(ok.sent, 2);
      const first = sent[0];
      assert.equal(first.url, cfg.url);
      assert.equal(first.init.headers['X-Signature'], `sha256=${createHmac('sha256', 's3cret').update(first.init.body).digest('hex')}`);
      const body = JSON.parse(first.init.body);
      assert.equal(body.event, 'pedido_estado');
      assert.ok(body.text.includes(`#${made.data.id}`) && body.data.tracking_code === made.data.tracking_code);
      assert.equal(t3.db.prepare("SELECT COUNT(*) n FROM notifications WHERE status = 'enviado'").get().n, 2);
      // fallos: reintenta y al quinto queda en error
      const v2 = await t3.call('/api/orders', { method: 'POST', body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 61 }) });
      const key = `ord:${v2.data.id}:recibido:email`;
      for (let i = 0; i < 4; i++) await flush(t3.db, cfg, { brand: t3.app.brand, fetchImpl: async () => ({ ok: false, status: 502 }) });
      assert.equal(t3.db.prepare('SELECT status FROM notifications WHERE dedupe_key = ?').get(key).status, 'pendiente');
      await flush(t3.db, cfg, { brand: t3.app.brand, fetchImpl: async () => { throw new Error('sin red'); } });
      const row = t3.db.prepare('SELECT status, attempts, last_error FROM notifications WHERE dedupe_key = ?').get(key);
      assert.deepEqual([row.status, row.attempts], ['error', 5]);
      const admin = await t3.login('admin');
      const id = t3.db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(key).id;
      assert.equal((await t3.call(`/api/admin/notifications/${id}/retry`, { method: 'POST', token: admin, body: {} })).status, 200);
      assert.equal(t3.db.prepare('SELECT status FROM notifications WHERE id = ?').get(id).status, 'pendiente');
    } finally { t3.close(); }
  });
  test('un aviso de prueba exige un número o correo válido', async () => {
    const admin = await t.login('admin');
    assert.equal((await t.call('/api/admin/notifications/test', { method: 'POST', token: admin, body: { channel: 'whatsapp', to: '123' } })).status, 400);
    assert.equal((await t.call('/api/admin/notifications/test', { method: 'POST', token: admin, body: { channel: 'whatsapp', to: '+507 6000-9999' } })).status, 200);
    assert.equal((await t.call('/api/admin/notifications/test', { method: 'POST', token: await t.login('cajero'), body: { channel: 'email', to: 'a@b.co' } })).status, 403);
  });
});

describe('cuentas de clientes y favoritos', () => {
  const reg = (n, extra = {}) => t.call('/api/account/register', { method: 'POST', body: { name: `Cliente ${n}`, email: `cuenta${n}@example.com`, phone: '6000-0000', password: 'una-clave-buena', ...extra } });

  test('registrarse, entrar, ver el perfil; correo repetido y clave débil se rechazan', async () => {
    assert.equal((await reg(1, { password: '123' })).status, 400);
    assert.equal((await reg(1, { email: 'mal' })).status, 400);
    const ok = await reg(1);
    assert.equal(ok.status, 201);
    assert.ok(!JSON.stringify(ok.data).includes('scrypt'));
    assert.equal((await reg(1)).status, 409);
    assert.equal((await t.call('/api/account/me')).status, 401);
    assert.equal((await t.call('/api/account/me', { token: ok.data.token })).data.customer.email, 'cuenta1@example.com');
    const login = await t.call('/api/account/login', { method: 'POST', body: { email: 'CUENTA1@example.com', password: 'una-clave-buena' } });
    assert.equal(login.status, 200, 'el correo no distingue mayúsculas');
    assert.equal((await t.call('/api/account/login', { method: 'POST', body: { email: 'cuenta1@example.com', password: 'mala-clave' } })).status, 401);
    assert.equal((await t.call('/api/account/login', { method: 'POST', body: { email: 'nadie@example.com', password: 'mala-clave' } })).status, 401);
  });
  test('insistir con claves malas bloquea ese correo desde esa conexión', async () => {
    await reg(2);
    for (let i = 0; i < 8; i++) await t.call('/api/account/login', { method: 'POST', body: { email: 'cuenta2@example.com', password: 'mala-clave' } });
    assert.equal((await t.call('/api/account/login', { method: 'POST', body: { email: 'cuenta2@example.com', password: 'una-clave-buena' } })).status, 429);
  });
  test('los pedidos hechos con sesión quedan en la cuenta; los de invitado no', async () => {
    const acct = await reg(3);
    const v = variantOf(t.db, 'Cedro & Cuero', 50);
    const guest = await order([{ variant_id: v.id, qty: 1 }], { n: 3 });
    const mine = await t.call('/api/orders', { method: 'POST', token: acct.data.token, body: onlineOrder([{ variant_id: v.id, qty: 1 }], { n: 3 }) });
    assert.equal(mine.status, 201);
    const list = (await t.call('/api/account/orders', { token: acct.data.token })).data.orders;
    assert.deepEqual(list.map((o) => o.id), [mine.data.id]);
    assert.ok(list[0].tracking_code && list[0].items.length === 1);
    assert.ok(!list.some((o) => o.id === guest.data.id), 'no se recogen pedidos de invitado: el correo no está verificado');
  });
  test('favoritos: se guardan en la cuenta, ignoran lo que no existe y no se mezclan entre clientes', async () => {
    const a = await reg(4);
    const b = await reg(5);
    const put = (token, ids) => t.call('/api/account/favorites', { method: 'PUT', token, body: { ids } });
    assert.deepEqual((await put(a.data.token, [3, 5, 99999, 3])).data.ids.sort(), [3, 5]);
    assert.deepEqual((await t.call('/api/account/favorites', { token: b.data.token })).data.ids, []);
    assert.deepEqual((await put(a.data.token, [])).data.ids, []);
    const items = await t.call('/api/products-by-ids?ids=3,5,99999');
    assert.deepEqual(items.data.products.map((p) => p.id), [3, 5]);
  });
  test('cambiar la clave cierra las demás sesiones; un token de cliente no abre el panel ni al revés', async () => {
    const a = await reg(6);
    const ch = await t.call('/api/account/password', { method: 'POST', token: a.data.token, body: { current: 'una-clave-buena', next: 'otra-clave-nueva' } });
    assert.equal(ch.status, 200);
    assert.equal((await t.call('/api/account/me', { token: a.data.token })).status, 401);
    assert.equal((await t.call('/api/account/me', { token: ch.data.token })).status, 200);
    assert.equal((await t.call('/api/admin/dashboard', { token: ch.data.token })).status, 401);
    assert.equal((await t.call('/api/account/me', { token: await t.login('admin') })).status, 401);
  });
});

describe('buscador guiado', () => {
  const ask = (answers) => t.call('/api/finder', { method: 'POST', body: { answers } });
  const base = { for: 'damas', occasion: 'noche', style: 'dulce', intensity: 'media', budget: '80a150' };

  test('las preguntas son cinco y vienen con sus opciones', async () => {
    const r = await t.call('/api/finder/questions');
    assert.deepEqual(r.data.questions.map((q) => q.id), ['for', 'occasion', 'style', 'intensity', 'budget']);
  });
  test('recomienda hasta tres productos con existencias, de la categoría pedida y con el motivo', async () => {
    const r = await ask(base);
    assert.equal(r.status, 200);
    assert.ok(r.data.products.length >= 1 && r.data.products.length <= 3);
    for (const p of r.data.products) {
      assert.equal(p.category, 'Damas');
      assert.ok(p.total_stock > 0);
      assert.notEqual(p.kind, 'Tester');
      assert.ok(p.reasons.length >= 1);
    }
  });
  test('el estilo y el presupuesto cambian el resultado', async () => {
    const fresh = await ask({ ...base, style: 'fresco', intensity: 'suave', budget: 'hasta40', for: '' });
    const spicy = await ask({ ...base, style: 'especiado', intensity: 'intensa', budget: 'mas150', for: '' });
    assert.notDeepEqual(fresh.data.products.map((p) => p.id), spicy.data.products.map((p) => p.id));
    for (const p of fresh.data.products) assert.ok(p.min_price <= 44, 'respeta el techo del presupuesto (con un margen)');
  });
  test('si no hay coincidencia exacta afloja criterios y lo avisa', async () => {
    const r = await ask({ for: 'infantil', occasion: 'noche', style: 'especiado', intensity: 'intensa', budget: 'hasta40' });
    assert.equal(r.status, 200);
    assert.ok(r.data.relaxed.length >= 1);
    assert.ok(r.data.products.every((p) => p.category === 'Infantil'));
  });
  test('respuestas inválidas dan 400', async () => {
    assert.equal((await ask({ ...base, for: 'marcianos' })).status, 400);
    assert.equal((await ask({})).status, 400);
  });
});
