// Rutas públicas de la tienda: precio de la bolsa con ofertas, tarjetas de regalo, «avísame», seguimiento, buscador guiado,
// cuentas de clientes, favoritos, fotos y confirmación de pagos.
import { HttpError, tx } from './db.js';
import * as svc from './service.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as pricing from './pricing.js';
import * as gift from './giftcards.js';
import * as bundles from './bundles.js';
import * as notify from './notify.js';
import * as tracking from './tracking.js';
import * as finder from './finder.js';
import * as accounts from './accounts.js';
import * as media from './media.js';
import * as payments from './payments.js';
import { notifyGiftCard } from './routes-ops.js';

const CUSTOMER_TTL = 30 * 24 * 3600e3;

export function registerShop(kit) {
  const { route, db, sessions, services, payCfg, customerOf, giftFails: giftCheckFails, dummyHash } = kit;

  // Topes por visitante (en memoria): frenan adivinar códigos y llenar la base de avisos o cuentas.
  const limit = (max, windowMs) => {
    const lim = auth.createLimiter({ max, windowMs });
    return (c, msg = 'Demasiados intentos. Inténtalo de nuevo en unos minutos.') => {
      if (!lim.take(c.ip)) throw new HttpError(429, msg);
    };
  };
  const quoteLimit = limit(120, 60e3);
  const giftBuyLimit = limit(10, 3600e3);
  const notifyLimit = limit(10, 3600e3);
  const trackLimit = limit(600, 15 * 60e3); // consultas en total
  const trackMiss = auth.createLimiter({ max: 20, windowMs: 15 * 60e3 }); // consultas que no encuentran nada (frena adivinar datos)
  const registerLimit = limit(Number(process.env.ACCOUNT_REGISTER_PER_HOUR || 10), 3600e3); // cuentas nuevas por hora y por conexión
  const loginFails = auth.createLimiter({ max: 8, windowMs: 15 * 60e3 });
  const finderLimit = limit(60, 60e3);

  const needCustomer = (c) => {
    const cu = customerOf(c);
    if (!cu) throw new HttpError(401, 'Inicia sesión para continuar');
    return cu;
  };
  const sessionFor = (cu) => ({ token: sessions.issue('c', cu.id, cu.pass_hash, CUSTOMER_TTL), customer: accounts.profile(db, cu.id) });

  // ─── Ofertas y precio de la bolsa ─────────────────────────────────────
  route('GET', '/api/offers', () => ({ offers: pricing.publicOffers(db) }));

  // Calcula la bolsa con ofertas, cupón y tarjeta de regalo, sin crear nada.
  route('POST', '/api/cart/quote', (c) => {
    quoteLimit(c);
    const wanted = new Map();
    for (const it of Array.isArray(c.body.items) ? c.body.items.slice(0, 50) : []) {
      const id = Number(it.variant_id);
      const qty = Math.min(99, Math.max(1, Math.floor(Number(it.qty) || 0)));
      if (Number.isInteger(id) && id > 0 && qty > 0) wanted.set(id, (wanted.get(id) || 0) + qty);
    }
    const lines = bundles.priceLinesOf(db, wanted);
    const q = pricing.quote(db, { lines, coupon: c.body.coupon, channel: 'online', email: c.body.email });
    let giftOut = null;
    const code = String(c.body.gift_code ?? '').trim();
    if (code) {
      if (giftCheckFails.blocked(c.ip)) throw new HttpError(429, 'Demasiados códigos incorrectos. Inténtalo de nuevo en unos minutos.');
      try {
        const card = gift.usableCard(db, code);
        giftOut = { code: card.code, balance: card.balance, applied: Math.min(card.balance, q.total) };
      } catch (e) {
        giftCheckFails.take(c.ip);
        throw e;
      }
    }
    const due = Math.round((q.total - (giftOut?.applied || 0)) * 100) / 100;
    return { subtotal: q.subtotal, discount: q.discount, total: q.total, applied: q.applied, coupon_note: q.couponNote, gift: giftOut, due };
  });

  // ─── Tarjetas de regalo ───────────────────────────────────────────────
  route('POST', '/api/gift-cards/check', (c) => {
    if (giftCheckFails.blocked(c.ip)) throw new HttpError(429, 'Demasiados códigos incorrectos. Inténtalo de nuevo en unos minutos.');
    try {
      return gift.balanceOf(db, c.body.code);
    } catch (e) {
      giftCheckFails.take(c.ip);
      throw e;
    }
  });
  route('POST', '/api/gift-cards', (c) => {
    giftBuyLimit(c, 'Has comprado varias tarjetas seguidas. Inténtalo de nuevo más tarde.');
    if (c.body.website) throw new HttpError(400, 'No se pudo completar la compra.'); // campo trampa
    const method = c.body.payment_method;
    if (!['tarjeta', 'transferencia'].includes(method)) throw new HttpError(400, 'Elige cómo vas a pagar');
    const buyer = c.body.buyer || {};
    if (!String(buyer.name ?? '').trim()) throw new HttpError(400, 'Escribe tu nombre');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(buyer.email ?? '').trim())) throw new HttpError(400, 'Escribe tu correo para enviarte el código');
    const cu = customerOf(c);
    c.status = 201;
    // Con tarjeta (simulada en la demostración) queda activa al instante; con transferencia espera a que se confirme el pago.
    const card = gift.issueCard(db, { amount: c.body.amount, buyer: { ...buyer, phone: buyer.phone }, recipient: c.body.recipient, message: c.body.message, paymentMethod: method, status: method === 'tarjeta' ? 'activa' : 'pendiente' });
    if (method === 'tarjeta') notifyGiftCard(db, card, services(c));
    return { ...gift.publicCard(card), pending: card.status === 'pendiente', reference: `TR-${String(card.id).padStart(5, '0')}`, customer: !!cu };
  });

  // ─── Avísame cuando llegue ────────────────────────────────────────────
  route('POST', '/api/products/:id/notify', (c) => {
    if (c.body.website) throw new HttpError(400, 'No se pudo guardar tu aviso.');
    notifyLimit(c, 'Has pedido varios avisos seguidos. Inténtalo de nuevo más tarde.');
    const pid = Number(c.params.id);
    const p = db.prepare('SELECT id FROM products WHERE id = ? AND active = 1').get(pid);
    if (!p) throw new HttpError(404, 'Producto no encontrado');
    let variantId = null;
    if (c.body.variant_id != null && c.body.variant_id !== '') {
      variantId = Number(c.body.variant_id);
      const v = db.prepare('SELECT stock FROM variants WHERE id = ? AND product_id = ? AND active = 1').get(variantId, pid);
      if (!v) throw new HttpError(404, 'Ese tamaño no existe');
      if (v.stock > 0) throw new HttpError(409, 'Ese tamaño ya está disponible');
    } else if (db.prepare('SELECT 1 FROM variants WHERE product_id = ? AND active = 1 AND stock > 0 LIMIT 1').get(pid)) {
      throw new HttpError(409, 'Este producto ya está disponible');
    }
    const channel = c.body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    let contact = String(c.body.contact ?? '').trim();
    if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new HttpError(400, 'Escribe un correo válido');
    } else {
      contact = notify.phoneDigits(contact) || '';
      if (!contact) throw new HttpError(400, 'Escribe un número de WhatsApp válido');
      if (!c.body.consent) throw new HttpError(400, 'Acepta que te escribamos por WhatsApp para avisarte');
    }
    const name = String(c.body.name ?? '').trim().slice(0, 60);
    try {
      db.prepare('INSERT INTO stock_alerts (product_id, variant_id, channel, contact, name) VALUES (?, ?, ?, ?, ?)').run(pid, variantId, channel, contact, name);
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
    c.status = 201;
    return { ok: true };
  });

  // ─── Seguimiento del pedido ───────────────────────────────────────────
  route('GET', '/api/track', (c) => {
    trackLimit(c, 'Demasiadas consultas. Inténtalo de nuevo en unos minutos.');
    if (trackMiss.blocked(c.ip)) throw new HttpError(429, 'Demasiadas consultas sin resultado. Revisa los datos e inténtalo de nuevo en unos minutos.');
    try {
      return tracking.publicTrack(db, { code: c.query.get('code') || '', order: c.query.get('order'), contact: c.query.get('contact') || '' });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) trackMiss.take(c.ip);
      throw e;
    }
  });

  // ─── Buscador guiado ──────────────────────────────────────────────────
  route('GET', '/api/finder/questions', () => ({ questions: finder.QUESTIONS }));
  route('POST', '/api/finder', (c) => {
    finderLimit(c);
    return finder.recommend(db, c.body.answers || c.body);
  });

  // ─── Productos por número (favoritos) y fichas de sets ────────────────
  route('GET', '/api/products-by-ids', (c) => ({ products: catalog.getProductsByIds(db, String(c.query.get('ids') || '').split(',').slice(0, 100).map(Number)) }));

  // ─── Cuentas de clientes ──────────────────────────────────────────────
  route('POST', '/api/account/register', (c) => {
    registerLimit(c, 'Se crearon varias cuentas desde esta conexión. Inténtalo de nuevo más tarde.');
    if (c.body.website) throw new HttpError(400, 'No se pudo crear la cuenta.');
    c.status = 201;
    return sessionFor(accounts.registerCustomer(db, c.body));
  });
  route('POST', '/api/account/login', (c) => {
    const email = String(c.body.email ?? '').trim().toLowerCase().slice(0, 120);
    const key = `${email}:${c.ip}`;
    if (loginFails.blocked(key)) throw new HttpError(429, 'Demasiados intentos. Vuelve a intentarlo en unos minutos.');
    const cu = accounts.checkLogin(db, email, c.body.password, dummyHash);
    if (!cu) {
      loginFails.take(key);
      throw new HttpError(401, 'Correo o contraseña incorrectos');
    }
    loginFails.reset(key);
    return sessionFor(cu);
  });
  route('GET', '/api/account/me', (c) => ({ customer: accounts.profile(db, needCustomer(c).id) }));
  route('PATCH', '/api/account/me', (c) => ({ customer: accounts.updateProfile(db, needCustomer(c).id, c.body) }));
  route('POST', '/api/account/password', (c) => {
    const cu = needCustomer(c);
    accounts.changePassword(db, cu.id, c.body.current, c.body.next);
    return sessionFor(accounts.customerById(db, cu.id)); // la clave nueva cierra las demás sesiones
  });
  route('GET', '/api/account/orders', (c) => ({ orders: accounts.ordersOf(db, needCustomer(c).id) }));
  route('GET', '/api/account/favorites', (c) => ({ ids: accounts.favoritesOf(db, needCustomer(c).id) }));
  route('PUT', '/api/account/favorites', (c) => ({ ids: accounts.setFavorites(db, needCustomer(c).id, c.body.ids) }));

  // ─── Fotos ────────────────────────────────────────────────────────────
  route('GET', '/api/media/:id', (c) => {
    const m = media.getImage(db, Number(c.params.id));
    c.reply(200, {
      'Content-Type': m.mime,
      'Cache-Control': 'public, max-age=31536000, immutable', // una foto nueva siempre tiene número nuevo
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }, m.bytes);
  });

  // ─── Pagos ────────────────────────────────────────────────────────────
  const settle = (reference, status, c) => {
    const svcs = services(c);
    return tx(db, () =>
      payments.settle(db, reference, status, {
        onPaid: (orderId) => svc.markOrderPaid(db, orderId, { services: svcs }),
        onFailed: (orderId) => svc.failOrderPayment(db, orderId, { services: svcs, note: 'El pago fue rechazado' }),
        onLate: (orderId) => tracking.addEvent(db, orderId, 'pago_tardio', { note: 'La pasarela cobró este pedido cuando ya no esperaba el pago: revisar y devolver el dinero' }),
      })
    ); // un solo bloque: o se anota el resultado del pago y se actualiza el pedido, o no se hace nada
  };
  // Aviso de la pasarela (o del servicio intermediario): { reference, status: "pagado" | "fallido" }, con firma.
  route('POST', '/api/payments/webhook', (c) => {
    if (!payCfg.secret) throw new HttpError(503, 'El aviso de pagos no está configurado (PAYMENTS_WEBHOOK_SECRET)');
    if (!payments.verifySignature(c.raw, c.headers['x-signature'], payCfg.secret)) throw new HttpError(401, 'Firma no válida');
    let body;
    try { body = JSON.parse(c.raw.toString('utf8')); } catch { throw new HttpError(400, 'El cuerpo no es JSON válido'); }
    return settle(body.reference, body.status, c);
  }, { raw: true, limit: 1e5 });
  // Página de pago de ejemplo (solo con PAYMENTS_PROVIDER=demo-hosted): quien paga elige si el pago sale bien o mal.
  route('POST', '/api/payments/demo/complete', (c) => {
    if (payCfg.provider !== 'demo-hosted') throw new HttpError(404, 'Ruta no encontrada');
    return settle(c.body.reference, c.body.result === 'fallido' ? 'fallido' : 'pagado', c);
  });
  route('GET', '/api/payments/mode', () => ({ provider: payCfg.provider, hosted: payments.isHosted(payCfg) }));
}
