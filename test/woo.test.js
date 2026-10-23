// WooCommerce: importación por CSV con informe de calidad, lectura por API, envío de stock y webhooks firmados.
// El "WooCommerce" de estas pruebas es un servidor falso local: nunca se toca una tienda real.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.js';
import { parseCsv, decodeCsv, parseMoney, parseSize, stripHtml, planFromCsv } from '../woo-import.js';
import { createWooClient, flushOutbox, pullCatalog, verifySignature } from '../woo-sync.js';
import { openDb } from '../db.js';

const SAMPLE = readFileSync(new URL('../public/samples/woocommerce-export-demo.csv', import.meta.url));
const KEY = 'ck_test';
const SECRET = 'cs_test';

// ─── WooCommerce falso ─────────────────────────────────────────────────────
function mockWoo() {
  const state = {
    puts: [],
    failNext: 0,
    products: [
      { id: 11, type: 'simple', status: 'publish', name: 'Noche de Jazmín 50ml', sku: 'NJ-50', regular_price: '62', sale_price: '', manage_stock: true, stock_quantity: 14, stock_status: 'instock', categories: [{ name: 'Damas' }], tags: [{ name: 'Nuevo' }], attributes: [{ name: 'Marca', options: ['Maison Ébène'] }], images: [{ src: 'https://cdn.example.com/nj50.jpg' }], permalink: 'https://tienda.example.com/producto/noche-de-jazmin-50/', description: '<p>Jazmín y <b>ámbar</b></p>', short_description: '' },
      { id: 12, type: 'simple', status: 'publish', name: 'Noche de Jazmín 100ml', sku: 'NJ-100', regular_price: '98', sale_price: '', manage_stock: true, stock_quantity: 9, stock_status: 'instock', categories: [{ name: 'Damas' }], tags: [], attributes: [{ name: 'Marca', options: ['Maison Ébène'] }], images: [], permalink: 'https://tienda.example.com/producto/noche-de-jazmin-100/', description: '', short_description: '' },
      { id: 20, type: 'variable', status: 'publish', name: 'Cedro & Cuero', sku: '', regular_price: '', sale_price: '', manage_stock: false, stock_quantity: null, stock_status: 'instock', categories: [{ name: 'Caballeros' }], tags: [], attributes: [{ name: 'Marca', options: ['Atelier Sol'] }, { name: 'Tamaño', options: ['50 ml', '100 ml'] }], images: [], permalink: 'https://tienda.example.com/producto/cedro-cuero/', description: 'Cedro', short_description: '' },
      { id: 30, type: 'simple', status: 'publish', name: 'Vela aromática', sku: 'VE-1', regular_price: '28', sale_price: '', manage_stock: false, stock_quantity: null, stock_status: 'instock', categories: [{ name: 'Accesorios' }], tags: [], attributes: [], images: [], permalink: '', description: '', short_description: '' },
    ],
    variations: {
      20: [
        { id: 201, sku: 'CC-50', regular_price: '72', sale_price: '', manage_stock: true, stock_quantity: 12, stock_status: 'instock', attributes: [{ name: 'Tamaño', option: '50 ml' }] },
        { id: 202, sku: 'CC-100', regular_price: '118', sale_price: '95', manage_stock: true, stock_quantity: 5, stock_status: 'instock', attributes: [{ name: 'Tamaño', option: '100 ml' }] },
      ],
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.searchParams.get('consumer_key') !== KEY || url.searchParams.get('consumer_secret') !== SECRET) return json(401, { code: 'woocommerce_rest_cannot_view', message: 'Clave no válida' });
    let m;
    if (req.method === 'GET' && url.pathname === '/wp-json/wc/v3/products') {
      const per = Number(url.searchParams.get('per_page') || 10);
      const page = Number(url.searchParams.get('page') || 1);
      return json(200, state.products.slice((page - 1) * per, page * per), { 'X-WP-Total': String(state.products.length), 'X-WP-TotalPages': String(Math.ceil(state.products.length / per)) });
    }
    if (req.method === 'GET' && (m = /^\/wp-json\/wc\/v3\/products\/(\d+)\/variations$/.exec(url.pathname))) {
      const list = state.variations[m[1]] || [];
      return json(200, list, { 'X-WP-Total': String(list.length), 'X-WP-TotalPages': '1' });
    }
    if (req.method === 'PUT' && (m = /^\/wp-json\/wc\/v3\/products\/(\d+)(?:\/variations\/(\d+))?$/.exec(url.pathname))) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (state.failNext > 0) { state.failNext--; return json(500, { message: 'Error de prueba' }); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        state.puts.push({ product: Number(m[1]), variation: m[2] ? Number(m[2]) : null, ...body });
        json(200, { id: Number(m[2] || m[1]), ...body });
      });
      return;
    }
    json(404, { message: 'No existe' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

// ─── Utilidades ────────────────────────────────────────────────────────────
async function startApp(wooOpts = {}, password = 'pw') {
  const app = createApp({ dbPath: ':memory:', password, chatFactory: () => ({ enabled: false, reason: 'apagado' }), woo: wooOpts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const token = (await (await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })).json()).token;
  const call = async (path, { method = 'GET', body, raw, headers = {}, auth = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { app, base, call };
}
const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64');
const hook = (ctx, topic, payload, { secret = 'whsec', delivery, signature } = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return ctx.call('/api/woo/webhook', {
    method: 'POST', auth: false, raw: body,
    headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': topic, 'X-WC-Webhook-Delivery-ID': delivery ?? `d-${Math.random()}`, 'X-WC-Webhook-Signature': signature ?? sign(body, secret) },
  });
};
const q1 = (db, sql, ...a) => db.prepare(sql).get(...a);

// ─── CSV y utilidades de texto ─────────────────────────────────────────────
describe('lector de CSV', () => {
  test('comillas, comillas dobles, saltos de línea dentro de un campo y BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","di ""hola""","línea 1\nlínea 2"\r\n1,2,3\r\n');
    assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'di "hola"', 'línea 1\nlínea 2'], ['1', '2', '3']]);
  });
  test('detecta el delimitador ; y tabulador, e ignora filas vacías', () => {
    assert.deepEqual(parseCsv('a;b\n1;2\n\n3;4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  });
  test('un archivo guardado desde Excel en Windows-1252 conserva las tildes', () => {
    const latin = Buffer.from('Nombre\nÁmbar Nocturno\n', 'latin1');
    assert.equal(decodeCsv(latin), 'Nombre\nÁmbar Nocturno\n');
    assert.equal(decodeCsv(Buffer.from('﻿Nombre\nÁmbar', 'utf8')), 'Nombre\nÁmbar');
  });
  test('precios con coma o punto, tamaños en ml y onzas, HTML fuera', () => {
    assert.equal(parseMoney('49.99'), 49.99);
    assert.equal(parseMoney('1.234,56'), 1234.56);
    assert.equal(parseMoney('$ 1,234.50'), 1234.5);
    assert.equal(parseMoney(''), null);
    assert.equal(parseSize('Acqua 100ml').ml, 100);
    assert.equal(parseSize('Acqua 3.4 oz').ml, 100);
    assert.equal(parseSize('Acqua 1.7 fl oz').ml, 50);
    assert.equal(parseSize('212 VIP Men'), null, 'un número suelto no es un tamaño');
    assert.equal(stripHtml('<p>Jazmín &amp; <b>ámbar</b></p><br>fin'), 'Jazmín & ámbar fin');
  });
  test('un archivo que no es de WooCommerce da un error claro', () => {
    assert.throws(() => planFromCsv('foo,bar\n1,2'), /Nombre/);
    assert.throws(() => planFromCsv('Nombre'), /filas/);
  });
});

// ─── Plan e informe de calidad ─────────────────────────────────────────────
describe('importación del CSV de WooCommerce (informe de calidad)', () => {
  const { plan, report } = planFromCsv(decodeCsv(SAMPLE));
  const issue = (code) => report.issues.find((i) => i.code === code);

  test('cuenta registros, productos y variantes y agrupa los tamaños sueltos', () => {
    assert.equal(report.records, 43);
    assert.equal(report.products, 28);
    assert.equal(report.variants, 36);
    const jazmin = plan.products.find((p) => p.name === 'Noche de Jazmín');
    assert.deepEqual(jazmin.variants.map((v) => v.size_ml).sort((a, b) => a - b), [30, 50, 100]);
    assert.equal(issue('agrupado').count, 4);
  });
  test('clasifica categoría, tipo y marca; lo dudoso queda "Sin clasificar"', () => {
    const by = (n) => plan.products.find((p) => p.name === n);
    assert.equal(by('Cedro & Cuero').category, 'Caballeros');
    assert.equal(by('Medianoche Negro').category, 'Caballeros', '"Hombre" también es caballero');
    assert.equal(by('Gotas de Luna').category, 'Infantil');
    assert.equal(by('Gotas de Luna').subcategory, 'Niñas');
    assert.equal(by('Aventura Marina').subcategory, 'Niños');
    assert.equal(by('Estuche Rosa Imperial').kind, 'Estuche');
    assert.equal(by('Set Vetiver Real + miniatura').kind, 'Estuche');
    assert.equal(by('Tester Rosa Imperial').kind, 'Tester');
    assert.equal(by('Oud Majestad').category, 'Unisex');
    assert.equal(by('Neceser de viaje').category, 'Sin clasificar');
    assert.equal(by('Cedro & Cuero').brand, 'Atelier Sol');
    assert.equal(by('Noche de Jazmín').is_new, true, 'la etiqueta "Nuevo" marca la novedad');
    assert.equal(report.mapping.categories['Sin clasificar'], 4);
  });
  test('variaciones: tamaño desde el atributo, precios y ofertas', () => {
    const c = plan.products.find((p) => p.name === 'Cedro & Cuero');
    assert.deepEqual(c.variants.map((v) => [v.size_ml, v.price, v.compare_at, v.stock, v.external_id]), [[50, 72, null, 12, '2001:2002'], [100, 95, 118, 5, '2001:2003']]);
  });
  test('onzas convertidas a ml; sin tamaño = tamaño único', () => {
    assert.equal(plan.products.find((p) => p.name === 'Brisa Marina').variants[0].size_ml, 100);
    assert.equal(plan.products.find((p) => p.name === 'Vela aromática').variants[0].size_ml, 0);
  });
  test('detecta cada problema de datos con su cantidad', () => {
    const counts = Object.fromEntries(report.issues.map((i) => [i.code, i.count]));
    assert.equal(counts.sin_precio, 2);
    assert.equal(counts.nombre_vacio, 1);
    assert.equal(counts.sku_duplicado, 1);
    assert.equal(counts.id_duplicado, 1);
    assert.equal(counts.sin_sku, 2);
    assert.equal(counts.oferta_invalida, 1);
    assert.equal(counts.sin_categoria, 4);
    assert.equal(counts.sin_marca, 6);
    assert.equal(counts.stock_negativo, 1);
    assert.equal(counts.stock_invalido, 1);
    assert.equal(counts.stock_desconocido, 2);
    assert.equal(counts.variable_sin_variaciones, 1);
    assert.equal(counts.tipo_omitido, 2);
    assert.equal(counts.borrador, 2);
    assert.equal(counts.tamano_oz, 1);
    assert.equal(counts.duplicado_probable, undefined, 'tamaños distintos no son duplicados');
    for (const i of report.issues) assert.ok(i.samples.length && i.samples[0].row > 1, `${i.code} trae ejemplos con su fila`);
    assert.deepEqual(report.issues.map((i) => i.level), [...report.issues.map((i) => i.level)].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b]), 'errores primero');
  });
  test('sin precio: se importa oculto para la venta, nunca a $0; oferta inválida usa el precio normal', () => {
    const citrus = plan.products.find((p) => p.name === 'Citrus Solar').variants[0];
    assert.deepEqual([citrus.price, citrus.active], [0, false]);
    const cereza = plan.products.find((p) => p.name === 'Cereza Noir').variants[0];
    assert.deepEqual([cereza.price, cereza.compare_at], [80, null]);
  });
  test('stock raro: negativo y texto quedan en 0, sin inventario no se inventa stock', () => {
    const v = (n) => plan.products.find((p) => p.name === n).variants[0];
    assert.equal(v('Madera Real').stock, 0);
    assert.equal(v('Seda de Oriente').stock, 0);
    assert.equal(v('Brisa Cítrica').stock, 0);
    assert.equal(v('Brisa Cítrica').known, false);
  });
  test('mismo ID repetido: gana la primera fila; SKU repetido recibe sufijo', () => {
    assert.ok(!plan.products.some((p) => p.name === 'Fila con ID repetido'));
    const skus = plan.products.flatMap((p) => p.variants.map((v) => v.sku));
    assert.equal(new Set(skus.map((s) => s.toLowerCase())).size, skus.length, 'todos los SKU son únicos');
    assert.ok(skus.includes('PF-1001-2'));
  });
  test('la salud del catálogo resume la completitud de los datos', () => {
    assert.ok(report.score > 40 && report.score < 90);
    assert.equal(report.completeness.foto, 0);
    assert.ok(report.completeness.categoria > 80 && report.completeness.categoria < 100);
  });
  test('también entiende los encabezados en inglés', () => {
    const en = 'ID,Type,SKU,Name,Published,In stock?,Stock,Sale price,Regular price,Categories,Images\n5,simple,EN-1,Rose 50ml,1,1,4,,30,Perfumes > Women,\n';
    const r = planFromCsv(en);
    assert.equal(r.plan.products[0].category, 'Damas');
    assert.equal(r.plan.products[0].variants[0].stock, 4);
  });
});

// ─── Aplicar el CSV (por la API del panel) ─────────────────────────────────
describe('importar el CSV al inventario', () => {
  let ctx;
  let purchases0;
  before(async () => { ctx = await startApp(); purchases0 = q1(ctx.app.db, 'SELECT COUNT(*) n FROM purchases').n; });
  after(() => ctx.app.server.close());
  const csv = () => ({ method: 'POST', raw: SAMPLE, headers: { 'Content-Type': 'text/csv' } });

  test('exige sesión y un archivo', async () => {
    assert.equal((await ctx.call('/api/admin/woo/preview', { ...csv(), auth: false })).status, 401);
    assert.equal((await ctx.call('/api/admin/woo/preview', { method: 'POST', raw: Buffer.alloc(0), headers: { 'Content-Type': 'text/csv' } })).status, 400);
  });
  test('la vista previa no escribe nada y dice cuánto se crearía', async () => {
    const before = q1(ctx.app.db, 'SELECT COUNT(*) n FROM products').n;
    const r = await ctx.call('/api/admin/woo/preview', csv());
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.preview.products, { create: 28, update: 0 });
    assert.equal(r.data.report.products, 28);
    assert.equal(q1(ctx.app.db, 'SELECT COUNT(*) n FROM products').n, before);
  });
  test('importar crea productos, variantes y el stock inicial como entradas', async () => {
    const r = await ctx.call('/api/admin/woo/import', csv());
    assert.equal(r.status, 200);
    assert.equal(r.data.applied.products.created, 28);
    assert.equal(r.data.applied.variants.created, 36);
    const db = ctx.app.db;
    const jazmin = q1(db, "SELECT id, brand, category, kind, is_new, external_id FROM products WHERE name = 'Noche de Jazmín' AND external_id = '1001'");
    assert.deepEqual([jazmin.brand, jazmin.category, jazmin.kind, jazmin.is_new, jazmin.external_id], ['Maison Ébène', 'Damas', 'Perfume', 1, '1001']);
    const v = db.prepare('SELECT sku, size_ml, price, stock, external_id FROM variants WHERE product_id = ? ORDER BY size_ml').all(jazmin.id);
    assert.deepEqual(v.map((x) => [x.sku, x.size_ml, x.price, x.stock]), [['PF-1001-2', 30, 42, 4], ['PF-1001', 50, 62, 14], ['PF-1002', 100, 98, 9]]);
    const mov = q1(db, "SELECT COUNT(*) n, SUM(qty) q FROM stock_movements WHERE reason LIKE 'Importación desde WooCommerce%'");
    assert.equal(mov.q, r.data.applied.units_in);
    assert.equal(q1(db, "SELECT COUNT(*) n FROM variants WHERE sku = 'CC-100' AND compare_at = 118 AND price = 95").n, 1);
    assert.equal(q1(db, "SELECT active FROM variants WHERE sku = 'SP-4004'").active, 0, 'sin precio: no se vende');
    assert.equal(q1(db, "SELECT active FROM products WHERE name = 'Colección Otoño'").active, 0, 'borrador: oculto');
    assert.equal(q1(db, "SELECT COUNT(*) n FROM products WHERE category = 'Sin clasificar'").n, 4);
    assert.equal(q1(db, "SELECT COUNT(*) n FROM products WHERE search_text = ''").n, 0, 'los importados se pueden buscar');
  });
  test('los productos importados aparecen en la tienda, con búsqueda y filtros', async () => {
    const r = await ctx.call('/api/products?q=cedro+cuero&limit=5', { auth: false });
    assert.equal(r.data.products[0].name, 'Cedro & Cuero');
    const kids = await ctx.call('/api/products?category=Infantil&limit=60', { auth: false });
    assert.ok(kids.data.products.some((p) => p.name === 'Gotas de Luna'));
  });
  test('reimportar el mismo archivo no duplica nada ni mueve el stock', async () => {
    const db = ctx.app.db;
    const counts = () => [q1(db, 'SELECT COUNT(*) n FROM products').n, q1(db, 'SELECT COUNT(*) n FROM variants').n, q1(db, 'SELECT COUNT(*) n FROM stock_movements').n];
    const before = counts();
    const prev = await ctx.call('/api/admin/woo/preview', csv());
    assert.deepEqual(prev.data.preview.products, { create: 0, update: 28 });
    const r = await ctx.call('/api/admin/woo/import', csv());
    assert.equal(r.data.applied.products.created, 0);
    assert.equal(r.data.applied.stock_adjusted, 0);
    assert.deepEqual(counts(), before);
  });
  test('un stock distinto en WooCommerce se refleja como un ajuste con motivo, y se puede desactivar', async () => {
    const db = ctx.app.db;
    const changed = Buffer.from(SAMPLE.toString('utf8').replace(',1,14,,62,Perfumes > Damas,Nuevo', ',1,20,,62,Perfumes > Damas,Nuevo'));
    assert.notEqual(changed.toString(), SAMPLE.toString(), 'el reemplazo de prueba aplicó');
    const keep = await ctx.call('/api/admin/woo/import?update_stock=0', { method: 'POST', raw: changed, headers: { 'Content-Type': 'text/csv' } });
    assert.equal(keep.data.applied.stock_adjusted, 0);
    assert.equal(q1(db, "SELECT stock FROM variants WHERE sku = 'PF-1001'").stock, 14);
    const r = await ctx.call('/api/admin/woo/import?update_stock=1', { method: 'POST', raw: changed, headers: { 'Content-Type': 'text/csv' } });
    assert.equal(r.data.applied.stock_adjusted, 1);
    assert.equal(q1(db, "SELECT stock FROM variants WHERE sku = 'PF-1001'").stock, 20);
    const m = q1(db, "SELECT type, qty, reason FROM stock_movements WHERE variant_id = (SELECT id FROM variants WHERE sku = 'PF-1001') ORDER BY id DESC LIMIT 1");
    assert.deepEqual([m.type, m.qty, m.reason], ['ajuste', 6, 'Sincronización con WooCommerce']);
  });
  test('importar no genera cientos de órdenes de compra automáticas', async () => {
    assert.equal(q1(ctx.app.db, 'SELECT COUNT(*) n FROM purchases').n, purchases0, 'las compras que ya existían, y ninguna nueva');
  });
});

