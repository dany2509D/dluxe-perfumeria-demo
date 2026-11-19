// Datos de ejemplo (marcas y fragancias ficticias) con 14 días de historial.
// Se genera usando las mismas funciones de la tienda, así el historial de movimientos y los saldos salen como en el uso real.
//   npm run seed          → catálogo de demostración (unos 30 productos con fotos)
//   npm run seed:large    → catálogo masivo (8.500 productos) para probar el rendimiento
import { fileURLToPath } from 'node:url';
import { openDb, tx, setSetting, getSetting } from './db.js';
import { createOrder, autoReplenish, adjustStock } from './service.js';
import { bumpCatalog } from './catalog.js';
import { searchText } from './text.js';
import { loadBrand } from './brand.js';
import { pickPhoto } from './photos.js';
import { createSet } from './bundles.js';
import { createPromotion } from './pricing.js';

const SUPPLIERS = [
  ['Distribuidora Esencia S.A.', 'ventas@esencia.example', 4],
  ['Importadora Bouquet', 'pedidos@bouquet.example', 7],
  ['Aromas del Mundo', 'contacto@aromasdelmundo.example', 10],
];

// Fotos libres de derechos en public/img (ver public/img/CREDITS.md).
const photo = (file) => (file ? `/img/${file}.jpg` : null);

// Marca propia de los perfumes de ejemplo. Antes se llamaba «D'Luxe Privé»; se cambió porque D'luxe Perfumería es una tienda real en Panamá.
export const DEMO_HOUSE_BRAND = 'Aurora Privé';
const OLD_DEMO_HOUSE_BRAND = "D'Luxe Privé";

// nombre, marca, categoría, familia, notas, color del líquido, precio base 50 ml, proveedor (1-3), foto, descripción
const PERFUMES = [
  ['Noche de Jazmín', DEMO_HOUSE_BRAND, 'Damas', 'Floral', 'Jazmín, vainilla, almizcle', '#e7b8d0', 82, 1, 'p11', 'Un jazmín blanco que se abre despacio sobre un fondo cremoso de vainilla. Pensado para las noches largas.'],
  ['Rosa Imperial', DEMO_HOUSE_BRAND, 'Damas', 'Floral', 'Rosa de Damasco, peonía, pachulí', '#f0a6b4', 96, 1, 'p05', 'Rosa vestida de terciopelo, con un pachulí suave que le da profundidad y carácter.'],
  ['Ámbar Nocturno', 'Maison Ébène', 'Unisex', 'Oriental', 'Ámbar, oud, canela', '#d98c3f', 128, 2, 'p02', 'Resinas cálidas y especias sobre madera oscura. Una firma intensa que perdura todo el día.'],
  ['Cedro & Cuero', 'Maison Ébène', 'Caballeros', 'Amaderado', 'Cedro, cuero, tabaco', '#9a6b43', 110, 2, 'p12', 'Cedro seco, cuero curtido y un toque de tabaco dulce. Elegante y seguro de sí mismo.'],
  ['Brisa Marina', 'Atelier Sol', 'Unisex', 'Fresco', 'Sal marina, bergamota, salvia', '#8fc7d6', 74, 3, 'p01', 'La frescura de una costa al amanecer: sal, cítricos y hierbas verdes.'],
  ['Vetiver Real', 'Maison Ébène', 'Caballeros', 'Amaderado', 'Vetiver, pimienta rosa, haba tonka', '#6f8f5e', 104, 2, 'p13', 'Un vetiver terroso y limpio, con una chispa de pimienta y un fondo suave de haba tonka.'],
  ['Citrus Solar', 'Atelier Sol', 'Unisex', 'Cítrico', 'Naranja, limón, neroli', '#f2c14e', 68, 3, 'p08', 'Luz de mediodía en un frasco. Cítricos jugosos y flor de azahar para todos los días.'],
  ['Flor de Algodón', DEMO_HOUSE_BRAND, 'Damas', 'Fresco', 'Algodón, lirio, almizcle blanco', '#dfe6ee', 78, 1, 'p04', 'Ropa recién tendida al sol. Limpio, ligero y luminoso.'],
  ['Oud Majestad', 'Al Najma', 'Unisex', 'Oriental', 'Oud, rosa, azafrán', '#7b3f4f', 165, 2, 'p14', 'Oud profundo con azafrán y rosa. La pieza más suntuosa de la colección.'],
  ['Medianoche Negro', 'Maison Ébène', 'Caballeros', 'Oriental', 'Pimienta negra, haba tonka, incienso', '#3a3a52', 118, 2, 'p09', 'Especiado, magnético y nocturno. Pimienta negra e incienso sobre un fondo cremoso.'],
  ['Té Blanco', 'Atelier Sol', 'Unisex', 'Fresco', 'Té blanco, pera, cedro', '#d9e6c8', 70, 3, 'p06', 'Té blanco tibio, sereno y minimalista. Para quienes prefieren lo discreto.'],
  ['Vainilla Dorada', DEMO_HOUSE_BRAND, 'Damas', 'Gourmand', 'Vainilla, caramelo, sándalo', '#e3b778', 88, 1, 'p10', 'Vainilla ámbar y caramelo tostado sobre sándalo cremoso. Un abrazo en forma de perfume.'],
  ['Cereza Noir', 'Maison Ébène', 'Damas', 'Frutal', 'Cereza negra, almendra, rosa', '#8c1d3c', 99, 2, 'p03', 'Cereza oscura, almendra amarga y un corazón de rosa. Seductor y atrevido.'],
  // Inspiración árabe (sin foto: se ve el frasco ilustrado)
  ['Najm al-Layl', 'Al Najma', 'Unisex', 'Oriental', 'Oud, ámbar, azafrán, rosa', '#6b3a2a', 138, 2, null, 'La estrella de la noche: oud ahumado, azafrán y una rosa oscura. Intensidad de Oriente.'],
  ['Rosa de Sahara', 'Sahara Essence', 'Damas', 'Floral', 'Rosa taifí, ámbar, almizcle', '#e09aa6', 92, 2, null, 'Rosa del desierto con ámbar cálido. Femenino, envolvente y duradero.'],
  ['Oud Safrán', 'Noor Parfums', 'Caballeros', 'Oriental', 'Oud, azafrán, cuero', '#8a5a2b', 124, 2, null, 'Oud y azafrán sobre cuero suave. Presencia y carácter.'],
];

