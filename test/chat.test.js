// Pruebas del asistente. No llaman a la API real: usan un cliente falso con la forma de las respuestas
// de Claude (bloques de razonamiento, tool_use, rechazos, errores) para verificar NUESTRA lógica.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { resetAndSeed } from '../seed.js';
import { createApp } from '../app.js';
import { buildChat } from '../chat-env.js';
import { SYSTEM_PROMPT, TOOLS, sanitizeMessages, searchCatalog, executeTool, echoContent, createChatService, friendlyError } from '../chatbot.js';

// ─── Cliente falso ──────────────────────────────────────────────────────────
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };

function fakeClient(script, { hold } = {}) {
  const calls = [];
  const signals = [];
  return {
    calls,
    signals,
    beta: {
      messages: {
        stream(params, opts = {}) {
          calls.push(structuredClone(params)); // copia: el bucle sigue agregando mensajes a `messages`
          signals.push(opts.signal);
          const resp = script[calls.length - 1];
          const handlers = {};
          return {
            on(evt, cb) { handlers[evt] = cb; return this; },
            async finalMessage() {
              if (hold) await hold;
              if (resp instanceof Error) throw resp;
              for (const b of resp.content) if (b.type === 'text') handlers.text?.(b.text);
              return { usage, model: params.model, ...resp };
            },
          };
        },
      },
    },
  };
}

const THINKING = { type: 'thinking', thinking: '', signature: 'sig-opaca-123' };
const toolUse = (name, input, id = 'toolu_1') => ({ type: 'tool_use', id, name, input });
const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function setup() {
  const db = openDb(':memory:');
  resetAndSeed(db);
  return db;
}

async function chat(service, text = 'hola') {
  const events = [];
  const u = await service.run({ messages: [{ role: 'user', content: text }], emit: (e) => events.push(e), signal: undefined });
  return { events, usage: u };
}

// ─── Entradas ───────────────────────────────────────────────────────────────
describe('sanitizeMessages', () => {
  test('acepta un historial válido y lo recorta a los últimos 12 mensajes', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    raw.push({ role: 'user', content: 'última' });
    const out = sanitizeMessages(raw);
    assert.ok(out.length <= 12);
    assert.equal(out[0].role, 'user');
    assert.equal(out.at(-1).content, 'última');
  });
  test('rechaza vacío, roles raros, mensajes vacíos y último mensaje del asistente', () => {
    assert.throws(() => sanitizeMessages([]), { status: 400 });
    assert.throws(() => sanitizeMessages('hola'), { status: 400 });
    assert.throws(() => sanitizeMessages([{ role: 'system', content: 'x' }]), { status: 400 });
    assert.throws(() => sanitizeMessages([{ role: 'user', content: '   ' }]), { status: 400 });
    assert.throws(() => sanitizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), { status: 400 });
  });
  test('rechaza un mensaje del cliente demasiado largo, pero no el contenido que no es texto', () => {
    assert.throws(() => sanitizeMessages([{ role: 'user', content: 'x'.repeat(601) }]), { status: 400 });
    assert.throws(() => sanitizeMessages([{ role: 'user', content: [{ type: 'text', text: 'hola' }] }]), { status: 400 });
  });
  test('descarta respuestas del asistente iniciales (el historial empieza con el cliente)', () => {
    const out = sanitizeMessages([{ role: 'assistant', content: 'hola' }, { role: 'user', content: 'quiero algo' }]);
    assert.deepEqual(out, [{ role: 'user', content: 'quiero algo' }]);
  });
});

