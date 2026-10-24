// Fotos de productos subidas desde el panel. Se guardan en la propia base de datos (tabla media) y se sirven desde /api/media/:id,
// así funcionan igual en un servidor propio que en la función de Netlify. Solo se aceptan JPG, PNG y WebP, reconocidos por su
// contenido (no por el nombre ni por lo que diga el navegador); nunca SVG, que puede llevar código.
import { HttpError } from './db.js';

export const MAX_BYTES = 1_500_000; // el panel reduce la foto antes de subirla; esto es el tope de seguridad
const MAX_TOTAL = 40_000_000; // tope de todas las fotos juntas (la demo guarda su base de datos entera en cada cambio)

export function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function saveImage(db, buf, name = '') {
  if (!buf?.length) throw new HttpError(400, 'No llegó ninguna imagen');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'La imagen pesa demasiado (máximo 1,5 MB)');
  const mime = sniff(buf);
  if (!mime) throw new HttpError(400, 'Solo se aceptan imágenes JPG, PNG o WebP');
  const used = db.prepare('SELECT COALESCE(SUM(size), 0) AS t FROM media').get().t;
  if (used + buf.length > MAX_TOTAL) throw new HttpError(413, 'Se llegó al límite de fotos guardadas. Elimina algunas que ya no uses.');
  const r = db.prepare('INSERT INTO media (mime, bytes, size, name) VALUES (?, ?, ?, ?)').run(mime, buf, buf.length, String(name ?? '').replace(/[^\w. -]/g, '').slice(0, 80));
  const id = Number(r.lastInsertRowid);
  return { id, url: `/api/media/${id}`, mime, size: buf.length };
}

export function getImage(db, id) {
  const m = db.prepare('SELECT mime, bytes FROM media WHERE id = ?').get(id);
  if (!m) throw new HttpError(404, 'Imagen no encontrada');
  return { mime: m.mime, bytes: Buffer.from(m.bytes) };
}

// Borra las fotos que ningún producto usa (por ejemplo, la que se reemplazó). Las de la última hora se respetan: alguien puede
// haberla subido y estar a punto de guardarla en un producto.
export function pruneUnused(db) {
  const r = db
    .prepare("DELETE FROM media WHERE created_at < datetime('now','localtime','-1 hour') AND NOT EXISTS (SELECT 1 FROM products p WHERE p.image = '/api/media/' || media.id)")
    .run();
  return r.changes;
}