// Estuches de regalo y testers: mismo perfume, otra presentación.
const SETS = [
  ['Vetiver Real', 'p13', 135],
  ['Noche de Jazmín', 'p11', 118],
  ['Oud Majestad', 'p14', 210],
  ['Rosa Imperial', 'p05', 128],
];
const TESTERS = [
  ['Medianoche Negro', 'p09', 99],
  ['Cereza Noir', 'p03', 82],
  ['Té Blanco', 'p06', 54],
];

// Línea infantil (la foto se elige sola entre las claras y dulces: photos.js)
const KIDS = [
  ['Gotas de Luna', 'Pequeño Lux', 'Niñas', 'Frutal', 'Fresa, vainilla suave', '#f3b6cf', 32, 'Aroma dulce y suave, sin alcohol fuerte. Para las pequeñas de la casa.'],
  ['Bosque Mágico', 'Pequeño Lux', 'Niños', 'Fresco', 'Manzana verde, menta', '#9ccf9a', 30, 'Fresco y divertido, con manzana verde y menta suave.'],
  ['Burbuja Cítrica', 'Pequeño Lux', 'Niñas', 'Cítrico', 'Mandarina, flor de algodón', '#f6c978', 28, 'Mandarina y algodón limpio: aroma de recién bañada.'],
  ['Aventura Marina', 'Pequeño Lux', 'Niños', 'Fresco', 'Brisa marina, limón', '#8fc7d6', 30, 'Frescura de mar y limón para pequeños exploradores.'],
];

// Ofertas: producto → { tamaño: % de descuento }. Novedades: productos recién llegados.
const DEALS = {
  'Citrus Solar': { 30: 25, 50: 20 },
  'Té Blanco': { 100: 15 },
  'Brisa Marina': { 30: 30 },
  'Vainilla Dorada': { 50: 20 },
  'Rosa de Sahara': { 50: 12 },
};
const NEW_ARRIVALS = new Set(['Oud Majestad', 'Cereza Noir', 'Noche de Jazmín', 'Najm al-Layl', 'Oud Safrán', 'Gotas de Luna']);

