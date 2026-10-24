// Tarjetas de regalo: se compran en la tienda o en el mostrador, se pagan con un código y llevan su saldo.
// Una tarjeta es dinero recibido por adelantado, no una venta: por eso no entra en los pedidos como ingreso hasta que se usa.
// Quien la usa paga con el saldo y el resto con otro método; si se devuelve algo de un pedido pagado con tarjeta, el dinero
// vuelve como una tarjeta nueva (nota de crédito).
import { randomBytes } from 'node:crypto';
import { HttpError } from './db.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const MIN_AMOUNT = 5;
export const MAX_AMOUNT = 1000;
const EXPIRY_MONTHS = 12;

// Sin 0/O ni 1/I/L para que se pueda dictar por teléfono sin confundirse. 12 letras = 60 bits: no se adivina.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode() {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `GC-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}
export const normalizeCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export function amountOf(v, min = MIN_AMOUNT) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > MAX_AMOUNT) throw new HttpError(400, `El monto debe estar entre $${min} y $${MAX_AMOUNT}`);
  return round2(n);
}

const expiry = (db) => db.prepare(`SELECT date('now','localtime','+${EXPIRY_MONTHS} months') AS d`).get().d;
const today = (db) => db.prepare("SELECT date('now','localtime') AS d").get().d;

// Emite una tarjeta. status: 'activa' (ya pagada) o 'pendiente' (esperando una transferencia).
export function issueCard(db, { amount, buyer = {}, recipient = {}, message = '', source = 'venta', paymentMethod = null, status = 'activa', user = null, shiftId = null }) {
  const value = amountOf(amount, source === 'nota_credito' ? 0.01 : MIN_AMOUNT); // una nota de crédito puede ser de cualquier monto
  const rEmail = String(recipient.email ?? '').trim();
  if (rEmail && !emailOk(rEmail)) throw new HttpError(400, 'El correo de quien recibe la tarjeta no es válido');
  const bEmail = String(buyer.email ?? '').trim();
  if (bEmail && !emailOk(bEmail)) throw new HttpError(400, 'El correo de quien compra no es válido');
  for (let tries = 0; tries < 5; tries++) {
    const code = randomCode();
    try {
      const r = db
        .prepare(
          `INSERT INTO gift_cards (code, initial_amount, balance, status, source, buyer_name, buyer_email, buyer_phone, recipient_name, recipient_email,
                                   message, payment_method, user_id, shift_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code, value, value, status, source, String(buyer.name ?? '').trim().slice(0, 80), bEmail || null, String(buyer.phone ?? '').trim().slice(0, 30) || null,
          String(recipient.name ?? '').trim().slice(0, 80), rEmail || null, String(message ?? '').trim().slice(0, 240), paymentMethod, user?.id ?? null, shiftId, expiry(db)
        );
      return getCard(db, Number(r.lastInsertRowid));
    } catch (e) {
      if (!String(e.message).includes('UNIQUE')) throw e;
    }
  }
  throw new HttpError(500, 'No se pudo generar el código de la tarjeta');
}

export const getCard = (db, id) => db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(id);
export const cardByCode = (db, code) => db.prepare('SELECT * FROM gift_cards WHERE code = ? COLLATE NOCASE').get(normalizeCode(code));

// ¿Se puede pagar con esta tarjeta? (Mismo mensaje para todo: no se revela si el código existe.)
export function usableCard(db, code) {
  const card = cardByCode(db, code);
  if (!card || card.status !== 'activa' || card.balance <= 0 || (card.expires_at && today(db) > card.expires_at)) {
    throw new HttpError(400, 'El código de la tarjeta de regalo no es válido, venció o no tiene saldo');
  }
  return card;
}

// Consulta pública del saldo.
export function balanceOf(db, code) {
  const card = usableCard(db, code);
  return { code: card.code, balance: card.balance, expires_at: card.expires_at };
}

// Usa parte del saldo en un pedido.
export function redeem(db, card, amount, orderId) {
  const use = round2(Math.min(amount, card.balance));
  if (use <= 0) return 0;
  const r = db.prepare("UPDATE gift_cards SET balance = round(balance - ?, 2) WHERE id = ? AND balance >= ? AND status = 'activa'").run(use, card.id, use);
  if (!r.changes) throw new HttpError(409, 'La tarjeta de regalo ya no tiene ese saldo');
  db.prepare("INSERT INTO gift_card_uses (gift_card_id, order_id, kind, amount) VALUES (?, ?, 'canje', ?)").run(card.id, orderId, use);
  return use;
}

// Si el pedido se cancela, el saldo vuelve a la tarjeta (una sola vez).
export function reverseForOrder(db, orderId) {
  const used = db.prepare("SELECT gift_card_id, SUM(amount) AS amount FROM gift_card_uses WHERE order_id = ? AND kind = 'canje' GROUP BY gift_card_id").all(orderId);
  const back = db.prepare("SELECT gift_card_id, SUM(amount) AS amount FROM gift_card_uses WHERE order_id = ? AND kind = 'reverso' GROUP BY gift_card_id").all(orderId);
  for (const u of used) {
    const already = back.find((b) => b.gift_card_id === u.gift_card_id)?.amount || 0;
    const left = round2(u.amount - already);
    if (left <= 0) continue;
    db.prepare('UPDATE gift_cards SET balance = round(balance + ?, 2) WHERE id = ?').run(left, u.gift_card_id);
    db.prepare("INSERT INTO gift_card_uses (gift_card_id, order_id, kind, amount) VALUES (?, ?, 'reverso', ?)").run(u.gift_card_id, orderId, left);
  }
}

// ─── Administración ────────────────────────────────────────────────────────
export function listCards(db, { q = '', status = '', page = 1, limit = 40 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 40, 100));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  if (['pendiente', 'activa', 'anulada'].includes(status)) { w.push('status = ?'); a.push(status); }
  const term = String(q ?? '').trim();
  if (term) {
    const e = `%${term.slice(0, 40).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    w.push("(code LIKE ? ESCAPE '\\' OR buyer_name LIKE ? ESCAPE '\\' OR recipient_name LIKE ? ESCAPE '\\' OR buyer_email LIKE ? ESCAPE '\\')");
    a.push(e, e, e, e);
  }
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM gift_cards WHERE ${cond}`).get(...a).n;
  const rows = db.prepare(`SELECT * FROM gift_cards WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, lim, (pg - 1) * lim);
  const day = today(db);
  const totals = db.prepare("SELECT COALESCE(SUM(balance), 0) AS outstanding, COUNT(*) AS n FROM gift_cards WHERE status = 'activa' AND balance > 0").get();
  return {
    rows: rows.map((c) => ({ ...c, expired: !!(c.expires_at && day > c.expires_at && c.balance > 0) })),
    total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)), outstanding: totals.outstanding, active_count: totals.n,
  };
}

