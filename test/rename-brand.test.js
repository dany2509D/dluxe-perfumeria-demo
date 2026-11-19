import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { resetAndSeed, renameDemoHouseBrand, DEMO_HOUSE_BRAND } from '../seed.js';

test('una demo publicada con «D\'Luxe Privé» pasa sus perfumes a la marca nueva, también en la búsqueda', () => {
  const db = openDb(':memory:');
  resetAndSeed(db, { fiscal: null });
  const own = db.prepare('SELECT COUNT(*) AS n FROM products WHERE brand = ?').get(DEMO_HOUSE_BRAND).n;
  assert.ok(own > 0, 'la semilla usa la marca nueva');

  // Simula una base guardada con la versión anterior.
  db.prepare("UPDATE products SET brand = 'D''Luxe Privé', search_text = 'd luxe prive' WHERE brand = ?").run(DEMO_HOUSE_BRAND);

  assert.equal(renameDemoHouseBrand(db), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE brand = 'D''Luxe Privé'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products WHERE brand = ?').get(DEMO_HOUSE_BRAND).n, own);
  const rows = db.prepare('SELECT search_text FROM products WHERE brand = ?').all(DEMO_HOUSE_BRAND);
  assert.ok(rows.every((r) => r.search_text.includes('aurora')), 'el texto de búsqueda se rehace con la marca nueva');

  assert.equal(renameDemoHouseBrand(db), false, 'una segunda vez no hace nada');
});