// ─── API REST de WooCommerce (servidor falso) ──────────────────────────────
describe('lectura del catálogo por la API REST', () => {
  let woo;
  before(async () => { woo = await mockWoo(); });
  after(() => woo.server.close());
  const client = (over = {}) => createWooClient({ url: woo.url, key: KEY, secret: SECRET, ...over });

  test('clave incorrecta: error claro, sin filtrar nada', async () => {
    await assert.rejects(() => client({ secret: 'mal' }).ping(), (e) => e.status === 502 && /401/.test(e.message) && /clave/i.test(e.message));
  });
  test('un servidor caído da un error entendible', async () => {
    await assert.rejects(() => createWooClient({ url: 'http://127.0.0.1:1', key: KEY, secret: SECRET, timeoutMs: 800 }).ping(), (e) => e.status === 502 && /No pude conectar/.test(e.message));
  });
  test('descarga productos y variaciones y los guarda con sus enlaces', async () => {
    const db = openDb(':memory:');
    const progress = [];
    const r = await pullCatalog(db, client(), { progress: (p) => progress.push(p.phase) });
    assert.deepEqual(progress.filter((x, i, a) => a.indexOf(x) === i), ['leyendo', 'analizando', 'guardando']);
    assert.equal(r.applied.products.created, 3, 'los dos "Noche de Jazmín" se agrupan');
    const rows = db.prepare('SELECT v.sku, v.size_ml, v.price, v.compare_at, v.stock, v.external_id, p.name, p.brand, p.permalink, p.image, p.category FROM variants v JOIN products p ON p.id = v.product_id ORDER BY v.sku').all();
    const by = Object.fromEntries(rows.map((x) => [x.sku, x]));
    assert.equal(by['NJ-50'].external_id, '11');
    assert.equal(by['NJ-50'].image, 'https://cdn.example.com/nj50.jpg');
    assert.equal(by['NJ-50'].permalink, 'https://tienda.example.com/producto/noche-de-jazmin-50/');
    assert.deepEqual([by['CC-100'].external_id, by['CC-100'].price, by['CC-100'].compare_at, by['CC-100'].stock, by['CC-100'].size_ml], ['20:202', 95, 118, 5, 100]);
    assert.equal(by['VE-1'].stock, 0, 'sin control de inventario: no se inventa stock');
    assert.equal(by['VE-1'].category, 'Sin clasificar');
    assert.ok(r.report.issues.some((i) => i.code === 'stock_desconocido'));
  });
  test('la vista previa (dry run) no escribe', async () => {
    const db = openDb(':memory:');
    const r = await pullCatalog(db, client(), { apply: false });
    assert.equal(r.preview.products.create, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
  });
});

// ─── Envío de stock a WooCommerce ──────────────────────────────────────────
describe('stock hacia WooCommerce (bandeja de salida)', () => {
  let woo, ctx, client;
  before(async () => {
    woo = await mockWoo();
    client = createWooClient({ url: woo.url, key: KEY, secret: SECRET });
    ctx = await startApp({ url: woo.url, key: KEY, secret: SECRET, push: true, client });
    await pullCatalog(ctx.app.db, client, { updateStock: false });
  });
  after(() => { ctx.app.server.close(); woo.server.close(); });

  const sell = (sku, qty) => {
    const v = q1(ctx.app.db, 'SELECT id FROM variants WHERE sku = ?', sku);
    return ctx.call('/api/admin/pos/orders', { method: 'POST', body: { customer: { name: 'Mostrador' }, payment_method: 'efectivo', items: [{ variant_id: v.id, qty }] } });
  };

  test('traer el catálogo no encola envíos (el stock vino de WooCommerce)', () => {
    assert.equal(q1(ctx.app.db, 'SELECT COUNT(*) n FROM woo_outbox').n, 0);
  });
  test('una venta en el mostrador encola el stock nuevo y se envía a la variante correcta', async () => {
    assert.equal((await sell('CC-50', 2)).status, 201);
    const row = q1(ctx.app.db, "SELECT o.stock FROM woo_outbox o JOIN variants v ON v.id = o.variant_id WHERE v.sku = 'CC-50'");
    assert.equal(row.stock, 10);
    const r = await ctx.call('/api/admin/woo/flush', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.sent, 1);
    assert.deepEqual(woo.state.puts.at(-1), { product: 20, variation: 201, manage_stock: true, stock_quantity: 10 });
    assert.equal(q1(ctx.app.db, 'SELECT COUNT(*) n FROM woo_outbox').n, 0);
  });
  test('un producto simple se actualiza en /products/:id', async () => {
    await sell('NJ-100', 1);
    await flushOutbox(ctx.app.db, client);
    assert.deepEqual(woo.state.puts.at(-1), { product: 12, variation: null, manage_stock: true, stock_quantity: 8 });
  });
  test('varias ventas seguidas envían solo el último valor', async () => {
    const puts = woo.state.puts.length;
    await sell('NJ-50', 1);
    await sell('NJ-50', 1);
    await sell('NJ-50', 1);
    assert.equal(q1(ctx.app.db, 'SELECT COUNT(*) n FROM woo_outbox').n, 1);
    await flushOutbox(ctx.app.db, client);
    assert.equal(woo.state.puts.length, puts + 1);
    assert.equal(woo.state.puts.at(-1).stock_quantity, 11);
  });
  test('si WooCommerce falla, se guarda el error y se reintenta; nada se pierde', async () => {
    await sell('CC-100', 1);
    woo.state.failNext = 1;
    const a = await flushOutbox(ctx.app.db, client);
    assert.deepEqual([a.sent, a.failed, a.pending], [0, 1, 1]);
    const row = q1(ctx.app.db, 'SELECT attempts, last_error FROM woo_outbox');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /500/);
    const b = await flushOutbox(ctx.app.db, client);
    assert.deepEqual([b.sent, b.failed, b.pending], [1, 0, 0]);
    assert.equal(woo.state.puts.at(-1).stock_quantity, 4);
  });
  test('un cambio de stock mientras se enviaba no se pierde', async () => {
    await sell('CC-100', 1);
    const slow = { updateStock: async () => { await sell('CC-100', 1); } }; // otra venta llega durante el envío
    await flushOutbox(ctx.app.db, slow);
    assert.equal(q1(ctx.app.db, 'SELECT stock FROM woo_outbox').stock, 2, 'queda pendiente el valor más nuevo');
  });
  test('con el envío activo, traer el catálogo no pisa el stock de este sistema', async () => {
    const before = q1(ctx.app.db, "SELECT stock FROM variants WHERE sku = 'NJ-50'").stock;
    woo.state.products[0].stock_quantity = 999;
    const r = await ctx.call('/api/admin/woo/sync', { method: 'POST', body: {} });
    assert.equal(r.status, 202);
    for (let i = 0; i < 50; i++) {
      const s = (await ctx.call('/api/admin/woo/status')).data;
      if (!s.job.running) { assert.equal(s.job.error, null); break; }
      await new Promise((ok) => setTimeout(ok, 40));
    }
    assert.equal(q1(ctx.app.db, "SELECT stock FROM variants WHERE sku = 'NJ-50'").stock, before);
  });
  test('el estado muestra la conexión, lo pendiente y los errores', async () => {
    const s = (await ctx.call('/api/admin/woo/status')).data;
    assert.equal(s.configured, true);
    assert.equal(s.push, true);
    assert.equal(s.host, new URL(woo.url).host);
    assert.ok(!JSON.stringify(s).includes(SECRET) && !JSON.stringify(s).includes(KEY), 'nunca expone las claves');
    assert.ok(s.linked.variants >= 5);
  });
});

