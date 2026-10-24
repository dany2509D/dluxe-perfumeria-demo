// Avisos a clientes y al equipo (WhatsApp y correo): confirmación del pedido, cada paso de su entrega, «ya llegó lo que
// pediste», tarjetas de regalo y alertas de stock bajo.
//
// Cómo funciona: cada aviso se guarda en la bandeja de salida (tabla notifications) con su plantilla y sus datos. Dónde se
// entrega depende de cómo esté instalado:
//   · Sin NOTIFY_WEBHOOK_URL (demostración): el aviso queda como «simulado», con el texto exacto que se enviaría. No sale nada.
//   · Con NOTIFY_WEBHOOK_URL: cada aviso se envía a ese enlace con una firma (X-Signature, HMAC-SHA256 con NOTIFY_WEBHOOK_SECRET).
//     Pensado para un flujo de n8n que lo reenvía por WhatsApp Business (plantillas aprobadas) o por correo.
// A WhatsApp solo se escribe a quien lo aceptó al comprar (consentimiento) o a números del propio equipo.
import { createHmac } from 'node:crypto';
import { HttpError, setSetting } from './db.js';

const MAX_ATTEMPTS = 5;

export const notifyConfigFromEnv = (env = process.env) => ({ url: env.NOTIFY_WEBHOOK_URL || '', secret: env.NOTIFY_WEBHOOK_SECRET || '' });
export const notifyReady = (cfg) => /^https?:\/\//i.test(cfg?.url || '');

// Los triggers de la base de datos (stock bajo, «ya llegó») leen este modo para saber cómo dejar el aviso.
export function applyMode(db, cfg) {
  setSetting(db, 'notify_mode', notifyReady(cfg) ? 'webhook' : 'simulado');
}
const modeOf = (db) => (db.prepare("SELECT value FROM settings WHERE key = 'notify_mode'").get()?.value === 'webhook' ? 'pendiente' : 'simulado');

// Número a dígitos con código de país. Un número de 8 cifras se toma como panameño (507).
export function phoneDigits(raw, defaultCountry = '507') {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = defaultCountry + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? ''));

