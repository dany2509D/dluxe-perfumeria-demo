// Cuentas de clientes: registrarse, entrar, ver sus pedidos y guardar favoritos. Comprar no exige cuenta.
//
// Limitación conocida: el correo no se verifica (la demostración no envía correos de verdad). Por eso un registro nuevo NO recoge
// los pedidos que se hicieron antes como invitado con ese correo: solo ve los pedidos hechos con la sesión iniciada. En producción
// hay que confirmar el correo (o el WhatsApp) con un código antes de activar la cuenta.
import { HttpError } from './db.js';
import { hashPassword, verifyPassword, passwordProblem } from './auth.js';

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const publicCustomer = (c) => c && { id: c.id, name: c.name, email: c.email, phone: c.phone, notify_opt_in: !!c.notify_opt_in, created_at: c.created_at };

export const customerById = (db, id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
export const customerByEmail = (db, email) => db.prepare('SELECT * FROM customers WHERE email = ?').get(String(email ?? '').trim());

export function registerCustomer(db, { name, email, phone = '', password, notify_opt_in = false }) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!n) throw new HttpError(400, 'Escribe tu nombre');
  const mail = String(email ?? '').trim().slice(0, 120);
  if (!emailOk(mail)) throw new HttpError(400, 'Escribe un correo válido');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  if (customerByEmail(db, mail)) throw new HttpError(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db
    .prepare('INSERT INTO customers (name, email, phone, pass_hash, notify_opt_in) VALUES (?, ?, ?, ?, ?)')
    .run(n, mail, String(phone ?? '').trim().slice(0, 30), hashPassword(password), notify_opt_in ? 1 : 0);
  return customerById(db, Number(r.lastInsertRowid));
}

// Devuelve el cliente si el correo y la clave coinciden; si no, null (el mismo resultado exista o no la cuenta).
export function checkLogin(db, email, password, dummyHash) {
  const c = customerByEmail(db, email);
  const ok = verifyPassword(String(password ?? ''), c?.pass_hash ?? dummyHash) && !!c;
  if (!ok) return null;
  db.prepare("UPDATE customers SET last_login = datetime('now','localtime') WHERE id = ?").run(c.id);
  return c;
}

export function updateProfile(db, id, body) {
  const sets = [];
  const vals = [];
  if ('name' in body) {
    const n = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!n) throw new HttpError(400, 'Escribe tu nombre');
    sets.push('name = ?'); vals.push(n);
  }
  if ('phone' in body) { sets.push('phone = ?'); vals.push(String(body.phone ?? '').trim().slice(0, 30)); }
  if ('notify_opt_in' in body) { sets.push('notify_opt_in = ?'); vals.push(body.notify_opt_in ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, 'No hay cambios que guardar');
  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return publicCustomer(customerById(db, id));
}

export function changePassword(db, id, current, next) {
  const c = customerById(db, id);
  if (!c || !verifyPassword(current, c.pass_hash)) throw new HttpError(401, 'La contraseña actual no es correcta');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  db.prepare('UPDATE customers SET pass_hash = ? WHERE id = ?').run(hashPassword(next), id);
}

export const profile = (db, id) => publicCustomer(customerById(db, id));

export function ordersOf(db, customerId, limit = 50) {
  const orders = db
    .prepare('SELECT id, status, total, discount, gift_amount, refunded, delivery, payment_method, tracking_code, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit);
  const items = db.prepare('SELECT oi.qty, oi.unit_price, v.size_ml, p.name, p.id AS product_id FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ? ORDER BY oi.id');
  return orders.map((o) => ({ ...o, items: items.all(o.id) }));
}

// ─── Favoritos ─────────────────────────────────────────────────────────────
export const favoritesOf = (db, customerId) =>
  db.prepare('SELECT f.product_id FROM customer_favorites f JOIN products p ON p.id = f.product_id AND p.active = 1 WHERE f.customer_id = ? ORDER BY f.created_at DESC, f.product_id DESC LIMIT 200').all(customerId).map((r) => r.product_id);

// Reemplaza la lista por la que llega (tras unir lo guardado en el navegador con lo de la cuenta).
export function setFavorites(db, customerId, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  const valid = wanted.length ? db.prepare(`SELECT id FROM products WHERE active = 1 AND id IN (${wanted.map(() => '?').join(',')})`).all(...wanted).map((r) => r.id) : [];
  db.prepare('DELETE FROM customer_favorites WHERE customer_id = ?').run(customerId);
  const ins = db.prepare('INSERT OR IGNORE INTO customer_favorites (customer_id, product_id) VALUES (?, ?)');
  for (const id of valid.reverse()) ins.run(customerId, id);
  return favoritesOf(db, customerId);
}