// ─── Webhooks entrantes ────────────────────────────────────────────────────
describe('avisos de WooCommerce (webhook firmado)', () => {
  let woo, ctx, client;
  before(async () => {
    woo = await mockWoo();
    client = createWooClient({ url: woo.url, key: KEY, secret: SECRET });
    ctx = await startApp({ url: woo.url, key: KEY, secret: SECRET, webhookSecret: 'whsec', push: true, client });
    await pullCatalog(ctx.app.db, client, { updateStock: false });
  });
  after(() => { ctx.app.server.close(); woo.server.close(); });

  const stock = (sku) => q1(ctx.app.db, 'SELECT stock FROM variants WHERE sku = ?', sku).stock;
  const order = (id, status, items, extra = {}) => ({
    id, status, total: '0', date_created: '2026-10-21T10:30:00', payment_method: 'cod',
    billing: { first_name: 'Ana', last_name: 'Pérez', email: 'ana@example.com', phone: '+507 6000-1111', address_1: 'Calle 1', city: 'Panamá' },
    shipping_lines: [{ method_id: 'flat_rate' }],
    line_items: items, ...extra,
  });

  test('la firma se verifica con HMAC-SHA256 en tiempo constante', () => {
    const body = Buffer.from('{"a":1}');
    assert.equal(verifySignature(body, sign(body, 'k'), 'k'), true);
    assert.equal(verifySignature(body, sign(body, 'otra'), 'k'), false);
    assert.equal(verifySignature(body, '', 'k'), false);
    assert.equal(verifySignature(body, 'no-es-base64!!', 'k'), false);
    assert.equal(verifySignature(body, sign(body, 'k'), ''), false);
  });
  test('sin firma o con firma falsa se rechaza y no se toca el inventario', async () => {
    const before = stock('NJ-50');
    const body = order(500, 'processing', [{ product_id: 11, quantity: 1, name: 'x', total: '62' }]);
    const noSig = await ctx.call('/api/woo/webhook', { method: 'POST', auth: false, raw: JSON.stringify(body), headers: { 'X-WC-Webhook-Topic': 'order.created', 'Content-Type': 'application/json' } });
    assert.equal(noSig.status, 401);
    assert.equal((await hook(ctx, 'order.created', body, { signature: sign('otro cuerpo', 'whsec') })).status, 401);
    assert.equal((await hook(ctx, 'order.created', body, { secret: 'equivocado' })).status, 401);
    assert.equal(stock('NJ-50'), before);
  });
  test('el webhook no está disponible si no se configuró el secreto', async () => {
    const other = await startApp({});
    try {
      assert.equal((await hook(other, 'order.created', { id: 1 })).status, 503);
    } finally {
      other.app.server.close();
    }
  });
  test('el aviso de prueba (ping) responde sin hacer nada', async () => {
    const body = 'webhook_id=7';
    const r = await ctx.call('/api/woo/webhook', { method: 'POST', auth: false, raw: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-WC-Webhook-Signature': sign(body, 'whsec') } });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'pong');
  });
  test('un pedido nuevo descuenta el stock, crea el pedido y no se manda de vuelta a WooCommerce', async () => {
    const db = ctx.app.db;
    const before = stock('NJ-50');
    const body = order(501, 'processing', [{ product_id: 11, variation_id: 0, quantity: 2, name: 'Noche de Jazmín 50ml', sku: 'NJ-50', total: '124' }], { total: '124' });
    const r = await hook(ctx, 'order.created', body, { delivery: 'del-501' });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'descontado');
    assert.equal(stock('NJ-50'), before - 2);
    const o = q1(db, 'SELECT o.* FROM orders o JOIN woo_orders w ON w.order_id = o.id WHERE w.woo_order_id = ?', '501');
    assert.deepEqual([o.channel, o.customer_name, o.delivery, o.payment_method, o.status, o.total, o.created_at], ['online', 'Ana Pérez', 'envio', 'contra_entrega', 'pagado', 124, '2026-10-21 10:30:00']);
    assert.equal(q1(db, 'SELECT qty, unit_price FROM order_items WHERE order_id = ?', o.id).unit_price, 62);
    assert.equal(q1(db, "SELECT COUNT(*) n FROM stock_movements WHERE reason LIKE ?", `Venta #${o.id}%`).n, 1);
    assert.equal(q1(db, "SELECT COUNT(*) n FROM woo_outbox o JOIN variants v ON v.id = o.variant_id WHERE v.sku = 'NJ-50'").n, 0, 'WooCommerce ya descontó: no se le devuelve');
  });
  test('el mismo aviso dos veces solo descuenta una vez (idempotente)', async () => {
    const before = stock('NJ-100');
    const body = order(502, 'processing', [{ product_id: 12, quantity: 1, name: 'x', sku: 'NJ-100', total: '98' }]);
    assert.equal((await hook(ctx, 'order.created', body, { delivery: 'del-502' })).data.status, 'descontado');
    assert.equal((await hook(ctx, 'order.created', body, { delivery: 'del-502' })).data.status, 'duplicado');
    assert.equal((await hook(ctx, 'order.created', body, { delivery: 'del-502-b' })).data.status, 'ignorado', 'otro aviso del mismo pedido tampoco descuenta');
    assert.equal(stock('NJ-100'), before - 1);
  });
  test('una variación se enlaza por su id y un pedido pendiente aún no descuenta', async () => {
    const before = stock('CC-100');
    const pending = order(503, 'pending', [{ product_id: 20, variation_id: 202, quantity: 1, name: 'Cedro', total: '95' }]);
    assert.equal((await hook(ctx, 'order.created', pending)).data.status, 'ignorado');
    assert.equal(stock('CC-100'), before);
    const paid = order(503, 'processing', [{ product_id: 20, variation_id: 202, quantity: 1, name: 'Cedro', total: '95' }]);
    assert.equal((await hook(ctx, 'order.updated', paid)).data.status, 'descontado');
    assert.equal(stock('CC-100'), before - 1);
  });
  test('completado marca el pedido como entregado; cancelado devuelve el stock', async () => {
    const db = ctx.app.db;
    const before = stock('CC-50');
    const items = [{ product_id: 20, variation_id: 201, quantity: 3, name: 'Cedro', total: '216' }];
    await hook(ctx, 'order.created', order(504, 'processing', items));
    assert.equal(stock('CC-50'), before - 3);
    await hook(ctx, 'order.updated', order(504, 'cancelled', items));
    assert.equal(stock('CC-50'), before, 'el stock volvió');
    const o = q1(db, 'SELECT o.status FROM orders o JOIN woo_orders w ON w.order_id = o.id WHERE w.woo_order_id = ?', '504');
    assert.equal(o.status, 'cancelado');
    assert.equal((await hook(ctx, 'order.updated', order(504, 'cancelled', items))).data.status, 'ignorado', 'cancelar dos veces no devuelve dos veces');
    assert.equal(stock('CC-50'), before);

    const items2 = [{ product_id: 11, quantity: 1, name: 'x', sku: 'NJ-50', total: '62' }];
    await hook(ctx, 'order.created', order(505, 'processing', items2));
    assert.equal((await hook(ctx, 'order.updated', order(505, 'completed', items2))).data.status, 'actualizado');
    assert.equal(q1(db, 'SELECT o.status FROM orders o JOIN woo_orders w ON w.order_id = o.id WHERE w.woo_order_id = ?', '505').status, 'entregado');
  });
  test('si WooCommerce vendió más de lo que hay aquí, no queda stock negativo y se deja constancia', async () => {
    const have = stock('CC-100');
    const r = await hook(ctx, 'order.created', order(506, 'processing', [{ product_id: 20, variation_id: 202, quantity: have + 5, name: 'Cedro', total: '1' }, { product_id: 999, quantity: 1, name: 'Fantasma', total: '1' }]));
    assert.equal(r.data.status, 'descontado');
    assert.match(r.data.note, /Faltante/);
    assert.match(r.data.note, /Sin enlazar: Fantasma/);
    assert.equal(stock('CC-100'), 0);
  });
  test('un pedido sin productos conocidos no crea un pedido vacío', async () => {
    const r = await hook(ctx, 'order.created', order(507, 'processing', [{ product_id: 888, quantity: 1, name: 'Desconocido', total: '5' }]));
    assert.equal(r.data.status, 'sin_productos');
    assert.equal(q1(ctx.app.db, "SELECT COUNT(*) n FROM woo_orders WHERE woo_order_id = '507'").n, 0);
  });
  test('un producto actualizado en WooCommerce actualiza precio y datos, pero no el stock cuando este sistema manda', async () => {
    const before = stock('NJ-50');
    const changed = { ...woo.state.products[0], regular_price: '70', sale_price: '55', stock_quantity: 500, name: 'Noche de Jazmín 50ml' };
    const r = await hook(ctx, 'product.updated', changed);
    assert.equal(r.data.status, 'sincronizado');
    const v = q1(ctx.app.db, "SELECT price, compare_at, stock FROM variants WHERE sku = 'NJ-50'");
    assert.deepEqual([v.price, v.compare_at, v.stock], [55, 70, before]);
  });
  test('los avisos quedan registrados en el estado', async () => {
    const s = (await ctx.call('/api/admin/woo/status')).data;
    assert.ok(s.events.length >= 5);
    assert.ok(s.events.every((e) => e.topic && e.status));
  });
  test('un pedido de WooCommerce aparece en la lista de pedidos y en los movimientos del panel', async () => {
    const orders = (await ctx.call('/api/admin/orders')).data;
    assert.ok(orders.some((o) => o.customer_name === 'Ana Pérez'));
    const moves = (await ctx.call('/api/admin/movements?limit=50')).data;
    assert.ok(moves.some((m) => /^Venta #/.test(m.reason)));
  });
});

describe('sin WooCommerce configurado', () => {
  test('el panel lo dice y las acciones responden con una explicación', async () => {
    const ctx = await startApp({});
    try {
      const s = (await ctx.call('/api/admin/woo/status')).data;
      assert.equal(s.configured, false);
      assert.equal(s.host, null);
      for (const path of ['/api/admin/woo/test', '/api/admin/woo/sync', '/api/admin/woo/flush']) {
        const r = await ctx.call(path, { method: 'POST', body: {} });
        assert.equal(r.status, 409, path);
        assert.match(r.data.error, /WOO_URL/);
      }
    } finally {
      ctx.app.server.close();
    }
  });
});
