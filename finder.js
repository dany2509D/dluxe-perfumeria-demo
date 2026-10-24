// Buscador guiado: cinco preguntas ("¿para quién?", "¿qué ocasión?", "¿qué estilo?", "¿qué intensidad?", "¿qué presupuesto?") y
// tres recomendaciones con el motivo de cada una. No usa inteligencia artificial: puntúa el catálogo real con reglas claras
// (familia olfativa, notas, intensidad, ocasión, precio y existencias), así que da siempre la misma respuesta y no cuesta nada.
// Si no hay coincidencias exactas, va aflojando criterios en orden (primero la intensidad, luego el estilo, al final el presupuesto)
// y avisa cuáles aflojó.
import { norm } from './text.js';
import { searchProducts } from './catalog.js';
import { HttpError } from './db.js';

export const QUESTIONS = [
  { id: 'for', title: '¿Para quién es?', options: [['damas', 'Para ella'], ['caballeros', 'Para él'], ['unisex', 'Para cualquiera (unisex)'], ['infantil', 'Para un niño o una niña'], ['', 'Me da igual']] },
  { id: 'occasion', title: '¿Para qué ocasión?', options: [['diario', 'Todos los días'], ['trabajo', 'Trabajo u oficina'], ['noche', 'Salidas y noche'], ['especial', 'Una ocasión especial'], ['regalo', 'Es un regalo']] },
  { id: 'style', title: '¿Qué aromas te atraen?', options: [['dulce', 'Dulces y cremosos (vainilla, caramelo, frutas)'], ['fresco', 'Frescos y limpios (cítricos, mar, té)'], ['floral', 'Florales (rosa, jazmín, peonía)'], ['amaderado', 'Amaderados (cedro, cuero, vetiver)'], ['especiado', 'Intensos y especiados (oud, ámbar, incienso)'], ['', 'No sé, sorpréndeme']] },
  { id: 'intensity', title: '¿Qué tan notorio lo quieres?', options: [['suave', 'Suave y discreto'], ['media', 'Equilibrado'], ['intensa', 'Intenso, que se note']] },
  { id: 'budget', title: '¿Cuánto quieres invertir?', options: [['hasta40', 'Hasta $40'], ['40a80', 'De $40 a $80'], ['80a150', 'De $80 a $150'], ['mas150', 'Más de $150'], ['sin', 'Sin límite']] },
];

const STYLE = {
  dulce: { families: ['gourmand', 'frutal'], words: ['vainilla', 'caramelo', 'cereza', 'almendra', 'fresa', 'tonka', 'chocolate', 'coco', 'miel', 'azucar', 'sandalo'] },
  fresco: { families: ['fresco', 'citrico', 'aromatico'], words: ['marino', 'sal', 'bergamota', 'limon', 'naranja', 'menta', 'algodon', 'te', 'pera', 'manzana', 'brisa', 'mandarina', 'neroli'] },
  floral: { families: ['floral'], words: ['rosa', 'jazmin', 'peonia', 'lirio', 'iris', 'azahar', 'flor', 'neroli', 'taifi'] },
  amaderado: { families: ['amaderado'], words: ['cedro', 'sandalo', 'vetiver', 'madera', 'cuero', 'tabaco', 'pachuli'] },
  especiado: { families: ['oriental'], words: ['oud', 'ambar', 'canela', 'azafran', 'pimienta', 'incienso', 'cardamomo', 'resina'] },
};
// Intensidad típica de cada familia (1 suave, 2 equilibrada, 3 intensa).
const FAMILY_INTENSITY = { fresco: 1, citrico: 1, aromatico: 1, frutal: 1, floral: 2, gourmand: 2, amaderado: 3, oriental: 3 };
const WANTED = { suave: 1, media: 2, intensa: 3 };
const OCCASION_FAMILIES = {
  diario: ['fresco', 'citrico', 'floral', 'aromatico', 'frutal'],
  trabajo: ['fresco', 'citrico', 'aromatico', 'amaderado'],
  noche: ['oriental', 'gourmand', 'amaderado', 'floral'],
  especial: ['oriental', 'gourmand', 'floral', 'amaderado'],
};
const BUDGETS = { hasta40: [0, 40], '40a80': [40, 80], '80a150': [80, 150], mas150: [150, 100000], sin: [0, 100000] };
const CATEGORY = { damas: 'Damas', caballeros: 'Caballeros', infantil: 'Infantil', unisex: 'Unisex' };

const has = (q, id) => QUESTIONS.find((x) => x.id === id).options.some(([v]) => v === q);