const SIZES = [
  { ml: 30, factor: 0.62 },
  { ml: 50, factor: 1 },
  { ml: 100, factor: 1.7 },
];

const FIRST = ['Camila', 'Mateo', 'Valentina', 'Sebastián', 'Lucía', 'Andrés', 'Sofía', 'Diego', 'Isabella', 'Gabriel', 'Mariana', 'Daniel', 'Paola', 'Ricardo', 'Elena', 'Javier'];
const LAST = ['Rojas', 'Mendoza', 'Castillo', 'Vargas', 'Herrera', 'Ortega', 'Navarro', 'Cruz', 'Salazar', 'Pineda', 'Aguilar', 'Quintero'];

// Generador pseudoaleatorio con semilla: la demo siempre arranca igual.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Código de barras de ejemplo (EAN-13 válido, prefijo 745) para que el lector del mostrador tenga algo que leer.
function ean13(n) {
  const body = `745${String(n).padStart(9, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dealPrice = (price, pct) => Math.ceil(price / (1 - pct / 100));

// Inserta un producto con sus tamaños y su inventario inicial (como un movimiento, igual que en el uso real).
function addProduct(db, ctx, p, sizes) {
  const search = searchText({ ...p, kind: p.kind ?? 'Perfume' });
  const pid = Number(
    db
      .prepare(
        `INSERT INTO products (name, brand, category, subcategory, kind, family, notes, description, color, image, is_new, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.name, p.brand, p.category, p.subcategory ?? null, p.kind ?? 'Perfume', p.family, p.notes, p.description ?? '', p.color, p.image ?? pickPhoto({ ...p, kind: p.kind ?? 'Perfume' }), p.is_new ? 1 : 0, search)
      .lastInsertRowid
  );
  for (const s of sizes) {
    const vid = Number(
      db
        .prepare(
          `INSERT INTO variants (product_id, sku, size_ml, price, compare_at, cost, min_stock, reorder_qty, supplier_id, barcode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          pid, `${ctx.prefix}-${String(pid).padStart(5, '0')}-${s.ml || 'U'}`, s.ml, s.price, s.compare_at ?? null,
          Math.round(s.price * 0.42 * 100) / 100, s.ml >= 100 || s.ml === 0 ? 3 : 4, s.ml >= 100 ? 8 : 12, p.supplier ?? 1, ean13((ctx.ean = (ctx.ean || 0) + 1))
        ).lastInsertRowid
    );
    const initial = s.stock ?? 10 + Math.floor(ctx.rand() * 16);
    if (initial > 0) {
      db.prepare(`INSERT INTO stock_movements (variant_id, type, qty, reason, created_at) VALUES (?, 'entrada', ?, 'Inventario inicial', ?)`).run(vid, initial, ctx.openingStamp);
    }
  }
  return pid;
}

// Los usuarios del panel y las cuentas de clientes no se tocan: reiniciar la demostración borra datos de ejemplo, no personas.
const WIPE = [
  'notifications', 'stock_alerts', 'fiscal_docs', 'payment_attempts', 'return_items', 'returns', 'gift_card_uses', 'gift_cards', 'promotions',
  'cash_movements', 'cash_shifts', 'order_events', 'customer_favorites', 'bundle_items', 'media',
  'reviews', 'woo_outbox', 'woo_orders', 'woo_events', 'order_items', 'orders', 'purchase_items', 'purchases', 'stock_movements', 'variants', 'products', 'suppliers',
];

function wipe(db) {
  for (const t of WIPE) db.exec(`DELETE FROM ${t}`);
  // Se reinician la reposición automática y la numeración de facturas de ejemplo; el resto de ajustes (WooCommerce, avisos, políticas) se conserva.
  db.exec("DELETE FROM settings WHERE key IN ('auto_reorder', 'fiscal_seq_fe', 'fiscal_seq_nc')");
}

// Reseñas de ejemplo (nombres inventados y comentarios generales, sin datos de personas reales): cada producto recibe de 0 a 4,
// repartidas en los últimos dos meses. Una de cada cinco fichas queda sin reseñas para que se vea también ese estado.
const REVIEW_POOL = [
  ['Valentina R.', 5, 'Me encantó', 'Dura muchas horas y varias personas me han preguntado qué perfume uso. Lo volvería a comprar.'],
  ['Carlos M.', 4, 'Muy buena relación calidad-precio', 'Buen aroma y buena duración para el precio. Llegó bien presentado y sin ningún problema.'],
  ['Daniela P.', 5, 'Perfecto para regalar', 'Lo compré de regalo y quedó fascinada. La presentación es muy bonita.'],
  ['Andrés G.', 4, 'Elegante y discreto', 'No es empalagoso, se siente fino. En la oficina funciona de maravilla.'],
  ['Mariana L.', 3, 'Está bien', 'Me gusta, pero esperaba que durara un poco más en mi piel. Aun así lo uso seguido.'],
  ['Luis F.', 5, 'Mi favorito del momento', 'Lo uso casi todos los días. La estela es agradable y no cansa.'],
  ['Camila S.', 4, 'Bonito aroma', 'Se siente suave y agradable. Lo rocío por la mañana y todavía se nota en la tarde.'],
  ['Jorge T.', 5, 'Excelente atención', 'Me asesoraron por el chat para elegirlo y acertaron. La entrega fue rápida.'],
  ['Sofía A.', 4, 'Muy recomendable', 'El frasco es lindo y el aroma gusta. Lo recomiendo para ocasiones especiales.'],
  ['Ricardo B.', 3, 'Normal', 'Es agradable, aunque no me pareció tan especial. Cumple, pero hay otros que me gustan más.'],
  ['Paola D.', 5, 'Me sorprendió', 'No lo conocía y me llevé una grata sorpresa. Se nota que es de calidad.'],
  ['Miguel C.', 4, 'Buen producto', 'Llegó en perfecto estado y el aroma es tal como lo esperaba.'],
  ['Isabella V.', 5, 'Lo amo', 'Me hace sentir segura. Ya pedí otro para mi hermana.'],
  ['Gabriel N.', 4, 'Ideal para el día a día', 'Ligero y fácil de usar. Nada pesado ni fuerte.'],
];

function seedReviews(db) {
  const r = rng(20261023);
  const ins = db.prepare("INSERT INTO reviews (product_id, author, rating, title, body, sample, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now', 'localtime', ?))");
  for (const { id } of db.prepare('SELECT id FROM products ORDER BY id').all()) {
    if (r() < 0.2) continue;
    const count = 1 + Math.floor(r() * 4);
    const picks = [...REVIEW_POOL.keys()].sort(() => r() - 0.5).slice(0, count);
    // De la más antigua a la más reciente, para que el orden de los números coincida con el de las fechas.
    const days = picks.map(() => 2 + Math.floor(r() * 68)).sort((a, b) => b - a);
    picks.forEach((k, i) => ins.run(id, ...REVIEW_POOL[k], `-${days[i]} days`));
  }
}

function seedCatalog(db, ctx) {
  const sup = db.prepare('INSERT INTO suppliers (name, contact, lead_days) VALUES (?, ?, ?)');
  for (const s of SUPPLIERS) sup.run(...s);

  const find = (name) => PERFUMES.find((x) => x[0] === name);
  const sizesFor = (name, base, fixedSizes) => {
    const deals = DEALS[name] || {};
    return (fixedSizes ?? SIZES).map(({ ml, factor }) => {
      const price = Math.round(base * factor);
      const pct = deals[ml];
      return pct ? { ml, price, compare_at: dealPrice(price, pct) } : { ml, price };
    });
  };

  for (const [name, brand, category, family, notes, color, base, supplier, img, description] of PERFUMES) {
    // Los perfumes caros no tienen formato de 30 ml.
    const sizes = sizesFor(name, base, base > 120 ? SIZES.slice(1) : SIZES);
    addProduct(db, ctx, { name, brand, category, family, notes, color, supplier, image: photo(img), description, is_new: NEW_ARRIVALS.has(name) }, sizes);
  }
  for (const [name, img, price] of SETS) {
    const p = find(name);
    addProduct(
      db, ctx,
      { name: `Estuche ${name}`, brand: p[1], category: p[2], kind: 'Estuche', family: p[3], notes: `${p[4]} · incluye miniatura`, color: p[5], supplier: p[7], image: photo(img), description: `${p[9]} Presentación de regalo con perfume de 100 ml y miniatura.` },
      [{ ml: 0, price, compare_at: dealPrice(price, 10), stock: 6 + Math.floor(ctx.rand() * 8) }]
    );
  }
  for (const [name, img, price] of TESTERS) {
    const p = find(name);
    addProduct(
      db, ctx,
      { name: `Tester ${name}`, brand: p[1], category: p[2], kind: 'Tester', family: p[3], notes: p[4], color: p[5], supplier: p[7], image: photo(img), description: `${p[9]} Versión tester (sin caja), ideal para probar.` },
      [{ ml: 100, price, compare_at: dealPrice(price, 20), stock: 4 + Math.floor(ctx.rand() * 6) }]
    );
  }
  for (const [name, brand, subcategory, family, notes, color, base, description] of KIDS) {
    addProduct(
      db, ctx,
      { name, brand, category: 'Infantil', subcategory, family, notes, color, supplier: 3, description, is_new: NEW_ARRIVALS.has(name) },
      [{ ml: 30, price: base }, { ml: 50, price: Math.round(base * 1.5) }]
    );
  }
}

// Historial: 14 días de ventas (online y mostrador).
function seedHistory(db, rand, services = {}) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const variants = db.prepare('SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.kind = ? ORDER BY v.id').all('Perfume').map((v) => v.id);
  const now = new Date();
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const weekend = [0, 6].includes(new Date(now.getTime() - daysAgo * 864e5).getDay());
    const count = 2 + Math.floor(rand() * 4) + (weekend ? 2 : 0);
    for (let k = 0; k < count; k++) {
      const when = new Date(now);
      when.setDate(now.getDate() - daysAgo);
      when.setHours(9 + Math.floor(rand() * 11), Math.floor(rand() * 60), Math.floor(rand() * 60));
      if (when > now) when.setTime(now.getTime() - Math.floor(rand() * 3 * 3600e3));
      const online = rand() < 0.55;
      const lines = 1 + Math.floor(rand() * 3);
      const items = [];
      for (let l = 0; l < lines; l++) items.push({ variant_id: pick(variants), qty: rand() < 0.8 ? 1 : 2 });
      const who = `${pick(FIRST)} ${pick(LAST)}`;
      try {
        createOrder(
          db,
          online
            ? {
                customer: { name: who, email: `${who.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, phone: `+507 6${Math.floor(1000000 + rand() * 8999999)}` },
                payment_method: pick(['tarjeta', 'tarjeta', 'transferencia', 'contra_entrega']),
                delivery: rand() < 0.5 ? 'retiro' : 'envio',
                address: 'Av. Principal, Edificio Central, Apto. 4B',
                items,
              }
            : { customer: { name: 'Cliente mostrador' }, payment_method: pick(['efectivo', 'tarjeta', 'efectivo']), items },
          { channel: online ? 'online' : 'mostrador', created_at: stamp(when), skipReplenish: true, services }
        );
      } catch (e) {
        if (e.status !== 409) throw e; // sin stock: ese cliente simplemente no compra
      }
    }
  }
}

