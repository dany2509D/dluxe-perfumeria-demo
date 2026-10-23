// Chat embebible en otro sitio: página /embed, script embed.js, permiso de incrustación y enlaces de compra.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { buildChat } from '../chat-env.js';
import { openDb } from '../db.js';
import { resetAndSeed } from '../seed.js';
import { storeLinkFor } from '../woo-sync.js';

async function start(opts = {}) {
  const app = createApp({ dbPath: ':memory:', chatFactory: (db) => buildChat(db, { CHATBOT: 'local' }), ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
const chat = async (base, text, embed) => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: text }], embed }) });
  const raw = await res.text();
  return raw.split('\n\n').filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
};

describe('página y script del chat embebido', () => {
  let ctx;
  before(async () => { ctx = await start({ embedOrigins: 'https://tienda.example.com, http://localhost:8080, javascript:alert(1)' }); });
  after(() => ctx.app.server.close());

  test('/embed se sirve con el nombre de la marca y en modo embebido', async () => {
    const res = await fetch(`${ctx.base}/embed`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<html lang="es" data-embed>/);
    assert.ok(!html.includes('{{'));
    assert.match(html, /D&#39;Luxe/);
  });
  test('solo los orígenes autorizados pueden incrustarlo; el resto de páginas nunca', async () => {
    const embed = (await fetch(`${ctx.base}/embed`)).headers.get('content-security-policy');
    assert.equal(embed, "frame-ancestors 'self' https://tienda.example.com http://localhost:8080", 'se descartan valores que no son orígenes');
    for (const path of ['/', '/admin']) {
      assert.equal((await fetch(ctx.base + path)).headers.get('content-security-policy'), "frame-ancestors 'self'", path);
    }
  });
  test('sin EMBED_ORIGINS, ni siquiera el chat se deja incrustar fuera', async () => {
    const other = await start({ embedOrigins: '' });
    try {
      assert.equal((await fetch(`${other.base}/embed`)).headers.get('content-security-policy'), "frame-ancestors 'self'");
    } finally {
      other.app.server.close();
    }
  });
  test('embed.js se sirve como JavaScript y apunta a /embed de su propio servidor', async () => {
    const res = await fetch(`${ctx.base}/embed.js`);
    assert.match(res.headers.get('content-type'), /javascript/);
    const js = await res.text();
    assert.match(js, /base \+ '\/embed\?theme='/);
    assert.match(js, /new URL\(tag\.src\)\.origin/);
    assert.match(js, /e\.origin !== base/, 'solo escucha mensajes de su propio servidor');
  });
});

describe('enlaces de compra en el chat embebido', () => {
  let ctx;
  before(async () => {
    ctx = await start();
    const db = ctx.app.db;
    // Dos productos "de WooCommerce": uno simple (se agrega al carrito) y uno con variaciones (se elige tamaño en la página).
    db.prepare("UPDATE products SET permalink = 'https://tienda.example.com/producto/vetiver/' WHERE name = 'Vetiver Real'").run();
    db.prepare("UPDATE variants SET external_id = '77' WHERE sku = (SELECT sku FROM variants WHERE product_id = (SELECT id FROM products WHERE name = 'Vetiver Real') AND size_ml = 50)").run();
    db.prepare("UPDATE products SET permalink = 'https://tienda.example.com/producto/cedro/' WHERE name = 'Cedro & Cuero'").run();
    db.prepare("UPDATE variants SET external_id = '90:901' WHERE product_id = (SELECT id FROM products WHERE name = 'Cedro & Cuero') AND size_ml = 50").run();
  });
  after(() => ctx.app.server.close());

  test('producto simple de WooCommerce: enlace "?add-to-cart" en su propio dominio', async () => {
    const events = await chat(ctx.base, 'agrega 2 vetiver real de 50 ml a mi bolsa', true);
    assert.ok(!events.some((e) => e.type === 'action'), 'no se agrega a una bolsa que no existe en el otro sitio');
    const link = events.find((e) => e.type === 'link');
    assert.equal(link.url, 'https://tienda.example.com/?add-to-cart=77&quantity=2');
    assert.match(link.label, /Agregar Vetiver Real 50 ml/);
  });
  test('variación: lleva a la página del producto para elegir tamaño', async () => {
    const events = await chat(ctx.base, 'agrega cedro y cuero de 50 ml', true);
    const link = events.find((e) => e.type === 'link');
    assert.equal(link.url, 'https://tienda.example.com/producto/cedro/');
    assert.match(link.label, /Elegir tamaño/);
  });
  test('sin el modo embebido, el chat sigue agregando a la bolsa de la tienda', async () => {
    const events = await chat(ctx.base, 'agrega 2 vetiver real de 50 ml a mi bolsa', false);
    assert.ok(events.some((e) => e.type === 'action' && e.action === 'add_to_cart'));
    assert.ok(!events.some((e) => e.type === 'link'));
  });
  test('producto sin enlace de WooCommerce: abre la tienda de este sistema con la búsqueda', () => {
    const db = openDb(':memory:');
    resetAndSeed(db);
    const v = db.prepare("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Rosa Imperial' LIMIT 1").get();
    const link = storeLinkFor(db, v.id, 1, 'http://127.0.0.1:3000');
    assert.equal(link.url, 'http://127.0.0.1:3000/?q=Rosa%20Imperial');
    assert.equal(storeLinkFor(db, 999999, 1, 'http://x'), null);
    assert.equal(storeLinkFor(db, v.id, 1, ''), null);
  });
  test('la cantidad del enlace tiene tope', () => {
    const db = openDb(':memory:');
    resetAndSeed(db);
    db.prepare("UPDATE products SET permalink = 'https://t.example.com/p/' WHERE name = 'Rosa Imperial'").run();
    const v = db.prepare("SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Rosa Imperial' LIMIT 1").get();
    db.prepare('UPDATE variants SET external_id = ? WHERE id = ?').run('5', v.id);
    assert.match(storeLinkFor(db, v.id, 9999, '').url, /quantity=20$/);
    assert.match(storeLinkFor(db, v.id, -3, '').url, /quantity=1$/);
  });
});
