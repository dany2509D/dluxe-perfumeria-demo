// Personal del panel: usuarios, roles y permisos, sesiones, tope de intentos y bitácora. También la migración desde la versión 3.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { openDb, SCHEMA_VERSION } from '../db.js';
import * as auth from '../auth.js';
import { createOrder } from '../service.js';

let app, base;
const request = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const login = async (username, password = 'clave-de-prueba') => {
  const r = await request('/api/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `entrar como ${username}`);
  return r.data.token;
};

before(async () => {
  app = createApp({ dbPath: ':memory:', password: 'clave-de-prueba', chatFactory: () => ({ enabled: false, reason: 'apagado' }) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.server.close());

describe('claves y sesiones', () => {
  test('la clave se guarda con scrypt (nunca en claro) y se verifica', () => {
    const h = auth.hashPassword('mi clave larga');
    assert.match(h, /^scrypt\$/);
    assert.ok(!h.includes('mi clave larga'));
    assert.ok(auth.verifyPassword('mi clave larga', h));
    assert.ok(!auth.verifyPassword('otra', h));
    assert.ok(!auth.verifyPassword('x', 'no-es-un-hash'));
    assert.notEqual(auth.hashPassword('mi clave larga'), h, 'cada clave lleva su propia sal');
  });
  test('reglas de clave: 8 caracteres y nada demasiado común', () => {
    assert.ok(auth.passwordProblem('corta'));
    assert.ok(auth.passwordProblem('12345678'));
    assert.equal(auth.passwordProblem('una-clave-razonable'), null);
  });
  test('entrar sin usuario sigue entrando como administrador (compatibilidad con la clave única)', async () => {
    const r = await request('/api/login', { method: 'POST', body: { password: 'clave-de-prueba' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.username, 'admin');
    assert.equal(r.data.user.role, 'admin');
    assert.ok(r.data.user.perms.includes('usuarios'));
  });
  test('usuario o clave incorrectos dan el mismo mensaje', async () => {
    const a = await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'mala' } });
    const b = await request('/api/login', { method: 'POST', body: { username: 'nadie', password: 'mala' } });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.data.error, b.data.error, 'no delata qué usuarios existen');
  });
  test('tras varios intentos fallidos se bloquea ese usuario desde esa conexión, pero no a los demás usuarios', async () => {
    const admin = await login('admin');
    await request('/api/admin/users', { method: 'POST', token: admin, body: { username: 'temporal', name: 'Temporal', role: 'cajero', password: 'clave-de-prueba' } });
    for (let i = 0; i < 8; i++) assert.equal((await request('/api/login', { method: 'POST', body: { username: 'temporal', password: 'mala' } })).status, 401);
    const r = await request('/api/login', { method: 'POST', body: { username: 'temporal', password: 'clave-de-prueba' } });
    assert.equal(r.status, 429, 'aun con la clave buena');
    assert.match(r.data.error, /min/);
    assert.equal((await request('/api/login', { method: 'POST', body: { username: 'admin', password: 'clave-de-prueba' } })).status, 200, 'otro usuario desde la misma conexión sí entra');
  });
  test('el límite por usuario se reinicia al entrar bien', () => {
    const lim = auth.createLimiter({ max: 2, windowMs: 1000 });
    assert.ok(lim.take('a', 0) && lim.take('a', 1));
    assert.ok(!lim.take('a', 2) && lim.blocked('a', 2));
    assert.ok(lim.take('a', 1500), 'pasada la ventana, vuelve a dejar');
    lim.reset('a');
    assert.ok(!lim.blocked('a', 1600));
  });
});

describe('roles y permisos', () => {
  test('hay un usuario de ejemplo por rol y cada uno ve lo suyo', async () => {
    const lim = new Map();
    const who = async (u) => (await request('/api/admin/me', { token: await login(u) })).data;
    assert.equal((await who('gerente')).role, 'gerente');
    assert.equal((await who('cajero')).role, 'cajero');
    assert.equal((await who('bodega')).role, 'inventario');
    assert.ok(!(await who('cajero')).perms.includes('resumen'));
    lim.set('ok', true);
  });
  test('el cajero cobra pero no ve el resumen, ni los costos, ni los usuarios', async () => {
    const t = await login('cajero');
    assert.equal((await request('/api/admin/dashboard', { token: t })).status, 403);
    assert.equal((await request('/api/admin/users', { token: t })).status, 403);
    assert.equal((await request('/api/admin/audit', { token: t })).status, 403);
    assert.equal((await request('/api/admin/purchases', { token: t })).status, 403);
    const inv = await request('/api/admin/inventory?sellable=1&limit=5', { token: t });
    assert.equal(inv.status, 200);
    assert.ok(inv.data.rows.length);
    for (const row of inv.data.rows) assert.ok(!('cost' in row) && !('supplier_name' in row), 'sin costos ni proveedor');
    const v = await request(`/api/admin/variants/${inv.data.rows[0].id}`, { token: t });
    assert.ok(!('cost' in v.data));
    const ped = await request('/api/admin/pos/orders', { method: 'POST', token: t, body: { payment_method: 'efectivo', items: [{ variant_id: inv.data.rows.find((r) => r.stock > 2).id, qty: 1 }] } });
    assert.equal(ped.status, 201);
    assert.equal(ped.data.user_name, 'Cajero de mostrador', 'el pedido queda a nombre de quien cobró');
  });
  test('el cajero no puede cancelar pedidos; el gerente sí', async () => {
    const t = await login('cajero');
    const g = await login('gerente');
    const inv = await request('/api/admin/inventory?sellable=1&limit=50', { token: g });
    const v = inv.data.rows.find((r) => r.stock > 3);
    const ped = await request('/api/admin/pos/orders', { method: 'POST', token: g, body: { payment_method: 'efectivo', items: [{ variant_id: v.id, qty: 1 }] } });
    assert.equal((await request(`/api/admin/orders/${ped.data.id}/status`, { method: 'POST', token: t, body: { status: 'cancelado' } })).status, 403);
    assert.equal((await request(`/api/admin/orders/${ped.data.id}/status`, { method: 'POST', token: g, body: { status: 'cancelado' } })).status, 200);
  });
  test('inventario edita existencias y ve costos, pero no cobra ni abre el resumen', async () => {
    const t = await login('bodega');
    const inv = await request('/api/admin/inventory?limit=3', { token: t });
    assert.equal(inv.status, 200);
    assert.ok('cost' in inv.data.rows[0]);
    assert.equal((await request('/api/admin/pos/orders', { method: 'POST', token: t, body: {} })).status, 403);
    assert.equal((await request('/api/admin/dashboard', { token: t })).status, 403);
    assert.equal((await request('/api/admin/badges', { token: t })).status, 200, 'las etiquetas de la barra no llevan dinero');
  });
  test('toda ruta del panel declara su permiso (si no, la app ni arranca)', () => {
    // createApp ya lanza un error si alguna ruta /api/admin/ queda sin permiso: basta con que haya arrancado.
    assert.ok(app.server.listening);
  });
  test('sin sesión o con un token de cliente, el panel responde 401', async () => {
    assert.equal((await request('/api/admin/me')).status, 401);
    assert.equal((await request('/api/admin/me', { token: 'c.1.zzzzzz.' + '0'.repeat(64) })).status, 401);
  });
});

describe('gestión de usuarios', () => {
  test('solo el administrador crea usuarios; se validan nombre, rol y clave', async () => {
    const admin = await login('admin');
    const g = await login('gerente');
    assert.equal((await request('/api/admin/users', { method: 'POST', token: g, body: { username: 'x1', name: 'X', role: 'cajero', password: 'una-clave-buena' } })).status, 403);
    const bad = (body) => request('/api/admin/users', { method: 'POST', token: admin, body });
    assert.equal((await bad({ username: 'Ab', name: 'X', role: 'cajero', password: 'una-clave-buena' })).status, 400, 'usuario muy corto');
    assert.equal((await bad({ username: 'laura', name: 'Laura', role: 'jefe', password: 'una-clave-buena' })).status, 400, 'rol inexistente');
    assert.equal((await bad({ username: 'laura', name: 'Laura', role: 'cajero', password: '123' })).status, 400, 'clave débil');
    assert.equal((await bad({ username: 'cajero', name: 'Otra', role: 'cajero', password: 'una-clave-buena' })).status, 409, 'repetido');
    const ok = await bad({ username: 'laura', name: 'Laura Pérez', role: 'cajero', password: 'una-clave-buena' });
    assert.equal(ok.status, 201);
    assert.ok(!('pass_hash' in ok.data) && !JSON.stringify(ok.data).includes('scrypt'), 'nunca devuelve la clave');
    const list = await request('/api/admin/users', { token: admin });
    assert.ok(list.data.users.some((u) => u.username === 'laura'));
    assert.ok(!JSON.stringify(list.data).includes('scrypt'));
    assert.equal((await login('laura', 'una-clave-buena')).split('.')[0], 's');
  });
  test('desactivar a alguien cierra su sesión al instante; reactivarlo no la revive sola', async () => {
    const admin = await login('admin');
    const lauraToken = await login('laura', 'una-clave-buena');
    assert.equal((await request('/api/admin/me', { token: lauraToken })).status, 200);
    const id = (await request('/api/admin/users', { token: admin })).data.users.find((u) => u.username === 'laura').id;
    assert.equal((await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { active: false } })).status, 200);
    assert.equal((await request('/api/admin/me', { token: lauraToken })).status, 401);
    assert.equal((await request('/api/login', { method: 'POST', body: { username: 'laura', password: 'una-clave-buena' } })).status, 401, 'desactivada, no entra');
    await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { active: true } });
    assert.equal((await request('/api/admin/me', { token: lauraToken })).status, 200, 'vuelve a valer mientras no venza');
  });
  test('cambiar el rol surte efecto en la siguiente petición', async () => {
    const admin = await login('admin');
    const t = await login('laura', 'una-clave-buena');
    assert.equal((await request('/api/admin/dashboard', { token: t })).status, 403);
    const id = (await request('/api/admin/users', { token: admin })).data.users.find((u) => u.username === 'laura').id;
    await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { role: 'gerente' } });
    assert.equal((await request('/api/admin/dashboard', { token: t })).status, 200);
  });
  test('siempre queda al menos un administrador activo y nadie se desactiva a sí mismo', async () => {
    const admin = await login('admin');
    const id = (await request('/api/admin/users', { token: admin })).data.users.find((u) => u.username === 'admin').id;
    assert.equal((await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { active: false } })).status, 409);
    assert.equal((await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { role: 'gerente' } })).status, 409);
  });
  test('cambiar la propia clave exige la actual y cierra las demás sesiones', async () => {
    const admin = await login('admin');
    const old = await login('gerente');
    assert.equal((await request('/api/admin/me/password', { method: 'POST', token: old, body: { current: 'mala', next: 'otra-clave-buena' } })).status, 401);
    assert.equal((await request('/api/admin/me/password', { method: 'POST', token: old, body: { current: 'clave-de-prueba', next: 'corta' } })).status, 400);
    const r = await request('/api/admin/me/password', { method: 'POST', token: old, body: { current: 'clave-de-prueba', next: 'otra-clave-buena' } });
    assert.equal(r.status, 200);
    assert.equal((await request('/api/admin/me', { token: old })).status, 401, 'la sesión anterior ya no vale');
    assert.equal((await request('/api/admin/me', { token: r.data.token })).status, 200, 'la que devuelve sí');
    assert.equal((await request('/api/login', { method: 'POST', body: { username: 'gerente', password: 'clave-de-prueba' } })).status, 401);
    // restablecida por el administrador
    const id = (await request('/api/admin/users', { token: admin })).data.users.find((u) => u.username === 'gerente').id;
    await request(`/api/admin/users/${id}`, { method: 'PATCH', token: admin, body: { password: 'clave-de-prueba' } });
    assert.equal((await request('/api/admin/me', { token: r.data.token })).status, 401);
  });
});

