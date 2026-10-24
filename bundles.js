// Sets de regalo: varios perfumes que se venden juntos a un precio especial.
//
// Un set es un producto más del catálogo (tipo «Estuche») con una variante marcada is_set = 1. Así la tienda, la ficha, la bolsa y
// el asistente lo tratan como cualquier otro producto. La diferencia está en el inventario: un set no tiene existencias propias,
// su stock es el del componente más escaso (lo recalcula el trigger trg_set_stock) y, al venderlo, el pedido se «abre» en sus
// componentes: cada uno descuenta su propio stock y se lleva su parte del precio del set.
import { HttpError, tx } from './db.js';
import { bumpCatalog } from './catalog.js';
import { searchText } from './text.js';

const cents = (n) => Math.round(Number(n) * 100);
const dollars = (c) => c / 100;

// Reparte el precio de UN set entre sus unidades, proporcional al precio normal de cada una, sin perder ni inventar centavos
// (método del mayor resto). Devuelve filas { variant_id, qty, unit_price }; una misma pieza puede quedar con dos precios si no
// se reparte en partes iguales.
export function splitPrice(components, setPrice) {
  const units = [];
  for (const c of components) for (let i = 0; i < c.qty; i++) units.push({ variant_id: c.variant_id, p: cents(c.price) });
  const total = units.reduce((s, u) => s + u.p, 0);
  const target = cents(setPrice);
  if (total <= 0) throw new HttpError(400, 'Los productos del set no tienen precio');
  let given = 0;
  for (const u of units) {
    const exact = (target * u.p) / total;
    u.c = Math.floor(exact);
    u.rest = exact - u.c;
    given += u.c;
  }
  const order = units.map((u, i) => i).sort((a, b) => units[b].rest - units[a].rest || a - b);
  for (let k = 0; k < target - given; k++) units[order[k % order.length]].c += 1;
  const rows = [];
  for (const u of units) {
    const row = rows.find((r) => r.variant_id === u.variant_id && r.cents === u.c);
    if (row) row.qty += 1;
    else rows.push({ variant_id: u.variant_id, cents: u.c, qty: 1 });
  }
  return rows.map((r) => ({ variant_id: r.variant_id, qty: r.qty, unit_price: dollars(r.cents) }));
}

const VARIANT_INFO = `SELECT v.id, v.price, v.compare_at, v.cost, v.stock, v.size_ml, v.is_set, v.active AS v_active,
                             p.id AS product_id, p.name, p.brand, p.category, p.kind, p.active AS p_active
                        FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`;

export const componentsOf = (db, setVariantId) =>
  db
    .prepare(
      `SELECT bi.component_variant_id AS variant_id, bi.qty, v.price, v.cost, v.stock, v.size_ml, v.active AS v_active,
              p.id AS product_id, p.name, p.brand, p.image, p.color, p.active AS p_active
         FROM bundle_items bi JOIN variants v ON v.id = bi.component_variant_id JOIN products p ON p.id = v.product_id
        WHERE bi.bundle_variant_id = ? ORDER BY bi.rowid`
    )
    .all(setVariantId);

// Qué hay que descontar del inventario y a qué precio, para un conjunto de líneas de la bolsa { variantId → cantidad }.
// Devuelve: items (filas de order_items ya con el precio repartido), lines (para calcular ofertas) y needs (variante → unidades).
export function expandLines(db, wanted) {
  const items = [];
  const lines = [];
  const needs = new Map();
  const need = (id, qty) => needs.set(id, (needs.get(id) || 0) + qty);
  for (const [variantId, qty] of wanted) {
    const v = db.prepare(VARIANT_INFO).get(variantId);
    if (!v || !v.v_active || !v.p_active) throw new HttpError(404, 'Uno de los productos ya no está disponible');
    const label = `${v.name}${v.size_ml ? ` ${v.size_ml} ml` : ''}`;
    if (v.stock < qty) throw new HttpError(409, v.stock === 0 ? `${label} está agotado` : `Solo quedan ${v.stock} unidades de ${label}`);
    lines.push({ variant_id: v.id, product_id: v.product_id, brand: v.brand, category: v.category, kind: v.kind, qty, price: v.price, on_sale: !!(v.compare_at && v.compare_at > v.price), is_set: !!v.is_set });
    if (!v.is_set) {
      items.push({ variant_id: v.id, qty, unit_price: v.price, unit_cost: v.cost, bundle_variant_id: null, bundle_units: null });
      need(v.id, qty);
      continue;
    }
    const comps = componentsOf(db, v.id);
    if (!comps.length || comps.some((c) => !c.v_active || !c.p_active)) throw new HttpError(404, `Uno de los productos de «${v.name}» ya no está disponible`);
    for (const row of splitPrice(comps, v.price)) {
      const c = comps.find((x) => x.variant_id === row.variant_id);
      items.push({ variant_id: row.variant_id, qty: row.qty * qty, unit_price: row.unit_price, unit_cost: c.cost, bundle_variant_id: v.id, bundle_units: qty });
      need(row.variant_id, row.qty * qty);
    }
  }
  // Una pieza puede estar suelta y dentro de un set a la vez: el total que se pide de cada una no puede pasar de lo que hay.
  for (const [id, qty] of needs) {
    const v = db.prepare(VARIANT_INFO).get(id);
    if (v.stock < qty) throw new HttpError(409, `No alcanzan las existencias de ${v.name}${v.size_ml ? ` ${v.size_ml} ml` : ''} para completar el pedido`);
  }
  return { items, lines, needs };
}