export function enqueue(db, { channel, to, template, payload = {}, key = null }) {
  let addr = String(to ?? '').trim();
  if (channel === 'whatsapp') addr = phoneDigits(addr) || '';
  else if (channel === 'email') addr = emailOk(addr) ? addr : '';
  else throw new Error(`Canal desconocido: ${channel}`);
  if (!addr) return null;
  const r = db
    .prepare('INSERT OR IGNORE INTO notifications (channel, to_addr, template, payload, status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channel, addr, template, JSON.stringify(payload), modeOf(db), key);
  return r.changes ? Number(r.lastInsertRowid) : null;
}

// ─── Textos ────────────────────────────────────────────────────────────────
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const first = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';
const link = (url) => (url ? `\n${url}` : '');

const STEP_TEXT = {
  recibido: (p) => ({ subject: `Recibimos tu pedido #${p.order_id}`, text: `Hola ${first(p.name)}, recibimos tu pedido #${p.order_id} por ${money(p.total)}.${p.lines ? `\n${p.lines}` : ''}\nPuedes seguirlo aquí:${link(p.url)}` }),
  pago_confirmado: (p) => ({ subject: `Pago confirmado · pedido #${p.order_id}`, text: `Hola ${first(p.name)}, confirmamos el pago de tu pedido #${p.order_id}. Ya lo estamos preparando.${link(p.url)}` }),
  preparando: (p) => ({ subject: `Estamos preparando tu pedido #${p.order_id}`, text: `Hola ${first(p.name)}, estamos preparando tu pedido #${p.order_id}.${link(p.url)}` }),
  listo: (p) => ({ subject: `Tu pedido #${p.order_id} está listo para retirar`, text: `Hola ${first(p.name)}, tu pedido #${p.order_id} ya está listo para retirar en tienda.${p.hours ? `\nHorario: ${p.hours}.` : ''}${link(p.url)}` }),
  enviado: (p) => ({ subject: `Tu pedido #${p.order_id} va en camino`, text: `Hola ${first(p.name)}, tu pedido #${p.order_id} salió hacia ${p.address || 'tu dirección'}.${link(p.url)}` }),
  entregado: (p) => ({ subject: `Pedido #${p.order_id} entregado`, text: `Hola ${first(p.name)}, tu pedido #${p.order_id} fue entregado. ¡Gracias por tu compra! Si te gustó, cuéntanos en una reseña.${link(p.url)}` }),
  cancelado: (p) => ({ subject: `Pedido #${p.order_id} cancelado`, text: `Hola ${first(p.name)}, tu pedido #${p.order_id} fue cancelado. Si tienes dudas, escríbenos.${link(p.url)}` }),
};

function renderOrderStep(n, p, brand) {
  const t = (STEP_TEXT[p.step] || STEP_TEXT.recibido)(p);
  return { subject: `${brand.short}: ${t.subject}`, text: `${brand.short}: ${t.text}` };
}

// Arma el texto de un aviso a partir de su plantilla y sus datos. Algunas plantillas (las que crean los triggers) solo traen ids.
export function renderMessage(db, n, { brand, baseUrl = '' }) {
  let p = {};
  try { p = JSON.parse(n.payload || '{}'); } catch { /* aviso con datos dañados: se muestra lo básico */ }
  switch (n.template) {
    case 'pedido_estado':
      return renderOrderStep(n, p, brand);
    case 'stock_disponible': {
      const row = db.prepare('SELECT p.id, p.name, v.size_ml FROM products p LEFT JOIN variants v ON v.id = ? WHERE p.id = ?').get(p.variant_id ?? 0, p.product_id);
      const what = row ? `${row.name}${row.size_ml ? ` ${row.size_ml} ml` : ''}` : 'El producto que pediste';
      const url = baseUrl && row ? `${baseUrl}/#producto/${row.id}` : '';
      return { subject: `${brand.short}: ya llegó ${what}`, text: `${brand.short}: ¡Buenas noticias${p.name ? `, ${first(p.name)}` : ''}! ${what} ya está disponible de nuevo.${link(url)}` };
    }
    case 'stock_bajo': {
      const row = db.prepare('SELECT v.sku, v.size_ml, v.stock, v.min_stock, p.name FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?').get(p.variant_id);
      const what = row ? `${row.name}${row.size_ml ? ` ${row.size_ml} ml` : ''} (${row.sku})` : `variante ${p.variant_id}`;
      return { subject: `${brand.short}: stock bajo de ${what}`, text: `${brand.short} · Alerta de inventario: quedan ${row ? row.stock : p.stock} de ${what}; el mínimo es ${row ? row.min_stock : p.min}.` };
    }
    case 'tarjeta_regalo':
      return {
        subject: `${brand.short}: ${p.from ? `${p.from} te regaló` : 'Tienes'} una tarjeta de regalo`,
        text: `${brand.short}: ${p.to ? `Hola ${first(p.to)}, ` : ''}${p.from ? `${p.from} te regaló` : 'tienes'} una tarjeta de regalo de ${money(p.amount)}.${p.message ? `\n«${p.message}»` : ''}\nCódigo: ${p.code}${p.expires_at ? `\nVálida hasta el ${p.expires_at}.` : ''}${link(baseUrl)}`,
      };
    case 'tarjeta_regalo_comprador':
      return { subject: `${brand.short}: tu tarjeta de regalo`, text: `${brand.short}: Hola ${first(p.name)}, tu tarjeta de regalo de ${money(p.amount)} para ${p.recipient || 'tu regalo'} está lista. Código: ${p.code}${p.expires_at ? `\nVálida hasta el ${p.expires_at}.` : ''}` };
    case 'prueba':
      return { subject: `${brand.short}: aviso de prueba`, text: `${brand.short}: este es un aviso de prueba. Si lo recibes, la conexión funciona.` };
    default:
      return { subject: `${brand.short}: aviso`, text: `${brand.short}: ${n.template}` };
  }
}

// ─── Pedidos ───────────────────────────────────────────────────────────────
// Avisa al cliente cada paso de su pedido. Por correo siempre que haya uno; por WhatsApp solo si lo aceptó al comprar.
export function notifyOrderStep(db, order, step, { baseUrl = '', brand } = {}) {
  const url = baseUrl && order.tracking_code ? `${baseUrl}/#seguimiento/${order.tracking_code}` : '';
  const items = order.items || [];
  const payload = {
    step, order_id: order.id, name: order.customer_name, total: order.total, url, hours: brand?.hours || '', address: order.address || '',
    delivery: order.delivery, tracking_code: order.tracking_code,
    lines: items.slice(0, 6).map((i) => `• ${i.qty} × ${i.name}${i.size_ml ? ` ${i.size_ml} ml` : ''}`).join('\n') + (items.length > 6 ? `\n… y ${items.length - 6} más` : ''),
  };
  const ids = [];
  if (order.customer_email) ids.push(enqueue(db, { channel: 'email', to: order.customer_email, template: 'pedido_estado', payload, key: `ord:${order.id}:${step}:email` }));
  if (order.notify_opt_in && order.customer_phone) ids.push(enqueue(db, { channel: 'whatsapp', to: order.customer_phone, template: 'pedido_estado', payload, key: `ord:${order.id}:${step}:wa` }));
  return ids.filter(Boolean);
}

// ─── Bandeja ───────────────────────────────────────────────────────────────
export function listNotifications(db, { status = '', channel = '', page = 1, limit = 40, brand, baseUrl = '' } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 40, 100));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  if (['pendiente', 'enviado', 'error', 'simulado'].includes(status)) { w.push('status = ?'); a.push(status); }
  if (['whatsapp', 'email'].includes(channel)) { w.push('channel = ?'); a.push(channel); }
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${cond}`).get(...a).n;
  const rows = db.prepare(`SELECT * FROM notifications WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, lim, (pg - 1) * lim);
  return {
    rows: rows.map((n) => ({ id: n.id, channel: n.channel, to: n.to_addr, template: n.template, status: n.status, attempts: n.attempts, last_error: n.last_error, created_at: n.created_at, sent_at: n.sent_at, ...renderMessage(db, n, { brand, baseUrl }) })),
    total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)), counts: counts(db),
  };
}