// ─── Catálogo ───────────────────────────────────────────────────────────────
describe('searchCatalog', () => {
  const db = setup();
  test('encuentra por notas y pone lo más relevante primero', () => {
    const r = searchCatalog(db, { query: 'vainilla' });
    assert.ok(r.results.length >= 1);
    assert.equal(r.results[0].name, 'Vainilla Dorada');
  });
  test('ignora acentos y mayúsculas', () => {
    const a = searchCatalog(db, { query: 'ámbar' }).results.map((p) => p.id);
    const b = searchCatalog(db, { query: 'AMBAR' }).results.map((p) => p.id);
    assert.deepEqual(a, b);
    assert.ok(a.length >= 1);
  });
  test('filtra por categoría, familia y precio máximo', () => {
    const men = searchCatalog(db, { category: 'Caballeros' }).results;
    assert.ok(men.length >= 3 && men.every((p) => p.category === 'Caballeros'));
    assert.ok(searchCatalog(db, { family: 'fresco' }).results.every((p) => p.family === 'Fresco'));
    const cheap = searchCatalog(db, { max_price: 50 }).results;
    assert.ok(cheap.length >= 1 && cheap.every((p) => p.variants.some((v) => v.price <= 50)));
  });
  test('sin coincidencias avisa y devuelve el resumen del catálogo', () => {
    const r = searchCatalog(db, { query: 'zzzzzz' });
    assert.equal(r.total_matches, 0);
    assert.ok(r.note);
    assert.ok(r.catalog_summary.families.length >= 3);
  });
  test('nunca expone costos ni márgenes', () => {
    const json = JSON.stringify(searchCatalog(db, {}));
    assert.ok(!/"cost"|margin|supplier|min_stock/.test(json));
  });
  test('cada tamaño trae su id, precio, stock y estado', () => {
    const v = searchCatalog(db, {}).results[0].variants[0];
    assert.deepEqual(Object.keys(v).sort(), ['price', 'size_ml', 'status', 'stock', 'variant_id']);
  });
});

// ─── Herramientas ───────────────────────────────────────────────────────────
describe('executeTool', () => {
  const db = setup();
  const anyVariant = db.prepare('SELECT id, stock FROM variants WHERE stock > 5 LIMIT 1').get();

  test('add_to_bag válido emite la acción y NO toca el stock', () => {
    const r = executeTool(db, 'add_to_bag', { variant_id: anyVariant.id, quantity: 2 });
    assert.ok(!r.isError);
    assert.equal(r.events[0].action, 'add_to_cart');
    assert.equal(r.events[0].qty, 2);
    assert.equal(db.prepare('SELECT stock FROM variants WHERE id = ?').get(anyVariant.id).stock, anyVariant.stock);
  });
  test('add_to_bag rechaza ids y cantidades inválidos', () => {
    for (const bad of [{ variant_id: 'x', quantity: 1 }, { variant_id: 1.5, quantity: 1 }, { variant_id: 1, quantity: 0 }, { variant_id: 1, quantity: 11 }, { variant_id: 999999, quantity: 1 }, {}]) {
      const r = executeTool(db, 'add_to_bag', bad);
      assert.equal(r.isError, true, JSON.stringify(bad));
      assert.equal(r.events, undefined);
    }
  });
  test('add_to_bag respeta el stock y lo agotado', () => {
    db.prepare('UPDATE variants SET stock = 2 WHERE id = ?').run(anyVariant.id);
    assert.equal(executeTool(db, 'add_to_bag', { variant_id: anyVariant.id, quantity: 3 }).isError, true);
    db.prepare('UPDATE variants SET stock = 0 WHERE id = ?').run(anyVariant.id);
    const r = executeTool(db, 'add_to_bag', { variant_id: anyVariant.id, quantity: 1 });
    assert.equal(r.isError, true);
    assert.match(r.content, /agotado/);
  });
  test('add_to_bag no agrega productos ocultos', () => {
    const v = db.prepare('SELECT v.id FROM variants v WHERE v.stock > 0 LIMIT 1').get();
    db.prepare('UPDATE variants SET active = 0 WHERE id = ?').run(v.id);
    assert.equal(executeTool(db, 'add_to_bag', { variant_id: v.id, quantity: 1 }).isError, true);
  });
  test('show_products muestra solo ids reales, sin repetir y con tope de 4', () => {
    const ids = db.prepare('SELECT id FROM products WHERE active = 1 LIMIT 6').all().map((p) => p.id);
    const r = executeTool(db, 'show_products', { product_ids: [...ids, ids[0], 99999] });
    assert.equal(r.events[0].products.length, 4);
    assert.ok(!JSON.stringify(r.events[0]).includes('"cost"'));
  });
  test('show_products falla con ids inexistentes o mal formados', () => {
    assert.equal(executeTool(db, 'show_products', { product_ids: [99999] }).isError, true);
    assert.equal(executeTool(db, 'show_products', { product_ids: ['a'] }).isError, true);
    assert.equal(executeTool(db, 'show_products', { product_ids: 'x' }).isError, true);
  });
  test('entradas que no son objetos y herramientas desconocidas dan error, no excepción', () => {
    assert.equal(executeTool(db, 'search_products', null).isError, true);
    assert.equal(executeTool(db, 'search_products', [1]).isError, true);
    assert.equal(executeTool(db, 'search_products', { category: 'Robots' }).isError, true);
    assert.equal(executeTool(db, 'borrar_todo', {}).isError, true);
  });
});

