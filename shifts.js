// Caja: cada cajero abre su turno con un fondo, cobra, y al terminar cuenta el efectivo. El sistema calcula cuánto debería haber
// y muestra la diferencia (sobrante o faltante). Los pagos con tarjeta o transferencia no cuentan como efectivo.
import { HttpError, tx } from './db.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const amount = (v, name, { min = 0, max = 1_000_000 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} no es válido`);
  return round2(n);
};

export const currentShift = (db, userId) => db.prepare("SELECT * FROM cash_shifts WHERE user_id = ? AND status = 'abierto'").get(userId) || null;

// Lo que pasó en el turno hasta ahora.
export function shiftTotals(db, shift) {
  const id = shift.id;
  const sales = db
    .prepare(
      `SELECT payment_method AS method, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(gift_amount), 0) AS gift
         FROM orders WHERE shift_id = ? AND status <> 'cancelado' GROUP BY payment_method`
    )
    .all(id);
  const by = (m) => sales.find((s) => s.method === m);
  const cashSales = round2((by('efectivo')?.total || 0) - (by('efectivo')?.gift || 0));
  const card = round2((by('tarjeta')?.total || 0) - (by('tarjeta')?.gift || 0));
  const transfer = round2((by('transferencia')?.total || 0) - (by('transferencia')?.gift || 0));
  const gift = round2(sales.reduce((s, r) => s + r.gift, 0));
  const giftCash = db.prepare("SELECT COALESCE(SUM(initial_amount), 0) AS t, COUNT(*) AS n FROM gift_cards WHERE shift_id = ? AND payment_method = 'efectivo' AND status <> 'anulada'").get(id);
  const refundCash = db.prepare("SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM returns WHERE shift_id = ? AND refund_method = 'efectivo'").get(id);
  const mov = db.prepare('SELECT kind, COALESCE(SUM(amount), 0) AS t FROM cash_movements WHERE shift_id = ? GROUP BY kind').all(id);
  const income = mov.find((m) => m.kind === 'ingreso')?.t || 0;
  const withdrawals = mov.find((m) => m.kind === 'retiro')?.t || 0;
  const expected = round2(shift.opening_cash + cashSales + giftCash.t + income - withdrawals - refundCash.t);
  return {
    tickets: sales.reduce((s, r) => s + r.n, 0),
    sales_total: round2(sales.reduce((s, r) => s + r.total, 0)),
    cash_sales: cashSales, card_sales: card, transfer_sales: transfer, gift_redeemed: gift,
    gift_cards_cash: round2(giftCash.t), gift_cards_sold: giftCash.n,
    refunds_cash: round2(refundCash.t), refunds_count: refundCash.n,
    income: round2(income), withdrawals: round2(withdrawals),
    expected_cash: expected,
  };
}

export function shiftView(db, shift) {
  const totals = shift.status === 'abierto' ? shiftTotals(db, shift) : JSON.parse(shift.summary || 'null') || shiftTotals(db, shift);
  const movements = db.prepare('SELECT kind, amount, reason, created_at FROM cash_movements WHERE shift_id = ? ORDER BY id').all(shift.id);
  return { ...shift, summary: undefined, totals, movements };
}

export function openShift(db, user, openingCash) {
  const cash = amount(openingCash ?? 0, 'El fondo de caja', { max: 100_000 });
  return tx(db, () => {
    if (currentShift(db, user.id)) throw new HttpError(409, 'Ya tienes una caja abierta');
    const r = db.prepare('INSERT INTO cash_shifts (user_id, user_name, opening_cash) VALUES (?, ?, ?)').run(user.id, user.name, cash);
    return shiftView(db, db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(Number(r.lastInsertRowid)));
  });
}

export function addMovement(db, user, { kind, amount: value, reason }) {
  if (!['ingreso', 'retiro'].includes(kind)) throw new HttpError(400, 'El tipo de movimiento no es válido');
  const v = amount(value, 'El monto', { min: 0.01, max: 100_000 });
  const why = String(reason ?? '').trim().slice(0, 120);
  if (!why) throw new HttpError(400, 'Indica el motivo');
  return tx(db, () => {
    const shift = currentShift(db, user.id);
    if (!shift) throw new HttpError(409, 'Abre tu caja primero');
    if (kind === 'retiro' && v > shiftTotals(db, shift).expected_cash) throw new HttpError(409, 'No hay tanto efectivo en la caja');
    db.prepare('INSERT INTO cash_movements (shift_id, kind, amount, reason) VALUES (?, ?, ?, ?)').run(shift.id, kind, v, why);
    return shiftView(db, shift);
  });
}

// Cierra el turno: guarda lo esperado, lo contado y la diferencia. `shiftId` permite que un gerente cierre la caja de otro.
export function closeShift(db, user, { counted, notes = '', shiftId = null }) {
  const cash = amount(counted, 'El efectivo contado', { max: 1_000_000 });
  return tx(db, () => {
    const shift = shiftId ? db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId) : currentShift(db, user.id);
    if (!shift) throw new HttpError(404, 'No hay una caja abierta');
    if (shift.status !== 'abierto') throw new HttpError(409, 'Esa caja ya está cerrada');
    const totals = shiftTotals(db, shift);
    const diff = round2(cash - totals.expected_cash);
    db.prepare(
      `UPDATE cash_shifts SET status = 'cerrado', closed_at = datetime('now','localtime'), expected_cash = ?, counted_cash = ?, difference = ?, notes = ?, summary = ? WHERE id = ?`
    ).run(totals.expected_cash, cash, diff, String(notes ?? '').trim().slice(0, 200), JSON.stringify(totals), shift.id);
    return shiftView(db, db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shift.id));
  });
}

export function listShifts(db, { userId = null, page = 1, limit = 30 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 30, 100));
  const pg = Math.max(1, Number(page) || 1);
  const where = userId ? 'WHERE user_id = ?' : '';
  const a = userId ? [userId] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM cash_shifts ${where}`).get(...a).n;
  const rows = db.prepare(`SELECT * FROM cash_shifts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, lim, (pg - 1) * lim);
  return { rows: rows.map((s) => ({ ...shiftView(db, s) })), total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)) };
}

export function getShift(db, id) {
  const s = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(id);
  if (!s) throw new HttpError(404, 'Caja no encontrada');
  return shiftView(db, s);
}
