// Normalización de texto compartida (búsqueda sin acentos ni mayúsculas).
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Texto de búsqueda de un producto: normalizado, con un espacio al inicio y al final para poder
// buscar por INICIO de palabra con LIKE '% palabra%' (así "dia" no encuentra "Me-dia-noche").
export function searchText(p) {
  const body = norm([p.name, p.brand, p.category, p.subcategory, p.kind, p.family, p.notes].filter(Boolean).join(' '))
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${body} `;
}