export function cleanAnswers(raw = {}) {
  const a = {};
  for (const q of QUESTIONS) {
    const v = String(raw[q.id] ?? '');
    if (!has(v, q.id)) throw new HttpError(400, `Respuesta no válida en «${q.title}»`);
    a[q.id] = v;
  }
  return a;
}

function score(p, a, { useStyle, useIntensity }) {
  const fam = norm(p.family);
  const text = ` ${norm(`${p.name} ${p.notes} ${p.description}`)} `;
  let s = 0;
  const why = [];
  if (useStyle && a.style) {
    const st = STYLE[a.style];
    if (st.families.includes(fam)) { s += 5; why.push(`Es de la familia ${p.family.toLowerCase()}, justo el estilo que buscas`); }
    const hits = st.words.filter((w) => new RegExp(`[^a-z]${w}`).test(text));
    if (hits.length) { s += Math.min(hits.length, 3) * 1.5; why.push(`Tiene notas de ${hits.slice(0, 3).join(', ')}`); }
  }
  if (useIntensity && a.intensity && FAMILY_INTENSITY[fam]) {
    const gap = Math.abs(FAMILY_INTENSITY[fam] - WANTED[a.intensity]);
    s += gap === 0 ? 3 : gap === 1 ? 1 : -2;
    if (gap === 0) why.push(a.intensity === 'suave' ? 'Es un aroma suave y discreto' : a.intensity === 'intensa' ? 'Tiene presencia: se nota' : 'Es equilibrado, ni tímido ni invasivo');
  }
  const occ = OCCASION_FAMILIES[a.occasion];
  if (occ?.includes(fam)) { s += 2; why.push({ diario: 'Va muy bien para todos los días', trabajo: 'Es apropiado para la oficina', noche: 'Luce en salidas y de noche', especial: 'Es una buena elección para una ocasión especial' }[a.occasion]); }
  if (a.occasion === 'regalo') {
    if (p.kind === 'Estuche') { s += 4; why.push('Viene en presentación de regalo'); }
    s += 1; // los regalos se piden entre los más conocidos
  }
  s += Math.log10(1 + (p.sold || 0)) * 0.8;
  if (p.sold >= 30) why.push('Es de los más pedidos por nuestros clientes');
  if (p.discount_pct > 0) { s += 0.5; why.push(`Ahora tiene ${p.discount_pct}% de descuento`); }
  return { s, why };
}

export function recommend(db, rawAnswers, { limit = 3 } = {}) {
  const a = cleanAnswers(rawAnswers);
  const [lo, hi] = BUDGETS[a.budget];
  const category = CATEGORY[a.for] || '';
  const stage = (relax) => {
    const useStyle = !relax.includes('estilo');
    const useIntensity = !relax.includes('intensidad');
    const useBudget = !relax.includes('presupuesto');
    const tokens = useStyle && a.style ? [...STYLE[a.style].words, ...STYLE[a.style].families] : [];
    let { results } = searchProducts(db, { tokens, category: category || undefined, inStock: true, maxPrice: useBudget && hi < 100000 ? hi * 1.1 : undefined, limit: 120 });
    results = results.filter((p) => p.kind !== 'Tester' && p.total_stock > 0);
    if (useBudget && lo > 0) results = results.filter((p) => p.max_price >= lo * 0.9);
    // Una persona no espera que «para el día a día» le recomienden un set de $200: respeta el techo del presupuesto.
    if (useBudget && hi < 100000) results = results.filter((p) => p.min_price <= hi * 1.1);
    return results
      .map((p) => ({ p, ...score(p, a, { useStyle, useIntensity }) }))
      .sort((x, y) => y.s - x.s || y.p.sold - x.p.sold || x.p.id - y.p.id);
  };
  const ladder = [[], ['intensidad'], ['intensidad', 'estilo'], ['intensidad', 'estilo', 'presupuesto']];
  let relaxed = [];
  let ranked = [];
  for (const step of ladder) {
    ranked = stage(step);
    relaxed = step;
    if (ranked.length >= limit) break;
  }
  const picks = ranked.slice(0, limit).map(({ p, why }) => {
    const price = p.min_price === p.max_price ? `$${p.min_price}` : `desde $${p.min_price}`;
    const reasons = [...why];
    if (a.budget !== 'sin' && p.min_price >= lo * 0.9 && p.min_price <= hi) reasons.push(`Entra en tu presupuesto (${price})`);
    return { ...p, reasons: [...new Set(reasons)].slice(0, 4) };
  });
  return { answers: a, relaxed, products: picks, total_candidates: ranked.length };
}