export const counts = (db) => Object.fromEntries(['pendiente', 'enviado', 'error', 'simulado'].map((s) => [s, db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE status = ?').get(s).n]));

// Envía los pendientes al enlace configurado (n8n). Reintenta hasta MAX_ATTEMPTS veces; luego queda en «error» para revisarlo.
export async function flush(db, cfg, { brand, baseUrl = '', limit = 25, fetchImpl = fetch } = {}) {
  if (!notifyReady(cfg)) return { sent: 0, failed: 0, skipped: 0 };
  const rows = db.prepare("SELECT * FROM notifications WHERE status = 'pendiente' AND attempts < ? ORDER BY id LIMIT ?").all(MAX_ATTEMPTS, limit);
  let sent = 0;
  let failed = 0;
  for (const n of rows) {
    const msg = renderMessage(db, n, { brand, baseUrl });
    let payload = {};
    try { payload = JSON.parse(n.payload || '{}'); } catch { /* sin datos */ }
    const body = JSON.stringify({ id: n.id, event: n.template, channel: n.channel, to: n.to_addr, subject: msg.subject, text: msg.text, data: payload, store: brand?.name || '', created_at: n.created_at });
    const headers = { 'Content-Type': 'application/json', 'X-Notification-Id': String(n.id) };
    if (cfg.secret) headers['X-Signature'] = `sha256=${createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
    try {
      const res = await fetchImpl(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      db.prepare("UPDATE notifications SET status = 'enviado', attempts = attempts + 1, last_error = NULL, sent_at = datetime('now','localtime') WHERE id = ?").run(n.id);
      sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      db.prepare('UPDATE notifications SET status = ?, attempts = ?, last_error = ? WHERE id = ?').run(attempts >= MAX_ATTEMPTS ? 'error' : 'pendiente', attempts, String(e.message).slice(0, 200), n.id);
      failed++;
    }
  }
  return { sent, failed, skipped: 0 };
}

export function retry(db, id) {
  const r = db.prepare("UPDATE notifications SET status = 'pendiente', attempts = 0, last_error = NULL WHERE id = ? AND status = 'error'").run(id);
  if (!r.changes) throw new HttpError(409, 'Solo se reintentan los avisos con error');
  return { ok: true };
}

// Aviso de prueba al número o correo del encargado (para comprobar la conexión).
export function sendTest(db, { channel, to }) {
  const id = enqueue(db, { channel, to, template: 'prueba', payload: {}, key: null });
  if (!id) throw new HttpError(400, channel === 'email' ? 'El correo no es válido' : 'El número no es válido (incluye el código de país, por ejemplo 507…)');
  return { id };
}
