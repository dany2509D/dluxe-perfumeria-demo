// Ofertas y cupones. Una promoción con código es un cupón (el cliente lo escribe); sin código se aplica sola a la bolsa.
// Regla simple y predecible: en cada compra se aplica UNA sola promoción, la que más descuenta (las ofertas no se acumulan).
// Los sets de regalo ya llevan su descuento: ninguna promoción se les suma.
import { HttpError } from './db.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lc = (s) => String(s ?? '').trim().toLowerCase();

export const SCOPES = ['todo', 'marca', 'categoria', 'tipo'];
export const KINDS = ['percent', 'fixed', 'bundle'];
const CHANNELS = ['ambos', 'online', 'mostrador'];

export const today = (db) => db.prepare("SELECT date('now','localtime') AS d").get().d;

// ─── Cálculo ───────────────────────────────────────────────────────────────
const inScope = (promo, line) => {
  if (promo.scope === 'todo') return true;
  const target = lc(promo.scope_value);
  if (promo.scope === 'marca') return lc(line.brand) === target;
  if (promo.scope === 'categoria') return lc(line.category) === target;
  if (promo.scope === 'tipo') return lc(line.kind) === target;
  return false;
};

// Las líneas a las que se aplica la promoción.
export const eligibleLines = (promo, lines) => lines.filter((l) => !l.is_set && (!promo.skip_sale || !l.on_sale) && inScope(promo, l));

// Descuento de una promoción sobre unas líneas (0 si no aplica).
export function discountFor(promo, lines) {
  const el = eligibleLines(promo, lines);
  const sub = el.reduce((s, l) => s + l.price * l.qty, 0);
  if (!el.length || sub <= 0 || sub < promo.min_total) return { amount: 0, eligible: round2(sub) };
  let amount = 0;
  if (promo.kind === 'percent') amount = (sub * promo.amount) / 100;
  else if (promo.kind === 'fixed') amount = Math.min(promo.amount, sub);
  else {
    // «Llévate N por $X»: las unidades se agrupan de N en N, las más caras primero; cada grupo completo paga X.
    const n = Math.max(2, promo.buy_qty);
    const prices = el.flatMap((l) => Array(l.qty).fill(l.price)).sort((a, b) => b - a);
    for (let i = 0; i + n <= prices.length; i += n) {
      const group = prices.slice(i, i + n).reduce((s, p) => s + p, 0);
      if (group > promo.amount) amount += group - promo.amount;
    }
  }
  return { amount: round2(Math.min(amount, sub)), eligible: round2(sub) };
}

const publicPromo = (p) => ({ id: p.id, name: p.name, code: p.code, kind: p.kind, amount: p.amount, buy_qty: p.buy_qty, scope: p.scope, scope_value: p.scope_value });

// ¿La promoción se puede usar hoy, en este canal, por esta persona? Devuelve el motivo si no.
function whyNot(db, promo, { channel, email, day }) {
  if (!promo.active) return 'El código no está activo';
  if (promo.starts_at && day < promo.starts_at) return 'El código todavía no está vigente';
  if (promo.ends_at && day > promo.ends_at) return 'El código venció';
  if (promo.max_uses != null && promo.uses >= promo.max_uses) return 'El código ya se agotó';
  if (promo.channel !== 'ambos' && promo.channel !== channel) return promo.channel === 'online' ? 'Este código es solo para compras en la tienda en línea' : 'Este código es solo para compras en el mostrador';
  if (promo.per_customer && email && promo.code) {
    const used = db.prepare("SELECT 1 FROM orders WHERE lower(customer_email) = ? AND lower(coupon_code) = ? AND status <> 'cancelado' LIMIT 1").get(lc(email), lc(promo.code));
    if (used) return 'Ya usaste este código';
  }
  return null;
}

