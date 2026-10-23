// Importación desde WooCommerce. Dos orígenes (el CSV de "Productos → Exportar" o la API REST) producen el mismo
// "plan"; el plan se analiza (informe de calidad de datos) y recién después se aplica a la base, todo en una transacción.
import { HttpError, tx } from './db.js';
import { norm, searchText } from './text.js';
import { CATEGORIES, UNCLASSIFIED, bumpCatalog } from './catalog.js';

// ─── CSV ───────────────────────────────────────────────────────────────────
// Los exportes de Excel pueden venir en Windows-1252: si no es UTF-8 válido, se decodifica así.
export function decodeCsv(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

// Lector CSV completo (comillas, comillas dobles escapadas, saltos de línea dentro de un campo; delimitador , ; o tab).
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const first = s.slice(0, s.search(/\r?\n/) === -1 ? s.length : s.search(/\r?\n/));
  const count = (ch) => first.split(ch).length - 1;
  const delim = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x.trim() !== '')) rows.push(row); }
  return rows;
}

// Encabezados: el exporte sale en el idioma del sitio (ES/EN), así que se reconocen ambos.
const hkey = (h) => norm(h).replace(/[^a-z0-9]+/g, ' ').trim();
const ALIASES = {
  id: ['id'],
  type: ['type', 'tipo'],
  sku: ['sku', 'referencia'],
  name: ['name', 'nombre'],
  published: ['published', 'publicado'],
  visibility: ['visibility in catalog', 'visibilidad en el catalogo'],
  description: ['description', 'descripcion'],
  short: ['short description', 'descripcion corta'],
  instock: ['in stock', 'existencias'],
  stock: ['stock', 'inventario'],
  sale: ['sale price', 'precio rebajado', 'precio de oferta', 'precio rebaja'],
  regular: ['regular price', 'precio normal', 'precio regular'],
  categories: ['categories', 'categorias'],
  tags: ['tags', 'etiquetas'],
  images: ['images', 'imagenes'],
  parent: ['parent', 'superior', 'padre'],
  brands: ['brands', 'marcas', 'brand', 'marca'],
};
const ATTR_NAME = /^(?:attribute (\d+) name|nombre del atributo (\d+))$/;
const ATTR_VALUE = /^(?:attribute (\d+) value s|valor es del atributo (\d+))$/;

function indexHeaders(headers) {
  const col = {};
  const attrs = {};
  headers.forEach((h, i) => {
    const k = hkey(h);
    for (const [field, names] of Object.entries(ALIASES)) if (names.includes(k) && col[field] === undefined) col[field] = i;
    const n = ATTR_NAME.exec(k);
    const v = ATTR_VALUE.exec(k);
    if (n) (attrs[n[1] || n[2]] ??= {}).name = i;
    if (v) (attrs[v[1] || v[2]] ??= {}).value = i;
  });
  return { col, attrs: Object.values(attrs).filter((a) => a.name !== undefined && a.value !== undefined) };
}

