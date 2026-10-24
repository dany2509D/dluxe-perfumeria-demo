// Facturación electrónica: cada venta pagada genera una factura y cada devolución, una nota de crédito.
//
// IMPORTANTE: en Panamá la factura electrónica se emite a través de un Proveedor Autorizado Calificado (PAC) autorizado por la
// DGI. Esta demostración NO emite documentos fiscales válidos. Trae dos proveedores:
//   · demo     (por defecto): numera los documentos como «FE-DEMO-000001» y los marca «SIN VALIDEZ FISCAL». Sirve para mostrar el
//              flujo completo (factura al cobrar, nota de crédito al devolver, listado en el panel).
//   · webhook  (FISCAL_PROVIDER=webhook, FISCAL_WEBHOOK_URL, FISCAL_WEBHOOK_SECRET): envía cada documento, firmado, a un servicio
//              propio (por ejemplo un flujo de n8n) que lo traduce al formato del PAC elegido y responde { number, auth_code, url }.
//              El contrato exacto está en el README. Lo que haga ese servicio con el PAC es parte de la integración real.
// Nunca se bloquea una venta por un problema de facturación: si falla, el documento queda en «error» para reintentarlo.
import { createHmac } from 'node:crypto';
import { HttpError, getSetting, setSetting } from './db.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const fiscalConfigFromEnv = (env = process.env) => ({
  provider: ['off', 'webhook'].includes(env.FISCAL_PROVIDER) ? env.FISCAL_PROVIDER : 'demo',
  url: env.FISCAL_WEBHOOK_URL || '',
  secret: env.FISCAL_WEBHOOK_SECRET || '',
});
export const fiscalReady = (cfg) => cfg.provider === 'demo' || (cfg.provider === 'webhook' && /^https?:\/\//i.test(cfg.url));

// El documento que se manda a quien lo emite.
export function buildDocument(db, orderId, kind, { brand, returnId = null } = {}) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new HttpError(404, 'Pedido no encontrado');
  let lines;
  let total;
  let reference = null;
  if (kind === 'nota_credito' && returnId) {
    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    lines = db
      .prepare(
        `SELECT v.sku, p.name, v.size_ml, ri.qty, ri.unit_refund AS unit_price
           FROM return_items ri JOIN variants v ON v.id = ri.variant_id JOIN products p ON p.id = v.product_id WHERE ri.return_id = ?`
      )
      .all(returnId);
    total = ret.amount;
  } else {
    lines = db
      .prepare(
        `SELECT v.sku, p.name, v.size_ml, oi.qty, oi.unit_price
           FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ?`
      )
      .all(orderId);
    total = o.total;
  }
  // La nota de crédito (por una devolución o por anular el pedido) hace referencia a la factura original.
  if (kind === 'nota_credito') reference = db.prepare("SELECT number FROM fiscal_docs WHERE order_id = ? AND kind = 'factura' AND number IS NOT NULL ORDER BY id LIMIT 1").get(orderId)?.number || null;
  const rate = brand?.taxRate > 0 && brand?.taxIncluded !== false ? brand.taxRate : 0;
  const tax = rate ? round2(total - total / (1 + rate)) : 0;
  return {
    kind,
    order_id: o.id,
    return_id: returnId,
    reference_number: reference,
    date: new Date().toISOString(),
    seller: { name: brand?.name || '', address: brand?.address || '', country: brand?.country || '' },
    customer: { name: o.customer_name, email: o.customer_email || '', phone: o.customer_phone || '' },
    lines: lines.map((l) => ({ sku: l.sku, description: `${l.name}${l.size_ml ? ` ${l.size_ml} ml` : ''}`, qty: l.qty, unit_price: round2(l.unit_price) })),
    tax: { name: brand?.taxName || 'ITBMS', rate, amount: tax, included: true },
    total: round2(total),
    currency: brand?.currency || 'USD',
    payment_method: o.payment_method,
  };
}

function nextNumber(db, kind) {
  const key = kind === 'factura' ? 'fiscal_seq_fe' : 'fiscal_seq_nc';
  const n = Number(getSetting(db, key, '0')) + 1;
  setSetting(db, key, n);
  return `${kind === 'factura' ? 'FE' : 'NC'}-DEMO-${String(n).padStart(6, '0')}`;
}

