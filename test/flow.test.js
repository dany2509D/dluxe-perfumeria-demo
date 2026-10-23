// Prueba el ciclo completo contra un servidor real con base de datos en memoria:
// vender → el stock baja → se genera compra automática → recibir → el stock sube.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';

let app, base, token;

const api = async (path, { method = 'GET', body, auth = false } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const customer = { name: 'Ana Prueba', email: 'ana@example.com', phone: '+507 6000-0000' };
const order = (variant_id, qty) => ({
  customer,
  payment_method: 'tarjeta',
  delivery: 'retiro',
  items: [{ variant_id, qty }],
});
const stockOf = async (id) => (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows.find((v) => v.id === id);

before(async () => {
  app = createApp({ dbPath: ':memory:', password: 'test-pw' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  token = (await api('/api/login', { method: 'POST', body: { password: 'test-pw' } })).data.token;
});

after(() => app.server.close());

test('el panel exige sesión y rechaza contraseñas incorrectas', async () => {
  assert.equal((await api('/api/admin/dashboard')).status, 401);
  assert.equal((await api('/api/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  assert.equal((await api('/api/admin/dashboard', { auth: true })).status, 200);
});

test('el catálogo público no expone costos ni stock mínimo', async () => {
  const { data } = await api('/api/products?limit=60');
  assert.ok(data.products.length >= 10);
  assert.ok(data.total >= data.products.length && data.facets, 'devuelve total y conteos por filtro');
  const v = data.products[0].variants[0];
  assert.deepEqual(Object.keys(v).sort(), ['compare_at', 'id', 'price', 'size_ml', 'stock']);
});

test('una venta online descuenta el stock y deja un movimiento', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const target = inv.find((v) => v.stock >= 6 && v.stock > v.min_stock + 2);
  const before = target.stock;

  const res = await api('/api/orders', { method: 'POST', body: order(target.id, 2) });
  assert.equal(res.status, 201);
  assert.equal(res.data.total, target.price * 2);

  assert.equal((await stockOf(target.id)).stock, before - 2);
  const moves = (await api(`/api/admin/movements?variant_id=${target.id}`, { auth: true })).data;
  assert.equal(moves[0].type, 'salida');
  assert.equal(moves[0].qty, -2);
  assert.equal(moves[0].balance, before - 2);
});

test('no se puede vender más de lo que hay (ni con la API directa)', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const target = inv.find((v) => v.stock > 0);
  const res = await api('/api/orders', { method: 'POST', body: order(target.id, target.stock + 1) });
  assert.equal(res.status, 409);
  assert.equal((await stockOf(target.id)).stock, target.stock, 'el stock no cambió');
});

test('un pedido con varias líneas es todo-o-nada', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows.filter((v) => v.stock > 0);
  const [a, b] = inv;
  const res = await api('/api/orders', {
    method: 'POST',
    body: { ...order(a.id, 1), items: [{ variant_id: a.id, qty: 1 }, { variant_id: b.id, qty: b.stock + 5 }] },
  });
  assert.equal(res.status, 409);
  assert.equal((await stockOf(a.id)).stock, a.stock, 'la primera línea no quedó descontada');
});

test('los precios los pone el servidor, no el cliente', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const target = inv.find((v) => v.stock > 3);
  const res = await api('/api/orders', {
    method: 'POST',
    body: { ...order(target.id, 1), items: [{ variant_id: target.id, qty: 1, unit_price: 0.01 }], total: 0.01 },
  });
  assert.equal(res.data.total, target.price);
});

test('cancelar un pedido devuelve el stock', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const target = inv.find((v) => v.stock > 4);
  const before = target.stock;
  const o = (await api('/api/orders', { method: 'POST', body: order(target.id, 3) })).data;
  assert.equal((await stockOf(target.id)).stock, before - 3);

  const cancel = await api(`/api/admin/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelado' }, auth: true });
  assert.equal(cancel.status, 200);
  assert.equal((await stockOf(target.id)).stock, before);

  const again = await api(`/api/admin/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelado' }, auth: true });
  assert.equal(again.status, 409, 'no se puede cancelar dos veces (duplicaría el stock)');
  assert.equal((await stockOf(target.id)).stock, before);
});

test('al caer al mínimo se crea una compra automática y al recibirla sube el stock', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const target = inv.find((v) => !v.on_order && v.stock > v.min_stock && v.supplier_id);
  const sell = target.stock - target.min_stock; // queda justo en el mínimo
  const res = await api('/api/admin/pos/orders', {
    method: 'POST',
    auth: true,
    body: { customer: { name: 'Mostrador' }, payment_method: 'efectivo', items: [{ variant_id: target.id, qty: sell }] },
  });
  assert.equal(res.status, 201);
  assert.ok(res.data.replenished.items >= 1, 'generó reposición');

  const after = await stockOf(target.id);
  assert.equal(after.stock, target.min_stock);
  assert.equal(after.on_order, 1);

  const purchases = (await api('/api/admin/purchases', { auth: true })).data;
  const po = purchases.find((p) => p.status === 'pendiente' && p.items.some((i) => i.sku === target.sku));
  assert.ok(po && po.auto === 1);

  const rec = await api(`/api/admin/purchases/${po.id}/status`, { method: 'POST', body: { status: 'recibida' }, auth: true });
  assert.equal(rec.status, 200);
  const qty = po.items.find((i) => i.sku === target.sku).qty;
  const final = await stockOf(target.id);
  assert.equal(final.stock, target.min_stock + qty);
  assert.equal(final.on_order, 0);

  const again = await api(`/api/admin/purchases/${po.id}/status`, { method: 'POST', body: { status: 'recibida' }, auth: true });
  assert.equal(again.status, 409, 'recibir dos veces duplicaría el stock');
});

test('la carga masiva por CSV es atómica', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const [a] = inv;

  const bad = await api('/api/admin/import', { method: 'POST', auth: true, body: { csv: `sku,cantidad\n${a.sku},5\nNOEXISTE,2` } });
  assert.equal(bad.status, 400);
  assert.equal((await stockOf(a.id)).stock, a.stock, 'una fila inválida cancela todo');

  const ok = await api('/api/admin/import', { method: 'POST', auth: true, body: { csv: `sku;cantidad;costo\n${a.sku};5;9,50` } });
  assert.equal(ok.status, 200);
  const now = await stockOf(a.id);
  assert.equal(now.stock, a.stock + 5);
  assert.equal(now.cost, 9.5);
});

test('ajustes manuales: por diferencia y por conteo, sin dejar stock negativo', async () => {
  const inv = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows;
  const t = inv.find((v) => v.stock > 2);
  const neg = await api(`/api/admin/variants/${t.id}/adjust`, { method: 'POST', auth: true, body: { delta: -(t.stock + 1), reason: 'prueba' } });
  assert.equal(neg.status, 409);

  const cnt = await api(`/api/admin/variants/${t.id}/adjust`, { method: 'POST', auth: true, body: { count: t.stock + 7, reason: 'Conteo físico' } });
  assert.equal(cnt.status, 200);
  assert.equal((await stockOf(t.id)).stock, t.stock + 7);

  const noReason = await api(`/api/admin/variants/${t.id}/adjust`, { method: 'POST', auth: true, body: { delta: 1 } });
  assert.equal(noReason.status, 400);
});

test('crear un producto nuevo con stock inicial', async () => {
  const res = await api('/api/admin/products', {
    method: 'POST',
    auth: true,
    body: {
      name: 'Prueba Eau', brand: 'Test', category: 'Unisex', family: 'Fresco', color: '#aabbcc',
      variants: [{ size_ml: 50, price: 60, cost: 25, stock: 9, min_stock: 2, reorder_qty: 6 }],
    },
  });
  assert.equal(res.status, 201);
  const v = (await api('/api/admin/inventory?limit=200', { auth: true })).data.rows.find((x) => x.name === 'Prueba Eau');
  assert.equal(v.stock, 9);
  assert.match(v.sku, /^DLX-\d{5}-50$/);
});

test('el dashboard responde con datos coherentes', async () => {
  const d = (await api('/api/admin/dashboard', { auth: true })).data;
  assert.equal(d.series.length, 14);
  assert.ok(d.month.total > 0);
  assert.ok(d.inventory.units > 0);
});