// ─── Administración de sets ────────────────────────────────────────────────
export function recomputeSetStock(db, setVariantId) {
  db.prepare(
    `UPDATE variants
        SET stock = COALESCE((SELECT MIN(cv.stock / bi.qty) FROM bundle_items bi JOIN variants cv ON cv.id = bi.component_variant_id
                               WHERE bi.bundle_variant_id = variants.id), 0)
      WHERE id = ? AND is_set = 1`
  ).run(setVariantId);
}

function cleanComponents(db, raw, { exceptSet = null } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Agrega los productos que incluye el set');
  const merged = new Map();
  for (const c of raw) {
    const id = Number(c?.variant_id);
    const qty = Number(c?.qty ?? 1);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Producto del set no válido');
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'La cantidad de cada producto del set debe ser de 1 a 20');
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const out = [];
  for (const [id, qty] of merged) {
    const v = db.prepare(VARIANT_INFO).get(id);
    if (!v || id === exceptSet) throw new HttpError(404, 'Uno de los productos del set no existe');
    if (v.is_set) throw new HttpError(400, 'Un set no puede incluir otro set');
    if (!v.v_active || !v.p_active) throw new HttpError(400, `${v.name} está oculto: no se puede incluir en un set`);
    out.push({ variant_id: id, qty, price: v.price, cost: v.cost, name: v.name, brand: v.brand, family: db.prepare('SELECT family FROM products WHERE id = ?').get(v.product_id).family, category: v.category });
  }
  if (out.reduce((s, c) => s + c.qty, 0) < 2) throw new HttpError(400, 'Un set necesita al menos dos productos');
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

function setDescription(comps) {
  return `Incluye: ${comps.map((c) => `${c.qty > 1 ? `${c.qty} × ` : ''}${c.name}`).join(', ')}.`;
}

export function createSet(db, body, { skuPrefix = 'DLX' } = {}) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw new HttpError(400, 'El nombre es obligatorio');
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) throw new HttpError(400, 'El precio del set no es válido');
  return tx(db, () => {
    const comps = cleanComponents(db, body.components);
    const regular = round2(comps.reduce((s, c) => s + c.price * c.qty, 0));
    if (price >= regular) throw new HttpError(400, `El precio del set debe ser menor que la suma de sus productos (${regular.toFixed(2)})`);
    const brands = [...new Set(comps.map((c) => c.brand).filter(Boolean))];
    const categories = [...new Set(comps.map((c) => c.category))];
    const brand = brands.length === 1 ? brands[0] : String(body.brand ?? '').trim().slice(0, 60) || (brands.length ? 'Varias marcas' : '');
    const category = categories.length === 1 ? categories[0] : 'Unisex';
    const description = String(body.description ?? '').trim().slice(0, 1200) || setDescription(comps);
    const image = String(body.image ?? '').trim();
    if (image && !/^\/img\/[\w./-]+$/.test(image) && !/^\/api\/media\/\d+$/.test(image) && !/^https:\/\/[^\s"'<>]{4,500}$/.test(image)) throw new HttpError(400, 'La imagen no es válida');
    const p = db
      .prepare(
        `INSERT INTO products (name, brand, category, kind, family, notes, description, color, image, is_new)
         VALUES (?, ?, ?, 'Estuche', ?, ?, ?, ?, ?, 0)`
      )
      .run(name, brand, category, comps[0].family || '', comps.map((c) => c.name).join(', ').slice(0, 160), description, /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#c9a24b', image || null);
    const pid = Number(p.lastInsertRowid);
    const sku = `${skuPrefix}-SET-${String(pid).padStart(5, '0')}`;
    const vr = db
      .prepare(`INSERT INTO variants (product_id, sku, size_ml, price, compare_at, cost, min_stock, reorder_qty, is_set) VALUES (?, ?, 0, ?, ?, ?, 0, 1, 1)`)
      .run(pid, sku, round2(price), regular, round2(comps.reduce((s, c) => s + c.cost * c.qty, 0)));
    const vid = Number(vr.lastInsertRowid);
    const ins = db.prepare('INSERT INTO bundle_items (bundle_variant_id, component_variant_id, qty) VALUES (?, ?, ?)');
    for (const c of comps) ins.run(vid, c.variant_id, c.qty);
    recomputeSetStock(db, vid);
    db.prepare('UPDATE products SET search_text = ? WHERE id = ?').run(
      searchText({ name, brand, category, subcategory: null, kind: 'Estuche', family: comps[0].family || '', notes: comps.map((c) => c.name).join(' ') }),
      pid
    );
    bumpCatalog(db);
    return { product_id: pid, variant_id: vid, sku };
  });
}

export function updateSet(db, productId, body) {
  return tx(db, () => {
    const v = db.prepare('SELECT v.id, v.price FROM variants v WHERE v.product_id = ? AND v.is_set = 1').get(productId);
    if (!v) throw new HttpError(404, 'Set no encontrado');
    const sets = [];
    const vals = [];
    if ('name' in body) {
      const name = String(body.name ?? '').trim().slice(0, 120);
      if (!name) throw new HttpError(400, 'El nombre es obligatorio');
      sets.push('name = ?'); vals.push(name);
    }
    if ('description' in body) { sets.push('description = ?'); vals.push(String(body.description ?? '').trim().slice(0, 1200)); }
    if ('active' in body) { sets.push('active = ?'); vals.push(body.active ? 1 : 0); }
    if ('image' in body) {
      const image = String(body.image ?? '').trim();
      if (image && !/^\/img\/[\w./-]+$/.test(image) && !/^\/api\/media\/\d+$/.test(image) && !/^https:\/\/[^\s"'<>]{4,500}$/.test(image)) throw new HttpError(400, 'La imagen no es válida');
      sets.push('image = ?'); vals.push(image || null);
    }
    if (sets.length) db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...vals, productId);

    let comps = null;
    if ('components' in body) {
      comps = cleanComponents(db, body.components, { exceptSet: v.id });
      db.prepare('DELETE FROM bundle_items WHERE bundle_variant_id = ?').run(v.id);
      const ins = db.prepare('INSERT INTO bundle_items (bundle_variant_id, component_variant_id, qty) VALUES (?, ?, ?)');
      for (const c of comps) ins.run(v.id, c.variant_id, c.qty);
    }
    const current = componentsOf(db, v.id);
    const regular = round2(current.reduce((s, c) => s + c.price * c.qty, 0));
    const price = 'price' in body ? Number(body.price) : v.price;
    if (!Number.isFinite(price) || price <= 0) throw new HttpError(400, 'El precio del set no es válido');
    if (price >= regular) throw new HttpError(400, `El precio del set debe ser menor que la suma de sus productos (${regular.toFixed(2)})`);
    db.prepare('UPDATE variants SET price = ?, compare_at = ?, cost = ?, active = COALESCE(?, active) WHERE id = ?').run(
      round2(price), regular, round2(current.reduce((s, c) => s + c.cost * c.qty, 0)), 'active' in body ? (body.active ? 1 : 0) : null, v.id
    );
    if (comps && !('description' in body)) db.prepare('UPDATE products SET description = ?, notes = ? WHERE id = ?').run(setDescription(comps), comps.map((c) => c.name).join(', ').slice(0, 160), productId);
    recomputeSetStock(db, v.id);
    const p = db.prepare('SELECT id, name, brand, category, subcategory, kind, family, notes FROM products WHERE id = ?').get(productId);
    db.prepare('UPDATE products SET search_text = ? WHERE id = ?').run(searchText(p), productId);
    bumpCatalog(db);
    return { ok: true };
  });
}

export function listSets(db) {
  const rows = db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.image, p.color, p.active, v.id AS variant_id, v.sku, v.price, v.compare_at, v.cost, v.stock
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.is_set = 1 ORDER BY p.id DESC`
    )
    .all();
  return rows.map((r) => ({ ...r, components: componentsOf(db, r.variant_id).map((c) => ({ variant_id: c.variant_id, product_id: c.product_id, name: c.name, size_ml: c.size_ml, qty: c.qty, price: c.price, stock: c.stock })) }));
}

// Lo que se muestra en la ficha pública de un set («Este set incluye…»). Devuelve null si el producto no es un set.
export function publicComponents(db, productId) {
  const v = db.prepare('SELECT id FROM variants WHERE product_id = ? AND is_set = 1 AND active = 1').get(productId);
  if (!v) return null;
  return componentsOf(db, v.id).map((c) => ({ product_id: c.product_id, name: c.name, brand: c.brand, size_ml: c.size_ml, qty: c.qty, image: c.image, color: c.color, price: c.price }));
}

// Las líneas de una bolsa para calcular precios y ofertas (sin revisar existencias: sirve para mostrar el total mientras se arma).
export function priceLinesOf(db, wanted) {
  const lines = [];
  for (const [variantId, qty] of wanted) {
    const v = db.prepare(VARIANT_INFO).get(variantId);
    if (!v || !v.v_active || !v.p_active) continue; // lo que ya no existe simplemente no suma
    lines.push({ variant_id: v.id, product_id: v.product_id, brand: v.brand, category: v.category, kind: v.kind, qty, price: v.price, on_sale: !!(v.compare_at && v.compare_at > v.price), is_set: !!v.is_set });
  }
  return lines;
}
