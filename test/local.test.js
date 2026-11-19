// Pruebas del asistente local (sin IA): entiende español cotidiano y responde con el catálogo real.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { resetAndSeed } from '../seed.js';
import { createApp } from '../app.js';
import { buildChat } from '../chat-env.js';
import { respond, createLocalChatService } from '../chatbot-local.js';
import { sanitizeContext, searchCatalog } from '../chatbot.js';

const setup = () => {
  const db = openDb(':memory:');
  resetAndSeed(db);
  return db;
};
const pid = (db, name) => db.prepare('SELECT id FROM products WHERE name = ?').get(name).id;
const cards = (r) => r.events.filter((e) => e.type === 'cards').flatMap((e) => e.products);
const action = (r) => r.events.find((e) => e.type === 'action');

describe('conversación básica', () => {
  const db = setup();
  test('saluda, agradece y se despide', () => {
    assert.match(respond(db, { text: 'Hola' }).text, /Aura/);
    assert.match(respond(db, { text: 'Buenas tardes' }).text, /Aura/);
    assert.match(respond(db, { text: 'muchas gracias' }).text, /Con gusto/);
    assert.match(respond(db, { text: 'chao' }).text, /pronto/);
  });
  test('responde horario, entregas y pagos (y varios a la vez)', () => {
    assert.match(respond(db, { text: '¿A qué hora abren?' }).text, /9:00 a 19:00/);
    assert.match(respond(db, { text: 'hacen envíos a domicilio?' }).text, /retirar/);
    assert.match(respond(db, { text: 'puedo pagar con transferencia' }).text, /transferencia/);
    const both = respond(db, { text: '¿Cómo son los envíos y los pagos?' }).text;
    assert.ok(/retirar/.test(both) && /transferencia/.test(both));
  });
  test('lo que no sabe (devoluciones, facturas) lo dice en vez de inventar', () => {
    for (const q of ['¿Hacen devoluciones?', 'necesito una factura']) {
      assert.match(respond(db, { text: q }).text, /no lo tengo|equipo de la tienda/i, q);
    }
  });
  test('dice dónde está la tienda y quiénes son, con lo que trae brand.json', () => {
    assert.match(respond(db, { text: 'dónde queda la tienda' }).text, /Plaza Aurora/);
    const who = respond(db, { text: '¿Quiénes son ustedes?' }).text;
    assert.match(who, /Maison Aurora nació/);
    assert.match(who, /Llevamos \d+ años/);
    assert.match(respond(db, { text: '¿desde cuándo existen?' }).text, /2012/);
  });
  test('lo que no entiende o está fuera de tema no inventa recomendaciones', () => {
    for (const q of ['cuál es la capital de Francia', 'qué opinas del fútbol', 'asdfgh']) {
      const r = respond(db, { text: q });
      assert.match(r.text, /No estoy segura/, q);
      assert.equal(r.events.length, 0, q);
    }
  });
  test('ayuda explica qué puede hacer', () => {
    assert.match(respond(db, { text: 'qué puedes hacer' }).text, /Elegir un perfume/);
  });
  test('pasar con una persona: sin número avisa; con número entrega un enlace de WhatsApp válido', () => {
    const sin = respond(db, { text: 'quiero hablar con una persona' });
    assert.equal(sin.events.length, 0);
    assert.match(sin.text, /aún no tiene un contacto/);
    const con = respond(db, { text: 'quiero hablar con un asesor', whatsapp: '50760000000' });
    const link = con.events.find((e) => e.type === 'link');
    assert.match(link.url, /^https:\/\/wa\.me\/50760000000\?text=/);
  });
});

