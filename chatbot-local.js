// Asistente local: SIN IA, SIN clave y SIN costo. Entiende palabras clave en español (ocasión, notas, categoría, tipo,
// ofertas, presupuesto, nombres de perfumes) y responde con datos reales del catálogo. Usa las mismas piezas que el
// asistente de IA (búsqueda, tarjetas y "agregar a la bolsa" validada), así la interfaz es idéntica en los dos modos.
// Funciona con catálogos de miles de productos: busca en SQL y nunca carga el catálogo completo.
import { namesIndex, getProductsByIds, catalogSummary } from './catalog.js';
import { norm } from './text.js';
import { searchCatalog, executeTool } from './chatbot.js';
import { loadBrand } from './brand.js';

const money = (n) => `$${Number(n).toFixed(2)}`;
const plural = (n, one, many) => (n === 1 ? one : many);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => s.replace(/[^a-z0-9$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const sizeLabel = (ml) => (ml ? `${ml} ml` : 'Tamaño único');
const priceText = (v) => (v.compare_at ? `${money(v.price)} (antes ${money(v.compare_at)})` : money(v.price));

// Información de la tienda (lo único que se sabe de ella; igual que en el asistente de IA).
function infoFor(brand) {
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const years = brand.founded ? new Date().getFullYear() - brand.founded : 0;
  const about = brand.about?.lead && `${brand.about.lead}${years > 0 ? ` Llevamos ${years} años dedicados a los perfumes.` : ''}`;
  const place = brand.address || brand.about?.where;
  return {
    about: about || null,
    hours: `Atendemos ${lower(brand.hours)}.`,
    delivery: 'Puedes retirar tu pedido en la tienda sin costo, o pedir envío a domicilio (lo coordinamos por teléfono).',
    payment: 'Aceptamos tarjeta (en esta demostración el pago es simulado), transferencia bancaria y pago contra entrega.',
    noinfo: 'Eso no lo tengo a la mano. Lo mejor es consultarlo directamente con el equipo de la tienda.',
    address: place ? `Nos encuentras en ${place}. ${lower(brand.hours).replace(/^/, 'Atendemos ')}.` : null,
    contact: [brand.phone && `Teléfono: ${brand.phone}`, brand.email && `Correo: ${brand.email}`].filter(Boolean).join(' · ') || null,
  };
}

const HELP =
  'Puedo ayudarte con esto:\n\n- **Elegir un perfume**: dime para quién es, la ocasión, las notas que te gustan o tu presupuesto.\n' +
  '- **Ofertas, novedades, estuches y testers**.\n- **Precios, tamaños y existencias** de cualquier perfume.\n- **Agregar a tu bolsa** lo que elijas.\n- **Envíos, pagos y horarios**.';

// ─── Intenciones ────────────────────────────────────────────────────────────
const RE = {
  strongAdd: /\b(agrega|agregar|agregame|agregalo|agregala|agregue|anade|anadir|anademe|anadelo|anadela|mete|meter|metelo|metela|ponlo|ponla|ponme)\b/,
  weakAdd: /\b(me llevo|llevo|lo llevo|la llevo|me quedo con|lo quiero|la quiero|lo compro|la compro|comprarlo|comprarla|quiero ese|quiero esa|quiero este|quiero esta)\b/,
  bag: /\b(bolsa|carrito|carro)\b/,
  hours: /\b(horario|horarios|hora|horas|abren|abierto|abierta|cierran|cierra|atienden|atencion)\b/,
  delivery: /\b(envio|envios|enviar|enviarlo|entrega|entregan|entregar|domicilio|retiro|retirar|recoger|recojo|despacho|delivery|cuanto tarda|demora|demoran)\b/,
  payment: /\b(pago|pagos|pagar|tarjeta|transferencia|contra entrega|contraentrega|efectivo|yappy|metodos? de pago|forma de pago|formas de pago)\b/,
  about: /\b(quienes son|quienes somos|quien es|historia|desde cuando|cuantos anos|trayectoria|fundada|fundado|mision|vision|valores|sobre ustedes|sobre la tienda|sobre la empresa)\b/,
  where: /\b(direccion|ubicacion|donde estan|donde queda|donde se ubican|como llegar|local|sucursal)\b/,
  contact: /\b(telefono|correo|email|contacto|numero de contacto)\b/,
  noinfo: /\b(devolucion|devoluciones|devolver|cambio de producto|garantia|factura|facturas|rastrear|rastreo|seguimiento|reclamo|reembolso)\b/,
  human: /\b(persona|humano|humana|asesor|asesora|vendedor|vendedora|agente|operador|hablar con alguien|hablar con una persona|llamar|llamen|whatsapp)\b/,
  thanks: /\b(gracias|te agradezco|muy amable|perfecto gracias)\b/,
  bye: /\b(adios|chao|chau|hasta luego|nos vemos|bye)\b/,
  greet: /^(hola|holi|hey|buenas|buenos dias|buenas tardes|buenas noches|saludos|que tal|buen dia)\b/,
  help: /\b(ayuda|ayudame|ayudar|que puedes|que haces|como funciona|opciones|menu|que sabes)\b/,
  price: /\b(cuanto|precio|precios|cuesta|cuestan|valen|vale|costo|costos|valor)\b/,
  stock: /\b(stock|existencia|existencias|disponible|disponibles|disponibilidad|queda|quedan|agotado|agotados)\b/,
  gift: /\b(regal\w*|obsequi\w*|cumple\w*|aniversario|sorpresa|detalle para)\b/,
  cheap: /\b(barat\w*|economic\w*|accesible\w*|pocos? dinero)\b/,
  best: /\b(mas vendid\w*|popular\w*|favorit\w*|estrella|top|lo mejor|recomendad\w*)\b/,
  sale: /\b(ofertas?|descuentos?|promocion\w*|rebaja\w*|liquidacion|promos?)\b/,
  newer: /\b(nuevos?|nuevas?|novedad\w*|reciente\w*|lanzamiento\w*|recien llegad\w*)\b/,
  set: /\b(estuches?|sets?|cofres?)\b/,
  tester: /\b(testers?|probadores?)\b/,
  brands: /\b(marcas?|casas? de perfum\w*)\b/,
  kids: /\b(ninos?|ninas?|infantil\w*|bebes?)\b/,
  men: /\b(hombres?|caballeros?|masculin\w*|novio|esposo|marido|papa|padre|abuelo|hijo|hermano|amigo)\b/,
  women: /\b(mujer(?:es)?|damas?|femenin\w*|novia|esposa|mama|madre|abuela|hija|hermana|amiga|senora|ella)\b/,
  unisex: /\bunisex\b/,
};

// Palabras del cliente → términos para buscar en el catálogo.
const THEMES = [
  [/\b(fresc[oa]s?|ligero|ligera|refrescante|verano|calor|playa|diario|dia a dia|oficina|trabajo|limpio|primavera|deport\w*)\b/, 'fresco citrico aromatico limpio'],
  [/\b(dulce|dulces|postre|golosin\w*|caramelo|gourmand|azucar\w*)\b/, 'gourmand vainilla caramelo dulce'],
  [/\b(floral|florales|flor|flores|romantic\w*|delicad\w*)\b/, 'floral rosa jazmin flor'],
  [/\b(madera|amaderad\w*|cedro|sandalo|terroso|tierra|cuero|tabaco)\b/, 'amaderado cedro sandalo vetiver cuero'],
  [/\b(intens\w*|noche|nocturn\w*|fiesta|cita|seductor\w*|sensual\w*|especiad\w*|oscuro|potente|fuerte|arabe|oud|ambar)\b/, 'oriental ambar oud especiado pimienta'],
  [/\b(frut\w*|cereza|pera|manzana)\b/, 'frutal cereza pera'],
  [/\b(citric\w*|limon|naranja|bergamota|toronja)\b/, 'citrico limon naranja bergamota'],
  [/\b(lavanda|aromatic\w*|hierbas|herbal\w*)\b/, 'aromatico lavanda'],
];

// Palabras que no ayudan a buscar.
const NOISE = new Set(
  ('agrega agregar agregame agregalo agregala anade anadir mete meter ponlo ponla ponme bolsa carrito carro favor porfa quiero quisiera necesito dame dime muestrame ensename ' +
    'busco buscando recomienda recomiendame recomendar recomendacion sugiere sugiereme tienen tienes hay que cual cuales cuanto cuesta cuestan precio precios valor tamano tamanos ' +
    'mililitros unidades unidad frasco frascos perfume perfumes fragancia fragancias olor aroma algo alguno alguna algun otro otra mas menos muy con sin para por del una uno unos ' +
    'unas los las como donde esta este ese esa eso tipo tal vez gustaria gusta tengo estoy puedes podrias puedo hola buenas gracias dolares usd balboas hasta maximo entre presupuesto ' +
    'llevo comprar compro quedo regalo regalar hombre hombres mujer mujeres unisex barato barata economico dia dias ' +
    'oferta ofertas descuento descuentos promocion promociones rebaja rebajas promo promos nuevo nuevos nueva nuevas novedad novedades estuche estuches tester testers probador probadores ' +
    'set sets cofre cofres infantil infantiles nino ninos nina ninas bebe bebes marca marcas').split(' ')
);
const cleanTokens = (n) =>
  n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !NOISE.has(t));

const ORDINAL = /^(primer\w*|segund\w*|tercer\w*|ultim\w*)$/;

// ─── Lectura de datos del mensaje ───────────────────────────────────────────
function parseBudget(n) {
  const m =
    /\b(?:menos de|menor a|menor que|hasta|maximo|max|por debajo de|no mas de|bajo|a lo sumo|presupuesto(?: de)?)\s*\$?\s*(\d{1,4})\b/.exec(n) ||
    /\bentre\s*\$?\s*\d{1,4}\s*y\s*\$?\s*(\d{1,4})\b/.exec(n) ||
    /\$\s*(\d{1,4})\b/.exec(n) ||
    /\b(\d{1,4})\s*(?:dolares|usd|balboas)\b/.exec(n);
  return m ? Number(m[1]) : null;
}
const stripBudget = (n) =>
  n
    .replace(/\b(?:menos de|menor a|menor que|hasta|maximo|max|por debajo de|no mas de|bajo|a lo sumo|presupuesto(?: de)?)\s*\$?\s*\d{1,4}\b/g, ' ')
    .replace(/\bentre\s*\$?\s*\d{1,4}\s*y\s*\$?\s*\d{1,4}\b/g, ' ')
    .replace(/\$\s*\d{1,4}\b/g, ' ')
    .replace(/\b\d{1,4}\s*(?:dolares|usd|balboas)\b/g, ' ');

const QTY_WORDS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
function parseQty(n) {
  const t = n.replace(/\b\d{2,3}\s*(?:ml|mililitros?)\b/g, ' ');
  const m = /\b(\d{1,2})\s*(?:unidades?|und|piezas?|frascos?)\b/.exec(t) || /\bx\s*(\d{1,2})\b/.exec(t) || /\b(\d{1,2})\b/.exec(t.replace(/\b\d{2,3}\b/g, ' '));
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 10) return Number(m[1]);
  for (const [w, q] of Object.entries(QTY_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) return q;
  return 1;
}

function pickSize(n, variants) {
  for (const m of n.matchAll(/\b(\d{2,3})\b/g)) {
    const v = variants.find((x) => x.size_ml === Number(m[1]));
    if (v) return v;
  }
  const sorted = [...variants].sort((a, b) => a.size_ml - b.size_ml);
  if (/\b(pequen\w*|chic[oa]s?|mini|minis|viaje)\b/.test(n)) return sorted[0];
  if (/\b(grande|grandes|mayor)\b/.test(n)) return sorted.at(-1);
  if (/\b(median[oa])\b/.test(n)) return sorted[Math.floor((sorted.length - 1) / 2)];
  return null;
}

// ¿El mensaje es solo un tamaño/cantidad ("el de 50", "dos de 100 ml", "el grande")?
const FILLER = new Set('el la de del los las un una uno dos tres quiero me llevo dame ponme mejor pues ok si de ml mililitros unidades unidad frasco en tamano'.split(' '));
function sizeOnly(n) {
  const toks = n.split(/[^a-z0-9]+/).filter(Boolean);
  const hasSize = toks.some((t) => /^\d{2,3}$/.test(t)) || /\b(pequen\w*|chic[oa]s?|mini|grande|grandes|mayor|median[oa])\b/.test(n);
  const rest = toks.filter((t) => !FILLER.has(t) && !/^\d{1,3}$/.test(t) && !/^(pequen\w*|chic[oa]s?|mini|grande|grandes|mayor|median[oa])$/.test(t));
  return hasSize && rest.length === 0;
}

// ─── Productos ──────────────────────────────────────────────────────────────
// Reconoce un perfume por su nombre dentro del mensaje. Si varios empatan, es ambiguo: no se adivina.
function findByName(db, n) {
  const words = n.split(/[^a-z0-9]+/).filter(Boolean);
  const hay = ` ${squash(n)} `;
  let best = 0;
  let hits = [];
  for (const it of namesIndex(db)) {
    let s = 0;
    if (it.norm && hay.includes(` ${it.norm} `)) s = 100 + it.tokens.length;
    else if (it.tokens.filter((t) => words.some((w) => w.startsWith(t))).length >= 2) s = it.tokens.filter((t) => words.some((w) => w.startsWith(t))).length;
    if (!s) continue;
    if (s > best) { best = s; hits = [it]; }
    else if (s === best) hits.push(it);
  }
  return hits.length === 1 ? getProductsByIds(db, [hits[0].id])[0] ?? null : null;
}

const byIds = (db, ids) => getProductsByIds(db, ids); // conserva el orden pedido

const minAvail = (p) => {
  const av = p.variants.filter((v) => v.stock > 0);
  return av.length ? Math.min(...av.map((v) => v.price)) : null;
};
const stockWord = (s) => (s === 0 ? 'agotado' : s <= 3 ? `quedan ${s}` : 'disponible');

function cardsFor(db, ids) {
  const r = executeTool(db, 'show_products', { product_ids: ids });
  return r.events || [];
}

function oneLine(p) {
  const low = p.variants.some((v) => v.stock > 0 && v.stock <= 3);
  const tag = [p.on_sale && `en oferta -${p.discount_pct}%`, p.is_new && 'novedad', low && 'quedan pocas unidades'].filter(Boolean).join(', ');
  const meta = [p.kind !== 'Perfume' && p.kind, p.family].filter(Boolean).join(' · ');
  return `- **${p.name}**${meta ? ` (${meta})` : ''}: ${p.notes || 'sin notas'}. Desde ${money(minAvail(p))}${tag ? `, ${tag}` : ''}.`;
}

function detail(db, p) {
  const lines = p.variants.map((v) => `- ${sizeLabel(v.size_ml)}: ${priceText(v)} (${stockWord(v.stock)})`).join('\n');
  const head = [p.kind, p.category + (p.subcategory ? ` · ${p.subcategory}` : ''), p.family].filter(Boolean).join(' · ');
  let text = `**${p.name}** · ${head}\n\n${p.description || ''}\n\nNotas: ${p.notes || 'sin datos'}.\n\nTamaños:\n${lines}`;
  if (p.total_stock === 0) {
    const alt = byIds(db, searchCatalog(db, { family: p.family || undefined, category: p.category, only_in_stock: true }).results.filter((x) => x.id !== p.id).slice(0, 2).map((x) => x.id));
    text += '\n\nPor ahora está agotado.';
    if (alt.length) {
      text += ` Algo parecido que sí tengo:\n\n${alt.map(oneLine).join('\n')}`;
      return { text, events: cardsFor(db, [p.id, ...alt.map((x) => x.id)]) };
    }
  } else {
    text += '\n\n¿Te lo agrego a la bolsa? Dime el tamaño.';
  }
  return { text, events: cardsFor(db, [p.id]) };
}

// ─── Agregar a la bolsa ─────────────────────────────────────────────────────
function resolveTarget(n, { db, prevN, lastProducts }) {
  const named = findByName(db, n);
  if (named) return { product: named };

  const toks = cleanTokens(stripBudget(n)).filter((t) => !ORDINAL.test(t));
  if (toks.length) {
    const r = searchCatalog(db, { query: toks.join(' ') });
    if (r.total_matches === 1) return { product: byIds(db, [r.results[0].id])[0] };
    if (r.total_matches > 1) {
      const ids = new Set(r.results.map((x) => x.id));
      const inLast = lastProducts.filter((p) => ids.has(p.id));
      if (inLast.length === 1) return { product: inLast[0] };
    }
  }

  const ord = /\bprimer\w*\b/.test(n) ? 0 : /\bsegund\w*\b/.test(n) ? 1 : /\btercer\w*\b/.test(n) ? 2 : /\bultim\w*\b/.test(n) ? lastProducts.length - 1 : null;
  if (ord !== null && lastProducts[ord]) return { product: lastProducts[ord] };

  // ¿El asistente nombró un producto en su mensaje anterior? (el más específico gana)
  const mentioned = namesIndex(db).filter((it) => it.norm && prevN.includes(it.norm)).sort((a, b) => b.norm.length - a.norm.length);
  if (mentioned.length) return { product: byIds(db, [mentioned[0].id])[0] };
  if (lastProducts.length === 1) return { product: lastProducts[0] };
  if (lastProducts.length > 1) return { ask: lastProducts };
  return { ask: [] };
}

function addFlow(n, ctx) {
  const { db } = ctx;
  const target = resolveTarget(n, ctx);
  if (!target.product) {
    if (target.ask.length) return { text: `¿Cuál quieres agregar? ${target.ask.map((p) => `**${p.name}**`).join(', ')}.`, events: [] };
    return { text: '¿Cuál perfume quieres agregar? Dime el nombre (por ejemplo «Vetiver Real») o pídeme una recomendación y te muestro opciones.', events: [] };
  }
  const p = target.product;
  const avail = p.variants.filter((v) => v.stock > 0);
  if (!avail.length) return detail(db, p);

  const clean = stripBudget(n);
  let v = pickSize(clean, p.variants);
  const sizesText = avail.map((x) => `- ${sizeLabel(x.size_ml)}: ${money(x.price)}`).join('\n');
  if (!v) {
    if (avail.length === 1) v = avail[0];
    else return { text: `¿Qué tamaño prefieres para **${p.name}**?\n\n${sizesText}\n\nDime el tamaño (por ejemplo «${avail[0].size_ml} ml»).`, events: cardsFor(db, [p.id]) };
  }
  if (v.stock === 0) return { text: `El de ${sizeLabel(v.size_ml)} de **${p.name}** está agotado. Tengo:\n\n${sizesText}\n\n¿Cuál prefieres?`, events: [] };

  const qty = parseQty(clean);
  const res = executeTool(db, 'add_to_bag', { variant_id: v.id, quantity: qty });
  if (res.isError) return { text: `${res.content} ¿Quieres otro tamaño u otra cantidad?`, events: [] };
  return {
    text: `Listo, agregué **${res.events[0].label}** a tu bolsa (${money(v.price * qty)}). Puedes revisarla y finalizar la compra desde ahí. ¿Buscas algo más?`,
    events: res.events,
  };
}

// ─── Recomendar ─────────────────────────────────────────────────────────────
const CAT_WHO = { Damas: ' para dama', Caballeros: ' para hombre', Infantil: ' para niños', Unisex: ' unisex' };

function recommend(n, { db }) {
  const category = RE.kids.test(n) ? 'Infantil' : RE.men.test(n) ? 'Caballeros' : RE.women.test(n) ? 'Damas' : RE.unisex.test(n) ? 'Unisex' : null;
  const kind = RE.set.test(n) ? 'Estuche' : RE.tester.test(n) ? 'Tester' : null;
  const onSale = RE.sale.test(n);
  const isNew = RE.newer.test(n);
  const budget = parseBudget(n);
  const gift = RE.gift.test(n);
  const cheap = RE.cheap.test(n);
  const best = RE.best.test(n);
  const theme = THEMES.filter(([re]) => re.test(n)).map(([, add]) => add).join(' ');
  const base = cleanTokens(stripBudget(n)).join(' ');
  const hasFilter = category || kind || onSale || isNew || budget || gift || cheap || best || theme || base;

  if (!hasFilter) {
    return {
      text: 'Con gusto te ayudo a elegir. Cuéntame:\n\n- ¿Para quién es? (hombre, mujer, niños o para ti)\n- ¿Para qué ocasión? (día a día, noche, regalo)\n- ¿Qué notas te gustan? (fresco, dulce, floral, amaderado…)\n- ¿Cuál es tu presupuesto?\n\nTambién puedo mostrarte las ofertas, las novedades, estuches y testers.',
      events: [],
    };
  }

  const q = (extra = {}) => searchCatalog(db, { query: `${base} ${theme}`.trim(), category, kind, max_price: budget, only_in_stock: true, on_sale: onSale, new_arrivals: isNew, ...extra });
  let res = q();
  let note = '';
  if (!res.results.length && (base || theme) && (category || budget || kind || onSale || isNew)) {
    res = q({ query: '' });
    note = 'No encontré algo exacto con esas palabras, pero con tus otros criterios tengo esto:\n\n';
  }
  if (!res.results.length && budget) {
    res = q({ max_price: null });
    const what = kind ? `${kind.toLowerCase()}s` : 'perfumes';
    note = `No tengo ${what}${category ? ` de ${category.toLowerCase()}` : ''} por debajo de ${money(budget)}. Lo más cercano:\n\n`;
  }
  if (!res.results.length) {
    // Solo palabras sueltas sin criterio reconocible: no es una búsqueda de perfumes, no la adivinamos.
    if (!(category || kind || onSale || isNew || budget || gift || cheap || best || theme)) return { unknown: true, text: '', events: [] };
    const fam = res.catalog_summary.families.join(', ').toLowerCase();
    return { text: `No encontré productos con eso${onSale ? ' en oferta' : ''}. Tengo fragancias ${fam}. ¿Te muestro alguna familia?`, events: [] };
  }

  let found = byIds(db, res.results.map((r) => r.id));
  if (cheap) found.sort((a, b) => minAvail(a) - minAvail(b));
  found = found.slice(0, 3);

  const who = CAT_WHO[category] || '';
  const upTo = budget && !note ? ` de hasta ${money(budget)}` : '';
  const what = kind ? plural(found.length, `este ${kind.toLowerCase()}`, `estos ${found.length} ${kind.toLowerCase()}s`) : plural(found.length, 'esta fragancia', `estas ${found.length} fragancias`);
  let intro;
  if (note) intro = note;
  else if (onSale) intro = `Estas son las ofertas que tengo${who}${upTo} ahora mismo:\n\n`;
  else if (isNew) intro = `Estas son las novedades${who}${upTo}:\n\n`;
  else if (gift) intro = `¡Qué buen detalle! Estas son de las más queridas${who}:\n\n`;
  else intro = `Te sugiero ${what}${who}${upTo}:\n\n`;
  const closing = gift && !category ? '\n\n¿Es para un hombre o para una mujer? Así afino la recomendación.' : '\n\n¿Quieres ver los tamaños de alguna o agregarla a tu bolsa?';
  return { text: intro + found.map(oneLine).join('\n') + closing, events: cardsFor(db, found.map((p) => p.id)) };
}

// ─── Respuesta ──────────────────────────────────────────────────────────────
export function respond(db, { text = '', prev = '', lastIds = [], whatsapp = null, brand = loadBrand() } = {}) {
  const n = norm(text).replace(/\s+/g, ' ').trim();
  if (!n) return { text: HELP, events: [] };

  const INFO = infoFor(brand);
  const lastProducts = byIds(db, lastIds);
  const prevN = norm(prev);
  const ctx = { db, prevN, lastProducts };
  const short = n.length <= 28;

  if (RE.human.test(n)) {
    const events = whatsapp
      ? [{ type: 'link', label: 'Hablar por WhatsApp', url: `https://wa.me/${whatsapp}?text=${encodeURIComponent('Hola, vengo de la tienda en línea y quisiera hablar con una persona.')}` }]
      : [];
    return { text: whatsapp ? 'Claro, una persona del equipo te puede atender. Toca el botón para escribirles por WhatsApp.' : `Con gusto. ${INFO.hours} Esta demostración aún no tiene un contacto configurado, pero yo puedo seguir ayudándote a elegir.`, events };
  }
  if (RE.thanks.test(n) && short) return { text: '¡Con gusto! Si necesitas algo más, aquí estoy.', events: [] };
  if (RE.bye.test(n) && short) return { text: '¡Hasta pronto! Que disfrutes tu fragancia.', events: [] };
  if (RE.greet.test(n) && short) return { text: `Hola, soy Aura, tu asistente de compras en ${brand.short}. ¿Qué estás buscando hoy? Puedo recomendarte un perfume según para quién es, la ocasión o tu presupuesto.`, events: [] };

  const infos = [];
  if (RE.about.test(n) && INFO.about) infos.push(INFO.about);
  if (RE.hours.test(n)) infos.push(INFO.hours);
  if (RE.delivery.test(n)) infos.push(INFO.delivery);
  if (RE.payment.test(n)) infos.push(INFO.payment);
  if (RE.where.test(n)) infos.push(INFO.address || INFO.noinfo);
  if (RE.contact.test(n)) infos.push(INFO.contact || INFO.noinfo);
  if (infos.length) return { text: [...new Set(infos)].join('\n\n'), events: [] };
  if (RE.noinfo.test(n)) return { text: INFO.noinfo, events: [] };

  // Agregar a la bolsa
  const pendingSize = /que tamano|cual tamano|que tamano prefieres/.test(prevN) && sizeOnly(n);
  const strong = RE.strongAdd.test(n) || (RE.bag.test(n) && /\b(quiero|dame|pon|agrega|mete|anade)\b/.test(n));
  if (strong || pendingSize) return addFlow(n, ctx);
  if (RE.weakAdd.test(n)) {
    const t = resolveTarget(n, ctx);
    if (t.product) return addFlow(n, ctx);
  }

  if (RE.help.test(n)) return { text: HELP, events: [] };

  // "la primera", "quiero el segundo", "el último": elegir una de las tarjetas que acaba de ver → su ficha
  if (lastProducts.length > 1) {
    const ord = /\bprimer\w*\b/.test(n) ? 0 : /\bsegund\w*\b/.test(n) ? 1 : /\btercer\w*\b/.test(n) ? 2 : /\bultim\w*\b/.test(n) ? lastProducts.length - 1 : null;
    const rest = cleanTokens(n).filter((t) => !ORDINAL.test(t) && !/^(opcion|opciones|interesa|interesan|gusta|gusto|encanta)$/.test(t));
    if (ord !== null && lastProducts[ord] && rest.length === 0) return detail(db, lastProducts[ord]);
  }

  // ¿Qué marcas tienen?
  if (RE.brands.test(n) && cleanTokens(n).length === 0) {
    const brands = catalogSummary(db).brands;
    if (brands.length) return { text: `Trabajamos con marcas como ${brands.slice(0, 6).join(', ')}${brands.length > 6 ? ' y más' : ''}. Dime cuál te interesa y te muestro sus perfumes.`, events: [] };
  }

  // Un perfume concreto: su ficha
  const named = findByName(db, n);
  if (named) return detail(db, named);

  const hasCriteria = RE.kids.test(n) || RE.men.test(n) || RE.women.test(n) || RE.unisex.test(n) || RE.set.test(n) || RE.tester.test(n) || RE.sale.test(n) || RE.newer.test(n);
  const themed = THEMES.some(([re]) => re.test(n));
  const toks = cleanTokens(stripBudget(n));
  if (toks.length && !hasCriteria && !themed && !parseBudget(n) && !RE.gift.test(n)) {
    const r = searchCatalog(db, { query: toks.join(' ') });
    if (r.total_matches === 1) return detail(db, byIds(db, [r.results[0].id])[0]);
  }

  // Preguntas de precio o existencias sin un perfume concreto
  if ((RE.price.test(n) || RE.stock.test(n)) && !hasCriteria && !themed && toks.length === 0) {
    if (lastProducts.length === 1) return detail(db, lastProducts[0]);
    const s = catalogSummary(db).price_range;
    return { text: s ? `Nuestros productos van de ${money(s.min)} a ${money(s.max)} según el tamaño. Dime cuál te interesa y te doy el detalle de precios y existencias.` : INFO.noinfo, events: [] };
  }

  const rec = recommend(n, ctx);
  if (rec.unknown) return { text: `No estoy segura de haberte entendido. Solo puedo ayudarte con perfumes y con esta tienda.\n\n${HELP}`, events: [] };
  return rec;
}

// ─── Servicio (misma interfaz que el asistente de IA) ───────────────────────
async function typeOut(text, emit, signal) {
  for (let i = 0; i < text.length; i += 18) {
    if (signal?.aborted) return;
    emit({ type: 'text', text: text.slice(i, i + 18) });
    await sleep(8);
  }
}

export function createLocalChatService({ db, whatsapp = null, brand = loadBrand() }) {
  async function run({ messages, emit, signal, context = {} }) {
    const last = messages.at(-1).content;
    const prev = [...messages].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const reply = respond(db, { text: last, prev, lastIds: context.last_product_ids || [], whatsapp, brand });
    await typeOut(reply.text, emit, signal);
    if (signal?.aborted) return { mode: 'local' };
    for (const ev of reply.events) emit(ev);
    return { mode: 'local' };
  }
  return { enabled: true, mode: 'local', model: null, whatsapp: !!whatsapp, run };
}
