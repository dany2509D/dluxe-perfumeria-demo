// Consultas de catálogo pensadas para miles de productos: todo se filtra, ordena y pagina en SQL, y la búsqueda usa
// un texto normalizado (sin acentos, por inicio de palabra) que se mantiene al guardar cada producto.
// Lo usan la tienda, el panel y el asistente: ninguno carga el catálogo completo en memoria.
import { norm } from './text.js';

export const CATEGORIES = ['Damas', 'Caballeros', 'Infantil', 'Unisex'];
export const UNCLASSIFIED = 'Sin clasificar';
export const KINDS = ['Perfume', 'Estuche', 'Tester'];

// ─── Revisión del catálogo (para invalidar el índice de nombres) ─────────────
const revs = new WeakMap();
export const bumpCatalog = (db) => revs.set(db, (revs.get(db) || 0) + 1);
const rev = (db) => revs.get(db) || 0;

// ─── Utilidades ─────────────────────────────────────────────────────────────
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
// "frescos" → "fresco": se busca el inicio de la palabra, así que el plural no estorba.
const stem = (t) => (t.length > 4 ? t.replace(/(es|s)$/, '') : t);

export function queryTokens(q) {
  return [
    ...new Set(
      norm(q)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2)
    ),
  ].slice(0, 6);
}

const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// WHERE común. `skip` omite una dimensión (para calcular las cuentas de cada filtro sin que se anule a sí mismo).
function where(f, skip = []) {
  const w = ['p.active = 1'];
  const a = [];
  if (!skip.includes('q')) {
    for (const t of queryTokens(f.q)) {
      w.push("p.search_text LIKE ? ESCAPE '\\'");
      a.push(`% ${likeEsc(stem(t))}%`);
    }
  }
  if (!skip.includes('category') && f.category) { w.push('p.category = ? COLLATE NOCASE'); a.push(f.category); }
  if (!skip.includes('subcategory') && f.subcategory) { w.push('p.subcategory = ? COLLATE NOCASE'); a.push(f.subcategory); }
  if (!skip.includes('kind') && f.kind) { w.push('p.kind = ? COLLATE NOCASE'); a.push(f.kind); }
  if (!skip.includes('brand') && f.brand) { w.push('p.brand = ? COLLATE NOCASE'); a.push(f.brand); }
  if (!skip.includes('family') && f.family) { w.push('p.family = ? COLLATE NOCASE'); a.push(f.family); }
  if (f.isNew) w.push('p.is_new = 1');
  const lo = num(f.minPrice);
  const hi = num(f.maxPrice);
  if (lo !== null || hi !== null) {
    w.push('EXISTS (SELECT 1 FROM variants x WHERE x.product_id = p.id AND x.active = 1 AND x.price >= ? AND x.price <= ?)');
    a.push(lo ?? 0, hi ?? 1e9);
  }
  if (f.inStock) w.push('EXISTS (SELECT 1 FROM variants x WHERE x.product_id = p.id AND x.active = 1 AND x.stock > 0)');
  if (f.onSale) w.push('EXISTS (SELECT 1 FROM variants x WHERE x.product_id = p.id AND x.active = 1 AND x.compare_at > x.price)');
  return { sql: w.join(' AND '), args: a };
}

const BASE = (extraCols = '') => `
  SELECT p.id, p.name, p.brand, p.category, p.subcategory, p.kind, p.family, p.notes, p.description, p.color, p.image,
         p.is_new, p.sold, p.permalink${extraCols},
         MIN(v.price) AS min_price, MAX(v.price) AS max_price, COALESCE(SUM(v.stock), 0) AS total_stock,
         MAX(CASE WHEN v.compare_at > v.price THEN CAST(ROUND((v.compare_at - v.price) * 100.0 / v.compare_at) AS INTEGER) END) AS discount_pct
    FROM products p JOIN variants v ON v.product_id = p.id AND v.active = 1`;

const SORTS = {
  destacados: 'sold DESC, id ASC',
  novedades: 'is_new DESC, id DESC',
  'precio-asc': 'min_price ASC, id ASC',
  'precio-desc': 'min_price DESC, id ASC',
  nombre: 'name COLLATE NOCASE ASC, id ASC',
  descuento: 'COALESCE(discount_pct, 0) DESC, sold DESC, id ASC',
};

const PRODUCT_ORDER = {
  destacados: 'p.sold DESC, p.id ASC',
  novedades: 'p.is_new DESC, p.id DESC',
  nombre: 'p.search_text ASC, p.id ASC', // texto normalizado: "Ámbar" va con la A, no después de la Z
};

