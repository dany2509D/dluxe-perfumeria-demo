// Servidor HTTP + API REST. Sin frameworks: solo módulos nativos de Node.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, HttpError, setSetting } from './db.js';
import * as svc from './service.js';
import { resetAndSeed, seedLarge } from './seed.js';
import * as catalog from './catalog.js';
import { loadBrand, publicBrand, renderBrandHtml } from './brand.js';
import * as reviews from './reviews.js';
import { ancestors } from './frames.js';
import { buildChat } from './chat-env.js';
import { sanitizeMessages, sanitizeContext, friendlyError } from './chatbot.js';
import { decodeCsv, planFromCsv, previewApply, applyPlan } from './woo-import.js';
import { wooConfigFromEnv, wooReady, createWooClient, pullCatalog, flushOutbox, outboxCounts, verifySignature, handleWebhook, storeLinkFor } from './woo-sync.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};
const TOKEN_TTL = 12 * 3600e3;

export function createApp({ dbPath, password = 'admin123', seedIfEmpty = true, chatFactory = buildChat, chatLimits = {}, reviewLimits = {}, woo = {}, embedOrigins = process.env.EMBED_ORIGINS || '', frameOrigins = process.env.FRAME_ORIGINS || '', trustProxy = process.env.TRUST_PROXY === '1', brand: brandOverride = null } = {}) {
  const brand = brandOverride ?? loadBrand();
  const db = openDb(dbPath);
  if (seedIfEmpty && !db.prepare('SELECT 1 FROM products LIMIT 1').get()) resetAndSeed(db);

  // WooCommerce (opcional): las credenciales vienen del entorno (WOO_URL, WOO_KEY, WOO_SECRET, WOO_WEBHOOK_SECRET, WOO_PUSH_STOCK).
  const { client: injectedClient, ...wooOverrides } = woo;
  const wooCfg = { ...wooConfigFromEnv(), ...wooOverrides };
  const wooClient = injectedClient ?? (wooReady(wooCfg) ? createWooClient(wooCfg) : null);
  const wooPush = !!(wooClient && wooCfg.push);
  setSetting(db, 'woo_push', wooPush ? '1' : '0');
  const wooJob = { running: false, phase: '', page: 0, pages: 0, items: 0, startedAt: null, finishedAt: null, error: null, result: null };

  // Asistente de IA: cada mensaje consume la cuenta del dueño, así que hay topes por visitante y por día.
  const chat = chatFactory(db);
  const local = chat.mode === 'local'; // el asistente local no cuesta nada: topes más holgados
  const limits = {
    perIp: Number(chatLimits.perIp ?? process.env.CHAT_RATE_PER_10MIN ?? (local ? 60 : 15)),
    windowMs: Number(chatLimits.windowMs ?? 10 * 60e3),
    daily: Number(chatLimits.daily ?? process.env.CHAT_DAILY_LIMIT ?? (local ? 5000 : 200)),
    parallel: Number(chatLimits.parallel ?? 2),
  };
  // Reseñas: cualquiera puede publicar, así que hay un tope por visitante (en memoria, como el del chat).
  const reviewLimit = { perIp: Number(reviewLimits.perIp ?? process.env.REVIEW_RATE_PER_HOUR ?? 5), windowMs: Number(reviewLimits.windowMs ?? 3600e3) };
  const reviewHits = new Map();
  function takeReviewSlot(ip) {
    const now = Date.now();
    const recent = (reviewHits.get(ip) || []).filter((t) => now - t < reviewLimit.windowMs);
    if (recent.length >= reviewLimit.perIp) throw new HttpError(429, 'Has enviado varias reseñas seguidas. Inténtalo de nuevo más tarde.');
    recent.push(now);
    reviewHits.set(ip, recent);
  }
  const hits = new Map(); // ip -> marcas de tiempo dentro de la ventana
  const active = new Map(); // ip -> chats en curso
  const day = { key: '', n: 0 };
  function takeChatSlot(ip) {
    const now = Date.now();
    const today = new Date(now).toDateString();
    if (day.key !== today) Object.assign(day, { key: today, n: 0 });
    if (day.n >= limits.daily) return { ok: false, status: 429, retry: 3600, msg: 'El asistente alcanzó su límite de consultas de hoy. Vuelve a intentarlo mañana.' };
    if ((active.get(ip) || 0) >= limits.parallel) return { ok: false, status: 429, retry: 5, msg: 'Espera a que termine la respuesta anterior.' };
    const recent = (hits.get(ip) || []).filter((t) => now - t < limits.windowMs);
    if (recent.length >= limits.perIp) {
      const retry = Math.ceil((limits.windowMs - (now - recent[0])) / 1000);
      return { ok: false, status: 429, retry, msg: `Has hecho muchas preguntas seguidas. Inténtalo de nuevo en ${Math.ceil(retry / 60)} min.` };
    }
    recent.push(now);
    hits.set(ip, recent);
    day.n += 1;
    active.set(ip, (active.get(ip) || 0) + 1);
    return { ok: true };
  }
  const releaseChatSlot = (ip) => active.set(ip, Math.max(0, (active.get(ip) || 1) - 1));

  const pwHash = createHash('sha256').update(password).digest();
  // Sesión del panel: un token firmado con vencimiento (sin estado en el servidor). Así sigue valiendo aunque la petición
  // la atienda otra instancia (funciones serverless) o se reinicie el servidor.
  const sessionKey = createHash('sha256').update(`dluxe-session:${password}`).digest();
  const sign = (exp) => createHmac('sha256', sessionKey).update(String(exp)).digest('hex');
  // Detrás de un proxy de confianza (Netlify) la IP y el sitio reales vienen en cabeceras; si no, solo se mira la conexión.
  const clientIp = (req) => (trustProxy && (req.headers['x-nf-client-connection-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'local';
  const publicOrigin = (req) => (trustProxy && req.headers['x-forwarded-host'] ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}` : `http://${req.headers.host || 'localhost'}`);

  const routes = [];
  const route = (method, pattern, handler, { admin = false, raw = false, limit = 2e6 } = {}) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, re, handler, admin, raw, limit });
  };

  // ─── Público ──────────────────────────────────────────────────────────
  // Filtros del catálogo que llegan por la dirección (así cualquier búsqueda se puede compartir como enlace).
  const filtersFrom = (q) => ({
    q: (q.get('q') || '').slice(0, 80),
    category: q.get('category') || '',
    subcategory: q.get('subcategory') || '',
    kind: q.get('kind') || '',
    brand: q.get('brand') || '',
    family: q.get('family') || '',
    minPrice: q.get('min_price'),
    maxPrice: q.get('max_price'),
    onSale: q.get('on_sale') === '1',
    isNew: q.get('new') === '1',
    inStock: q.get('in_stock') === '1',
    sort: q.get('sort') || (q.get('q') ? 'relevancia' : 'destacados'),
    page: q.get('page') || 1,
    limit: q.get('limit') || 25,
  });

  route('GET', '/api/products', ({ query }) => {
    const f = filtersFrom(query);
    const result = catalog.queryProducts(db, f);
    // Los conteos por filtro solo hacen falta en la primera página; "cargar más" los omite.
    if (query.get('facets') !== '0') result.facets = catalog.facets(db, f);
    return result;
  });

  route('GET', '/api/products/:id', ({ params }) => {
    const p = catalog.getProduct(db, Number(params.id));
    if (!p) throw new HttpError(404, 'Producto no encontrado');
    const { avg, count } = reviews.summary(db, p.id);
    return { ...p, rating: { avg, count } };
  });
  route('GET', '/api/products/:id/related', ({ params, query }) => {
    const list = catalog.relatedProducts(db, Number(params.id), query.get('limit') || 8);
    if (!list) throw new HttpError(404, 'Producto no encontrado');
    return { products: list };
  });
  route('GET', '/api/products/:id/reviews', ({ params, query }) => {
    if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(Number(params.id))) throw new HttpError(404, 'Producto no encontrado');
    return reviews.listReviews(db, Number(params.id), { page: query.get('page') || 1, limit: query.get('limit') || 10 });
  });
  route('POST', '/api/products/:id/reviews', (ctx) => {
    // Campo trampa «website»: las personas no lo ven ni lo llenan; los programas que llenan todo, sí.
    if (ctx.body && ctx.body.website) throw new HttpError(400, 'No se pudo enviar la reseña.');
    takeReviewSlot(ctx.ip);
    const out = reviews.addReview(db, Number(ctx.params.id), ctx.body);
    ctx.status = 201;
    return out;
  });

  route('GET', '/api/cart/lookup', ({ query }) => ({
    products: catalog.getProductsByVariantIds(db, (query.get('variants') || '').split(',').map(Number)),
  }));
  route('GET', '/api/brands', () => svc.listBrands(db));
  route('GET', '/api/brand', () => publicBrand(brand));

  route('POST', '/api/orders', (ctx) => {
    ctx.status = 201;
    return svc.createOrder(db, ctx.body, { channel: 'online' });
  });

  route('GET', '/api/chat/status', () => ({
    enabled: !!chat.enabled,
    mode: chat.enabled ? chat.mode || 'ia' : null, // 'ia' (Claude) o 'local' (reglas, sin costo)
    whatsapp: !!chat.whatsapp,
    reason: chat.enabled ? null : chat.reason || 'apagado',
  }));

  route('POST', '/api/login', (ctx) => {
    const given = createHash('sha256').update(String(ctx.body.password ?? '')).digest();
    if (!timingSafeEqual(given, pwHash)) throw new HttpError(401, 'Contraseña incorrecta');
    const exp = Date.now() + TOKEN_TTL;
    return { token: `${exp.toString(36)}_${sign(exp)}` };
  });

  // ─── Admin ────────────────────────────────────────────────────────────
  const admin = (method, pattern, handler, opts = {}) => route(method, pattern, handler, { ...opts, admin: true });

  admin('GET', '/api/admin/dashboard', () => svc.dashboard(db));
  admin('GET', '/api/admin/inventory', ({ query }) =>
    svc.listInventory(db, {
      q: query.get('q') || '',
      filter: query.get('filter') || 'todos',
      category: query.get('category') || '',
      brand: query.get('brand') || '',
      kind: query.get('kind') || '',
      sort: query.get('sort') || 'nombre',
      page: query.get('page') || 1,
      limit: query.get('limit') || 50,
      sellable: query.get('sellable') === '1',
    })
  );
  admin('GET', '/api/admin/inventory/counts', () => svc.inventoryCounts(db));
  admin('GET', '/api/admin/variants/:id', (c) => svc.getInventoryRow(db, Number(c.params.id)));
  admin('PATCH', '/api/admin/variants/:id', (c) => svc.updateVariant(db, Number(c.params.id), c.body));
  admin('POST', '/api/admin/variants/:id/adjust', (c) => svc.adjustStock(db, Number(c.params.id), c.body));
  admin('GET', '/api/admin/movements', ({ query }) =>
    svc.listMovements(db, {
      variantId: Number(query.get('variant_id')) || null,
      type: query.get('type') || '',
      limit: query.get('limit') || 150,
    })
  );
  admin('POST', '/api/admin/import', (c) => svc.importCsv(db, c.body.csv));

  admin('GET', '/api/admin/products', ({ query }) =>
    svc.listProductsAdmin(db, {
      q: query.get('q') || '',
      category: query.get('category') || '',
      kind: query.get('kind') || '',
      brand: query.get('brand') || '',
      status: query.get('status') || '',
      page: query.get('page') || 1,
      limit: query.get('limit') || 50,
    })
  );
  admin('POST', '/api/admin/products', (c) => {
    c.status = 201;
    return svc.createProduct(db, c.body, { skuPrefix: brand.skuPrefix });
  });
  admin('PATCH', '/api/admin/products/:id', (c) => svc.updateProduct(db, Number(c.params.id), c.body));

  admin('POST', '/api/admin/pos/orders', (c) => {
    c.status = 201;
    return svc.createOrder(db, c.body, { channel: 'mostrador' });
  });
  admin('GET', '/api/admin/reviews', ({ query }) => reviews.listRecent(db, { page: query.get('page') || 1, limit: query.get('limit') || 25 }));
  admin('DELETE', '/api/admin/reviews/:id', ({ params }) => reviews.removeReview(db, Number(params.id)));
  admin('GET', '/api/admin/orders', () => svc.listOrders(db));
  admin('POST', '/api/admin/orders/:id/status', (c) => svc.setOrderStatus(db, Number(c.params.id), c.body.status));

  admin('GET', '/api/admin/suppliers', () => svc.listSuppliers(db));
  admin('GET', '/api/admin/purchases', () => svc.listPurchases(db));
  admin('POST', '/api/admin/purchases', (c) => {
    c.status = 201;
    return svc.createPurchase(db, c.body);
  });
  admin('POST', '/api/admin/purchases/auto', () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = svc.autoReplenish(db, { force: true });
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
  admin('POST', '/api/admin/purchases/:id/status', (c) => svc.setPurchaseStatus(db, Number(c.params.id), c.body.status));

  admin('GET', '/api/admin/settings', () => svc.getSettings(db));
  admin('PATCH', '/api/admin/settings', (c) => svc.updateSettings(db, c.body));
  admin('POST', '/api/admin/reset', () => {
    resetAndSeed(db);
    return { ok: true };
  });
  // Catálogo masivo de prueba (para demostrar rendimiento con miles de productos). Reemplaza los datos actuales.
  admin('POST', '/api/admin/seed-large', (c) => {
    const n = Math.max(500, Math.min(Number(c.body.count) || 8500, 20000));
    return seedLarge(db, n);
  });

  // ─── WooCommerce ──────────────────────────────────────────────────────
  const CSV_LIMIT = 80e6; // un exporte de ~10.000 productos pesa varios MB
  const requireWoo = () => {
    if (!wooClient) throw new HttpError(409, 'WooCommerce no está conectado. Configura WOO_URL, WOO_KEY y WOO_SECRET y reinicia el servidor.');
    return wooClient;
  };
  const csvFrom = (c) => {
    if (!c.raw?.length) throw new HttpError(400, 'Sube el archivo CSV exportado de WooCommerce');
    return decodeCsv(c.raw);
  };
  // El stock de productos que ya existen solo se pisa si WooCommerce manda; con el envío de stock activo, manda este sistema.
  const stockFlag = (q) => (q.get('update_stock') === null ? !wooPush : q.get('update_stock') === '1');

  admin('POST', '/api/admin/woo/preview', (c) => {
    const { plan, report } = planFromCsv(csvFrom(c));
    return { report, preview: previewApply(db, plan), updateStock: stockFlag(c.query) };
  }, { raw: true, limit: CSV_LIMIT });
  admin('POST', '/api/admin/woo/import', (c) => {
    const { plan, report } = planFromCsv(csvFrom(c));
    return { report, applied: applyPlan(db, plan, { reason: 'Importación desde WooCommerce (CSV)', updateStock: stockFlag(c.query) }) };
  }, { raw: true, limit: CSV_LIMIT });

  admin('GET', '/api/admin/woo/status', () => ({
    configured: !!wooClient,
    host: wooCfg.url ? new URL(wooCfg.url).host : null,
    push: wooPush,
    webhook: { configured: !!wooCfg.webhookSecret, path: '/api/woo/webhook' },
    outbox: outboxCounts(db),
    linked: db.prepare('SELECT COUNT(*) AS variants, COUNT(DISTINCT product_id) AS products FROM variants WHERE external_id IS NOT NULL').get(),
    job: { ...wooJob },
    events: db.prepare('SELECT topic, woo_order_id, status, note, created_at FROM woo_events ORDER BY rowid DESC LIMIT 8').all(),
    errors: db
      .prepare('SELECT v.sku, o.last_error, o.attempts FROM woo_outbox o JOIN variants v ON v.id = o.variant_id WHERE o.last_error IS NOT NULL ORDER BY o.queued_at DESC LIMIT 5')
      .all(),
  }));
  admin('POST', '/api/admin/woo/test', async () => ({ ok: true, products: await requireWoo().ping() }));
  // La lectura de un catálogo grande tarda: corre en segundo plano y el panel consulta el avance.
  admin('POST', '/api/admin/woo/sync', (c) => {
    const client = requireWoo();
    if (wooJob.running) throw new HttpError(409, 'Ya hay una sincronización en curso');
    Object.assign(wooJob, { running: true, phase: 'conectando', page: 0, pages: 0, items: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null });
    const dry = c.body.dry === true;
    pullCatalog(db, client, { apply: !dry, updateStock: !wooPush, progress: (p) => Object.assign(wooJob, p) })
      .then((r) => { wooJob.result = r; })
      .catch((e) => { wooJob.error = e.message; })
      .finally(() => Object.assign(wooJob, { running: false, phase: 'listo', finishedAt: new Date().toISOString() }));
    c.status = 202;
    return { ...wooJob };
  });
  admin('POST', '/api/admin/woo/flush', async () => flushOutbox(db, requireWoo()));

  // Aviso entrante de WooCommerce (pedidos, productos). Se acepta solo con firma válida.
  route('POST', '/api/woo/webhook', async (c) => {
    if (!wooCfg.webhookSecret) throw new HttpError(503, 'El webhook no está configurado (WOO_WEBHOOK_SECRET)');
    if (!verifySignature(c.raw, c.headers['x-wc-webhook-signature'], wooCfg.webhookSecret)) throw new HttpError(401, 'Firma no válida');
    return handleWebhook(db, { raw: c.raw, headers: c.headers, client: wooClient, updateStock: !wooPush });
  }, { raw: true, limit: 5e6 });

  // Envío periódico del stock a WooCommerce (solo si está activado).
  const flushTimer = wooPush ? setInterval(() => flushOutbox(db, wooClient).catch((e) => console.error('[woo] envío de stock:', e.message)), 20_000) : null;
  flushTimer?.unref();

  // ─── Plumbing ─────────────────────────────────────────────────────────
  const send = (res, status, data, headers = {}) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2e6) {
          reject(new HttpError(413, 'El archivo es demasiado grande'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolveBody({});
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'El cuerpo de la petición no es JSON válido'));
        }
      });
      req.on('error', reject);
    });

  const readRaw = (req, limit) =>
    new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, 'El archivo es demasiado grande'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const isAuthed = (req) => {
    const m = /^Bearer ([a-z0-9]{1,12})_([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const exp = parseInt(m[1], 36);
    return exp > Date.now() && timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(exp)));
  };

  // POST /api/chat → flujo de eventos (SSE): {type:'text'|'cards'|'action'|'tool'|'refusal'|'done'|'error'}
  async function handleChat(req, res) {
    if (!chat.enabled) throw new HttpError(503, 'El asistente de IA no está activo todavía.');
    const body = await readBody(req);
    const messages = sanitizeMessages(body.messages);
    const context = sanitizeContext(body.context);
    const embed = body.embed === true; // el chat dentro de otro sitio (WordPress): "agregar a la bolsa" se vuelve un enlace de compra
    const ip = clientIp(req);
    const slot = takeChatSlot(ip);
    if (!slot.ok) return send(res, slot.status, { error: slot.msg }, { 'Retry-After': String(slot.retry) });

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // el cliente cerró: dejamos de gastar
    const origin = publicOrigin(req);
    const emit = (ev) => {
      if (embed && ev.type === 'action' && ev.action === 'add_to_cart') {
        const link = storeLinkFor(db, ev.variant_id, ev.qty, origin);
        ev = link ? { type: 'link', ...link } : { type: 'text', text: '\n\nPara comprarlo, ábrelo desde la tienda.' };
      }
      if (!res.writableEnded) res.write('data: ' + JSON.stringify(ev) + '\n\n');
    };
    try {
      const usage = await chat.run({ messages, emit, signal: ac.signal, context });
      console.log('[chat]', JSON.stringify(usage));
      emit({ type: 'done' });
    } catch (err) {
      if (!ac.signal.aborted) {
        // Nunca se registra el mensaje crudo: podría contener fragmentos de una clave.
        console.error('[chat] error', err?.status ?? '', String(err?.message ?? err).replace(/sk-ant-[\w-]+/g, 'sk-ant-***'));
        emit({ type: 'error', message: friendlyError(err) });
      }
    } finally {
      releaseChatSlot(ip);
      res.end();
    }
  }

  // EMBED_ORIGINS="https://tu-tienda.com,https://www.tu-tienda.com" (o "*" para pruebas): quién puede mostrar el chat en un iframe.
  const embedAncestors = ancestors(embedOrigins); // EMBED_ORIGINS: quién puede mostrar el chat en un iframe
  const storeAncestors = ancestors(frameOrigins); // FRAME_ORIGINS: quién puede mostrar la tienda de demostración en un iframe
  const renderHtml = (html) => renderBrandHtml(html, brand, { adminHint: password === 'admin123' ? password : '' });

  async function serveStatic(req, res, pathname) {
    const aliases = { '/': '/index.html', '/admin': '/admin.html', '/embed': '/embed.html' };
    const rel = aliases[pathname] || pathname;
    const file = resolve(join(PUBLIC_DIR, normalize(rel)));
    if (file !== PUBLIC_DIR.slice(0, -1) && !file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      let data = await readFile(file);
      if (extname(file) === '.html') data = Buffer.from(renderHtml(data.toString('utf8')), 'utf8');
      const embedPage = file.endsWith(`${sep}embed.html`);
      const storePage = file.endsWith(`${sep}index.html`);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        // Ninguna página se puede incrustar en otro sitio, salvo el chat (EMBED_ORIGINS) y la tienda (FRAME_ORIGINS) desde los orígenes autorizados. El panel, nunca.
        ...(extname(file) === '.html' ? { 'Content-Security-Policy': `frame-ancestors ${embedPage ? embedAncestors : storePage ? storeAncestors : "'self'"}` } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
        return await serveStatic(req, res, decodeURIComponent(pathname));
      }
      if (req.method === 'POST' && pathname === '/api/chat') return await handleChat(req, res);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.admin && !isAuthed(req)) throw new HttpError(401, 'Inicia sesión para continuar');
        const ctx = { params: m.groups || {}, query: url.searchParams, body: {}, status: 200, headers: req.headers, ip: clientIp(req) };
        if (req.method !== 'GET') {
          if (r.raw) ctx.raw = await readRaw(req, r.limit);
          else ctx.body = await readBody(req);
        }
        const data = await r.handler(ctx);
        return send(res, ctx.status, data);
      }
      throw new HttpError(404, 'Ruta no encontrada');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, details: err.details });
      if (String(err.message).includes('STOCK_INSUFICIENTE')) {
        return send(res, 409, { error: 'No hay stock suficiente para completar la operación' });
      }
      console.error(err);
      send(res, 500, { error: 'Error interno del servidor' });
    }
  });

  server.on('close', () => flushTimer && clearInterval(flushTimer));
  return { server, db, chat, brand, wooClient };
}
