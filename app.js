// Servidor HTTP + API REST. Sin frameworks: solo módulos nativos de Node.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, HttpError, setSetting } from './db.js';
import * as svc from './service.js';
import { resetAndSeed, seedLarge, upgradeDemoData } from './seed.js';
import * as catalog from './catalog.js';
import { loadBrand, publicBrand, renderBrandHtml } from './brand.js';
import * as reviews from './reviews.js';
import * as accounts from './accounts.js';
import * as auth from './auth.js';
import * as bundles from './bundles.js';
import * as notify from './notify.js';
import * as invoicing from './invoicing.js';
import * as payments from './payments.js';
import { registerOps } from './routes-ops.js';
import { registerShop } from './routes-shop.js';
import { getSetting } from './db.js';
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
const STAFF_TTL = 12 * 3600e3;
const DUMMY_HASH = auth.hashPassword('sin-usuario'); // se compara contra ella cuando el usuario no existe

export function createApp({ dbPath, password = 'admin123', seedIfEmpty = true, demoUsers = null, chatFactory = buildChat, chatLimits = {}, reviewLimits = {}, woo = {}, embedOrigins = process.env.EMBED_ORIGINS || '', frameOrigins = process.env.FRAME_ORIGINS || '', trustProxy = process.env.TRUST_PROXY === '1', brand: brandOverride = null, ...opts } = {}) {
  const brand = brandOverride ?? loadBrand();
  const db = openDb(dbPath);
  // Avisos (WhatsApp/correo), facturación electrónica y pagos en línea: cada uno con su proveedor, todos simulados si no se configura nada.
  const notifyCfg = { ...notify.notifyConfigFromEnv(), ...(opts.notify || {}) };
  const fiscalCfg = { ...invoicing.fiscalConfigFromEnv(), ...(opts.fiscal || {}) };
  const payCfg = { ...payments.paymentConfigFromEnv(), ...(opts.payments || {}) };
  notify.applyMode(db, notifyCfg);
  const publicUrlEnv = String(opts.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
  const freshDb = !db.prepare('SELECT 1 FROM products LIMIT 1').get();
  // Las facturas de las ventas de ejemplo solo se crean con el proveedor de demostración: nunca se mandan datos de ejemplo a una integración real.
  const seedServices = () => ({ fiscal: fiscalCfg.provider === 'demo' ? fiscalCfg : null, brand });
  if (seedIfEmpty && freshDb) resetAndSeed(db, seedServices());
  // Personal del panel: el administrador inicial usa la clave de ADMIN_PASSWORD; los usuarios de ejemplo (gerente, cajero,
  // bodega) solo se crean en una demostración con datos de ejemplo.
  auth.ensureOwner(db, password);
  const withDemoUsers = demoUsers ?? (seedIfEmpty && freshDb);
  if (withDemoUsers) {
    auth.seedDemoUsers(db, password);
    if (!freshDb) upgradeDemoData(db, { prefix: brand.skuPrefix }); // una demostración anterior recibe las ofertas, sets y tarjetas nuevos
  }

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

  // Sesiones: un token firmado con vencimiento (sin estado en el servidor). Así siguen valiendo aunque la petición la atienda
  // otra instancia (funciones serverless) o se reinicie el servidor.
  const sessions = auth.createSessions(password);
  // Intentos fallidos: pocos por usuario y conexión (frena adivinar una clave) y bastantes por conexión (un local con varios
  // cajeros comparte la misma dirección: un descuido no debe dejar a todos afuera).
  const loginUserLimit = auth.createLimiter({ max: Number(process.env.LOGIN_MAX_FAILS || 8), windowMs: 15 * 60e3 });
  const loginIpLimit = auth.createLimiter({ max: Number(process.env.LOGIN_IP_MAX_FAILS || 40), windowMs: 15 * 60e3 });
  // Quién hace la petición: el personal del panel (token «s») con su rol vigente en la base de datos.
  const staffOf = (req) => {
    const parsed = sessions.parse(req.headers.authorization);
    if (!parsed || parsed.kind !== 's') return null;
    const u = auth.userById(db, parsed.id);
    if (!u || !u.active || !sessions.valid(parsed, u.pass_hash)) return null;
    return { id: u.id, username: u.username, name: u.name, role: u.role };
  };
  // Detrás de un proxy de confianza (Netlify) la IP y el sitio reales vienen en cabeceras; si no, solo se mira la conexión.
  const clientIp = (req) => (trustProxy && (req.headers['x-nf-client-connection-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'local';
  const publicOrigin = (req) => (trustProxy && req.headers['x-forwarded-host'] ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}` : `http://${req.headers.host || 'localhost'}`);

  const routes = [];
  const route = (method, pattern, handler, { admin = false, raw = false, limit = 2e6, perm = null } = {}) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    routes.push({ method, pattern, re, handler, admin, raw, limit, perm });
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
    const bundle = bundles.publicComponents(db, p.id);
    return { ...p, rating: { avg, count }, ...(bundle ? { bundle } : {}) };
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

  // Topes por conexión (en memoria): pedidos seguidos, intentos con códigos de tarjeta de regalo falsos y pedidos que reservan
  // stock esperando un pago (si no, alguien podría agotar el inventario a punta de pedidos sin pagar).
  const orderLimit = auth.createLimiter({ max: Number(process.env.ORDER_RATE_PER_10MIN || 60), windowMs: 10 * 60e3 });
  const giftFails = auth.createLimiter({ max: 10, windowMs: 15 * 60e3 });
  const pendingLimit = auth.createLimiter({ max: Number(process.env.PENDING_ORDERS_MAX || 8), windowMs: payCfg.holdMinutes * 60e3 });
  route('POST', '/api/orders', async (ctx) => {
    sweepPayments(ctx);
    const svcs = services(ctx);
    if (!orderLimit.take(ctx.ip)) throw new HttpError(429, 'Hiciste varios pedidos seguidos. Inténtalo de nuevo en unos minutos.');
    if (String(ctx.body.gift_code ?? '').trim() && giftFails.blocked(ctx.ip)) throw new HttpError(429, 'Demasiados códigos de tarjeta de regalo incorrectos. Inténtalo de nuevo en unos minutos.');
    const hostedCard = payments.isHosted(payCfg) && ctx.body.payment_method === 'tarjeta';
    if (hostedCard && pendingLimit.blocked(ctx.ip)) throw new HttpError(429, 'Tienes varios pedidos esperando el pago. Completa o espera a que venzan antes de hacer otro.');
    let order;
    try {
      order = svc.createOrder(db, ctx.body, { channel: 'online', customerId: customerOf(ctx)?.id ?? null, services: svcs });
    } catch (e) {
      if (e instanceof HttpError && e.status === 400 && /tarjeta de regalo/i.test(e.message)) giftFails.take(ctx.ip);
      throw e;
    }
    ctx.status = 201;
    if (order.payment) {
      pendingLimit.take(ctx.ip);
      // Pasarela externa: el pedido ya reservó el stock; falta mandar al cliente a pagar.
      try {
        const { url } = await payments.startCheckout(payCfg, {
          reference: order.payment.reference, amount: order.payment.amount, currency: brand.currency, description: `Pedido #${order.id} · ${brand.name}`,
          customer: { name: order.customer_name, email: order.customer_email, phone: order.customer_phone }, baseUrl: svcs.baseUrl, orderCode: order.tracking_code,
        });
        order.payment.url = url;
      } catch (e) {
        console.error('[pagos] no se pudo iniciar el cobro:', String(e.message).slice(0, 200));
        svc.failOrderPayment(db, order.id, { services: svcs, note: 'No se pudo iniciar el pago' });
        throw new HttpError(502, 'No pudimos iniciar el pago. Inténtalo de nuevo en un momento.');
      }
    }
    return order;
  });

  route('GET', '/api/chat/status', () => ({
    enabled: !!chat.enabled,
    mode: chat.enabled ? chat.mode || 'ia' : null, // 'ia' (Claude) o 'local' (reglas, sin costo)
    whatsapp: !!chat.whatsapp,
    reason: chat.enabled ? null : chat.reason || 'apagado',
  }));

  // Acceso del personal. Sin usuario se entra como «admin» (así funcionaba antes, con una sola contraseña).
  const sessionInfo = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, role_label: auth.ROLES[u.role], perms: auth.permsOf(u.role) });
  route('POST', '/api/login', (ctx) => {
    const username = String(ctx.body.username ?? 'admin').trim().toLowerCase().slice(0, 40) || 'admin';
    const userKey = `${username}:${ctx.ip}`;
    if (loginUserLimit.blocked(userKey) || loginIpLimit.blocked(ctx.ip)) {
      const wait = Math.max(loginUserLimit.retrySeconds(userKey), loginIpLimit.retrySeconds(ctx.ip));
      throw new HttpError(429, `Demasiados intentos. Vuelve a intentarlo en ${Math.ceil(wait / 60)} min.`);
    }
    const u = auth.userByName(db, username);
    // Se verifica siempre una clave (aunque el usuario no exista) para que el tiempo de respuesta no delate usuarios.
    const ok = auth.verifyPassword(String(ctx.body.password ?? ''), u?.pass_hash ?? DUMMY_HASH) && !!u && !!u.active;
    if (!ok) {
      loginUserLimit.take(userKey);
      loginIpLimit.take(ctx.ip);
      console.warn(`[auth] intento fallido: usuario «${username.replace(/[^\w.-]/g, '?')}»`); // solo al registro del servidor: así no escribe en la base de datos
      throw new HttpError(401, 'Usuario o contraseña incorrectos');
    }
    loginUserLimit.reset(userKey);
    auth.touchLogin(db, u.id);
    auth.audit(db, u, { action: 'sesion.entrar', entity: 'usuario', id: u.id, ip: ctx.ip });
    return { token: sessions.issue('s', u.id, u.pass_hash, STAFF_TTL), user: sessionInfo(u) };
  });

  // ─── Admin ────────────────────────────────────────────────────────────
  // Cada ruta del panel declara qué permiso exige (ver auth.js): al arrancar se verifica que ninguna quede sin permiso.
  const ROUTE_PERMS = {
    'GET /api/admin/dashboard': 'resumen',
    'GET /api/admin/inventory': 'inventario',
    'GET /api/admin/inventory/counts': 'inventario',
    'GET /api/admin/variants/:id': 'inventario',
    'PATCH /api/admin/variants/:id': 'inventario_editar',
    'POST /api/admin/variants/:id/adjust': 'inventario_editar',
    'GET /api/admin/movements': 'movimientos',
    'POST /api/admin/import': 'inventario_editar',
    'GET /api/admin/products': 'productos',
    'POST /api/admin/products': 'productos',
    'PATCH /api/admin/products/:id': 'productos',
    'POST /api/admin/pos/orders': 'pos',
    'GET /api/admin/reviews': 'resenas',
    'DELETE /api/admin/reviews/:id': 'resenas',
    'GET /api/admin/orders': 'pedidos',
    'POST /api/admin/orders/:id/status': 'pedidos',
    'GET /api/admin/suppliers': ['compras', 'inventario'],
    'GET /api/admin/purchases': 'compras',
    'POST /api/admin/purchases': 'compras',
    'POST /api/admin/purchases/auto': 'compras',
    'POST /api/admin/purchases/:id/status': 'compras',
    'GET /api/admin/settings': ['compras', 'resumen'],
    'PATCH /api/admin/settings': 'compras',
    'POST /api/admin/reset': 'ajustes',
    'POST /api/admin/seed-large': 'ajustes',
    'POST /api/admin/woo/preview': 'woocommerce',
    'POST /api/admin/woo/import': 'woocommerce',
    'GET /api/admin/woo/status': 'woocommerce',
    'POST /api/admin/woo/test': 'woocommerce',
    'POST /api/admin/woo/sync': 'woocommerce',
    'POST /api/admin/woo/flush': 'woocommerce',
  };
  const admin = (method, pattern, handler, opts = {}) => route(method, pattern, handler, { ...opts, admin: true, perm: opts.perm ?? ROUTE_PERMS[`${method} ${pattern}`] ?? null });
  // Quien no ve costos no debe recibirlos aunque llame a la API directamente.
  const redactCosts = (user, row) => {
    if (auth.can(user, 'costos')) return row;
    const { cost, supplier_id, supplier_name, reorder_qty, ...rest } = row;
    return rest;
  };

  admin('GET', '/api/admin/me', (c) => sessionInfo(auth.userById(db, c.user.id)), { perm: [] });
  admin('POST', '/api/admin/me/password', (c) => {
    auth.changeOwnPassword(db, c.user.id, c.body.current, c.body.next);
    c.log('usuario.clave_propia', 'usuario', c.user.id);
    const u = auth.userById(db, c.user.id);
    return { ok: true, token: sessions.issue('s', u.id, u.pass_hash, STAFF_TTL) }; // la clave nueva cierra las demás sesiones
  }, { perm: [] });
  admin('GET', '/api/admin/badges', () => {
    const inv = svc.inventoryCounts(db);
    return { inventory: inv.out_count + inv.low_count, purchases: db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE status = 'pendiente'").get().n };
  }, { perm: [] });

  admin('GET', '/api/admin/users', () => ({ users: auth.listUsers(db), roles: auth.ROLES }), { perm: 'usuarios' });
  admin('POST', '/api/admin/users', (c) => {
    c.status = 201;
    const u = auth.createUser(db, c.body);
    c.log('usuario.crear', 'usuario', u.id, `${u.username} · ${u.role}`);
    return u;
  }, { perm: 'usuarios' });
  admin('PATCH', '/api/admin/users/:id', (c) => {
    const r = auth.updateUser(db, Number(c.params.id), c.body, { actorId: c.user.id });
    c.log('usuario.editar', 'usuario', r.user.id, `${r.user.username}: ${r.changes.join(', ') || 'datos'}`);
    return r.user;
  }, { perm: 'usuarios' });
  admin('GET', '/api/admin/audit', ({ query }) =>
    auth.listAudit(db, { action: query.get('action') || '', userId: query.get('user_id'), q: query.get('q') || '', from: query.get('from') || '', to: query.get('to') || '', page: query.get('page') || 1, limit: query.get('limit') || 50 }),
    { perm: 'bitacora' }
  );

  admin('GET', '/api/admin/dashboard', () => svc.dashboard(db));
  admin('GET', '/api/admin/inventory', (c) => {
    const { query } = c;
    const out = svc.listInventory(db, {
      q: query.get('q') || '',
      filter: query.get('filter') || 'todos',
      category: query.get('category') || '',
      brand: query.get('brand') || '',
      kind: query.get('kind') || '',
      sort: query.get('sort') || 'nombre',
      page: query.get('page') || 1,
      limit: query.get('limit') || 50,
      sellable: query.get('sellable') === '1',
    });
    out.rows = out.rows.map((r) => redactCosts(c.user, r));
    return out;
  });
  admin('GET', '/api/admin/inventory/counts', () => svc.inventoryCounts(db));
  admin('GET', '/api/admin/variants/:id', (c) => redactCosts(c.user, svc.getInventoryRow(db, Number(c.params.id))));
  admin('PATCH', '/api/admin/variants/:id', (c) => {
    const before = db.prepare('SELECT price, compare_at, cost, min_stock, active FROM variants WHERE id = ?').get(Number(c.params.id));
    const r = svc.updateVariant(db, Number(c.params.id), c.body);
    const changed = before ? Object.keys(c.body).filter((k) => k in before && String(before[k]) !== String(c.body[k])).map((k) => `${k} ${before[k] ?? '—'} → ${c.body[k] ?? '—'}`) : [];
    c.log('inventario.editar', 'variante', c.params.id, changed.join(', ') || 'sin cambios de valor');
    return r;
  });
  admin('POST', '/api/admin/variants/:id/adjust', (c) => {
    const r = svc.adjustStock(db, Number(c.params.id), { ...c.body, actor: c.user });
    c.log('inventario.ajuste', 'variante', c.params.id, `${r.delta > 0 ? '+' : ''}${r.delta} → ${r.stock} · ${String(c.body.reason ?? '').slice(0, 80)}`);
    return r;
  });
  admin('GET', '/api/admin/movements', ({ query }) =>
    svc.listMovements(db, {
      variantId: Number(query.get('variant_id')) || null,
      type: query.get('type') || '',
      limit: query.get('limit') || 150,
    })
  );
  admin('POST', '/api/admin/import', (c) => {
    const r = svc.importCsv(db, c.body.csv, { actor: c.user });
    c.log('inventario.importar', 'inventario', '', `${r.applied} filas · ${r.units} unidades`);
    return r;
  });

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
    const r = svc.createProduct(db, c.body, { skuPrefix: brand.skuPrefix, actor: c.user });
    c.log('producto.crear', 'producto', r.id, String(c.body.name ?? '').slice(0, 80));
    return r;
  });
  admin('PATCH', '/api/admin/products/:id', (c) => {
    const r = svc.updateProduct(db, Number(c.params.id), c.body);
    c.log('producto.editar', 'producto', c.params.id, Object.keys(c.body).filter((k) => k !== 'description').join(', ') + ('description' in c.body ? ', descripción' : ''));
    return r;
  });

  admin('POST', '/api/admin/pos/orders', (c) => {
    c.status = 201;
    // Descuento manual: el cajero hasta el tope que fija el gerente; gerente y administrador, sin tope.
    const cap = auth.can(c.user, 'descuento_libre') ? 100 : auth.can(c.user, 'descuento_manual') ? Number(getSetting(db, 'max_manual_discount', '10')) : 0;
    if (c.body.discount && cap <= 0) throw new HttpError(403, 'No tienes permiso para dar descuentos');
    const o = svc.createOrder(db, c.body, { channel: 'mostrador', actor: c.user, services: services(c), manualCapPct: cap });
    c.log('venta.mostrador', 'pedido', o.id, `${o.payment_method} · ${o.total}${o.discount ? ` · descuento ${o.discount}${o.promo_label ? ` (${o.promo_label})` : ''}` : ''}`);
    return o;
  });
  admin('GET', '/api/admin/reviews', ({ query }) => reviews.listRecent(db, { page: query.get('page') || 1, limit: query.get('limit') || 25 }));
  admin('DELETE', '/api/admin/reviews/:id', (c) => {
    const r = reviews.removeReview(db, Number(c.params.id));
    c.log('resena.eliminar', 'resena', c.params.id);
    return r;
  });
  admin('GET', '/api/admin/orders', (c) => {
    sweepPayments(c);
    return svc.listOrders(db, { status: c.query.get('status') || '', q: c.query.get('q') || '', limit: c.query.get('limit') || 200 });
  });
  admin('POST', '/api/admin/orders/:id/status', (c) => {
    if (c.body.status === 'cancelado' && !auth.can(c.user, 'pedidos_cancelar')) throw new HttpError(403, 'No tienes permiso para cancelar pedidos');
    const o = svc.setOrderStatus(db, Number(c.params.id), c.body.status, { actor: c.user, services: services(c) });
    c.log(`pedido.${c.body.status}`, 'pedido', c.params.id);
    return o;
  });

  admin('GET', '/api/admin/suppliers', () => svc.listSuppliers(db));
  admin('GET', '/api/admin/purchases', () => svc.listPurchases(db));
  admin('POST', '/api/admin/purchases', (c) => {
    c.status = 201;
    const r = svc.createPurchase(db, c.body);
    c.log('compra.crear', 'compra', r.id);
    return r;
  });
  admin('POST', '/api/admin/purchases/auto', (c) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = svc.autoReplenish(db, { force: true });
      db.exec('COMMIT');
      c.log('compra.sugeridas', 'compra', '', `${r.items} productos en ${r.purchases} órdenes`);
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });
  admin('POST', '/api/admin/purchases/:id/status', (c) => {
    const r = svc.setPurchaseStatus(db, Number(c.params.id), c.body.status, { actor: c.user });
    c.log(`compra.${c.body.status}`, 'compra', c.params.id);
    return r;
  });

  admin('GET', '/api/admin/settings', () => svc.getSettings(db));
  admin('PATCH', '/api/admin/settings', (c) => {
    const r = svc.updateSettings(db, c.body);
    c.log('ajustes.editar', 'ajustes', '', Object.keys(c.body).join(', '));
    return r;
  });
  admin('POST', '/api/admin/reset', (c) => {
    resetAndSeed(db, seedServices());
    if (withDemoUsers) auth.seedDemoUsers(db, password);
    c.log('demo.reiniciar', 'demo');
    return { ok: true };
  });
  // Catálogo masivo de prueba (para demostrar rendimiento con miles de productos). Reemplaza los datos actuales.
  admin('POST', '/api/admin/seed-large', (c) => {
    const n = Math.max(500, Math.min(Number(c.body.count) || 8500, 20000));
    c.log('demo.catalogo_masivo', 'demo', '', `${n} productos`);
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
    const applied = applyPlan(db, plan, { reason: 'Importación desde WooCommerce (CSV)', updateStock: stockFlag(c.query) });
    c.log('woo.importar', 'catalogo', '', `${report.products} productos`);
    return { report, applied };
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
    c.log(dry ? 'woo.revisar' : 'woo.sincronizar', 'catalogo');
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
      let over = false;
      req.on('data', (c) => {
        size += c.length;
        if (over) return; // se sigue leyendo (y descartando) para poder contestar sin cortar la conexión
        if (size > 2e6) over = true;
        else chunks.push(c);
      });
      req.on('end', () => {
        if (over) return reject(new HttpError(413, 'El archivo es demasiado grande'));
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
      let over = false;
      req.on('data', (c) => {
        size += c.length;
        if (over) return;
        if (size > limit) over = true;
        else chunks.push(c);
      });
      req.on('end', () => (over ? reject(new HttpError(413, 'El archivo es demasiado grande')) : resolveBody(Buffer.concat(chunks))));
      req.on('error', reject);
    });


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
        const ctx = { params: m.groups || {}, query: url.searchParams, body: {}, status: 200, headers: req.headers, ip: clientIp(req), user: null };
        if (r.admin) {
          ctx.user = staffOf(req);
          if (!ctx.user) throw new HttpError(401, 'Inicia sesión para continuar');
          // perm = [] significa «cualquier usuario del panel»; si no, hace falta tener alguno de los permisos de la ruta.
          if (!(Array.isArray(r.perm) && !r.perm.length) && !auth.canAny(ctx.user, r.perm)) throw new HttpError(403, 'No tienes permiso para esto');
        }
        const logs = [];
        ctx.log = (action, entity = '', id = '', detail = '') => logs.push({ action, entity, id, detail });
        ctx.reply = (status, headers, body) => { ctx.rawResponse = { status, headers, body }; }; // para archivos (fotos, CSV)
        if (req.method !== 'GET') {
          if (r.raw) ctx.raw = await readRaw(req, r.limit);
          else ctx.body = await readBody(req);
        }
        const data = await r.handler(ctx);
        for (const l of logs) auth.audit(db, ctx.user, { ...l, ip: ctx.ip });
        if (ctx.rawResponse) {
          res.writeHead(ctx.rawResponse.status, { 'Cache-Control': 'no-store', ...ctx.rawResponse.headers });
          return res.end(req.method === 'HEAD' ? undefined : ctx.rawResponse.body);
        }
        return send(res, ctx.status, data);
      }
      throw new HttpError(404, 'Ruta no encontrada');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, details: err.details }, err.status === 413 ? { Connection: 'close' } : {});
      if (String(err.message).includes('STOCK_INSUFICIENTE')) {
        return send(res, 409, { error: 'No hay stock suficiente para completar la operación' });
      }
      console.error(err);
      send(res, 500, { error: 'Error interno del servidor' });
    }
  });

  // Cada petición arma lo que un pedido necesita de afuera (marca, enlaces, facturación, pasarela).
  const baseUrlOf = (c) => publicUrlEnv || publicOrigin({ headers: c.headers });
  const services = (c) => ({ brand, baseUrl: baseUrlOf(c), fiscal: fiscalCfg, hostedPayments: payments.isHosted(payCfg), paymentProvider: payCfg.provider });
  // Pedidos que esperan un pago que nunca llegó: se cancelan y el stock vuelve (se revisa en cada consulta y cada minuto).
  function sweepPayments(c) {
    payments.expirePending(db, payCfg, { onExpired: (orderId) => svc.failOrderPayment(db, orderId, { services: services(c || { headers: {} }), note: 'Venció el tiempo para pagar' }) });
  }
  const customerOf = (c) => {
    const parsed = sessions.parse(c.headers.authorization);
    if (!parsed || parsed.kind !== 'c') return null;
    const cu = accounts.customerById(db, parsed.id);
    return cu && sessions.valid(parsed, cu.pass_hash) ? cu : null;
  };
  const kit = { route, admin, db, brand, sessions, services, notifyCfg, fiscalCfg, payCfg, customerOf, giftFails, dummyHash: DUMMY_HASH, withDemoUsers };
  registerOps(kit);
  registerShop(kit);

  const timers = [];
  if (notify.notifyReady(notifyCfg)) timers.push(setInterval(() => notify.flush(db, notifyCfg, { brand, baseUrl: publicUrlEnv }).catch((e) => console.error('[avisos]', e.message)), 20_000));
  if (fiscalCfg.provider === 'webhook') timers.push(setInterval(() => invoicing.flushFiscal(db, fiscalCfg, { brand }).catch((e) => console.error('[facturas]', e.message)), 30_000));
  if (payments.isHosted(payCfg)) timers.push(setInterval(() => { try { sweepPayments(null); } catch (e) { console.error('[pagos]', e.message); } }, 60_000));
  for (const t of timers) t.unref();

  // Ninguna ruta del panel puede quedar sin permiso declarado (sería abierta a cualquier usuario del panel por descuido).
  for (const r of routes) if (r.admin && r.perm === null) throw new Error(`La ruta ${r.method} ${r.pattern} no declara qué permiso exige`);

  server.on('close', () => {
    if (flushTimer) clearInterval(flushTimer);
    for (const t of timers) clearInterval(t);
  });
  return { server, db, chat, brand, wooClient };
}
