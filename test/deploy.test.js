// Despliegue en Netlify: sitio estático, función con estado compartido entre instancias, sesiones firmadas e IP detrás de un proxy.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { buildChat } from '../chat-env.js';
import { ancestors } from '../frames.js';
import { createDemoState } from '../netlify/lib/demo-state.mjs';
import { demoState, config } from '../netlify/functions/api.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'dluxe-deploy-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Doble de Netlify Blobs: mismo contrato (get/set), en memoria, con registro de escrituras.
const fakeStore = () => {
  const m = new Map();
  const sets = [];
  return { m, sets, get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { sets.push(k); m.set(k, v); } };
};
const OPTS = { password: 'pw-demo', trustProxy: true, chatFactory: (db) => buildChat(db, { CHATBOT: 'local' }) };
let n = 0;
// Cada "instancia" tiene su propia carpeta temporal, como cada contenedor de la función tendría su /tmp.
const instance = (store, extra = {}) => createDemoState({ store, createOptions: { ...OPTS, ...extra }, dir: join(tmp, `i${++n}`), retireAfterMs: 5 });
const call = (inst, path, { method = 'GET', body, token, headers = {} } = {}) =>
  inst.handle(new Request(`https://demo.example.com${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }));
const json = async (res) => res.json();

describe('estado compartido entre instancias de la función', () => {
  test('la primera instancia siembra la base y sube la copia inicial; las lecturas no vuelven a subir nada', async () => {
    const store = fakeStore();
    const a = instance(store);
    try {
      const res = await call(a, '/api/products');
      assert.equal(res.status, 200);
      assert.equal((await json(res)).products.length, 25);
      assert.deepEqual(store.sets, ['db', 'version']);
      const baseline = store.sets.length;
      await call(a, '/api/products?q=jazmin');
      await call(a, '/api/brands');
      assert.equal(store.sets.length, baseline, 'leer no guarda');
    } finally {
      await a.close();
    }
  });

  test('una compra hecha en una instancia la ve otra instancia (stock y pedido en el panel)', async () => {
    const store = fakeStore();
    const a = instance(store);
    const b = instance(store);
    try {
      await call(b, '/api/products'); // b ya cargó la copia inicial: queda "vieja" cuando a escriba
      const list = (await json(await call(a, '/api/products?limit=25'))).products;
      const p = list.find((x) => x.variants.some((v) => v.stock > 4));
      const v = p.variants.find((x) => x.stock > 4);
      const order = await call(a, '/api/orders', { method: 'POST', body: { customer: { name: 'Visitante', email: 'v@example.com', phone: '1' }, payment_method: 'tarjeta', delivery: 'retiro', items: [{ variant_id: v.id, qty: 2 }] } });
      assert.equal(order.status, 201);
      assert.equal(store.sets.filter((k) => k === 'version').length, 2, 'la compra subió una versión nueva');

      const seen = await json(await call(b, `/api/products/${p.id}`));
      assert.equal(seen.variants.find((x) => x.id === v.id).stock, v.stock - 2, 'la otra instancia ve el stock descontado');

      const login = await json(await call(b, '/api/login', { method: 'POST', body: { password: 'pw-demo' } }));
      const orders = await json(await call(b, '/api/admin/orders', { token: login.token }));
      assert.ok(orders.some((o) => o.customer_name === 'Visitante'), 'el pedido aparece en el panel servido por otra instancia');
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('la sesión del panel iniciada en una instancia vale en otra', async () => {
    const store = fakeStore();
    const a = instance(store);
    const b = instance(store);
    try {
      const { token } = await json(await call(a, '/api/login', { method: 'POST', body: { password: 'pw-demo' } }));
      assert.equal((await call(b, '/api/admin/dashboard', { token })).status, 200);
      assert.equal((await call(b, '/api/admin/dashboard')).status, 401);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('lo que no cambia datos (chat, errores, contraseña mala) no sube copias nuevas', async () => {
    const store = fakeStore();
    const a = instance(store);
    try {
      await call(a, '/api/products');
      const before = store.sets.length;
      const chat = await call(a, '/api/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'hola' }] } });
      assert.match(await chat.text(), /Aura/);
      assert.equal((await call(a, '/api/login', { method: 'POST', body: { password: 'mala' } })).status, 401);
      const p = (await json(await call(a, '/api/products?limit=1'))).products[0];
      const bad = await call(a, '/api/orders', { method: 'POST', body: { customer: { name: 'x', email: 'x@example.com', phone: '1' }, payment_method: 'tarjeta', delivery: 'retiro', items: [{ variant_id: p.variants[0].id, qty: p.variants[0].stock + 1 }] } });
      assert.equal(bad.status, 409, 'más de lo que hay: se rechaza y no se guarda nada');
      assert.equal(store.sets.length, before);
    } finally {
      await a.close();
    }
  });

  test('«Reiniciar demo» se propaga a las demás instancias', async () => {
    const store = fakeStore();
    const a = instance(store);
    const b = instance(store);
    try {
      const { token } = await json(await call(a, '/api/login', { method: 'POST', body: { password: 'pw-demo' } }));
      const total = async (inst) => (await json(await call(inst, '/api/admin/orders', { token }))).length;
      await call(b, '/api/products');
      const before = await total(b);
      assert.equal((await call(a, '/api/admin/reset', { method: 'POST', token, body: {} })).status, 200);
      const after = await total(b);
      assert.ok(after <= before && after > 0, 'la copia nueva llega a la otra instancia');
      assert.equal(store.sets.filter((k) => k === 'version').length, 2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('peticiones simultáneas se atienden bien (de a una por instancia)', async () => {
    const store = fakeStore();
    const a = instance(store);
    try {
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(a, `/api/products?page=${(i % 2) + 1}&limit=10`)));
      assert.ok(rs.every((r) => r.status === 200));
    } finally {
      await a.close();
    }
  });

  test('las cabeceras del proxy llegan a la app: la IP del visitante manda en los cupos del chat', async () => {
    const store = fakeStore();
    const a = instance(store, { chatLimits: { perIp: 1, windowMs: 60_000, daily: 100, parallel: 2 } });
    try {
      const say = async (ip) => {
        const res = await call(a, '/api/chat', { method: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: { messages: [{ role: 'user', content: 'hola' }] } });
        await res.text();
        return res.status;
      };
      assert.equal(await say('203.0.113.10'), 200);
      assert.equal(await say('203.0.113.11'), 200, 'otro visitante tiene su propio cupo');
      assert.equal(await say('203.0.113.10'), 429, 'el mismo visitante lo agota');
    } finally {
      await a.close();
    }
  });

  test('la función completa (api.mjs): ruta /api/*, contraseña y marca por entorno', async () => {
    assert.equal(config.path, '/api/*');
    const store = fakeStore();
    const inst = demoState(store, { ADMIN_PASSWORD: 'otra-clave', CHATBOT: 'local' });
    try {
      const res = await call(inst, '/api/brand');
      assert.equal((await json(res)).short, "D'Luxe");
      assert.equal((await call(inst, '/api/login', { method: 'POST', body: { password: 'admin123' } })).status, 401);
      assert.equal((await call(inst, '/api/login', { method: 'POST', body: { password: 'otra-clave' } })).status, 200);
      const sinFoto = (await json(await call(inst, '/api/products?limit=25'))).products.filter((p) => !p.image);
      assert.equal(sinFoto.length, 0, 'las fotos de ejemplo se reparten también dentro de la función');
    } finally {
      await inst.close();
    }
  });
});

describe('sesiones firmadas y proxy en la app', () => {
  const start = async (opts) => {
    const app = createApp({ dbPath: ':memory:', chatFactory: () => ({ enabled: false, reason: 'apagado' }), ...opts });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = (password) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }).then((r) => r.json());
    const dash = (token) => fetch(`${base}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
    return { app, base, login, dash };
  };

  test('el mismo token vale en otra instancia con la misma contraseña, y en ninguna con otra', async () => {
    const [x, y, z] = await Promise.all([start({ password: 'uno' }), start({ password: 'uno' }), start({ password: 'dos' })]);
    try {
      const { token } = await x.login('uno');
      assert.equal(await y.dash(token), 200);
      assert.equal(await z.dash(token), 401, 'otra contraseña, otra clave de firma');
    } finally {
      for (const s of [x, y, z]) s.app.server.close();
    }
  });
  test('un token alterado, vencido o inventado se rechaza', async () => {
    const x = await start({ password: 'uno' });
    const realNow = Date.now;
    try {
      const { token } = await x.login('uno');
      const [exp, sig] = token.split('_');
      assert.equal(await x.dash(`${exp}_${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`), 401, 'firma alterada');
      assert.equal(await x.dash(`${(parseInt(exp, 36) + 3_600_000).toString(36)}_${sig}`), 401, 'vencimiento alargado a mano');
      assert.equal(await x.dash('abc'), 401);
      assert.equal(await x.dash(`${'0'.repeat(3)}_${'0'.repeat(64)}`), 401);
      Date.now = () => realNow() + 13 * 3600e3; // pasan 13 horas
      assert.equal(await x.dash(token), 401, 'vencida');
    } finally {
      Date.now = realNow;
      x.app.server.close();
    }
  });
  test('sin proxy de confianza, las cabeceras de IP se ignoran (no se puede falsear el cupo)', async () => {
    const x = await start({ password: 'p', trustProxy: false, chatFactory: (db) => buildChat(db, { CHATBOT: 'local' }), chatLimits: { perIp: 1, windowMs: 60_000, daily: 100, parallel: 2 } });
    try {
      const say = async (ip) => {
        const r = await fetch(`${x.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': ip, 'x-forwarded-for': ip }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hola' }] }) });
        await r.text();
        return r.status;
      };
      assert.equal(await say('1.1.1.1'), 200);
      assert.equal(await say('2.2.2.2'), 429);
    } finally {
      x.app.server.close();
    }
  });
  test('el pie del acceso al panel solo muestra la contraseña cuando es la de demostración', async () => {
    const a = await start({});
    const b = await start({ password: 'secreta' });
    try {
      assert.match(await fetch(`${a.base}/admin`).then((r) => r.text()), /Demo: la contraseña es <strong>admin123/);
      const html = await fetch(`${b.base}/admin`).then((r) => r.text());
      assert.ok(!html.includes('Demo: la contraseña') && !html.includes('secreta') && !html.includes('{{'));
    } finally {
      a.app.server.close();
      b.app.server.close();
    }
  });
  test('la tienda solo se puede mostrar en iframes de los sitios autorizados; el panel nunca', async () => {
    const x = await start({ frameOrigins: 'https://mi-sitio.com, javascript:alert(1), https://www.mi-sitio.com' });
    try {
      assert.equal((await fetch(`${x.base}/`)).headers.get('content-security-policy'), "frame-ancestors 'self' https://mi-sitio.com https://www.mi-sitio.com");
      assert.equal((await fetch(`${x.base}/admin`)).headers.get('content-security-policy'), "frame-ancestors 'self'");
    } finally {
      x.app.server.close();
    }
  });
  test('ancestors(): solo orígenes válidos; "*" para pruebas', () => {
    assert.equal(ancestors(''), "'self'");
    assert.equal(ancestors(undefined), "'self'");
    assert.equal(ancestors('*'), "'self' *");
    assert.equal(ancestors('https://a.com:8443, http://localhost:3000, a.com, https://a.com/ruta, data:text/html'), "'self' https://a.com:8443 http://localhost:3000");
  });
  test('ancestors(): «https://*.sitio.com» admite subdominios, pero no comodines demasiado amplios ni mal puestos', () => {
    assert.equal(ancestors('https://*.mi-sitio.netlify.app'), "'self' https://*.mi-sitio.netlify.app");
    assert.equal(ancestors('https://mi-sitio.netlify.app, https://*.mi-sitio.netlify.app, http://localhost:3000'), "'self' https://mi-sitio.netlify.app https://*.mi-sitio.netlify.app http://localhost:3000");
    for (const malo of ['https://*.com', 'https://*', 'https://a.*.com', 'https://*.a.com/ruta', 'https://**.a.com', '*.a.com', 'https://a.com.*']) {
      assert.equal(ancestors(malo), "'self'", malo);
    }
  });
});

describe('sitio estático para Netlify (scripts/build-netlify.mjs)', () => {
  const build = (env = {}) => {
    const out = join(tmp, `dist-${++n}`);
    execFileSync(process.execPath, ['scripts/build-netlify.mjs'], { cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, BUILD_OUT: out, ...env }, stdio: 'pipe' });
    return out;
  };
  const read = (out, f) => readFileSync(join(out, f), 'utf8');

  test('arma las páginas con la marca, sin marcadores y con todos los archivos', () => {
    const out = build();
    for (const f of ['index.html', 'admin.html', 'embed.html']) {
      const html = read(out, f);
      assert.ok(!html.includes('{{') && !html.includes('<!--BRAND-->'), `${f} sin marcadores`);
      assert.match(html, /D&#39;Luxe/);
      assert.match(html, /window\.__BRAND=/);
    }
    for (const f of ['css/store.css', 'js/store.js', 'embed.js', 'img/p25.jpg', 'img/hero.jpg', 'samples/woocommerce-export-demo.csv', '_headers']) assert.ok(existsSync(join(out, f)), f);
    assert.ok(!read(out, 'admin.html').includes('Demo: la contraseña'), 'el panel no muestra contraseñas por defecto');
  });
  test('cabeceras: por defecto nada se puede incrustar; con FRAME_ORIGINS solo la tienda, con EMBED_ORIGINS solo el chat', () => {
    const none = read(build(), '_headers');
    assert.ok(!/https?:\/\//.test(none), 'sin orígenes ajenos');
    const h = read(build({ FRAME_ORIGINS: 'https://mi-sitio.com', EMBED_ORIGINS: 'https://chat.mi-sitio.com,malo' }), '_headers');
    assert.match(h, /\/index\.html\n  Content-Security-Policy: frame-ancestors 'self' https:\/\/mi-sitio\.com\n/);
    assert.match(h, /\/admin\.html\n  Content-Security-Policy: frame-ancestors 'self'\n/);
    assert.match(h, /\/embed\.html\n  Content-Security-Policy: frame-ancestors 'self' https:\/\/chat\.mi-sitio\.com\n/);
    assert.ok(!h.includes('malo'));
  });
  test('DEMO_SHOW_ADMIN_PASSWORD muestra la contraseña elegida en el acceso al panel (y escapada)', () => {
    const html = read(build({ DEMO_SHOW_ADMIN_PASSWORD: '1', ADMIN_PASSWORD: 'clave<demo>' }), 'admin.html');
    assert.match(html, /<strong>clave&lt;demo&gt;<\/strong>/);
  });
  test('netlify.toml: publica dist, enruta las direcciones sin extensión y fija Node', () => {
    const toml = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
    assert.match(toml, /publish = "dist"/);
    assert.match(toml, /command = "node scripts\/build-netlify\.mjs"/);
    assert.match(toml, /from = "\/admin"\s+to = "\/admin\.html"\s+status = 200/);
    assert.match(toml, /NODE_VERSION = "24"/);
  });
});