// services (opcional): { fiscal, brand } para que las ventas de ejemplo también tengan su factura de demostración.
export function resetAndSeed(db, services = {}) {
  const rand = rng(20261022);
  const opening = new Date();
  opening.setDate(opening.getDate() - 20);
  const ctx = { rand, prefix: loadBrand().skuPrefix, openingStamp: stamp(opening) };

  tx(db, () => {
    wipe(db);
    setSetting(db, 'auto_reorder', '0'); // se activa al final, para que el historial no genere compras
    seedCatalog(db, ctx);
    seedReviews(db);
  });
  seedHistory(db, rand, services);

  // Conteo físico para dejar a propósito casos para mostrar en la demo: dos variantes agotadas y tres con stock bajo.
  const counts = [
    ['Ámbar Nocturno', 50, 0],
    ['Citrus Solar', 30, 0],
    ['Cereza Noir', 50, 1],
    ['Rosa Imperial', 100, 2],
    ['Té Blanco', 30, 2],
  ];
  const findVariant = db.prepare(
    "SELECT v.id, v.stock FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = ? AND p.kind = 'Perfume' AND v.size_ml = ?"
  );
  for (const [name, ml, target] of counts) {
    const v = findVariant.get(name, ml);
    if (v && v.stock !== target) adjustStock(db, v.id, { count: target, reason: 'Conteo físico' });
  }

  setSetting(db, 'auto_reorder', '1');
  tx(db, () => autoReplenish(db, { force: true }));
  seedExtras(db, ctx);
  bumpCatalog(db);
}