describe('echoContent', () => {
  test('sin cambio de modelo devuelve el contenido igual (con el razonamiento intacto)', () => {
    const c = [THINKING, { type: 'text', text: 'hola' }, toolUse('search_products', {})];
    assert.deepEqual(echoContent(c), c);
  });
  test('tras una reserva omite razonamiento y herramientas anteriores a la frontera y la marca', () => {
    const c = [THINKING, toolUse('search_products', {}, 'a'), { type: 'text', text: 'parcial' }, { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } }, THINKING, toolUse('show_products', {}, 'b')];
    const out = echoContent(c);
    assert.deepEqual(out.map((b) => b.type), ['text', 'thinking', 'tool_use']);
    assert.equal(out[2].id, 'b');
  });
});

// ─── Bucle de conversación ──────────────────────────────────────────────────
describe('createChatService.run', () => {
  test('ciclo completo: razonamiento + herramienta → resultado → respuesta final', async () => {
    const db = setup();
    const client = fakeClient([
      { content: [THINKING, { type: 'text', text: 'Déjame ver.' }, toolUse('search_products', { query: 'vainilla' })], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Te recomiendo la Vainilla Dorada.' }], stop_reason: 'end_turn' },
    ]);
    const svc = createChatService({ db, client });
    const { events, usage: u } = await chat(svc, 'busco algo con vainilla');

    // eventos hacia el navegador
    assert.deepEqual(events.map((e) => e.type), ['text', 'tool', 'text', 'text']);
    assert.equal(events[0].text, 'Déjame ver.');
    assert.equal(events[2].text, '\n\n'); // párrafo entre rondas
    assert.equal(events[3].text, 'Te recomiendo la Vainilla Dorada.');
    assert.equal(u.rounds, 2);
    assert.equal(u.input, 200);

    // la segunda llamada devuelve el turno del modelo SIN TOCAR (con su razonamiento) + el resultado de la herramienta
    const second = client.calls[1].messages;
    assert.equal(second.length, 3);
    assert.deepEqual(second[1].content[0], THINKING);
    assert.equal(second[2].role, 'user');
    assert.equal(second[2].content[0].type, 'tool_result');
    assert.equal(second[2].content[0].tool_use_id, 'toolu_1');
    assert.match(second[2].content[0].content, /Vainilla Dorada/);
  });

  test('por defecto usa Haiku 5.5 con esfuerzo medio y sin reserva (Haiku no la admite)', async () => {
    const db = setup();
    const client = fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    const svc = createChatService({ db, client });
    await chat(svc);
    const a = client.calls[0];
    assert.equal(a.model, 'claude-haiku-5-5');
    assert.deepEqual(a.output_config, { effort: 'medium' });
    assert.ok(!('fallbacks' in a) && !('betas' in a));
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice']) assert.ok(!(forbidden in a), `sin ${forbidden}`);
    assert.equal(svc.fallback, false);
  });

  test('la petición cumple lo que exige Opus 5.5 y mantiene fijas las instrucciones y herramientas', async () => {
    const db = setup();
    const client = fakeClient([
      { content: [toolUse('search_products', {})], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    ]);
    await chat(createChatService({ db, client, model: 'claude-opus-5-5', effort: 'low' }));
    const [a, b] = client.calls;
    assert.equal(a.model, 'claude-opus-5-5');
    assert.equal(a.system, SYSTEM_PROMPT);
    assert.deepEqual(a.tools, TOOLS);
    assert.deepEqual(a.output_config, { effort: 'low' });
    assert.deepEqual(a.cache_control, { type: 'ephemeral' });
    assert.ok(a.max_tokens >= 4000, 'cabe el razonamiento y la respuesta');
    for (const forbidden of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice']) assert.ok(!(forbidden in a), `sin ${forbidden}`);
    // reserva por rechazos activada por defecto
    assert.deepEqual(a.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(a.fallbacks, 'default');
    // el prompt y las herramientas no cambian entre rondas (caché y razonamiento ligado a la conversación)
    assert.equal(b.system, a.system);
    assert.deepEqual(b.tools, a.tools);
    assert.ok(TOOLS.every((t) => t.eager_input_streaming === true && t.input_schema.additionalProperties === false));
  });

  test('una herramienta con entrada inválida devuelve is_error y la conversación continúa', async () => {
    const db = setup();
    const client = fakeClient([
      { content: [toolUse('add_to_bag', { variant_id: 999999, quantity: 1 })], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'No pude agregarlo.' }], stop_reason: 'end_turn' },
    ]);
    const { events } = await chat(createChatService({ db, client }));
    const result = client.calls[1].messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.ok(!events.some((e) => e.type === 'action'));
  });

  test('varias herramientas en un turno: todos los resultados van juntos en un solo mensaje', async () => {
    const db = setup();
    const client = fakeClient([
      { content: [toolUse('search_products', { query: 'jazmin' }, 't1'), toolUse('search_products', { query: 'cedro' }, 't2')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' },
    ]);
    await chat(createChatService({ db, client }));
    const last = client.calls[1].messages.at(-1);
    assert.deepEqual(last.content.map((r) => r.tool_use_id), ['t1', 't2']);
  });

  test('show_products y add_to_bag envían tarjetas y acciones al navegador', async () => {
    const db = setup();
    const v = db.prepare('SELECT v.id, v.product_id FROM variants v WHERE v.stock > 3 LIMIT 1').get();
    const client = fakeClient([
      { content: [toolUse('show_products', { product_ids: [v.product_id] }, 'a'), toolUse('add_to_bag', { variant_id: v.id, quantity: 1 }, 'b')], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Hecho.' }], stop_reason: 'end_turn' },
    ]);
    const { events } = await chat(createChatService({ db, client }));
    assert.equal(events.find((e) => e.type === 'cards').products[0].id, v.product_id);
    assert.equal(events.find((e) => e.type === 'action').variant_id, v.id);
  });

  test('un rechazo del modelo se informa y no ejecuta herramientas', async () => {
    const db = setup();
    const client = fakeClient([{ content: [toolUse('add_to_bag', { variant_id: 1, quantity: 1 })], stop_reason: 'refusal' }]);
    const { events } = await chat(createChatService({ db, client }));
    assert.deepEqual(events.map((e) => e.type), ['refusal']);
    assert.equal(client.calls.length, 1);
  });

  test('una herramienta cortada por max_tokens no se ejecuta', async () => {
    const db = setup();
    const client = fakeClient([{ content: [toolUse('add_to_bag', { variant_id: 1, quantity: 1 })], stop_reason: 'max_tokens' }]);
    await assert.rejects(() => chat(createChatService({ db, client })));
    assert.equal(client.calls.length, 1);
  });

  test('si la API rechaza la reserva (400), reintenta sin ella y la apaga', async () => {
    const db = setup();
    const client = fakeClient([apiError(400), { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    const svc = createChatService({ db, client, model: 'claude-opus-5-5', log: { warn() {} } });
    const { events } = await chat(svc);
    assert.equal(events.at(-1).text, 'ok');
    assert.equal(client.calls.length, 2);
    assert.ok(client.calls[0].fallbacks && !client.calls[1].fallbacks && !client.calls[1].betas);
    assert.equal(svc.fallback, false);
  });

  test('un 400 que persiste sin la reserva se propaga (no hay bucle infinito)', async () => {
    const db = setup();
    const client = fakeClient([apiError(400), apiError(400)]);
    await assert.rejects(() => chat(createChatService({ db, client, model: 'claude-opus-5-5', log: { warn() {} } })), { status: 400 });
    assert.equal(client.calls.length, 2);
  });

  test('aunque se pida la reserva, con Haiku no se envía (daría error o no haría nada)', async () => {
    const db = setup();
    const client = fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    await chat(createChatService({ db, client, model: 'claude-haiku-5-5', fallback: true }));
    assert.ok(!client.calls[0].fallbacks && !client.calls[0].betas);
  });

  test('el nivel de esfuerzo y el modelo son configurables', async () => {
    const db = setup();
    const client = fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
    await chat(createChatService({ db, client, model: 'claude-sonnet-5-5', effort: 'high' }));
    assert.equal(client.calls[0].model, 'claude-sonnet-5-5');
    assert.deepEqual(client.calls[0].output_config, { effort: 'high' });
    assert.equal(client.calls[0].fallbacks, 'default', 'Sonnet sí admite la reserva');
  });

  test('si el modelo nunca termina de llamar herramientas, se corta y se disculpa', async () => {
    const db = setup();
    const client = fakeClient(Array.from({ length: 10 }, () => ({ content: [toolUse('search_products', {})], stop_reason: 'tool_use' })));
    const { events } = await chat(createChatService({ db, client }));
    assert.equal(client.calls.length, 6);
    assert.match(events.at(-1).text, /Perdona/);
  });

  test('los errores de la API se traducen a mensajes claros sin filtrar detalles', () => {
    assert.match(friendlyError({ status: 401 }), /clave/);
    assert.match(friendlyError({ status: 429 }), /muchas consultas/);
    assert.match(friendlyError({ status: 529 }), /saturado/);
    assert.match(friendlyError(new Error('boom: sk-ant-secreto')), /No pude responder/);
    assert.ok(!friendlyError(new Error('boom: sk-ant-secreto')).includes('sk-ant'));
  });
});

// ─── Configuración desde variables de entorno ───────────────────────────────
describe('buildChat (variables de entorno)', () => {
  const db = setup();
  test('sin clave usa el asistente local (sin IA, sin costo) en lugar de apagarse', () => {
    const s = buildChat(db, {});
    assert.equal(s.enabled, true);
    assert.equal(s.mode, 'local');
    assert.equal(s.model, null);
  });
  test('CHATBOT=local fuerza el local aunque haya clave', () => {
    assert.equal(buildChat(db, { ANTHROPIC_API_KEY: 'k', CHATBOT: 'local' }).mode, 'local');
  });
  test('con clave pasa a la IA', () => {
    assert.equal(buildChat(db, { ANTHROPIC_API_KEY: 'k' }).mode, 'ia');
  });
  test('STORE_WHATSAPP solo se acepta con dígitos de longitud válida', () => {
    assert.equal(buildChat(db, { STORE_WHATSAPP: '+507 6000-0000' }).whatsapp, true);
    assert.equal(buildChat(db, { STORE_WHATSAPP: 'abc' }).whatsapp, false);
    assert.equal(buildChat(db, { STORE_WHATSAPP: '123' }).whatsapp, false);
  });
  test('CHATBOT=off lo apaga aunque haya clave', () => {
    assert.deepEqual(buildChat(db, { ANTHROPIC_API_KEY: 'k', CHATBOT: 'off' }), { enabled: false, reason: 'apagado' });
  });
  test('con clave: Haiku 5.5, esfuerzo medio y sin reserva por defecto', () => {
    const s = buildChat(db, { ANTHROPIC_API_KEY: 'k' });
    assert.equal(s.enabled, true);
    assert.equal(s.model, 'claude-haiku-5-5');
    assert.equal(s.effort, 'medium');
    assert.equal(s.fallback, false);
  });
  test('el modelo y el esfuerzo se cambian por variable; un esfuerzo inválido vuelve al medio', () => {
    const opus = buildChat(db, { ANTHROPIC_API_KEY: 'k', CHATBOT_MODEL: 'claude-opus-5-5', CHATBOT_EFFORT: 'high' });
    assert.deepEqual([opus.model, opus.effort, opus.fallback], ['claude-opus-5-5', 'high', true]);
    assert.equal(buildChat(db, { ANTHROPIC_API_KEY: 'k', CHATBOT_EFFORT: 'turbo' }).effort, 'medium');
    assert.equal(buildChat(db, { ANTHROPIC_API_KEY: 'k', CHATBOT_MODEL: 'claude-opus-5-5', CHATBOT_FALLBACK: 'off' }).fallback, false);
  });
  test('CHATBOT=on permite usar credenciales que resuelva el SDK (sin variable de clave)', () => {
    assert.equal(buildChat(db, { CHATBOT: 'on' }).enabled, true);
  });
});

// ─── Servidor (HTTP + SSE) ──────────────────────────────────────────────────
async function startApp(script, { limits = {}, enabled = true, hold } = {}) {
  let client;
  const app = createApp({
    dbPath: ':memory:',
    chatLimits: limits,
    chatFactory: (db) => {
      if (!enabled) return { enabled: false, reason: 'sin_clave' };
      client = fakeClient(script, { hold });
      return createChatService({ db, client });
    },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, get client() { return client; }, close: () => app.server.close() };
}

const post = (base, messages) =>
  fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
const parseSse = (text) => text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
const ok = [{ content: [{ type: 'text', text: 'Hola, soy Aura.' }], stop_reason: 'end_turn' }];

describe('POST /api/chat', () => {
  test('transmite eventos SSE y cierra con "done"', async () => {
    const s = await startApp(ok);
    try {
      const res = await post(s.base, [{ role: 'user', content: 'hola' }]);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = parseSse(await res.text());
      assert.deepEqual(events.map((e) => e.type), ['text', 'done']);
      assert.equal(events[0].text, 'Hola, soy Aura.');
    } finally { s.close(); }
  });

  test('el estado informa si el asistente está activo', async () => {
    const on = await startApp(ok);
    const off = await startApp(ok, { enabled: false });
    try {
      assert.deepEqual(await (await fetch(`${on.base}/api/chat/status`)).json(), { enabled: true, mode: 'ia', whatsapp: false, reason: null });
      assert.deepEqual(await (await fetch(`${off.base}/api/chat/status`)).json(), { enabled: false, mode: null, whatsapp: false, reason: 'sin_clave' });
    } finally { on.close(); off.close(); }
  });

  test('sin clave configurada responde 503 con un mensaje claro', async () => {
    const s = await startApp(ok, { enabled: false });
    try {
      const res = await post(s.base, [{ role: 'user', content: 'hola' }]);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /no está activo/);
    } finally { s.close(); }
  });

  test('valida la entrada antes de gastar nada', async () => {
    const s = await startApp(ok);
    try {
      assert.equal((await post(s.base, [])).status, 400);
      assert.equal((await post(s.base, [{ role: 'user', content: 'x'.repeat(700) }])).status, 400);
      assert.equal((await fetch(`${s.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{no es json' })).status, 400);
      assert.equal(s.client.calls.length, 0, 'ninguna petición inválida llegó al modelo');
    } finally { s.close(); }
  });

  test('limita los mensajes por visitante y avisa cuándo reintentar', async () => {
    const s = await startApp(Array.from({ length: 5 }, () => ok[0]), { limits: { perIp: 2 } });
    try {
      for (let i = 0; i < 2; i++) assert.equal((await (await post(s.base, [{ role: 'user', content: 'hola' }])).text()).includes('done'), true);
      const res = await post(s.base, [{ role: 'user', content: 'hola' }]);
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal(s.client.calls.length, 2, 'el tercero no llegó al modelo');
    } finally { s.close(); }
  });

  test('respeta el tope diario global', async () => {
    const s = await startApp(Array.from({ length: 5 }, () => ok[0]), { limits: { daily: 1 } });
    try {
      assert.equal((await post(s.base, [{ role: 'user', content: 'a' }])).status, 200);
      const res = await post(s.base, [{ role: 'user', content: 'b' }]);
      assert.equal(res.status, 429);
      assert.match((await res.json()).error, /hoy/);
    } finally { s.close(); }
  });

  test('limita las respuestas simultáneas de un mismo visitante', async () => {
    let release;
    const hold = new Promise((r) => (release = r));
    const s = await startApp(Array.from({ length: 5 }, () => ok[0]), { limits: { parallel: 2 }, hold });
    try {
      const a = post(s.base, [{ role: 'user', content: 'uno' }]);
      const b = post(s.base, [{ role: 'user', content: 'dos' }]);
      await new Promise((r) => setTimeout(r, 150));
      const c = await post(s.base, [{ role: 'user', content: 'tres' }]);
      assert.equal(c.status, 429);
      release();
      assert.equal((await a).status, 200);
      assert.equal((await b).status, 200);
      await (await a).text(); await (await b).text();
    } finally { s.close(); }
  });

  test('un error del modelo llega como evento "error" claro, sin detalles internos', async () => {
    const s = await startApp([Object.assign(new Error('clave sk-ant-secreta inválida'), { status: 401 })]);
    try {
      const events = parseSse(await (await post(s.base, [{ role: 'user', content: 'hola' }])).text());
      const err = events.find((e) => e.type === 'error');
      assert.match(err.message, /clave/);
      assert.ok(!JSON.stringify(events).includes('sk-ant'));
      assert.ok(!events.some((e) => e.type === 'done'));
    } finally { s.close(); }
  });

  test('si el visitante cierra la conexión, se cancela la llamada al modelo', async () => {
    let release;
    const hold = new Promise((r) => (release = r));
    const s = await startApp(ok, { hold });
    try {
      const ac = new AbortController();
      const req = post(s.base, [{ role: 'user', content: 'hola' }]).catch(() => {});
      const res = fetch(`${s.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hola' }] }), signal: ac.signal }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      ac.abort();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(s.client.signals.some((sig) => sig?.aborted), 'la señal de cancelación llegó al SDK');
      release();
      await Promise.allSettled([req, res]);
    } finally { s.close(); }
  });
});