// Calcula el precio de una bolsa.
//   lines:  [{ variant_id, product_id, brand, category, kind, qty, price, on_sale, is_set }]
//   coupon: código que escribió el cliente (opcional)
//   manual: { type: 'percent'|'fixed', value, reason } — descuento del mostrador (reemplaza a los demás)
// Devuelve { subtotal, discount, total, applied, couponNote }.
export function quote(db, { lines, coupon = '', channel = 'online', email = '', manual = null, day = null } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const out = { subtotal, discount: 0, applied: null, couponNote: null };
  const when = day || today(db);

  if (manual) {
    const v = Number(manual.value);
    if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, 'El descuento no es válido');
    if (manual.type === 'percent' && v > 100) throw new HttpError(400, 'El descuento no puede pasar de 100%');
    const amount = round2(Math.min(subtotal, manual.type === 'percent' ? (subtotal * v) / 100 : v));
    return { ...out, discount: amount, total: round2(subtotal - amount), applied: { id: null, name: `Descuento manual${manual.reason ? ` (${String(manual.reason).slice(0, 60)})` : ''}`, code: null, kind: 'manual' } };
  }

  const candidates = [];
  const auto = db.prepare("SELECT * FROM promotions WHERE code IS NULL AND active = 1").all();
  for (const p of auto) if (!whyNot(db, p, { channel, email, day: when })) candidates.push(p);

  let couponPromo = null;
  const code = String(coupon ?? '').trim();
  if (code) {
    couponPromo = db.prepare('SELECT * FROM promotions WHERE code = ? COLLATE NOCASE').get(code);
    if (!couponPromo) throw new HttpError(400, 'Ese código no existe');
    const reason = whyNot(db, couponPromo, { channel, email, day: when });
    if (reason) throw new HttpError(400, reason);
    const r = discountFor(couponPromo, lines);
    if (r.amount <= 0) {
      const min = couponPromo.min_total > 0 && r.eligible > 0 && r.eligible < couponPromo.min_total;
      throw new HttpError(400, min ? `Este código pide una compra mínima de $${couponPromo.min_total.toFixed(2)} en los productos que aplican` : 'Este código no aplica a los productos de tu bolsa (o ya están en oferta)');
    }
    candidates.push(couponPromo);
  }

  let best = null;
  for (const p of candidates) {
    const r = discountFor(p, lines);
    if (r.amount > (best?.amount ?? 0)) best = { promo: p, amount: r.amount };
  }
  if (best) {
    out.discount = best.amount;
    out.applied = publicPromo(best.promo);
    if (couponPromo && best.promo.id !== couponPromo.id) out.couponNote = 'Ya tienes una oferta que descuenta más: se aplicó esa y no se usó el código.';
  }
  out.total = round2(subtotal - out.discount);
  return out;
}

// Cuenta un uso (cuando el pedido se confirma) y lo devuelve si el pedido se cancela.
export function consume(db, code) {
  if (code) db.prepare('UPDATE promotions SET uses = uses + 1 WHERE code = ? COLLATE NOCASE').run(code);
}
export function release(db, code) {
  if (code) db.prepare('UPDATE promotions SET uses = MAX(0, uses - 1) WHERE code = ? COLLATE NOCASE').run(code);
}

