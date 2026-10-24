// Página de producto: reseñas (validación, antispam, moderación), recomendados y migración del esquema.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../db.js';
import { resetAndSeed, seedLarge } from '../seed.js';
import { relatedProducts } from '../catalog.js';
import { addReview, cleanReview, listReviews, summary, removeReview, listRecent } from '../reviews.js';
import { createApp } from '../app.js';

const seeded = () => {
  const db = openDb(':memory:');
  resetAndSeed(db);
  return db;
};
const good = { name: 'Lucía Prueba', rating: 5, title: 'Muy bueno', body: 'Me gustó mucho, dura todo el día.' };

describe('esquema', () => {
  test('una base de la versión 2 recibe la tabla de reseñas sin perder nada', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dluxe-rev-'));
    try {
      const path = join(dir, 'v2.db');
      const first = openDb(path);
      resetAndSeed(first);
      const products = first.prepare('SELECT COUNT(*) n FROM products').get().n;
      first.exec('DROP TABLE reviews; PRAGMA user_version = 2');
      first.close();
      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 4);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, products);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('la calificación solo admite de 1 a 5 y borrar un producto borra sus reseñas', () => {
    const db = seeded();
    assert.throws(() => db.prepare("INSERT INTO reviews (product_id, author, rating, body) VALUES (1, 'x', 6, 'y')").run());
    assert.throws(() => db.prepare("INSERT INTO reviews (product_id, author, rating, body) VALUES (1, 'x', 0, 'y')").run());
    const pid = Number(db.prepare("INSERT INTO products (name, brand, search_text) VALUES ('Producto de prueba', 'Marca', ' prueba')").run().lastInsertRowid);
    db.prepare("INSERT INTO reviews (product_id, author, rating, body) VALUES (?, 'Ana', 5, 'Muy bueno, sin problema.')").run(pid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews WHERE product_id = ?').get(pid).n, 1);
    db.prepare('DELETE FROM products WHERE id = ?').run(pid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews WHERE product_id = ?').get(pid).n, 0);
  });
  test('la demostración trae reseñas de ejemplo (marcadas) y deja fichas sin reseñas', () => {
    const db = seeded();
    const n = db.prepare('SELECT COUNT(*) n FROM reviews').get().n;
    assert.ok(n >= 30 && n <= 100, `reseñas de ejemplo: ${n}`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reviews WHERE sample = 0').get().n, 0);
    const bare = db.prepare('SELECT COUNT(*) n FROM products p WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = p.id)').get().n;
    assert.ok(bare >= 1, 'al menos un producto sin reseñas, para mostrar ese estado');
    assert.ok(db.prepare('SELECT MIN(rating) m FROM reviews').get().m >= 3);
  });
});

describe('validación de una reseña', () => {
  const bad = (patch, re) => assert.throws(() => cleanReview({ ...good, ...patch }), (e) => e.status === 400 && re.test(e.message), JSON.stringify(patch));
  test('acepta una reseña buena y limpia espacios y caracteres de control', () => {
    assert.deepEqual(cleanReview({ name: '  Lucía \n Prueba ', rating: '4', title: ' ', body: 'Muy   buen\u0000 aroma,\n dura mucho.' }), {
      author: 'Lucía Prueba', rating: 4, title: '', body: 'Muy buen aroma, dura mucho.',
    });
  });
  test('rechaza nombre, calificación, título y comentario inválidos con un mensaje claro', () => {
    bad({ name: 'A' }, /nombre/);
    bad({ name: 'N'.repeat(41) }, /nombre/);
    bad({ rating: 0 }, /estrellas/);
    bad({ rating: 6 }, /estrellas/);
    bad({ rating: 4.5 }, /estrellas/);
    bad({ rating: 'cinco' }, /estrellas/);
    bad({ rating: undefined }, /estrellas/);
    bad({ title: 'T'.repeat(81) }, /título/);
    bad({ body: 'corto' }, /al menos 10/);
    bad({ body: 'x'.repeat(601) }, /muy larga/);
  });
  test('no permite enlaces (ni en el nombre, ni en el título, ni en el comentario)', () => {
    bad({ body: 'Compra barato en https://spam.example ahora' }, /enlaces/);
    bad({ body: 'Mira www.spam.example para ofertas' }, /enlaces/);
    bad({ title: 'visita http://x.co' }, /enlaces/);
    bad({ name: 'www.spam.example' }, /enlaces/);
  });
  test('el texto se guarda tal cual: escapar es cosa de quien lo muestra', () => {
    const db = seeded();
    const { review } = addReview(db, 1, { ...good, body: '<img src=x onerror=alert(1)> muy lindo aroma' });
    assert.equal(review.body, '<img src=x onerror=alert(1)> muy lindo aroma');
  });
});

describe('reseñas de un producto', () => {
  test('publicar suma al resumen, aparece primero y no admite dos veces lo mismo', () => {
    const db = seeded();
    const before = summary(db, 3);
    const out = addReview(db, 3, { ...good, rating: 1, body: 'No me gustó nada, se acabó rápido.' });
    assert.equal(out.review.sample, false);
    assert.equal(out.summary.count, before.count + 1);
    assert.equal(out.summary.dist[1], before.dist[1] + 1);
    assert.equal(listReviews(db, 3).reviews[0].id, out.review.id, 'la más nueva va primero');
    assert.throws(() => addReview(db, 3, { ...good, rating: 1, body: 'No me gustó nada, se acabó rápido.' }), (e) => e.status === 409);
    assert.equal(summary(db, 3).count, before.count + 1);
  });
  test('el promedio se calcula con un decimal', () => {
    const db = seeded();
    const pid = db.prepare('SELECT id FROM products p WHERE NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = p.id) LIMIT 1').get().id;
    assert.deepEqual(summary(db, pid), { avg: 0, count: 0, dist: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    addReview(db, pid, { ...good, name: 'Ana', rating: 5, body: 'Excelente en todo sentido.' });
    addReview(db, pid, { ...good, name: 'Beto', rating: 4, body: 'Muy bueno, lo recomiendo.' });
    addReview(db, pid, { ...good, name: 'Cata', rating: 4, body: 'Bueno, aunque dura poco.' });
    assert.deepEqual(summary(db, pid), { avg: 4.3, count: 3, dist: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 } });
  });
  test('un producto que no existe o está inactivo no admite reseñas', () => {
    const db = seeded();
    assert.throws(() => addReview(db, 99999, good), (e) => e.status === 404);
    db.prepare('UPDATE products SET active = 0 WHERE id = 2').run();
    assert.throws(() => addReview(db, 2, good), (e) => e.status === 404);
  });
  test('la lista se pagina sin repetir ni saltarse reseñas', () => {
    const db = seeded();
    const pid = db.prepare('SELECT id FROM products LIMIT 1').get().id;
    for (let i = 0; i < 12; i++) addReview(db, pid, { ...good, name: `Persona ${i}`, body: `Comentario número ${i} de prueba.` });
    const total = summary(db, pid).count;
    const seen = new Set();
    let page = 1;
    for (;;) {
      const r = listReviews(db, pid, { page, limit: 5 });
      assert.equal(r.total, total);
      for (const x of r.reviews) { assert.ok(!seen.has(x.id), 'sin repetidas'); seen.add(x.id); }
      if (page >= r.pages) break;
      page++;
    }
    assert.equal(seen.size, total);
    assert.equal(listReviews(db, pid, { page: 999, limit: 5 }).page, Math.ceil(total / 5), 'una página fuera de rango se acota');
  });
  test('moderación: se lista lo más reciente y se elimina', () => {
    const db = seeded();
    const { review } = addReview(db, 1, good);
    const recent = listRecent(db, { limit: 5 });
    assert.equal(recent.reviews[0].id, review.id);
    assert.equal(recent.reviews[0].product_name, db.prepare('SELECT name FROM products WHERE id = 1').get().name);
    assert.deepEqual(removeReview(db, review.id), { ok: true });
    assert.throws(() => removeReview(db, review.id), (e) => e.status === 404);
  });
});

describe('productos recomendados', () => {
  const db = seeded();
  test('no incluye al propio producto, trae variantes y prefiere lo parecido y con existencias', () => {
    const base = db.prepare("SELECT id, family, category FROM products WHERE name = 'Rosa Imperial' AND kind = 'Perfume'").get();
    const rel = relatedProducts(db, base.id, 6);
    assert.equal(rel.length, 6);
    assert.ok(!rel.some((p) => p.id === base.id));
    assert.ok(rel.every((p) => p.variants.length >= 1));
    assert.ok(rel[0].family === base.family || rel[0].category === base.category, 'lo primero es parecido');
    const inStock = rel.map((p) => p.total_stock > 0);
    assert.deepEqual(inStock, [...inStock].sort((a, b) => b - a), 'los agotados van al final');
  });
  test('un producto inexistente devuelve null y el límite se acota', () => {
    assert.equal(relatedProducts(db, 99999), null);
    assert.equal(relatedProducts(db, 1, 1).length, 1);
    assert.ok(relatedProducts(db, 1, 500).length <= 24);
  });
  test('con 8.500 productos responde rápido', () => {
    const big = openDb(':memory:');
    seedLarge(big, 8500);
    const t0 = performance.now();
    const rel = relatedProducts(big, 4200, 8);
    const ms = performance.now() - t0;
    assert.equal(rel.length, 8);
    assert.ok(ms < 400, `recomendados con 8.500 productos: ${ms.toFixed(0)} ms`);
  });
});

describe('API', () => {
  let app, base, token;
  const api = async (path, { method = 'GET', body, auth = false, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  before(async () => {
    app = createApp({ dbPath: ':memory:', password: 'test-pw', reviewLimits: { perIp: 4 }, chatFactory: () => ({ enabled: false, reason: 'apagado' }) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    token = (await api('/api/login', { method: 'POST', body: { password: 'test-pw' } })).data.token;
  });
  after(() => app.server.close());

  test('la ficha trae el resumen de calificaciones; los recomendados y las reseñas tienen su ruta', async () => {
    const p = (await api('/api/products/11')).data;
    assert.equal(typeof p.rating.avg, 'number');
    assert.equal(typeof p.rating.count, 'number');
    const rel = await api('/api/products/11/related?limit=4');
    assert.equal(rel.status, 200);
    assert.equal(rel.data.products.length, 4);
    assert.ok(!rel.data.products.some((x) => x.id === 11));
    const rv = await api('/api/products/11/reviews?limit=2');
    assert.equal(rv.status, 200);
    assert.ok(rv.data.reviews.length <= 2 && rv.data.summary.count === p.rating.count && rv.data.pages >= 1);
    for (const path of ['/api/products/99999', '/api/products/99999/related', '/api/products/99999/reviews']) assert.equal((await api(path)).status, 404, path);
  });

  test('publicar una reseña: 201 con la reseña y el resumen nuevo; los errores dan 400 con mensaje', async () => {
    const before = (await api('/api/products/12/reviews')).data.summary.count;
    const ok = await api('/api/products/12/reviews', { method: 'POST', body: good });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.review.author, 'Lucía Prueba');
    assert.equal(ok.data.summary.count, before + 1);
    assert.equal((await api('/api/products/12/reviews')).data.reviews[0].id, ok.data.review.id);
    const bad = await api('/api/products/12/reviews', { method: 'POST', body: { ...good, rating: 9 } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /estrellas/);
    assert.equal((await api('/api/products/12/reviews', { method: 'POST', body: good })).status, 409, 'la misma reseña dos veces');
    assert.equal((await api('/api/products/99999/reviews', { method: 'POST', body: good })).status, 404);
  });

  test('el campo trampa «website» y el tope por visitante frenan el abuso', async () => {
    const trap = await api('/api/products/13/reviews', { method: 'POST', body: { ...good, website: 'http://spam' } });
    assert.equal(trap.status, 400);
    const count = (await api('/api/products/13/reviews')).data.summary.count;
    // el tope es de 4 por visitante: ya se usaron 2 (la buena y la repetida de arriba cuentan 2; la 400 de validación también cuenta)
    let last;
    for (let i = 0; i < 8; i++) last = await api('/api/products/13/reviews', { method: 'POST', body: { ...good, name: `Prueba ${i}`, body: `Comentario de prueba número ${i}.` } });
    assert.equal(last.status, 429);
    assert.match(last.data.error, /varias reseñas/);
    const after = (await api('/api/products/13/reviews')).data.summary.count;
    assert.ok(after - count <= 4, `no se pasó del tope: ${after - count}`);
  });

  test('moderación: el panel exige sesión; con sesión lista y elimina, y la ficha lo refleja', async () => {
    assert.equal((await api('/api/admin/reviews')).status, 401);
    assert.equal((await api('/api/admin/reviews/1', { method: 'DELETE' })).status, 401);
    const list = await api('/api/admin/reviews?limit=5', { auth: true });
    assert.equal(list.status, 200);
    assert.ok(list.data.reviews.length === 5 && list.data.total > 5 && list.data.reviews[0].product_name);
    const target = list.data.reviews[0];
    const sum0 = (await api(`/api/products/${target.product_id}/reviews`)).data.summary.count;
    assert.equal((await api(`/api/admin/reviews/${target.id}`, { method: 'DELETE', auth: true })).status, 200);
    assert.equal((await api(`/api/products/${target.product_id}/reviews`)).data.summary.count, sum0 - 1);
    assert.equal((await api(`/api/admin/reviews/${target.id}`, { method: 'DELETE', auth: true })).status, 404);
  });

  test('«Reiniciar demo» borra las reseñas escritas y vuelve a las de ejemplo', async () => {
    assert.equal((await api('/api/admin/reset', { method: 'POST', auth: true })).status, 200);
    const all = (await api('/api/admin/reviews?limit=100', { auth: true })).data;
    assert.ok(all.total >= 30);
    assert.ok(!all.reviews.some((r) => r.author === 'Lucía Prueba'), 'las de prueba ya no están');
    assert.ok(all.reviews.every((r) => r.sample));
  });
});