describe('recomendaciones', () => {
  const db = setup();
  test('"fresco para el día a día" da frescos/cítricos y NO fragmentos (regresión: "dia" en "Medianoche")', () => {
    const r = respond(db, { text: 'Algo fresco para el día a día' });
    const found = cards(r);
    assert.ok(found.length >= 2);
    assert.ok(found.every((p) => ['Fresco', 'Cítrico', 'Aromático'].includes(p.family)), found.map((p) => `${p.name}:${p.family}`).join(', '));
    assert.ok(!found.some((p) => p.name === 'Medianoche Negro'));
  });
  test('respeta categoría y presupuesto', () => {
    const r = respond(db, { text: 'Un perfume para hombre de menos de $80' });
    const found = cards(r);
    assert.ok(found.length >= 1);
    assert.ok(found.every((p) => p.category === 'Caballeros' && p.variants.some((v) => v.price <= 80)));
    assert.match(r.text, /hasta \$80\.00/);
  });
  test('entiende "ella" y "dulce"', () => {
    const found = cards(respond(db, { text: 'algo dulce para ella' }));
    assert.ok(found.length >= 1 && found.every((p) => p.category === 'Damas'));
  });
  test('busca por notas ("vainilla") y pone primero lo más relevante', () => {
    assert.equal(cards(respond(db, { text: '¿Qué tienen con vainilla?' }))[0].name, 'Vainilla Dorada');
  });
  test('"el más barato" ordena por precio', () => {
    const found = cards(respond(db, { text: 'el más barato para mujer' }));
    assert.ok(found.length >= 1 && found.every((p) => p.category === 'Damas'), '"mujer" en singular debe filtrar por categoría');
    const mins = found.map((p) => Math.min(...p.variants.filter((v) => v.stock > 0).map((v) => v.price)));
    assert.deepEqual(mins, [...mins].sort((a, b) => a - b));
  });
  test('un regalo sin más datos pregunta para quién es', () => {
    const r = respond(db, { text: 'Quiero un perfume para regalar' });
    assert.ok(cards(r).length >= 1);
    assert.match(r.text, /hombre o .* mujer/);
  });
  test('presupuesto imposible: lo dice y muestra lo más cercano', () => {
    const r = respond(db, { text: 'perfume para mujer de menos de $5' });
    assert.match(r.text, /No tengo perfumes de damas por debajo de \$5\.00/);
  });
  test('una petición vaga pide los datos que faltan', () => {
    assert.match(respond(db, { text: 'quiero un perfume' }).text, /¿Para quién es\?/);
  });
  test('no muestra productos agotados en las recomendaciones', () => {
    const db2 = setup();
    db2.prepare('UPDATE variants SET stock = 0 WHERE product_id = ?').run(pid(db2, 'Vainilla Dorada'));
    assert.ok(!cards(respond(db2, { text: 'algo con vainilla' })).some((p) => p.name === 'Vainilla Dorada'));
  });
});

describe('fichas de producto', () => {
  const db = setup();
  test('"cuánto cuesta X" da precios y existencias reales por tamaño', () => {
    const r = respond(db, { text: 'cuanto cuesta el vetiver real' });
    assert.match(r.text, /30 ml: \$64\.00/);
    assert.match(r.text, /100 ml: \$177\.00/);
    assert.equal(cards(r)[0].name, 'Vetiver Real');
  });
  test('un tamaño agotado se declara agotado', () => {
    assert.match(respond(db, { text: 'tienes ámbar nocturno?' }).text, /50 ml: \$128\.00 \(agotado\)/);
  });
  test('un producto totalmente agotado ofrece alternativas parecidas', () => {
    const db2 = setup();
    db2.prepare('UPDATE variants SET stock = 0 WHERE product_id = ?').run(pid(db2, 'Cedro & Cuero'));
    const r = respond(db2, { text: 'tienen cedro & cuero' });
    assert.match(r.text, /agotado/);
    assert.match(r.text, /parecido/);
  });
  test('un nombre parcial de un solo producto también abre su ficha', () => {
    assert.equal(cards(respond(db, { text: 'háblame del vetiver' }))[0].name, 'Vetiver Real');
  });
  test('nunca expone costos ni márgenes', () => {
    const all = ['cuanto cuesta el vetiver real', 'algo fresco', 'regalo', 'qué puedes hacer'].map((t) => JSON.stringify(respond(db, { text: t })));
    assert.ok(!/"cost"|margen|margin|supplier/i.test(all.join('')));
  });
});