describe('bitácora', () => {
  test('registra quién hizo qué, sin claves', async () => {
    const admin = await login('admin');
    const t = await login('bodega');
    const inv = await request('/api/admin/inventory?limit=5', { token: t });
    const v = inv.data.rows.find((r) => r.stock > 3);
    await request(`/api/admin/variants/${v.id}/adjust`, { method: 'POST', token: t, body: { delta: -1, reason: 'Frasco roto' } });
    await request(`/api/admin/variants/${v.id}`, { method: 'PATCH', token: t, body: { price: v.price + 1 } });
    const log = (await request('/api/admin/audit?limit=100', { token: admin })).data;
    const ajuste = log.rows.find((r) => r.action === 'inventario.ajuste' && r.entity_id === String(v.id));
    assert.match(ajuste.user_name, /bodega/);
    assert.match(ajuste.detail, /Frasco roto/);
    const edit = log.rows.find((r) => r.action === 'inventario.editar' && r.entity_id === String(v.id));
    assert.match(edit.detail, new RegExp(`price ${v.price} → ${v.price + 1}`));
    assert.ok(log.rows.some((r) => r.action === 'sesion.entrar'));
    assert.ok(!JSON.stringify(log).includes('scrypt') && !JSON.stringify(log).includes('clave-de-prueba'));
    const mov = (await request(`/api/admin/movements?variant_id=${v.id}`, { token: t })).data;
    assert.equal(mov[0].user_name, 'Encargado de inventario', 'el movimiento también guarda quién lo hizo');
  });
  test('se puede filtrar por área, usuario y texto; solo la ve quien tiene permiso', async () => {
    const admin = await login('admin');
    const all = (await request('/api/admin/audit?limit=200', { token: admin })).data;
    const inv = (await request('/api/admin/audit?action=inventario', { token: admin })).data;
    assert.ok(inv.rows.length && inv.rows.length < all.rows.length);
    assert.ok(inv.rows.every((r) => r.action.startsWith('inventario.')));
    assert.ok(all.areas.includes('inventario') && all.areas.includes('sesion'));
    assert.equal((await request('/api/admin/audit?q=Frasco+roto', { token: admin })).data.rows.length, 1);
    assert.equal((await request('/api/admin/audit', { token: await login('cajero') })).status, 403);
    assert.equal((await request('/api/admin/audit', { token: await login('gerente') })).status, 200, 'el gerente sí la consulta');
  });
  test('un intento de entrar fallido no escribe en la base de datos', async () => {
    const n = () => app.db.prepare('SELECT total_changes() AS n').get().n;
    const before = n();
    await request('/api/login', { method: 'POST', body: { username: 'otro-usuario', password: 'mala' } });
    assert.equal(n(), before);
  });
});