// Ofertas, cupones, sets de regalo y una tarjeta de regalo de ejemplo (después del historial, para que no lo afecten).
function seedExtras(db, ctx) {
  const inDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  tx(db, () => {
    createPromotion(db, { name: 'Bienvenida: 10% en tu primera compra', code: 'BIENVENIDA10', kind: 'percent', amount: 10, channel: 'online', per_customer: true, featured: true });
    createPromotion(db, { name: 'Temporada Atelier Sol: 15% de descuento', kind: 'percent', amount: 15, scope: 'marca', scope_value: 'Atelier Sol', ends_at: inDays(45) });
    createPromotion(db, { name: 'Pequeño Lux: llévate 2 por $50', kind: 'bundle', buy_qty: 2, amount: 50, scope: 'marca', scope_value: 'Pequeño Lux' });
    createPromotion(db, { name: 'Mostrador: $5 menos en compras de $50 o más', code: 'MOSTRADOR5', kind: 'fixed', amount: 5, min_total: 50, channel: 'mostrador' });
    db.prepare(
      `INSERT INTO gift_cards (code, initial_amount, balance, status, source, buyer_name, recipient_name, message, expires_at)
       VALUES ('GC-DEMO-0050', 50, 50, 'activa', 'manual', 'Tienda', 'Cliente de prueba', 'Tarjeta de ejemplo para probar el pago con tarjeta de regalo', ?)`
    ).run(inDays(365));
  });
  const find = db.prepare("SELECT v.id, p.image FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = ? AND p.kind = 'Perfume' AND v.size_ml = ?");
  const sets = [
    ['Set Dúo Floral', 149, [['Noche de Jazmín', 50], ['Rosa Imperial', 50]], 'Dos florales que se complementan: el jazmín cremoso de Noche de Jazmín y la rosa de terciopelo de Rosa Imperial. Presentación de regalo.'],
    ['Set Él y Ella', 159, [['Cedro & Cuero', 50], ['Flor de Algodón', 50]], 'Un perfume para cada uno: Cedro & Cuero para él y Flor de Algodón para ella. Ideal para aniversarios.'],
    ['Set Frescura de Verano', 135, [['Brisa Marina', 30], ['Té Blanco', 50], ['Flor de Algodón', 30]], 'Tres fragancias frescas y ligeras para el calor: sal marina, té blanco y algodón.'],
  ];
  for (const [name, price, parts, description] of sets) {
    const components = parts.map(([n, ml]) => ({ variant_id: find.get(n, ml)?.id, qty: 1 })).filter((c) => c.variant_id);
    if (components.length !== parts.length) continue;
    createSet(db, { name, price, components, description, image: find.get(parts[0][0], parts[0][1]).image || '' }, { skuPrefix: ctx.prefix });
  }
}

