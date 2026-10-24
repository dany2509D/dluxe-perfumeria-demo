// Utilidades de las pruebas: arranca una app real con base de datos en memoria y habla con ella por HTTP.
import { createApp } from '../app.js';

export async function startApp(opts = {}) {
  const app = createApp({ dbPath: ':memory:', password: 'clave-de-prueba', chatFactory: () => ({ enabled: false, reason: 'apagado' }), ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token, raw, contentType, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': contentType || 'application/octet-stream' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    return { status: res.status, data, headers: res.headers, res };
  };
  const tokens = new Map();
  const login = async (username = 'admin') => {
    if (tokens.has(username)) return tokens.get(username);
    const r = await call('/api/login', { method: 'POST', body: { username, password: opts.password || 'clave-de-prueba' } });
    if (r.status !== 200) throw new Error(`No se pudo entrar como ${username}: ${r.status} ${JSON.stringify(r.data)}`);
    tokens.set(username, r.data.token);
    return r.data.token;
  };
  return { app, db: app.db, base, call, login, close: () => { app.server.close(); } };
}

export const customer = (n = 1) => ({ name: `Cliente Prueba ${n}`, email: `cliente${n}@example.com`, phone: '+507 6000-0000' });

// Variante de un producto por nombre y tamaño (la tienda de ejemplo trae nombres fijos).
export const variantOf = (db, name, ml, kind = 'Perfume') =>
  db.prepare('SELECT v.id, v.price, v.compare_at, v.cost, v.stock, v.sku FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = ? AND p.kind = ? AND v.size_ml = ?').get(name, kind, ml);

export const onlineOrder = (items, extra = {}) => ({
  customer: extra.customer || customer(extra.n || 1),
  delivery: extra.delivery || 'retiro',
  address: extra.address || '',
  payment_method: extra.payment_method || 'transferencia',
  items,
  ...(extra.coupon ? { coupon: extra.coupon } : {}),
  ...(extra.gift_code ? { gift_code: extra.gift_code } : {}),
  ...(extra.notify_opt_in ? { notify_opt_in: true } : {}),
});

export const stockOf = (db, id) => db.prepare('SELECT stock FROM variants WHERE id = ?').get(id).stock;
export const cents = (n) => Math.round(n * 100);