// ─── Utilidades de texto y números ─────────────────────────────────────────
export function parseMoney(v) {
  let s = String(v ?? '').replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ' };
export const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<\s*(br|\/p|\/li)\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();

const SNAP = [5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 75, 80, 90, 100, 110, 120, 125, 150, 175, 200, 250, 300];
// Tamaño en el texto ("100 ml", "3.4 oz"). Devuelve { ml, text, oz } o null.
export function parseSize(text) {
  const s = String(text ?? '');
  let m = /(\d+(?:[.,]\d+)?)\s*(?:ml|cc|mls)\b/i.exec(s);
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.'))), text: m[0], oz: false };
  m = /(\d+(?:[.,]\d+)?)\s*(?:fl\.?\s*oz|oz)\b/i.exec(s);
  if (m) {
    const ml = Number(m[1].replace(',', '.')) * 29.5735;
    const near = SNAP.find((x) => Math.abs(x - ml) / x < 0.04);
    return { ml: near ?? Math.round(ml), text: m[0], oz: true };
  }
  return null;
}
const sizeFromAttr = (value) => {
  const bySize = parseSize(value);
  if (bySize) return bySize;
  const n = /^\s*(\d{1,4})\s*$/.exec(String(value ?? ''));
  return n && Number(n[1]) >= 5 ? { ml: Number(n[1]), text: n[0], oz: false } : null;
};
const stripSize = (name, size) => {
  if (!size) return name;
  const out = name
    .replace(size.text, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|,/(:]+|[\s\-–—|,/(:]+$/g, '')
    .trim();
  return out || name;
};

// ─── Reglas de clasificación (palabras, sin acentos) ───────────────────────
const RULES_CATEGORY = [
  ['Infantil', /\b(infantil|infantiles|nino|ninos|nina|ninas|kids?|junior|bebe|baby)\b/],
  ['Unisex', /\bunisex\b/],
  ['Caballeros', /\b(caballero|caballeros|hombre|hombres|men|man|masculino|masculinos|pour homme|for men|homme)\b/],
  ['Damas', /\b(dama|damas|mujer|mujeres|women|woman|femenino|femeninos|pour femme|for women|femme|ladies)\b/],
];
const RULES_KIND = [
  ['Estuche', /\b(estuche|estuches|set|sets|coffret|kit|gift set|cofre)\b/],
  ['Tester', /\b(tester|testers|probador|probadores)\b/],
];
const classify = (rules, ...texts) => {
  const t = norm(texts.filter(Boolean).join(' | '));
  for (const [label, re] of rules) if (re.test(t)) return label;
  return null;
};

// ─── Elementos "Woo" normalizados (de CSV o de la API) ─────────────────────
// { id, type, sku, name, published, visibility, description, short, instock, stock, sale, regular, categories[], tags[],
//   brands[], attrs{nombre:[valores]}, image, permalink, parent, row }
function fromCsv(rows) {
  if (rows.length < 2) throw new HttpError(400, 'El archivo no tiene filas de productos');
  const { col, attrs } = indexHeaders(rows[0]);
  if (col.name === undefined) throw new HttpError(400, 'No encuentro la columna "Nombre": ¿es el CSV de Productos → Exportar de WooCommerce?');
  const get = (r, f) => (col[f] === undefined ? '' : String(r[col[f]] ?? '').trim());
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return rows.slice(1).map((r, i) => {
    const a = {};
    for (const at of attrs) {
      const n = String(r[at.name] ?? '').trim();
      if (n) a[n] = String(r[at.value] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    }
    return {
      row: i + 2,
      id: get(r, 'id'),
      type: norm(get(r, 'type')) || 'simple',
      sku: get(r, 'sku'),
      name: get(r, 'name'),
      published: get(r, 'published'),
      visibility: norm(get(r, 'visibility')),
      description: get(r, 'description'),
      short: get(r, 'short'),
      instock: get(r, 'instock'),
      stock: get(r, 'stock'),
      sale: get(r, 'sale'),
      regular: get(r, 'regular'),
      categories: list(get(r, 'categories')),
      tags: list(get(r, 'tags')),
      brands: list(get(r, 'brands')),
      attrs: a,
      image: list(get(r, 'images'))[0] || '',
      permalink: '',
      parent: get(r, 'parent'),
    };
  });
}

// Producto o variación de la API REST de WooCommerce (v3).
export function fromRest(p, parent = null) {
  const attrs = {};
  for (const a of p.attributes || []) attrs[a.name] = a.options ?? (a.option ? [a.option] : []);
  const manage = p.manage_stock === true || p.manage_stock === 'parent';
  return {
    row: p.id,
    id: String(p.id),
    type: parent ? 'variation' : p.type || 'simple',
    sku: p.sku || '',
    name: p.name || parent?.name || '',
    published: p.status === 'publish' || parent ? '1' : p.status === 'private' ? '-1' : '0',
    visibility: p.catalog_visibility || '',
    description: p.description || '',
    short: p.short_description || '',
    instock: p.stock_status === 'instock' ? '1' : '0',
    stock: manage && p.stock_quantity != null ? String(p.stock_quantity) : '',
    sale: p.sale_price || '',
    regular: p.regular_price || '',
    categories: (p.categories || []).map((c) => c.name),
    tags: (p.tags || []).map((t) => t.name),
    brands: (p.brands || []).map((b) => b.name),
    attrs,
    image: p.image?.src || p.images?.[0]?.src || '',
    permalink: p.permalink || '',
    parent: parent ? String(parent.id) : '',
  };
}

// ─── Plan + informe de calidad ─────────────────────────────────────────────
export const ISSUES = {
  id_duplicado: ['warn', 'ID repetido en el archivo', 'Se conservó la primera fila y se omitieron las demás.'],
  nombre_vacio: ['error', 'Sin nombre', 'La fila se omite: un producto sin nombre no se puede vender.'],
  sin_precio: ['error', 'Sin precio', 'Se importa oculto para la venta hasta que se le ponga precio.'],
  sku_duplicado: ['warn', 'SKU repetido', 'Se agregó un sufijo al segundo para que no choque.'],
  sin_sku: ['warn', 'Sin SKU', 'Se generó un SKU a partir del ID de WooCommerce.'],
  oferta_invalida: ['warn', 'Precio de oferta no válido', 'La oferta es mayor o igual al precio normal: se ignora.'],
  sin_marca: ['warn', 'Sin marca', 'Agrega la marca en WooCommerce (atributo o taxonomía Marcas) para poder filtrar por marca.'],
  sin_categoria: ['warn', 'Categoría no reconocida', 'Va a "Sin clasificar" para revisarlo en el panel (Productos → Sin clasificar).'],
  stock_desconocido: ['warn', 'No controla inventario en WooCommerce', 'Queda con stock 0 hasta el primer conteo o entrada.'],
  stock_negativo: ['warn', 'Stock negativo', 'Se importa como 0.'],
  stock_invalido: ['warn', 'Stock no numérico', 'Se importa como 0.'],
  variable_sin_variaciones: ['warn', 'Producto variable sin variaciones', 'Se omite: no hay tamaños que vender.'],
  duplicado_probable: ['warn', 'Posible duplicado', 'Mismo nombre y tamaño que otro producto con distinto SKU: se importan separados.'],
  sin_imagen: ['info', 'Sin foto', 'Se verá la ilustración mientras no haya foto.'],
  sin_tamano: ['info', 'Tamaño no detectado', 'Se importa como "Tamaño único".'],
  tamano_oz: ['info', 'Tamaño en onzas', 'Se convirtió a ml (3.4 oz → 100 ml).'],
  sin_descripcion: ['info', 'Sin descripción', 'La ficha del producto saldrá sin texto.'],
  agrupado: ['info', 'Productos agrupados por tamaño', 'Productos simples con el mismo nombre se unieron en uno con varios tamaños.'],
  borrador: ['info', 'No publicado en WooCommerce', 'Se importa oculto.'],
  tipo_omitido: ['info', 'Tipo de producto omitido', 'Los productos externos o agrupados no tienen stock propio.'],
};

const ATTR_SIZE = /(tama|size|ml|volumen|presentaci|contenido)/;
const ATTR_BRAND = /^(marca|brand|fabricante)$/;
const ATTR_FAMILY = /(familia|olfativ|family|fragancia)/;
const ATTR_NOTES = /(notas|notes|acordes)/;

const attrOf = (attrs, re) => {
  for (const [k, v] of Object.entries(attrs || {})) if (re.test(norm(k)) && v?.length) return v;
  return null;
};

export function buildPlan(rawItems, { unknownStock = 0, skuPrefix = 'W' } = {}) {
  const issues = new Map();
  const note = (code, it, detail = '') => {
    const e = issues.get(code) || { code, level: ISSUES[code][0], label: ISSUES[code][1], help: ISSUES[code][2], count: 0, samples: [] };
    e.count++;
    if (e.samples.length < 500) e.samples.push({ row: it.row, sku: it.sku || '', name: it.name || '', detail });
    issues.set(code, e);
  };

  // Un ID repetido en el archivo chocaría con el índice único: se conserva la primera fila.
  const seenId = new Set();
  const items = rawItems.filter((it) => {
    if (!it.id) return true;
    if (!seenId.has(it.id)) { seenId.add(it.id); return true; }
    note('id_duplicado', it, `ID ${it.id}`);
    return false;
  });
  const byId = new Map();
  const byKey = new Map();
  for (const it of items) {
    if (it.id) byId.set(it.id, it);
    if (it.sku) byKey.set(it.sku, it);
  }
  const parentOf = (it) => {
    if (!it.parent) return null;
    const ref = it.parent.replace(/^id:/i, '');
    return byId.get(ref) || byKey.get(ref) || null;
  };
  const isVariation = (it) => it.type === 'variation' || (!!it.parent && it.type !== 'variable');
  const variations = new Map();
  for (const it of items) {
    if (!isVariation(it)) continue;
    const p = parentOf(it);
    if (p) (variations.get(p) ?? variations.set(p, []).get(p)).push(it);
    else note('tipo_omitido', it, 'variación sin producto padre');
  }

  const seenSku = new Set();
  const uniqueSku = (it, fallback) => {
    let sku = (it.sku || '').trim();
    if (!sku) { sku = `${skuPrefix}-${fallback}`; note('sin_sku', it, sku); }
    let out = sku;
    for (let n = 2; seenSku.has(out.toLowerCase()); n++) out = `${sku}-${n}`;
    if (out !== sku) note('sku_duplicado', it, `${sku} → ${out}`);
    seenSku.add(out.toLowerCase());
    return out;
  };

  // Variante a partir de un elemento Woo (simple o variación).
  const variantOf = (it, ext, size, fallbackId) => {
    const regular = parseMoney(it.regular);
    const sale = parseMoney(it.sale);
    let price = regular;
    let compare = null;
    if (sale !== null && sale > 0) {
      if (regular !== null && regular > 0 && sale < regular) { price = sale; compare = regular; }
      else if (regular === null || regular <= 0) price = sale;
      else note('oferta_invalida', it, `normal ${regular} · oferta ${sale}`);
    }
    let active = true;
    if (price === null || price <= 0) { price = 0; active = false; note('sin_precio', it); }
    let stock = 0;
    const raw = String(it.stock ?? '').trim();
    const known = raw !== '';
    if (raw === '') {
      if (String(it.instock) !== '') note('stock_desconocido', it, `¿En stock?: ${it.instock}`);
      stock = Number(unknownStock) || 0;
    } else {
      const n = Number(raw.replace(',', '.'));
      if (!Number.isFinite(n)) { note('stock_invalido', it, raw); }
      else if (n < 0) note('stock_negativo', it, raw);
      else stock = Math.floor(n);
    }
    return { external_id: ext, sku: uniqueSku(it, fallbackId || it.id || it.row), size_ml: size?.ml ?? 0, price, compare_at: compare, stock, known, active, _it: it };
  };

  const baseOf = (it, parent) => {
    const src = parent || it;
    const cats = it.categories.length ? it.categories : src.categories;
    const brandAttr = attrOf(src.attrs, ATTR_BRAND);
    const brand = (src.brands[0] || brandAttr?.[0] || '').trim();
    const catText = cats.join(' ');
    let category = classify(RULES_CATEGORY, catText) || classify(RULES_CATEGORY, src.tags.join(' '));
    if (!category) category = classify(RULES_CATEGORY, src.name);
    const kind = classify(RULES_KIND, catText, src.tags.join(' '), src.name) || 'Perfume';
    const published = String(src.published).trim();
    const hidden = published === '0' || published === '-1' || /hidden|oculto|search/.test(src.visibility || '');
    return {
      brand,
      category: category || UNCLASSIFIED,
      subcategory: category === 'Infantil' ? (/\b(nina|ninas)\b/.test(norm(catText + ' ' + src.name)) ? 'Niñas' : /\b(nino|ninos)\b/.test(norm(catText + ' ' + src.name)) ? 'Niños' : null) : null,
      kind,
      family: (attrOf(src.attrs, ATTR_FAMILY)?.[0] || '').slice(0, 40),
      notes: (attrOf(src.attrs, ATTR_NOTES) || []).join(', ').slice(0, 160),
      description: stripHtml(src.description || src.short).slice(0, 1200),
      image: src.image || '',
      permalink: src.permalink || '',
      is_new: src.tags.some((t) => /^(nuevo|nueva|new|novedad|novedades)$/.test(norm(t))) || cats.some((c) => /novedad|new arrival/.test(norm(c))),
      active: !hidden,
      hiddenWhy: published === '0' || published === '-1' ? 'borrador' : hidden ? 'oculto' : '',
    };
  };

  const products = [];
  const singles = []; // productos simples candidatos a agruparse por nombre

  for (const it of items) {
    if (isVariation(it)) continue;
    if (!it.name) { note('nombre_vacio', it); continue; }
    if (!['simple', 'variable'].includes(it.type)) { note('tipo_omitido', it, it.type); continue; }
    const base = baseOf(it, null);
    if (base.hiddenWhy === 'borrador') note('borrador', it);

    if (it.type === 'variable') {
      const vars = variations.get(it) || [];
      if (!vars.length) { note('variable_sin_variaciones', it); continue; }
      const sizeAttr = Object.entries(it.attrs).find(([k]) => ATTR_SIZE.test(norm(k)));
      const variants = [];
      for (const v of vars) {
        const raw = attrOf(v.attrs, ATTR_SIZE)?.[0] ?? sizeAttr?.[1]?.[0];
        const size = (raw && sizeFromAttr(raw)) || parseSize(v.name);
        if (size?.oz) note('tamano_oz', v, size.text);
        if (!size) note('sin_tamano', v);
        const ext = `${it.id}:${v.id}`;
        variants.push(variantOf(v, ext, size, v.id));
      }
      products.push(finish({ ...base, name: stripSize(it.name, null), external_id: it.id, variants, _it: it }));
    } else {
      const size = parseSize(it.name);
      if (size?.oz) note('tamano_oz', it, size.text);
      if (!size) note('sin_tamano', it);
      singles.push({ it, base, size, name: stripSize(it.name, size), variant: variantOf(it, it.id, size, it.id) });
    }
  }

  // Productos simples con el mismo nombre y marca → un producto con varios tamaños.
  const groups = new Map();
  for (const s of singles) {
    const key = `${norm(s.name)}|${norm(s.base.brand)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(s);
  }
  for (const list of groups.values()) {
    const bins = []; // cada contenedor no repite tamaño
    for (const s of list) {
      const bin = bins.find((b) => !b.some((x) => x.variant.size_ml === s.variant.size_ml));
      if (bin) bin.push(s);
      else {
        if (bins.length) note('duplicado_probable', s.it, `${s.name} ${s.variant.size_ml || 'único'}`);
        bins.push([s]);
      }
    }
    for (const bin of bins) {
      const head = bin[0];
      if (bin.length > 1) note('agrupado', head.it, `${bin.length} tamaños: ${bin.map((b) => b.variant.size_ml || 'único').join(', ')}`);
      products.push(finish({ ...head.base, name: head.name, external_id: head.it.id, variants: bin.map((b) => b.variant), _it: head.it }));
    }
  }

  function finish(p) {
    if (!p.brand) note('sin_marca', p._it);
    if (p.category === UNCLASSIFIED) note('sin_categoria', p._it, p._it.categories.join(' > '));
    if (!p.image) note('sin_imagen', p._it);
    if (!p.description) note('sin_descripcion', p._it);
    return p;
  }

  const variants = products.reduce((n, p) => n + p.variants.length, 0);
  const pct = (n) => (products.length ? Math.round((n / products.length) * 100) : 0);
  const completeness = {
    marca: pct(products.filter((p) => p.brand).length),
    categoria: pct(products.filter((p) => p.category !== UNCLASSIFIED).length),
    foto: pct(products.filter((p) => p.image).length),
    precio: pct(products.filter((p) => p.variants.every((v) => v.price > 0)).length),
    inventario: pct(products.filter((p) => p.variants.every((v) => v.known)).length),
    descripcion: pct(products.filter((p) => p.description).length),
  };
  const overall = Math.round(Object.values(completeness).reduce((a, b) => a + b, 0) / Object.keys(completeness).length);

  const count = (key) => products.reduce((m, p) => ((m[p[key]] = (m[p[key]] || 0) + 1), m), {});
  const order = { error: 0, warn: 1, info: 2 };
  return {
    plan: { products },
    report: {
      records: rawItems.length,
      products: products.length,
      variants,
      inactive: products.filter((p) => !p.active).length,
      mapping: { categories: count('category'), kinds: count('kind') },
      completeness,
      score: overall,
      issues: [...issues.values()].sort((a, b) => order[a.level] - order[b.level] || b.count - a.count),
    },
  };
}

export const planFromCsv = (csv, opts) => buildPlan(fromCsv(parseCsv(csv)), opts);
export const planFromRest = (restItems, opts) => buildPlan(restItems, opts);

// ─── Aplicar el plan a la base ─────────────────────────────────────────────
// Compara con lo que ya hay: cuántos productos y variantes se crearían o se actualizarían.
export function previewApply(db, plan) {
  const byExt = db.prepare('SELECT id FROM variants WHERE external_id = ?');
  const bySku = db.prepare('SELECT id FROM variants WHERE sku = ? COLLATE NOCASE');
  const pExt = db.prepare('SELECT id FROM products WHERE external_id = ?');
  const r = { products: { create: 0, update: 0 }, variants: { create: 0, update: 0 } };
  for (const p of plan.products) {
    let exists = p.external_id && pExt.get(p.external_id);
    for (const v of p.variants) {
      const hit = (v.external_id && byExt.get(v.external_id)) || bySku.get(v.sku);
      r.variants[hit ? 'update' : 'create']++;
      if (hit) exists = true;
    }
    r.products[exists ? 'update' : 'create']++;
  }
  return r;
}

export function applyPlan(db, plan, { reason = 'Importación desde WooCommerce', updateStock = true } = {}) {
  const res = { products: { created: 0, updated: 0 }, variants: { created: 0, updated: 0 }, stock_adjusted: 0, units_in: 0 };
  return tx(db, () => {
    // El stock que llega viene de WooCommerce: no hay que devolvérselo (ver la bandeja de salida en woo-sync.js).
    db.prepare("INSERT INTO settings (key, value) VALUES ('woo_pause', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    const findProductByExt = db.prepare('SELECT id FROM products WHERE external_id = ?');
    const findVarByExt = db.prepare('SELECT id, product_id, stock FROM variants WHERE external_id = ?');
    const findVarBySku = db.prepare('SELECT id, product_id, stock FROM variants WHERE sku = ? COLLATE NOCASE');
    const current = db.prepare('SELECT * FROM products WHERE id = ?');
    const insertProduct = db.prepare(
      `INSERT INTO products (name, brand, category, subcategory, kind, family, notes, description, color, image, permalink, is_new, active, external_id, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`
    );
    const updateProduct = db.prepare(
      `UPDATE products SET name = ?, brand = ?, category = ?, subcategory = ?, kind = ?, family = ?, notes = ?, description = ?, image = ?, permalink = ?,
              is_new = ?, active = ?, external_id = COALESCE(external_id, ?) WHERE id = ?`
    );
    const setSearch = db.prepare('UPDATE products SET search_text = ? WHERE id = ?');
    const insertVar = db.prepare(
      `INSERT INTO variants (product_id, sku, size_ml, price, compare_at, cost, min_stock, reorder_qty, active, external_id) VALUES (?, ?, ?, ?, ?, 0, 3, 12, ?, ?)`
    );
    const updateVar = db.prepare('UPDATE variants SET price = ?, compare_at = ?, size_ml = ?, active = ?, external_id = COALESCE(external_id, ?) WHERE id = ?');
    const move = db.prepare('INSERT INTO stock_movements (variant_id, type, qty, reason) VALUES (?, ?, ?, ?)');
    const skuTaken = db.prepare('SELECT 1 FROM variants WHERE sku = ? COLLATE NOCASE');
    const palette = ['#c9a24b', '#a85a3a', '#8aa88a', '#c98aa0', '#7d6aa8', '#d4a84b', '#6a8aa8'];
    const safeImage = (u) => (/^https:\/\/[^\s"'<>]{4,500}$/.test(u || '') ? u : null);
    const safeLink = (u) => (/^https?:\/\/[^\s"'<>]{4,500}$/.test(u || '') ? u : null);
    const category = (c) => (CATEGORIES.includes(c) ? c : UNCLASSIFIED);

    plan.products.forEach((p, idx) => {
      const found = [];
      let pid = (p.external_id && findProductByExt.get(p.external_id)?.id) || null;
      for (const v of p.variants) {
        const hit = (v.external_id && findVarByExt.get(v.external_id)) || findVarBySku.get(v.sku);
        found.push(hit || null);
        if (!pid && hit) pid = hit.product_id;
      }
      if (pid) {
        // WooCommerce manda en los datos del catálogo, pero un dato que viene vacío no borra lo que ya hay aquí.
        const cur = current.get(pid);
        updateProduct.run(
          p.name, p.brand || cur.brand, p.category === UNCLASSIFIED ? cur.category : category(p.category), p.subcategory ?? cur.subcategory, p.kind,
          p.family || cur.family, p.notes || cur.notes, p.description || cur.description, safeImage(p.image) ?? cur.image, safeLink(p.permalink) ?? cur.permalink,
          p.is_new ? 1 : 0, p.active ? 1 : 0, p.external_id || null, pid
        );
        res.products.updated++;
      } else {
        const r = insertProduct.run(
          p.name, p.brand, category(p.category), p.subcategory, p.kind, p.family, p.notes, p.description, palette[idx % palette.length],
          safeImage(p.image), safeLink(p.permalink), p.is_new ? 1 : 0, p.active ? 1 : 0, p.external_id || null
        );
        pid = Number(r.lastInsertRowid);
        res.products.created++;
      }
      setSearch.run(searchText(current.get(pid)), pid);

      p.variants.forEach((v, i) => {
        const hit = found[i];
        if (hit) {
          updateVar.run(v.price, v.compare_at, v.size_ml, v.active ? 1 : 0, v.external_id || null, hit.id);
          res.variants.updated++;
          if (updateStock && v.known && v.stock !== hit.stock) {
            move.run(hit.id, 'ajuste', v.stock - hit.stock, 'Sincronización con WooCommerce');
            res.stock_adjusted++;
          }
        } else {
          let sku = v.sku;
          for (let n = 2; skuTaken.get(sku); n++) sku = `${v.sku}-${n}`;
          const r = insertVar.run(pid, sku, v.size_ml, v.price, v.compare_at, v.active ? 1 : 0, v.external_id || null);
          res.variants.created++;
          if (v.stock > 0) {
            move.run(Number(r.lastInsertRowid), 'entrada', v.stock, reason);
            res.units_in += v.stock;
          }
        }
      });
    });
    db.prepare("DELETE FROM settings WHERE key = 'woo_pause'").run();
    bumpCatalog(db);
    return res;
  });
}