describe('agregar a la bolsa', () => {
  const db = setup();
  test('con producto y tamaño: agrega y emite la acción', () => {
    const r = respond(db, { text: 'agrega el vetiver real de 50 ml a mi bolsa' });
    assert.equal(action(r).qty, 1);
    assert.match(action(r).label, /Vetiver Real 50 ml/);
    assert.match(r.text, /Listo, agregué/);
  });
  test('entiende la cantidad', () => {
    assert.equal(action(respond(db, { text: 'agrega 2 cedro y cuero de 30' })).qty, 2);
    assert.equal(action(respond(db, { text: 'agrega tres vetiver real de 30 ml' })).qty, 3);
  });
  test('sin tamaño pregunta cuál (mostrando solo los disponibles)', () => {
    const r = respond(db, { text: 'agrega la vainilla dorada' });
    assert.equal(action(r), undefined);
    assert.match(r.text, /¿Qué tamaño prefieres/);
  });
  test('"agrégalo" usa la tarjeta que acaba de ver y luego entiende "el de 100 ml"', () => {
    const lastIds = [pid(db, 'Vetiver Real')];
    const ask = respond(db, { text: 'agrégalo', lastIds });
    assert.match(ask.text, /¿Qué tamaño prefieres para \*\*Vetiver Real\*\*/);
    const done = respond(db, { text: 'el de 100 ml', prev: ask.text, lastIds });
    assert.match(action(done).label, /Vetiver Real 100 ml/);
  });
  test('"el segundo" elige entre varias tarjetas', () => {
    const ids = [pid(db, 'Vetiver Real'), pid(db, 'Medianoche Negro'), pid(db, 'Té Blanco')];
    assert.match(respond(db, { text: 'me llevo el segundo', lastIds: ids }).text, /Medianoche Negro/);
  });
  test('elegir una tarjeta con solo "la primera" / "quiero el segundo" / "el último" abre su ficha', () => {
    const ids = [pid(db, 'Vetiver Real'), pid(db, 'Medianoche Negro'), pid(db, 'Té Blanco')];
    assert.equal(cards(respond(db, { text: 'la primera', lastIds: ids }))[0].name, 'Vetiver Real');
    assert.equal(cards(respond(db, { text: 'Quiero el segundo', lastIds: ids }))[0].name, 'Medianoche Negro');
    assert.equal(cards(respond(db, { text: 'me interesa el último', lastIds: ids }))[0].name, 'Té Blanco');
  });
  test('"la primera" sin tarjetas previas no inventa nada', () => {
    assert.match(respond(db, { text: 'la primera' }).text, /No estoy segura|Con gusto te ayudo/);
  });
  test('con varias tarjetas y sin pista, pregunta cuál', () => {
    const ids = [pid(db, 'Vetiver Real'), pid(db, 'Medianoche Negro')];
    assert.match(respond(db, { text: 'agrégame uno', lastIds: ids }).text, /¿Cuál quieres agregar\?/);
  });
  test('un tamaño agotado no se agrega', () => {
    const r = respond(db, { text: 'agrega ámbar nocturno de 50' });
    assert.equal(action(r), undefined);
    assert.match(r.text, /agotado/);
  });
  test('respeta el stock real', () => {
    const db2 = setup();
    db2.prepare('UPDATE variants SET stock = 1 WHERE product_id = ? AND size_ml = 50').run(pid(db2, 'Cedro & Cuero'));
    const r = respond(db2, { text: 'agrega 3 cedro y cuero de 50 ml' });
    assert.equal(action(r), undefined);
    assert.match(r.text, /Solo quedan 1/);
  });
  test('"quiero comprar un perfume" (genérico) NO agrega nada: recomienda', () => {
    const r = respond(db, { text: 'quiero comprar un perfume para mi papá', lastIds: [pid(db, 'Vetiver Real')] });
    assert.equal(action(r), undefined);
    assert.ok(cards(r).length >= 1);
  });
  test('sin producto claro pide el nombre', () => {
    assert.match(respond(db, { text: 'agrega uno a mi bolsa' }).text, /¿Cuál perfume/);
  });
});

describe('servicio y servidor', () => {
  test('transmite el texto por partes que, juntas, forman la respuesta completa', async () => {
    const db = setup();
    const svc = createLocalChatService({ db });
    const events = [];
    await svc.run({ messages: [{ role: 'user', content: 'cuanto cuesta el vetiver real' }], emit: (e) => events.push(e), signal: undefined });
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.equal(text, respond(db, { text: 'cuanto cuesta el vetiver real' }).text);
    assert.ok(events.filter((e) => e.type === 'text').length > 3, 'llega por partes');
    assert.equal(events.at(-1).type, 'cards');
  });
  test('si el cliente se va, deja de transmitir', async () => {
    const db = setup();
    const ac = new AbortController();
    const events = [];
    await createLocalChatService({ db }).run({
      messages: [{ role: 'user', content: 'cuanto cuesta el vetiver real' }],
      emit: (e) => { events.push(e); ac.abort(); },
      signal: ac.signal,
    });
    assert.equal(events.length, 1);
  });
  test('sanitizeContext solo deja ids enteros positivos (máx. 4)', () => {
    assert.deepEqual(sanitizeContext({ last_product_ids: [1, 'x', -2, 3.5, 4, 5, 6, 7] }), { last_product_ids: [1, 4, 5, 6] });
    assert.deepEqual(sanitizeContext(null), { last_product_ids: [] });
    assert.deepEqual(sanitizeContext({ last_product_ids: 'x' }), { last_product_ids: [] });
  });
  test('POST /api/chat sin clave responde con el asistente local y llega hasta "done"', async () => {
    const app = createApp({ dbPath: ':memory:', chatFactory: (db) => buildChat(db, {}) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      assert.deepEqual(await (await fetch(`${base}/api/chat/status`)).json(), { enabled: true, mode: 'local', whatsapp: false, reason: null });
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'algo con vainilla' }], context: { last_product_ids: [] } }),
      });
      const events = (await res.text()).split('\n\n').filter(Boolean).map((c) => JSON.parse(c.replace(/^data: /, '')));
      assert.ok(events.some((e) => e.type === 'cards'));
      assert.equal(events.at(-1).type, 'done');
    } finally {
      app.server.close();
    }
  });
  test('el asistente local tiene topes de uso más holgados (no cuesta nada)', async () => {
    const app = createApp({ dbPath: ':memory:', chatFactory: (db) => buildChat(db, {}) });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hola' }] }) });
        assert.equal(res.status, 200, `mensaje ${i + 1}`);
        await res.text();
      }
    } finally {
      app.server.close();
    }
  });
});

describe('búsqueda por palabras completas', () => {
  const db = setup();
  test('un fragmento dentro de otra palabra no coincide; el inicio de una palabra sí', () => {
    assert.equal(searchCatalog(db, { query: 'edianoc' }).total_matches, 0);
    assert.ok(searchCatalog(db, { query: 'marin' }).results.some((p) => p.name === 'Brisa Marina'));
  });
});