// Una demostración publicada con el nombre anterior guarda «D'Luxe Privé» en su base: al abrirse, sus productos pasan a la marca nueva.
export function renameDemoHouseBrand(db) {
  const rows = db.prepare('SELECT id, name, brand, category, subcategory, kind, family, notes FROM products WHERE brand = ?').all(OLD_DEMO_HOUSE_BRAND);
  if (!rows.length) return false;
  tx(db, () => {
    const upd = db.prepare('UPDATE products SET brand = ?, search_text = ? WHERE id = ?');
    for (const p of rows) upd.run(DEMO_HOUSE_BRAND, searchText({ ...p, brand: DEMO_HOUSE_BRAND }), p.id);
  });
  bumpCatalog(db);
  return true;
}

// Una demostración publicada con una versión anterior (sin ofertas, sets, tarjetas ni códigos de barras) recibe lo nuevo al abrirse
// con esta versión, sin borrar nada de lo que ya tiene. Solo toca una base que sea la de ejemplo (no la de una tienda real).
export function upgradeDemoData(db, { prefix = 'DLX' } = {}) {
  if (getSetting(db, 'demo_data_v4', '0') === '1') return false;
  const isDemo = db.prepare("SELECT 1 FROM products WHERE name = 'Noche de Jazmín' AND brand IN (?, ?) LIMIT 1").get(DEMO_HOUSE_BRAND, OLD_DEMO_HOUSE_BRAND);
  setSetting(db, 'demo_data_v4', '1');
  if (!isDemo) return false;
  tx(db, () => {
    const upd = db.prepare('UPDATE variants SET barcode = ? WHERE id = ?');
    db.prepare('SELECT id FROM variants WHERE barcode IS NULL AND is_set = 0 ORDER BY id').all().forEach((r, i) => upd.run(ean13(i + 1), r.id));
    if (!db.prepare('SELECT 1 FROM promotions LIMIT 1').get()) seedExtras(db, { prefix });
  });
  bumpCatalog(db);
  return true;
}

