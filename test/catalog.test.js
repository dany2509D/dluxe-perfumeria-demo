// Catálogo, esquema y migración: filtros, paginación, conteos, relevancia, ofertas, marca y rendimiento a escala.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../db.js';
import { resetAndSeed, seedLarge } from '../seed.js';
import { queryProducts, facets, getProductsByIds, namesIndex, catalogSummary } from '../catalog.js';
import { createProduct, updateProduct, updateVariant, listInventory, listProductsAdmin, listBrands, createOrder, setOrderStatus } from '../service.js';
import { loadBrand, fillAbout } from '../brand.js';
import { pickPhoto, fillMissingPhotos } from '../photos.js';
import { existsSync } from 'node:fs';
import { createApp } from '../app.js';

const setup = () => {
  const db = openDb(':memory:');
  resetAndSeed(db);
  return db;
};
const names = (r) => r.products.map((p) => p.name);

describe('filtros del catálogo', () => {
  const db = setup();
  test('por categoría, tipo y marca', () => {
    assert.ok(queryProducts(db, { category: 'Infantil' }).products.every((p) => p.category === 'Infantil'));
    assert.ok(queryProducts(db, { kind: 'Estuche' }).products.every((p) => p.kind === 'Estuche'));
    assert.ok(queryProducts(db, { brand: 'Atelier Sol' }).products.every((p) => p.brand === 'Atelier Sol'));
    assert.equal(queryProducts(db, { category: 'Infantil', subcategory: 'Niñas' }).total, 2);
  });
  test('ofertas: precio tachado mayor al precio y porcentaje coherente', () => {
    const r = queryProducts(db, { onSale: true, sort: 'descuento' });
    assert.ok(r.total >= 5);
    for (const p of r.products) {
      assert.ok(p.on_sale && p.discount_pct > 0);
      const v = p.variants.find((x) => x.compare_at);
      assert.ok(v && v.compare_at > v.price, p.name);
    }
    const pcts = r.products.map((p) => p.discount_pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a), 'ordenadas por mayor descuento');
  });
  test('novedades', () => {
    const r = queryProducts(db, { isNew: true });
    assert.ok(r.total >= 3 && r.products.every((p) => p.is_new));
  });
  test('rango de precio: basta con que UN tamaño entre en el rango, sin falsear el "desde"', () => {
    const r = queryProducts(db, { maxPrice: 50 });
    assert.ok(r.total >= 3);
    for (const p of r.products) assert.ok(p.variants.some((v) => v.price <= 50));
    const all = queryProducts(db, { minPrice: 100, maxPrice: 200 });
    for (const p of all.products) assert.ok(p.variants.some((v) => v.price >= 100 && v.price <= 200));
  });
  test('solo con existencias', () => {
    const r = queryProducts(db, { inStock: true, limit: 60 });
    assert.ok(r.products.every((p) => p.total_stock > 0));
  });
  test('la búsqueda ignora acentos y mayúsculas, exige TODAS las palabras y busca por inicio de palabra', () => {
    assert.ok(names(queryProducts(db, { q: 'AMBAR nocturno' })).includes('Ámbar Nocturno'));
    assert.deepEqual(names(queryProducts(db, { q: 'estuche vetiver' })), ['Estuche Vetiver Real']);
    assert.equal(queryProducts(db, { q: 'edianoc' }).total, 0, 'un fragmento de mitad de palabra no coincide');
    assert.ok(queryProducts(db, { q: 'marin' }).total >= 1, 'el inicio de palabra sí');
  });
  test('la búsqueda ordena por relevancia (el nombre antes que las notas)', () => {
    assert.equal(queryProducts(db, { q: 'vainilla' }).products[0].name, 'Vainilla Dorada');
  });
  test('combinar filtros', () => {
    const r = queryProducts(db, { category: 'Damas', kind: 'Perfume', maxPrice: 80, inStock: true });
    assert.ok(r.products.every((p) => p.category === 'Damas' && p.kind === 'Perfume'));
  });
  test('un caracter especial de SQL en la búsqueda no rompe ni coincide con todo', () => {
    assert.equal(queryProducts(db, { q: '100%' }).total, 0);
    assert.equal(queryProducts(db, { q: "x'; DROP TABLE products;--" }).total, 0);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM products').get().n > 20);
  });
});

