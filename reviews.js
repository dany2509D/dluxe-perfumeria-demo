// Reseñas de productos: cualquier visitante puede dejar la suya y el panel permite moderarlas (eliminar).
// Todo lo que llega se limpia y se valida aquí; la tienda además lo escapa al mostrarlo.
import { HttpError } from './db.js';

export const LIMITS = { nameMin: 2, nameMax: 40, titleMax: 80, bodyMin: 10, bodyMax: 600 };

// Sin caracteres de control y con los espacios y saltos de línea convertidos en un solo espacio.
const squash = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
const HAS_LINK = /(https?:\/\/|www\.)/i;

export function cleanReview(input = {}) {
  const author = squash(input.name ?? input.author);
  const title = squash(input.title);
  const body = squash(input.body);
  const rating = Number(input.rating);
  if (author.length < LIMITS.nameMin || author.length > LIMITS.nameMax) throw new HttpError(400, `Escribe tu nombre (de ${LIMITS.nameMin} a ${LIMITS.nameMax} letras).`);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Elige una calificación de 1 a 5 estrellas.');
  if (title.length > LIMITS.titleMax) throw new HttpError(400, `El título es muy largo (máximo ${LIMITS.titleMax} caracteres).`);
  if (body.length < LIMITS.bodyMin) throw new HttpError(400, `Cuéntanos un poco más: la reseña necesita al menos ${LIMITS.bodyMin} caracteres.`);
  if (body.length > LIMITS.bodyMax) throw new HttpError(400, `La reseña es muy larga (máximo ${LIMITS.bodyMax} caracteres).`);
  if (HAS_LINK.test(`${author} ${title} ${body}`)) throw new HttpError(400, 'Por seguridad, las reseñas no pueden incluir enlaces.');
  return { author, rating, title, body };
}

const COLS = 'id, product_id, author, rating, title, body, sample, created_at';
const shape = (r) => ({ id: r.id, product_id: r.product_id, author: r.author, rating: r.rating, title: r.title, body: r.body, sample: !!r.sample, created_at: r.created_at });

// Promedio (un decimal), cantidad y cuántas hay de cada calificación.
export function summary(db, productId) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const r of db.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? GROUP BY rating').all(productId)) {
    dist[r.rating] = r.n;
    count += r.n;
    sum += r.rating * r.n;
  }
  return { avg: count ? Math.round((sum / count) * 10) / 10 : 0, count, dist };
}

export function listReviews(db, productId, { page = 1, limit = 10 } = {}) {
  const per = Math.min(30, Math.max(1, Math.floor(Number(limit)) || 10));
  const total = summary(db, productId).count;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const reviews = db
    .prepare(`SELECT ${COLS} FROM reviews WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(productId, per, (p - 1) * per)
    .map(shape);
  return { reviews, page: p, pages, total, summary: summary(db, productId) };
}

export function addReview(db, productId, input) {
  if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(productId)) throw new HttpError(404, 'Producto no encontrado');
  const r = cleanReview(input);
  if (db.prepare('SELECT 1 FROM reviews WHERE product_id = ? AND lower(author) = lower(?) AND body = ?').get(productId, r.author, r.body)) {
    throw new HttpError(409, 'Ya recibimos esa reseña.');
  }
  const id = Number(db.prepare('INSERT INTO reviews (product_id, author, rating, title, body) VALUES (?, ?, ?, ?, ?)').run(productId, r.author, r.rating, r.title, r.body).lastInsertRowid);
  return { review: shape(db.prepare(`SELECT ${COLS} FROM reviews WHERE id = ?`).get(id)), summary: summary(db, productId) };
}

// ─── Panel (moderación) ─────────────────────────────────────────────────────
export function listRecent(db, { page = 1, limit = 25 } = {}) {
  const per = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 25));
  const total = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  const reviews = db
    .prepare(
      `SELECT r.id, r.product_id, p.name AS product_name, p.brand AS product_brand, r.author, r.rating, r.title, r.body, r.sample, r.created_at
         FROM reviews r JOIN products p ON p.id = r.product_id ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`
    )
    .all(per, (p - 1) * per)
    .map((r) => ({ ...r, sample: !!r.sample }));
  return { reviews, page: p, pages, total, limit: per, avg: total ? Math.round((db.prepare('SELECT AVG(rating) AS a FROM reviews').get().a || 0) * 10) / 10 : 0 };
}

export function removeReview(db, id) {
  const done = db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  if (!done.changes) throw new HttpError(404, 'Reseña no encontrada');
  return { ok: true };
}