describe('migración desde la versión 3', () => {
  test('una base real de la versión 3 conserva pedidos, stock y totales, y acepta lo nuevo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dluxe-v3-'));
    try {
      const path = join(dir, 'v3.db');
      copyFileSync(new URL('./fixtures/v3.db', import.meta.url), path);
      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 54);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM order_items').get().n, 112);
      assert.equal(db.prepare('SELECT SUM(total) t, SUM(subtotal) s FROM orders').get().t, db.prepare('SELECT SUM(subtotal) s FROM orders').get().s, 'subtotal = total en lo anterior');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      for (const t of ['users', 'audit_log', 'customers', 'returns', 'promotions', 'gift_cards', 'bundle_items', 'notifications', 'media', 'fiscal_docs']) {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM sqlite_master WHERE name = ?').get(t).n, 1, `tabla ${t}`);
      }
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger'").get().n, 11);
      const v = db.prepare('SELECT id, stock FROM variants WHERE stock > 3 LIMIT 1').get();
      const o = createOrder(db, { payment_method: 'efectivo', items: [{ variant_id: v.id, qty: 2 }] }, { channel: 'mostrador' });
      assert.equal(db.prepare('SELECT stock FROM variants WHERE id = ?').get(v.id).stock, v.stock - 2);
      assert.equal(o.status, 'pagado');
      db.prepare("UPDATE orders SET status = 'pendiente_pago' WHERE id = ?").run(o.id); // el estado nuevo existe
      db.close();
      const again = openDb(path);
      assert.equal(again.prepare('SELECT COUNT(*) n FROM orders').get().n, 55, 'abrirla otra vez no la migra de nuevo');
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('una demostración anterior recibe lo nuevo', () => {
  test('una base de la versión 3 (como la publicada) gana ofertas, sets, tarjeta de ejemplo, códigos de barras y usuarios sin perder pedidos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dluxe-up-'));
    try {
      const path = join(dir, 'v3.db');
      copyFileSync(new URL('./fixtures/v3.db', import.meta.url), path);
      const a = createApp({ dbPath: path, password: 'clave-de-prueba', demoUsers: true });
      const q = (sql) => a.db.prepare(sql).get().n;
      assert.equal(q('SELECT COUNT(*) n FROM orders'), 54, 'los pedidos de antes siguen ahí');
      assert.equal(q('SELECT COUNT(*) n FROM promotions'), 4);
      assert.equal(q('SELECT COUNT(*) n FROM variants WHERE is_set = 1'), 3);
      assert.equal(q("SELECT COUNT(*) n FROM gift_cards WHERE code = 'GC-DEMO-0050'"), 1);
      assert.equal(q('SELECT COUNT(*) n FROM variants WHERE barcode IS NULL AND is_set = 0'), 0);
      assert.equal(q('SELECT COUNT(DISTINCT barcode) n FROM variants WHERE barcode IS NOT NULL'), q('SELECT COUNT(*) n FROM variants WHERE barcode IS NOT NULL'), 'códigos únicos');
      assert.equal(q('SELECT COUNT(*) n FROM users'), 4);
      a.db.close();
      // abrir otra vez no repite nada
      const b = createApp({ dbPath: path, password: 'clave-de-prueba', demoUsers: true });
      assert.equal(b.db.prepare('SELECT COUNT(*) n FROM promotions').get().n, 4);
      assert.equal(b.db.prepare('SELECT COUNT(*) n FROM variants WHERE is_set = 1').get().n, 3);
      b.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('una base que no es la de ejemplo no recibe nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dluxe-up2-'));
    try {
      const path = join(dir, 'real.db');
      const db = openDb(path);
      db.prepare("INSERT INTO products (name, brand, search_text) VALUES ('Perfume Real', 'Marca Real', ' real')").run();
      db.prepare("INSERT INTO variants (product_id, sku, size_ml, price) VALUES (1, 'REAL-1', 50, 30)").run();
      db.close();
      const a = createApp({ dbPath: path, password: 'clave-de-prueba', demoUsers: true, seedIfEmpty: false });
      assert.equal(a.db.prepare('SELECT COUNT(*) n FROM promotions').get().n, 0);
      assert.equal(a.db.prepare('SELECT COUNT(*) n FROM variants').get().n, 1);
      assert.equal(a.db.prepare('SELECT barcode FROM variants').get().barcode, null);
      a.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