export function cardDetail(db, id) {
  const card = getCard(db, id);
  if (!card) throw new HttpError(404, 'Tarjeta no encontrada');
  card.uses = db.prepare('SELECT gu.kind, gu.amount, gu.order_id, gu.created_at FROM gift_card_uses gu WHERE gu.gift_card_id = ? ORDER BY gu.id').all(id);
  return card;
}

export function setCardStatus(db, id, status) {
  const card = getCard(db, id);
  if (!card) throw new HttpError(404, 'Tarjeta no encontrada');
  if (status === 'activa') {
    if (card.status !== 'pendiente') throw new HttpError(409, 'Solo se activan las tarjetas pendientes de pago');
  } else if (status === 'anulada') {
    if (card.status === 'anulada') throw new HttpError(409, 'La tarjeta ya está anulada');
  } else throw new HttpError(400, 'El estado no es válido');
  db.prepare('UPDATE gift_cards SET status = ? WHERE id = ?').run(status, id);
  return getCard(db, id);
}

// Lo que se le muestra a quien compró (sin datos de otros).
export const publicCard = (c, { showCode = true } = {}) => ({
  id: c.id, code: showCode && c.status === 'activa' ? c.code : null, amount: c.initial_amount, balance: c.balance, status: c.status,
  recipient_name: c.recipient_name, message: c.message, expires_at: c.expires_at,
});