// ─── Catálogo masivo (prueba de rendimiento) ────────────────────────────────
const W1 = ['Oud', 'Rosa', 'Ámbar', 'Musk', 'Vainilla', 'Jazmín', 'Cedro', 'Vetiver', 'Sándalo', 'Azafrán', 'Bergamota', 'Iris', 'Peonía', 'Neroli', 'Pachulí', 'Tabaco', 'Cuero', 'Lavanda', 'Noche', 'Aurora', 'Eclipse', 'Mirage', 'Elixir', 'Zafiro', 'Sahara', 'Imperial', 'Majestad', 'Esencia', 'Secreto', 'Prestigio', 'Absoluto', 'Seda', 'Terciopelo', 'Oro', 'Plata', 'Brisa', 'Océano', 'Selva', 'Desierto', 'Luna', 'Sol', 'Estrella'];
const W2 = ['Real', 'Negro', 'Blanco', 'Dorado', 'Intenso', 'Noir', 'Puro', 'Salvaje', 'Eterno', 'Mágico', 'Secreto', 'Profundo', 'Radiante', 'Nocturno', 'Solar', 'Marino', 'Oriental', 'Clásico', 'Privado', 'Extremo', 'Suave', 'Ardiente', 'Cristal', 'Imperial'];
const W3 = ['', '', '', 'Intenso', 'Elixir', 'Absoluto', 'Nuit', 'Éclat', 'Reserva', 'Edición Limitada', 'Gold', 'Silver', 'Privé', 'Légère', 'Extrait', 'Eau Fraîche'];
const B1 = ['Maison', 'Atelier', 'Casa', 'Parfums', 'Esencias', 'Noor', 'Al', 'Studio', 'Royal', 'Bruma', 'Aroma', 'Villa', 'Casa de', 'Domus'];
const B2 = ['Veloz', 'Norte', 'Lumière', 'Zafra', 'Orión', 'Najma', 'Dalia', 'Ébano', 'Sahel', 'Marfil', 'Cobre', 'Alba', 'Brisa', 'Cordial', 'Tamar', 'Rubí', 'Olivar', 'Magno', 'Cielo', 'Fénix', 'Orquídea', 'Cedro', 'Safra', 'Nácar'];
const FAMILIES = ['Floral', 'Oriental', 'Amaderado', 'Fresco', 'Cítrico', 'Gourmand', 'Frutal', 'Aromático'];
const COLORS = ['#e7b8d0', '#f0a6b4', '#d98c3f', '#9a6b43', '#8fc7d6', '#6f8f5e', '#f2c14e', '#dfe6ee', '#7b3f4f', '#e8d38b', '#3a3a52', '#d9e6c8', '#e3b778', '#a58fc4', '#b49a6e', '#8c1d3c'];
const BIG_SIZES = [30, 50, 60, 75, 80, 90, 100, 125, 200];