function attachVariants(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const vs = db
    .prepare(
      `SELECT id, product_id, size_ml, price, compare_at, stock FROM variants
        WHERE active = 1 AND product_id IN (${ids.map(() => '?').join(',')}) ORDER BY size_ml, id`
    )
    .all(...ids);
  const by = new Map();
  for (const v of vs) {
    if (!by.has(v.product_id)) by.set(v.product_id, []);
    by.get(v.product_id).push({ id: v.id, size_ml: v.size_ml, price: v.price, compare_at: v.compare_at && v.compare_at > v.price ? v.compare_at : null, stock: v.stock });
  }
  return rows.map((r) => ({
    id: r.id, name: r.name, brand: r.brand, category: r.category, subcategory: r.subcategory, kind: r.kind, family: r.family,
    notes: r.notes, description: r.description, color: r.color, image: r.image, permalink: r.permalink,
    is_new: !!r.is_new, sold: r.sold, min_price: r.min_price, max_price: r.max_price, total_stock: r.total_stock,
    discount_pct: r.discount_pct || 0, on_sale: (r.discount_pct || 0) > 0,
    variants: by.get(r.id) || [],
  }));
}

// Puntaje de relevancia: coincidir en el nombre pesa más que en las notas o la marca.
function scoreOf(p, matchers) {
  let score = 0;
  const fields = [[p.name, 3], [p.notes, 2], [p.family, 2], [p.category, 1], [p.brand, 1], [p.kind, 1], [p.description, 1]].map(([x, w]) => [norm(x), w]);
  for (const re of matchers) for (const [x, w] of fields) if (re.test(x)) score += w;
  return score;
}
// Coincidencia por inicio de palabra (el término ya viene recortado con stem()).
const wordStart = (t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

// ─── Listado paginado (tienda) ──────────────────────────────────────────────
export function queryProducts(db, f = {}) {
  const limit = Math.max(1, Math.min(Number(f.limit) || 25, 60));
  const page = Math.max(1, Number(f.page) || 1);
  const { sql, args } = where(f);
  const hasVariants = 'EXISTS (SELECT 1 FROM variants a WHERE a.product_id = p.id AND a.active = 1)';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE ${sql} AND ${hasVariants}`).get(...args).n;
  const wanted = f.sort || (queryTokens(f.q).length ? 'relevancia' : 'destacados'); // con búsqueda, lo más relevante primero
  let sort = SORTS[wanted] || wanted === 'relevancia' ? wanted : 'destacados';
  const offset = (page - 1) * limit;

  // Con una búsqueda de texto, lo más relevante va primero (con muchísimos resultados se ordena por más vendidos).
  if (sort === 'relevancia') {
    const toks = queryTokens(f.q);
    if (toks.length && total <= 300) {
      const matchers = toks.map((t) => wordStart(stem(t)));
      const all = db.prepare(`SELECT * FROM (${BASE()} WHERE ${sql} GROUP BY p.id) ORDER BY sold DESC, id ASC`).all(...args);
      const ranked = all
        .map((r) => ({ r, s: scoreOf(r, matchers) }))
        .sort((a, b) => b.s - a.s || b.r.sold - a.r.sold || a.r.id - b.r.id)
        .map((x) => x.r)
        .slice(offset, offset + limit);
      return { products: attachVariants(db, ranked), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
    }
    sort = 'destacados';
  }

  let rows;
  if (PRODUCT_ORDER[sort]) {
    // Orden por columnas del producto: se eligen primero los ids de la página (con índice) y solo después se
    // calculan precios y stock de esos pocos productos. Así la portada no agrupa los miles de productos del catálogo.
    const ids = db
      .prepare(`SELECT p.id FROM products p WHERE ${sql} AND ${hasVariants} ORDER BY ${PRODUCT_ORDER[sort]} LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
      .map((r) => r.id);
    const byId = new Map(
      ids.length ? db.prepare(`${BASE()} WHERE p.id IN (${ids.map(() => '?').join(',')}) GROUP BY p.id`).all(...ids).map((r) => [r.id, r]) : []
    );
    rows = ids.map((id) => byId.get(id)).filter(Boolean);
  } else {
    // Orden por precio o descuento: depende de los tamaños, hay que agrupar.
    const base = `${BASE()} WHERE ${sql} GROUP BY p.id`;
    rows = db.prepare(`SELECT * FROM (${base}) ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  }
  return { products: attachVariants(db, rows), total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Cuántos productos hay por categoría, tipo, marca y familia dentro de la selección actual.
export function facets(db, f = {}) {
  const dims = { category: 'p.category', kind: 'p.kind', brand: 'p.brand', family: 'p.family' };
  const out = {};
  for (const [dim, col] of Object.entries(dims)) {
    const w = where(f, [dim]);
    out[dim] = db
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS count FROM products p
          WHERE ${w.sql} AND ${col} <> '' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.active = 1)
          GROUP BY ${col} ORDER BY count DESC, value COLLATE NOCASE LIMIT ?`
      )
      .all(...w.args, dim === 'brand' ? 200 : 40);
  }
  const w = where(f);
  const price = db
    .prepare(`SELECT MIN(v.price) AS min, MAX(v.price) AS max FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND ${w.sql}`)
    .get(...w.args);
  return { categories: out.category, kinds: out.kind, brands: out.brand, families: out.family, price: { min: price.min ?? 0, max: price.max ?? 0 } };
}