// Crea el documento de una venta o de una devolución. Con el proveedor «demo» queda emitido (simulado) en el acto; con «webhook»
// queda pendiente hasta que flushFiscal() lo envíe. Nunca lanza un error hacia la venta.
export function recordDocument(db, orderId, kind, { cfg, brand, returnId = null, amount = null, createdAt = null }) {
  if (!cfg || cfg.provider === 'off') return null;
  try {
    const doc = buildDocument(db, orderId, kind, { brand, returnId });
    const status = cfg.provider === 'demo' ? 'simulada' : 'pendiente';
    const number = cfg.provider === 'demo' ? nextNumber(db, kind) : null;
    const auth = cfg.provider === 'demo' ? `DEMO-${Math.random().toString(16).slice(2, 10).toUpperCase()}` : null;
    const cols = ['order_id', 'return_id', 'kind', 'number', 'auth_code', 'provider', 'status', 'amount'];
    const vals = [orderId, returnId, kind, number, auth, cfg.provider, status, amount ?? doc.total];
    if (createdAt) { cols.push('created_at'); vals.push(createdAt); }
    const r = db.prepare(`INSERT INTO fiscal_docs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
    return Number(r.lastInsertRowid);
  } catch (e) {
    try {
      db.prepare("INSERT INTO fiscal_docs (order_id, return_id, kind, provider, status, amount, error) VALUES (?, ?, ?, ?, 'error', ?, ?)").run(orderId, returnId, kind, cfg.provider, amount ?? 0, String(e.message).slice(0, 200));
    } catch { /* la venta sigue aunque no se pueda ni anotar el error */ }
    return null;
  }
}

// Envía a la integración los documentos pendientes (proveedor «webhook»).
export async function flushFiscal(db, cfg, { brand, fetchImpl = fetch, limit = 20 } = {}) {
  if (cfg.provider !== 'webhook' || !fiscalReady(cfg)) return { sent: 0, failed: 0 };
  const rows = db.prepare("SELECT * FROM fiscal_docs WHERE status IN ('pendiente','error') AND provider = 'webhook' ORDER BY id LIMIT ?").all(limit);
  let sent = 0;
  let failed = 0;
  for (const d of rows) {
    try {
      const body = JSON.stringify({ document_id: d.id, ...buildDocument(db, d.order_id, d.kind, { brand, returnId: d.return_id }) });
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.secret) headers['X-Signature'] = `sha256=${createHmac('sha256', cfg.secret).update(body).digest('hex')}`;
      const res = await fetchImpl(cfg.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json().catch(() => ({}));
      if (!out.number) throw new Error('La respuesta no trae el número del documento');
      db.prepare("UPDATE fiscal_docs SET status = 'emitida', number = ?, auth_code = ?, url = ?, error = NULL WHERE id = ?").run(String(out.number).slice(0, 60), out.auth_code ? String(out.auth_code).slice(0, 120) : null, /^https:\/\//.test(out.url || '') ? out.url : null, d.id);
      sent++;
    } catch (e) {
      db.prepare("UPDATE fiscal_docs SET status = 'error', error = ? WHERE id = ?").run(String(e.message).slice(0, 200), d.id);
      failed++;
    }
  }
  return { sent, failed };
}

export function retryDocument(db, id) {
  const r = db.prepare("UPDATE fiscal_docs SET status = 'pendiente', error = NULL WHERE id = ? AND status = 'error'").run(id);
  if (!r.changes) throw new HttpError(409, 'Solo se reintentan los documentos con error');
  return { ok: true };
}

export function listDocuments(db, { kind = '', status = '', q = '', page = 1, limit = 40 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 40, 100));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  if (['factura', 'nota_credito'].includes(kind)) { w.push('d.kind = ?'); a.push(kind); }
  if (['pendiente', 'emitida', 'error', 'simulada'].includes(status)) { w.push('d.status = ?'); a.push(status); }
  const term = String(q ?? '').trim();
  if (term) {
    const e = `%${term.slice(0, 40).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    w.push("(d.number LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR CAST(d.order_id AS TEXT) = ?)");
    a.push(e, e, term);
  }
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM fiscal_docs d JOIN orders o ON o.id = d.order_id WHERE ${cond}`).get(...a).n;
  const rows = db
    .prepare(`SELECT d.*, o.customer_name FROM fiscal_docs d JOIN orders o ON o.id = d.order_id WHERE ${cond} ORDER BY d.id DESC LIMIT ? OFFSET ?`)
    .all(...a, lim, (pg - 1) * lim);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM fiscal_docs GROUP BY status').all().map((r) => [r.status, r.n]));
  return { rows, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)), counts };
}

export const documentsOfOrder = (db, orderId) => db.prepare('SELECT id, kind, number, status, provider, amount, created_at FROM fiscal_docs WHERE order_id = ? ORDER BY id').all(orderId);