describe('paginación y conteos', () => {
  const db = setup();
  test('las páginas no se repiten ni se saltan productos y suman el total', () => {
    const first = queryProducts(db, { limit: 5 });
    const seen = new Set();
    for (let page = 1; page <= first.pages; page++) {
      for (const p of queryProducts(db, { limit: 5, page }).products) {
        assert.ok(!seen.has(p.id), `repetido en la página ${page}`);
        seen.add(p.id);
      }
    }
    assert.equal(seen.size, first.total);
  });
  test('por defecto son 25 productos por página', async () => {
    assert.equal(queryProducts(db, {}).limit, 25);
    assert.equal(queryProducts(db, {}).products.length, 25);
    assert.equal(queryProducts(db, {}).pages, Math.ceil(queryProducts(db, {}).total / 25));
    const app = createApp({ dbPath: ':memory:', chatFactory: () => ({ enabled: false, reason: 'apagado' }) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    try {
      const r = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/products`)).json();
      assert.deepEqual([r.limit, r.products.length], [25, 25]);
    } finally {
      app.server.close();
    }
  });
  test('una página fuera de rango devuelve vacío, no falla', () => {
    assert.deepEqual(queryProducts(db, { page: 999 }).products, []);
    assert.equal(queryProducts(db, { limit: 9999 }).limit, 60, 'el tamaño de página tiene tope');
  });
  test('los conteos de cada filtro coinciden con los resultados reales', () => {
    const f = facets(db, {});
    for (const c of f.categories) assert.equal(queryProducts(db, { category: c.value }).total, c.count, c.value);
    for (const k of f.kinds) assert.equal(queryProducts(db, { kind: k.value }).total, k.count, k.value);
    for (const b of f.brands) assert.equal(queryProducts(db, { brand: b.value }).total, b.count, b.value);
  });
  test('los conteos respetan los otros filtros (sin anularse a sí mismos)', () => {
    const f = facets(db, { category: 'Damas' });
    assert.ok(f.kinds.every((k) => queryProducts(db, { category: 'Damas', kind: k.value }).total === k.count));
    assert.ok(f.categories.length >= 3, 'al filtrar por categoría se siguen viendo las demás para poder cambiar');
  });
  test('los ordenamientos funcionan', () => {
    const asc = queryProducts(db, { sort: 'precio-asc', limit: 60 }).products.map((p) => p.min_price);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    const desc = queryProducts(db, { sort: 'precio-desc', limit: 60 }).products.map((p) => p.min_price);
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
    const nm = queryProducts(db, { sort: 'nombre', limit: 60 }).products.map((p) => p.name.toLowerCase());
    const normd = nm.map((x) => x.normalize('NFD').replace(/\p{Diacritic}/gu, ''));
    assert.deepEqual(normd, [...normd].sort(), 'orden alfabético sin que las tildes manden al final');
    assert.ok(nm.indexOf('ámbar nocturno') < nm.indexOf('vetiver real'), '"Ámbar" va con la A');
    assert.equal(queryProducts(db, { sort: 'inventado' }).total, queryProducts(db, {}).total, 'un orden desconocido usa el predeterminado');
  });
  test('"más vendidos" sigue las ventas reales y se mantiene al cancelar', () => {
    const db2 = setup();
    const top = queryProducts(db2, { limit: 1 }).products[0];
    const sold0 = top.sold;
    const v = db2.prepare('SELECT id FROM variants WHERE product_id = ? AND stock > 3 LIMIT 1').get(top.id);
    const o = createOrder(db2, { customer: { name: 'x' }, payment_method: 'efectivo', items: [{ variant_id: v.id, qty: 3 }] }, { channel: 'mostrador' });
    assert.equal(getProductsByIds(db2, [top.id])[0].sold, sold0 + 3);
    setOrderStatus(db2, o.id, 'cancelado');
    assert.equal(getProductsByIds(db2, [top.id])[0].sold, sold0);
  });
  test('los productos u opciones ocultos no aparecen', () => {
    const db2 = setup();
    const p = queryProducts(db2, { limit: 1 }).products[0];
    db2.prepare('UPDATE products SET active = 0 WHERE id = ?').run(p.id);
    assert.ok(!queryProducts(db2, { limit: 60 }).products.some((x) => x.id === p.id));
    assert.equal(getProductsByIds(db2, [p.id]).length, 0);
  });
});

describe('productos y variantes (servicio)', () => {
  test('crear: SKU con el prefijo de la marca, texto de búsqueda y precio tachado válido', () => {
    const db = setup();
    const { id } = createProduct(
      db,
      { name: 'Prueba Aurora', brand: 'Marca X', category: 'Caballeros', kind: 'Tester', family: 'Fresco', variants: [{ size_ml: 100, price: 40, compare_at: 55, stock: 5 }, { size_ml: 0, price: 20 }] },
      { skuPrefix: 'ZZ' }
    );
    const skus = db.prepare('SELECT sku FROM variants WHERE product_id = ? ORDER BY size_ml').all(id).map((r) => r.sku);
    assert.deepEqual(skus, [`ZZ-${String(id).padStart(5, '0')}-U`, `ZZ-${String(id).padStart(5, '0')}-100`]);
    assert.ok(names(queryProducts(db, { q: 'aurora tester' })).includes('Prueba Aurora'));
  });
  test('rechaza un precio tachado menor o igual al precio, categorías y tipos inválidos', () => {
    const db = setup();
    const base = { name: 'X', brand: 'Y', variants: [{ size_ml: 50, price: 40, compare_at: 40 }] };
    assert.throws(() => createProduct(db, base), { status: 400 });
    assert.throws(() => createProduct(db, { ...base, variants: [{ size_ml: 50, price: 40 }], category: 'Marcianos' }), { status: 400 });
    assert.throws(() => createProduct(db, { ...base, variants: [{ size_ml: 50, price: 40 }], kind: 'Poción' }), { status: 400 });
  });
  test('editar un producto actualiza lo que encuentra la búsqueda', () => {
    const db = setup();
    updateProduct(db, 1, { name: 'Nombre Totalmente Nuevo', kind: 'Estuche' });
    assert.deepEqual(names(queryProducts(db, { q: 'totalmente nuevo' })), ['Nombre Totalmente Nuevo']);
    assert.ok(namesIndex(db).some((x) => x.name === 'Nombre Totalmente Nuevo'), 'el índice de nombres del asistente se actualiza');
  });
  test('el precio tachado de una variante: se pone, se quita y se valida', () => {
    const db = setup();
    const v = db.prepare('SELECT id, price FROM variants LIMIT 1').get();
    updateVariant(db, v.id, { compare_at: v.price + 10 });
    assert.equal(db.prepare('SELECT compare_at c FROM variants WHERE id = ?').get(v.id).c, v.price + 10);
    assert.throws(() => updateVariant(db, v.id, { compare_at: v.price }), { status: 400 });
    assert.throws(() => updateVariant(db, v.id, { price: v.price + 20 }), { status: 400 }, 'subir el precio por encima del tachado');
    updateVariant(db, v.id, { compare_at: null });
    assert.equal(db.prepare('SELECT compare_at c FROM variants WHERE id = ?').get(v.id).c, null);
  });
  test('inventario paginado: búsqueda por nombre o SKU, filtros y orden', () => {
    const db = setup();
    const all = listInventory(db, { limit: 200 });
    assert.equal(all.total, all.rows.length);
    const page = listInventory(db, { limit: 10, page: 2 });
    assert.equal(page.rows.length, 10);
    assert.equal(listInventory(db, { q: 'DLX-00001' }).rows.every((r) => r.sku.startsWith('DLX-00001')), true);
    assert.ok(listInventory(db, { q: 'vetiver' }).rows.every((r) => /vetiver/i.test(r.name)));
    assert.ok(listInventory(db, { filter: 'agotado' }).rows.every((r) => r.stock === 0));
    assert.ok(listInventory(db, { filter: 'bajo' }).rows.every((r) => r.stock > 0 && r.stock <= r.min_stock));
    const byStock = listInventory(db, { sort: 'stock-asc', limit: 200 }).rows.map((r) => r.stock);
    assert.deepEqual(byStock, [...byStock].sort((a, b) => a - b));
  });
  test('lista de productos del panel: filtros por estado y marcas', () => {
    const db = setup();
    updateProduct(db, 2, { active: false });
    assert.equal(listProductsAdmin(db, { status: 'oculto' }).total, 1);
    assert.ok(listProductsAdmin(db, { status: 'sin_imagen' }).rows.every((r) => !r.image));
    assert.ok(listBrands(db).length >= 5);
  });
});

describe('migración desde el esquema anterior', () => {
  test('conserva productos, stock y ventas; renombra categorías; deja todo funcionando', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dluxe-'));
    const path = join(dir, 'viejo.db');
    try {
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT, lead_days INTEGER NOT NULL DEFAULT 5);
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('Mujer','Hombre','Unisex')), family TEXT NOT NULL, notes TEXT, description TEXT,
          color TEXT NOT NULL DEFAULT '#c9a24b', image TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE variants (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), sku TEXT NOT NULL UNIQUE,
          size_ml INTEGER NOT NULL, price REAL NOT NULL, cost REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0,
          min_stock INTEGER NOT NULL DEFAULT 3, reorder_qty INTEGER NOT NULL DEFAULT 12, supplier_id INTEGER, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, customer_name TEXT NOT NULL, customer_email TEXT, customer_phone TEXT,
          delivery TEXT, address TEXT, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pagado', total REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, variant_id INTEGER NOT NULL, qty INTEGER NOT NULL, unit_price REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0);
        INSERT INTO products (id, name, brand, category, family, notes) VALUES (1, 'Rosa Vieja', 'Casa', 'Mujer', 'Floral', 'rosa, jazmín'), (2, 'Cedro Viejo', 'Casa', 'Hombre', 'Amaderado', 'cedro');
        INSERT INTO variants (id, product_id, sku, size_ml, price, stock) VALUES (1, 1, 'OLD-1-50', 50, 60, 7), (2, 2, 'OLD-2-100', 100, 90, 4);
        INSERT INTO orders (id, channel, customer_name, payment_method, total) VALUES (1, 'online', 'Ana', 'tarjeta', 120), (2, 'online', 'Bea', 'tarjeta', 90);
        INSERT INTO order_items (order_id, variant_id, qty, unit_price) VALUES (1, 1, 2, 60), (2, 2, 1, 90);
        UPDATE orders SET status = 'cancelado' WHERE id = 2;
      `);
      old.close();

      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
      assert.deepEqual(db.prepare('SELECT id, category FROM products ORDER BY id').all().map((r) => `${r.id}:${r.category}`), ['1:Damas', '2:Caballeros']);
      assert.equal(db.prepare('SELECT SUM(stock) n FROM variants').get().n, 11);
      assert.equal(db.prepare('SELECT sold FROM products WHERE id = 1').get().sold, 2);
      assert.equal(db.prepare('SELECT sold FROM products WHERE id = 2').get().sold, 0, 'lo cancelado no cuenta como vendido');
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.deepEqual(names(queryProducts(db, { q: 'jazmin' })), ['Rosa Vieja'], 'la búsqueda funciona sobre datos migrados');
      // los triggers nuevos funcionan sobre la base migrada
      db.prepare("INSERT INTO orders (channel, customer_name, payment_method, total) VALUES ('mostrador', 'x', 'efectivo', 1)").run();
      const oid = db.prepare('SELECT MAX(id) n FROM orders').get().n;
      db.prepare('INSERT INTO order_items (order_id, variant_id, qty, unit_price) VALUES (?, 1, 1, 60)').run(oid);
      assert.equal(db.prepare('SELECT sold FROM products WHERE id = 1').get().sold, 3);
      assert.equal(db.prepare('SELECT stock FROM variants WHERE id = 1').get().stock, 6, 'la venta descontó stock por trigger');
      // abrir otra vez no migra de nuevo ni duplica nada
      db.close();
      const again = openDb(path);
      assert.equal(again.prepare('SELECT COUNT(*) n FROM products').get().n, 2);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('marca configurable', () => {
  test('valores por defecto y reemplazo por variables de entorno', () => {
    const b = loadBrand({});
    assert.equal(b.short, "D'Luxe");
    assert.equal(b.skuPrefix, 'DLX');
    const c = loadBrand({ BRAND_NAME: 'Mi Tienda', BRAND_SHORT: 'Mi', STORE_PHONE: '+507 111', STORE_WHATSAPP: '+507 6000-0000' });
    assert.deepEqual([c.name, c.short, c.phone, c.whatsapp], ['Mi Tienda', 'Mi', '+507 111', '50760000000']);
  });
  test('«Quiénes somos»: texto de brand.json, o uno genérico con el nombre de la tienda', () => {
    const d = loadBrand({});
    assert.equal(d.founded, 2007);
    assert.equal(d.about.pillars.length, 4);
    assert.match(d.about.where, /Los Pueblos 2000/);
    const g = loadBrand({ BRAND_NAME: 'Mi Tienda' }, new URL('file:///no/existe.json'));
    assert.equal(g.founded, 0);
    assert.match(g.about.lead, /^Mi Tienda es una tienda de perfumes/);
    assert.ok(g.about.pillars.length >= 3 && g.about.mission && g.about.vision && g.about.values);
  });
  test('fillAbout rellena años y fundación, y omite la línea si no hay año', () => {
    const now = new Date('2026-10-23');
    assert.equal(fillAbout('{years} años desde {founded}', 2007, now), '19 años desde 2007');
    assert.equal(fillAbout('{years} años', 0, now), '');
    assert.equal(fillAbout('Sin marcadores', 0, now), 'Sin marcadores');
  });
  test('un brand.json inexistente o dañado no rompe nada', () => {
    assert.equal(loadBrand({}, new URL('file:///no/existe.json')).name, "D'Luxe Perfumería");
  });
  test('la tienda y el panel se sirven con el nombre de la marca y sin marcadores sin resolver', async () => {
    const app = createApp({ dbPath: ':memory:', chatFactory: () => ({ enabled: false, reason: 'apagado' }) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      for (const path of ['/', '/admin']) {
        const html = await (await fetch(base + path)).text();
        assert.ok(!html.includes('{{'), `${path} tiene marcadores sin reemplazar`);
        assert.match(html, /D&#39;Luxe/, `${path} muestra el nombre (escapado)`);
        assert.match(html, /window\.__BRAND=\{/, `${path} expone la marca al navegador`);
      }
      assert.match(await (await fetch(`${base}/admin`)).text(), /data-initial="d"/, 'el logo compacto usa la inicial de la marca');
      const brand = await (await fetch(`${base}/api/brand`)).json();
      assert.equal(brand.short, "D'Luxe");
      assert.ok(!('skuPrefix' in brand) && !('whatsapp' in brand && typeof brand.whatsapp === 'string'), 'no expone datos internos');
    } finally {
      app.server.close();
    }
  });
});

describe('escala: miles de productos', () => {
  const db = openDb(':memory:');
  const info = seedLarge(db, 2500);
  const ms = (fn, reps = 5) => {
    fn();
    const t = performance.now();
    for (let i = 0; i < reps; i++) fn();
    return (performance.now() - t) / reps;
  };
  test('genera el volumen pedido, con nombres únicos y datos coherentes', () => {
    assert.ok(info.products >= 2500, `productos: ${info.products}`);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT name) n FROM products').get().n, info.products);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE p.id IS NULL').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE search_text = ''").get().n, 0);
  });
  test('portada, filtros y búsqueda responden rápido con miles de productos', () => {
    assert.ok(ms(() => queryProducts(db, { page: 1 })) < 150, 'portada');
    assert.ok(ms(() => queryProducts(db, { page: 90 })) < 150, 'página profunda');
    assert.ok(ms(() => queryProducts(db, { category: 'Damas', kind: 'Perfume', maxPrice: 60 })) < 150, 'filtros combinados');
    assert.ok(ms(() => queryProducts(db, { q: 'oud dorado' })) < 150, 'búsqueda');
    assert.ok(ms(() => queryProducts(db, { sort: 'precio-asc' })) < 250, 'orden por precio');
    assert.ok(ms(() => facets(db, {}), 3) < 250, 'conteos');
    assert.ok(ms(() => listInventory(db, { q: 'musk' })) < 150, 'inventario');
  });
  test('ningún producto del catálogo masivo se queda sin foto, con buena variedad', () => {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE image IS NULL OR image = ''").get().n, 0);
    assert.ok(db.prepare('SELECT COUNT(DISTINCT image) n FROM products').get().n >= 18);
  });
  test('la paginación sigue exacta a escala', () => {
    const a = queryProducts(db, { limit: 60, page: 1 });
    const b = queryProducts(db, { limit: 60, page: 2 });
    assert.equal(a.total, info.products);
    assert.ok(!a.products.some((p) => b.products.some((q) => q.id === p.id)));
    assert.equal(a.pages, Math.ceil(info.products / 60));
  });
  test('el resumen del catálogo se calcula sin cargar todo', () => {
    const s = catalogSummary(db);
    assert.equal(s.total_products, info.products);
    assert.ok(s.families.length >= 6 && s.price_range.min < s.price_range.max);
  });
});

describe('fotos de los productos de ejemplo', () => {
  const file = (img) => new URL(`../public${img}`, import.meta.url);
  const KIDS = ['/img/p15.jpg', '/img/p17.jpg', '/img/p11.jpg', '/img/p05.jpg', '/img/p18.jpg', '/img/p16.jpg'];
  const NOT_FOR_MEN = ['/img/p15.jpg', '/img/p03.jpg', '/img/p05.jpg', '/img/p11.jpg', '/img/p17.jpg', '/img/p18.jpg', '/img/p20.jpg', '/img/p16.jpg'];

  test('el catálogo de ejemplo no deja ningún producto sin foto y todas existen', () => {
    const db = setup();
    const rows = db.prepare('SELECT name, image FROM products').all();
    assert.equal(rows.filter((r) => !r.image).length, 0, rows.filter((r) => !r.image).map((r) => r.name).join(', '));
    for (const r of rows) assert.ok(existsSync(file(r.image)), `${r.name}: ${r.image}`);
  });
  test('lo infantil lleva fotos claras y dulces; los caballeros, ninguna rosada', () => {
    const db = setup();
    for (const r of db.prepare("SELECT name, image FROM products WHERE category = 'Infantil'").all()) assert.ok(KIDS.includes(r.image), `${r.name} ${r.image}`);
    const men = db.prepare("SELECT name, image FROM products WHERE category = 'Caballeros' AND name IN ('Oud Safrán')").all();
    assert.ok(men.length === 1 && men.every((r) => !NOT_FOR_MEN.includes(r.image)));
  });
  test('la misma foto para el mismo producto, y reparto variado entre productos', () => {
    const p = { name: 'Noche Prueba', color: '#e7b8d0', category: 'Damas', kind: 'Perfume' };
    assert.equal(pickPhoto(p), pickPhoto({ ...p }));
    const picks = new Set(Array.from({ length: 200 }, (_, i) => pickPhoto({ ...p, name: `Prueba ${i}` })));
    assert.ok(picks.size >= 3 && picks.size <= 4, 'entre las fotos más parecidas en color, no siempre la misma');
    assert.ok(pickPhoto({ name: 'Caja', color: '#7b3f4f', category: 'Unisex', kind: 'Estuche' }).startsWith('/img/p'));
  });
  test('completar fotos: solo productos de ejemplo sin foto; no toca fotos ni productos importados de WooCommerce', () => {
    const db = openDb(':memory:');
    const ins = db.prepare("INSERT INTO products (name, brand, category, family, color, image, external_id, search_text) VALUES (?, 'M', 'Damas', 'Floral', '#e7b8d0', ?, ?, ' x ')");
    ins.run('Sin foto', null, null);
    ins.run('Foto vacía', '', null);
    ins.run('Con foto propia', '/img/p01.jpg', null);
    ins.run('Importado de Woo', null, '123');
    assert.deepEqual(fillMissingPhotos(db), { missing: 2, filled: 2 });
    const by = Object.fromEntries(db.prepare('SELECT name, image FROM products').all().map((r) => [r.name, r.image]));
    assert.match(by['Sin foto'], /^\/img\/p\d\d\.jpg$/);
    assert.match(by['Foto vacía'], /^\/img\/p\d\d\.jpg$/);
    assert.equal(by['Con foto propia'], '/img/p01.jpg');
    assert.equal(by['Importado de Woo'], null, 'la foto de otro frasco no es la de un producto real');
    assert.deepEqual(fillMissingPhotos(db), { missing: 0, filled: 0 }, 'volver a correrlo no cambia nada');
  });
});
