// Reparto de las fotos libres de derechos (public/img, ver CREDITS.md) entre los productos de EJEMPLO.
// La foto se elige por parecido de color con el producto (y por tipo: lo infantil, lo claro y dulce; los estuches, presentaciones de regalo),
// y siempre igual para el mismo producto. NUNCA se aplica a productos importados de una tienda real: la foto de otro frasco no es la de ese producto.
//   npm run photos     → completa las fotos que faltan en la base de datos de la demo
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

// archivo, color medio de la foto (para casarlo con el color del producto)
const PHOTOS = [
  ['p01', '#c28b35'], ['p02', '#94551d'], ['p03', '#903d38'], ['p04', '#cdbab1'], ['p05', '#b78e80'], ['p06', '#b6a697'], ['p08', '#71531d'],
  ['p09', '#423b31'], ['p10', '#cb9e3f'], ['p11', '#c1babf'], ['p12', '#ad6645'], ['p13', '#988368'], ['p14', '#b4864b'], ['p15', '#d987b1'],
  ['p16', '#e0cab9'], ['p17', '#d7d2c5'], ['p18', '#b69568'], ['p19', '#9f7a4f'], ['p20', '#d1b5a3'], ['p21', '#c59a84'], ['p22', '#574032'],
  ['p23', '#919498'], ['p24', '#a0a39f'], ['p25', '#695a42'],
];
const KIDS = ['p15', 'p17', 'p11', 'p05', 'p18', 'p16']; // rosados, claros y dulces
const GIFT = ['p12', 'p20', 'p19', 'p09']; // cajas, encaje, telas: presentación de regalo
const NOT_FOR_MEN = ['p15', 'p03', 'p05', 'p11', 'p17', 'p18', 'p20', 'p16']; // rosados y florales
const NOT_FOR_WOMEN = ['p09', 'p22', 'p23', 'p24', 'p13', 'p08']; // muy oscuros o fríos

const rgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xc9a24b;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const hash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

const available = PHOTOS; // los archivos viven en public/img y se comprueban en las pruebas

// Foto (ruta pública) para un producto de ejemplo, o null si no hay fotos disponibles.
export function pickPhoto({ name, color, category, kind }) {
  let pool = available;
  if (category === 'Infantil') pool = available.filter(([f]) => KIDS.includes(f));
  else if (kind === 'Estuche') pool = available.filter(([f]) => GIFT.includes(f));
  else if (category === 'Caballeros') pool = available.filter(([f]) => !NOT_FOR_MEN.includes(f));
  else if (category === 'Damas') pool = available.filter(([f]) => !NOT_FOR_WOMEN.includes(f));
  if (!pool.length) pool = available;
  if (!pool.length) return null;
  const target = rgb(color);
  // Las 4 fotos de color más parecido; entre ellas manda el nombre, así no todo lo "rosado" lleva la misma.
  const near = [...pool].sort((a, b) => dist(rgb(a[1]), target) - dist(rgb(b[1]), target)).slice(0, Math.min(4, pool.length));
  return `/img/${near[hash(name) % near.length][0]}.jpg`;
}

// Completa las fotos que faltan. Solo productos de ejemplo: los importados de WooCommerce (con external_id) no se tocan.
export function fillMissingPhotos(db) {
  const rows = db.prepare("SELECT id, name, color, category, kind FROM products WHERE (image IS NULL OR image = '') AND external_id IS NULL").all();
  const set = db.prepare('UPDATE products SET image = ? WHERE id = ?');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const img = pickPhoto(r);
      if (img) { set.run(img, r.id); n++; }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { missing: rows.length, filled: n };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(process.env.DB_PATH || fileURLToPath(new URL('./data/aurelia.db', import.meta.url)));
  const r = fillMissingPhotos(db);
  console.log(`Fotos completadas: ${r.filled} de ${r.missing} productos sin foto (los importados de WooCommerce no se tocan).`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}