// ─── Administración ────────────────────────────────────────────────────────
const date = (v, name) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${name} no es una fecha válida`);
  return s;
};

function clean(body) {
  const name = String(body.name ?? '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'El nombre de la promoción es obligatorio');
  const kind = body.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'El tipo de descuento no es válido');
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'El monto del descuento debe ser mayor que cero');
  if (kind === 'percent' && amount > 100) throw new HttpError(400, 'El porcentaje no puede pasar de 100');
  const buy = Math.floor(Number(body.buy_qty) || 0);
  if (kind === 'bundle' && (buy < 2 || buy > 12)) throw new HttpError(400, 'En «llévate N por…» N debe ser de 2 a 12');
  const scope = SCOPES.includes(body.scope) ? body.scope : 'todo';
  const scopeValue = String(body.scope_value ?? '').trim().slice(0, 60);
  if (scope !== 'todo' && !scopeValue) throw new HttpError(400, 'Indica a qué marca, categoría o tipo aplica');
  const channel = CHANNELS.includes(body.channel) ? body.channel : 'ambos';
  const code = String(body.code ?? '').trim().toUpperCase();
  if (code && !/^[A-Z0-9_-]{3,24}$/.test(code)) throw new HttpError(400, 'El código debe tener de 3 a 24 letras, números o guiones');
  const starts = date(body.starts_at, 'La fecha de inicio');
  const ends = date(body.ends_at, 'La fecha de fin');
  if (starts && ends && ends < starts) throw new HttpError(400, 'La fecha de fin es anterior a la de inicio');
  const maxUses = body.max_uses === '' || body.max_uses == null ? null : Math.floor(Number(body.max_uses));
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) throw new HttpError(400, 'El máximo de usos no es válido');
  const minTotal = Number(body.min_total || 0);
  if (!Number.isFinite(minTotal) || minTotal < 0) throw new HttpError(400, 'La compra mínima no es válida');
  return {
    name, code: code || null, kind, amount: round2(amount), buy_qty: kind === 'bundle' ? buy : 0, scope, scope_value: scope === 'todo' ? '' : scopeValue,
    min_total: round2(minTotal), skip_sale: body.skip_sale === false || body.skip_sale === 0 ? 0 : 1, channel, starts_at: starts, ends_at: ends, max_uses: maxUses,
    per_customer: body.per_customer ? 1 : 0, featured: code && body.featured ? 1 : 0, active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

export function listPromotions(db) {
  const day = today(db);
  return db.prepare('SELECT * FROM promotions ORDER BY active DESC, id DESC').all().map((p) => ({
    ...p,
    state: !p.active ? 'inactiva' : p.ends_at && day > p.ends_at ? 'vencida' : p.starts_at && day < p.starts_at ? 'programada' : p.max_uses != null && p.uses >= p.max_uses ? 'agotada' : 'vigente',
  }));
}

export function createPromotion(db, body) {
  const f = clean(body);
  try {
    const r = db
      .prepare(
        `INSERT INTO promotions (name, code, kind, amount, buy_qty, scope, scope_value, min_total, skip_sale, channel, starts_at, ends_at, max_uses, per_customer, featured, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.name, f.code, f.kind, f.amount, f.buy_qty, f.scope, f.scope_value, f.min_total, f.skip_sale, f.channel, f.starts_at, f.ends_at, f.max_uses, f.per_customer, f.featured, f.active);
    return { id: Number(r.lastInsertRowid) };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe una promoción con ese código');
    throw e;
  }
}

export function updatePromotion(db, id, body) {
  const cur = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Promoción no encontrada');
  const f = clean({ ...cur, ...body, skip_sale: 'skip_sale' in body ? body.skip_sale : !!cur.skip_sale });
  try {
    db.prepare(
      `UPDATE promotions SET name = ?, code = ?, kind = ?, amount = ?, buy_qty = ?, scope = ?, scope_value = ?, min_total = ?, skip_sale = ?, channel = ?,
              starts_at = ?, ends_at = ?, max_uses = ?, per_customer = ?, featured = ?, active = ? WHERE id = ?`
    ).run(f.name, f.code, f.kind, f.amount, f.buy_qty, f.scope, f.scope_value, f.min_total, f.skip_sale, f.channel, f.starts_at, f.ends_at, f.max_uses, f.per_customer, f.featured, f.active, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Ya existe una promoción con ese código');
    throw e;
  }
  return { ok: true };
}

// Una promoción ya usada no se borra (queda en el historial de pedidos): se desactiva.
export function removePromotion(db, id) {
  const cur = db.prepare('SELECT id, uses FROM promotions WHERE id = ?').get(id);
  if (!cur) throw new HttpError(404, 'Promoción no encontrada');
  if (cur.uses > 0) {
    db.prepare('UPDATE promotions SET active = 0 WHERE id = ?').run(id);
    return { removed: false, deactivated: true };
  }
  db.prepare('DELETE FROM promotions WHERE id = ?').run(id);
  return { removed: true, deactivated: false };
}

// Lo que la tienda anuncia: las ofertas automáticas vigentes y los cupones marcados para mostrarse. Los demás códigos no se revelan.
export function publicOffers(db, { channel = 'online' } = {}) {
  const day = today(db);
  return db
    .prepare('SELECT * FROM promotions WHERE active = 1 AND (code IS NULL OR featured = 1) ORDER BY code IS NOT NULL, id')
    .all()
    .filter((p) => !whyNot(db, p, { channel, email: '', day }))
    .map((p) => ({ ...publicPromo(p), ends_at: p.ends_at, min_total: p.min_total, per_customer: !!p.per_customer }));
}