export function seedLarge(db, count = 8500) {
  const rand = rng(8500);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const brands = [...new Set(Array.from({ length: 160 }, () => `${pick(B1)} ${pick(B2)}`))];
  const opening = new Date();
  opening.setDate(opening.getDate() - 20);
  const ctx = { rand, prefix: loadBrand().skuPrefix, openingStamp: stamp(opening) };
  const t0 = Date.now();

  tx(db, () => {
    wipe(db);
    setSetting(db, 'auto_reorder', '0');
    seedCatalog(db, ctx); // empieza con el catálogo curado

    const usedNames = new Set(db.prepare('SELECT name FROM products').all().map((r) => r.name));
    for (let i = 0; usedNames.size < count && i < count * 3; i++) {
      const r = rand();
      const category = r < 0.55 ? 'Damas' : r < 0.95 ? 'Caballeros' : r < 0.975 ? 'Infantil' : 'Unisex';
      const k = rand();
      const kind = k < 0.7 ? 'Perfume' : k < 0.82 ? 'Estuche' : 'Tester';
      const base = `${pick(W1)} ${pick(W2)}${pick(W3) ? ` ${pick(W3)}` : ''}`.replace(/\s+/g, ' ');
      const name = kind === 'Perfume' ? base : `${kind} ${base}`;
      if (usedNames.has(name)) continue;
      usedNames.add(name);
      const family = pick(FAMILIES);
      const unit = Math.round(18 + rand() ** 2 * 220); // precio base: la mayoría baratos, pocos caros
      const nSizes = kind === 'Perfume' ? 1 + Math.floor(rand() * 3) : 1;
      const sizesPool = [...BIG_SIZES].sort(() => rand() - 0.5).slice(0, nSizes).sort((a, b) => a - b);
      const onSale = rand() < 0.15;
      const sizes = (kind === 'Estuche' ? [0] : sizesPool).map((ml) => {
        const price = Math.max(8, Math.round(unit * (ml ? 0.5 + ml / 100 : 1.3)));
        return { ml, price, compare_at: onSale ? dealPrice(price, 10 + Math.floor(rand() * 25)) : null, stock: rand() < 0.06 ? 0 : Math.floor(rand() * 30) };
      });
      addProduct(
        db, ctx,
        {
          name, brand: pick(brands), category, subcategory: category === 'Infantil' ? pick(['Niñas', 'Niños']) : null, kind, family,
          notes: `${pick(W1)}, ${pick(W1)}, ${pick(W1)}`.toLowerCase().replace(/^./, (c) => c.toUpperCase()), color: pick(COLORS),
          supplier: 1 + Math.floor(rand() * 3), is_new: rand() < 0.08,
          description: `Fragancia ${family.toLowerCase()} de la casa. Producto de ejemplo.`,
        },
        sizes
      );
    }
    // Popularidad: unos pocos productos muy vendidos y una cola larga.
    db.exec('UPDATE products SET sold = CAST((abs(random() % 1000) / 1000.0) * (abs(random() % 1000) / 1000.0) * 400 AS INTEGER)');
    setSetting(db, 'auto_reorder', '1');
  });
  bumpCatalog(db);
  return { products: db.prepare('SELECT COUNT(*) n FROM products').get().n, variants: db.prepare('SELECT COUNT(*) n FROM variants').get().n, ms: Date.now() - t0 };
}

// `npm run seed` / `npm run seed:large` → reinicia la base de datos con los datos de ejemplo.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(process.env.DB_PATH || fileURLToPath(new URL('./data/aurelia.db', import.meta.url)));
  if (process.argv.includes('--large')) {
    const n = Number(process.argv[process.argv.indexOf('--large') + 1]) || 8500;
    const r = seedLarge(db, n);
    console.log(`Catálogo masivo listo: ${r.products} productos, ${r.variants} variantes (${(r.ms / 1000).toFixed(1)} s).`);
  } else {
    resetAndSeed(db);
    console.log('Base de datos reiniciada con datos de ejemplo. Auto-reposición:', getSetting(db, 'auto_reorder') === '1' ? 'activada' : 'desactivada');
  }
}