export function getProductsByIds(db, ids) {
  const list = [...new Set((ids || []).filter(Number.isInteger))].slice(0, 100);
  if (!list.length) return [];
  const rows = db
    .prepare(`${BASE()} WHERE p.active = 1 AND p.id IN (${list.map(() => '?').join(',')}) GROUP BY p.id`)
    .all(...list);
  const byId = new Map(attachVariants(db, rows).map((p) => [p.id, p]));
  return list.map((id) => byId.get(id)).filter(Boolean);
}

export const getProduct = (db, id) => getProductsByIds(db, [id])[0] ?? null;

// Productos (con todos sus tamaños) a los que pertenecen unas variantes: sirve para restaurar la bolsa de un cliente.
export function getProductsByVariantIds(db, variantIds) {
  const ids = [...new Set((variantIds || []).filter(Number.isInteger))].slice(0, 50);
  if (!ids.length) return [];
  const pids = db.prepare(`SELECT DISTINCT product_id FROM variants WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.product_id);
  return getProductsByIds(db, pids);
}

// ─── Búsqueda para el asistente (con puntaje por relevancia) ────────────────
export function searchProducts(db, { tokens = [], category, subcategory, kind, brand, family, maxPrice, inStock, onSale, isNew, limit = 8 } = {}) {
  const f = { category, subcategory, kind, brand, family, maxPrice: maxPrice > 0 ? maxPrice : null, inStock, onSale, isNew };
  const w = where(f);
  let cond = w.sql;
  const args = [...w.args];
  const toks = tokens.map((t) => stem(t)).filter(Boolean);
  if (toks.length) {
    cond += ` AND (${toks.map(() => "p.search_text LIKE ? ESCAPE '\\'").join(' OR ')})`;
    args.push(...toks.map((t) => `% ${likeEsc(t)}%`));
  }
  const CAP = 400;
  const rows = attachVariants(db, db.prepare(`SELECT * FROM (${BASE()} WHERE ${cond} GROUP BY p.id) ORDER BY sold DESC, id ASC LIMIT ?`).all(...args, CAP));
  const matchers = toks.map(wordStart);
  const scored = rows
    .map((p) => ({ p, score: scoreOf(p, matchers) }))
    .filter(({ score }) => !toks.length || score > 0)
    .sort((a, b) => b.score - a.score || b.p.sold - a.p.sold || a.p.id - b.p.id);
  return { results: scored.slice(0, limit).map((x) => x.p), total: scored.length, capped: rows.length >= CAP };
}

export function catalogSummary(db) {
  const g = (col, n) => db.prepare(`SELECT ${col} AS v, COUNT(*) AS c FROM products WHERE active = 1 AND ${col} <> '' GROUP BY ${col} ORDER BY c DESC LIMIT ?`).all(n);
  const range = db.prepare('SELECT MIN(v.price) AS lo, MAX(v.price) AS hi FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active = 1 AND p.active = 1').get();
  const total = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n;
  return {
    total_products: total,
    families: g('family', 12).map((r) => r.v),
    categories: g('category', 8).map((r) => r.v),
    kinds: g('kind', 5).map((r) => r.v),
    brands: g('brand', 8).map((r) => r.v),
    price_range: range.lo === null ? null : { min: range.lo, max: range.hi },
  };
}

// ─── Índice de nombres (para reconocer "el vetiver real" en un mensaje) ─────
const nameCache = new WeakMap();
export function namesIndex(db) {
  const hit = nameCache.get(db);
  if (hit && hit.rev === rev(db)) return hit.items;
  const items = db
    .prepare('SELECT p.id, p.name FROM products p WHERE p.active = 1 AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.active = 1)')
    .all()
    .map((p) => ({ id: p.id, name: p.name, norm: norm(p.name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() }))
    .map((p) => ({ ...p, tokens: p.norm.split(' ').filter((t) => t.length >= 3 && !['del', 'los', 'las'].includes(t)) }));
  nameCache.set(db, { rev: rev(db), items });
  return items;
}
