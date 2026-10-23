import { api, ApiError, money, esc, icon, bottleSVG, productArt, tileColor, toast, sizeLabel } from './ui.js';
import { mountThemeSwitch } from './theme.js';
import { createProductPage, productHref, ratingLine, sizeOptionsHTML, buyState } from './product-page.js';

const $ = (sel, root = document) => root.querySelector(sel);
const BRAND = window.__BRAND || { name: "D'Luxe Perfumería", short: "D'Luxe", tagline: 'Perfumería', taxName: 'ITBMS', taxRate: 0.07, taxIncluded: true };
const CART_KEY = 'aurelia-cart-v1';
const LOW = 3; // "últimas unidades"
const PAGE = 25; // productos por página
const CATEGORIES = ['Damas', 'Caballeros', 'Infantil', 'Unisex'];
const KINDS = [['Perfume', 'Perfumes'], ['Estuche', 'Estuches'], ['Tester', 'Testers']];
const PRICE_STEPS = [25, 50, 75, 100, 150, 250];
const FAMILY_COLORS = { Floral: '#f0a6b4', Oriental: '#7b3f4f', Amaderado: '#9a6b43', Fresco: '#8fc7d6', Cítrico: '#f2c14e', Gourmand: '#e3b778', Frutal: '#8c1d3c', Aromático: '#a58fc4' };
// Cómo se ven los productos: lista, cuadrícula grande o pequeña. Se recuerda en este navegador; sin elección previa,
// el celular arranca con la cuadrícula pequeña (dos columnas) y el resto con la grande.
const LAYOUT_KEY = 'aurelia-layout-v1';
const LAYOUTS = ['lista', 'grande', 'pequena'];
const defaultLayout = () => (matchMedia('(max-width: 560px)').matches ? 'pequena' : 'grande');
function loadLayout() {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    if (LAYOUTS.includes(v)) return v;
  } catch { /* sin almacenamiento */ }
  return defaultLayout();
}
const EMPTY = { q: '', category: '', kind: '', brand: '', family: '', maxPrice: '', onSale: false, isNew: false, inStock: false, sort: '', page: '' };

const state = {
  filters: { ...EMPTY },
  layout: 'grande',
  list: [], // productos mostrados (se acumulan al cargar más)
  total: 0, page: 0, pages: 0, loading: false, error: '', fetchedAt: 0,
  facets: null, // conteos por filtro, para la selección actual
  top: [], topFacets: null, // más vendidos y conteos globales (portada)
  cache: new Map(), // id de variante → { product, variant }
  products: new Map(), // id de producto → producto
  ac: null, req: 0,
  cart: [], // [{ variantId, qty }]
  pd: null, // producto abierto: { product, variantId, qty }
  checkout: { delivery: 'retiro', payment: 'tarjeta', error: '', busy: false },
  brands: null,
};

// ─── Datos ─────────────────────────────────────────────────────────────────
const remember = (products) => {
  for (const p of products || []) {
    state.products.set(p.id, p);
    for (const v of p.variants) state.cache.set(v.id, { product: p, variant: v });
  }
};
const findVariant = (variantId) => state.cache.get(variantId) || null;

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    state.cart = Array.isArray(raw) ? raw.filter((l) => Number.isInteger(l.variantId) && Number.isInteger(l.qty) && l.qty > 0) : [];
  } catch {
    state.cart = [];
  }
}
let productPage = null; // la página de un producto (se crea en init)
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* sin almacenamiento */ }
  productPage?.refreshBuy(); // el botón de agregar de la página depende de lo que ya hay en la bolsa
}

// Trae del servidor lo que hay en la bolsa (precios y stock actuales) sin cargar el catálogo.
async function refreshCart() {
  const ids = state.cart.map((l) => l.variantId);
  if (!ids.length) return;
  try {
    remember((await api(`/api/cart/lookup?variants=${ids.join(',')}`)).products);
  } catch {
    return; // sin conexión: se deja la bolsa como está
  }
  state.cart = state.cart
    .map((l) => {
      const f = findVariant(l.variantId);
      return f && f.variant.stock > 0 ? { ...l, qty: Math.min(l.qty, f.variant.stock) } : null;
    })
    .filter(Boolean);
  saveCart();
  renderCartBadge();
}

// ─── Filtros y dirección (los enlaces son compartibles) ─────────────────────
const URL_KEYS = { q: 'q', category: 'categoria', kind: 'tipo', brand: 'marca', family: 'familia', maxPrice: 'hasta', onSale: 'ofertas', isNew: 'nuevos', inStock: 'disponibles', sort: 'orden', page: 'pagina' };

function filtersFromUrl() {
  const p = new URLSearchParams(location.search);
  const f = { ...EMPTY };
  for (const [k, name] of Object.entries(URL_KEYS)) {
    const v = p.get(name);
    if (v === null) continue;
    f[k] = typeof EMPTY[k] === 'boolean' ? v === '1' : k === 'page' ? (/^[1-9]\d{0,3}$/.test(v) ? v : '') : v.slice(0, 80);
  }
  return f;
}

function syncUrl() {
  const p = new URLSearchParams();
  for (const [k, name] of Object.entries(URL_KEYS)) {
    const v = state.filters[k];
    if (v) p.set(name, v === true ? '1' : v);
  }
  const qs = p.toString();
  history.replaceState(null, '', (qs ? `?${qs}` : location.pathname) + location.hash);
}

function queryString(withFacets) {
  const f = state.filters;
  const p = new URLSearchParams({ page: Number(f.page) || 1, limit: PAGE });
  if (f.q) p.set('q', f.q);
  if (f.category) p.set('category', f.category);
  if (f.kind) p.set('kind', f.kind);
  if (f.brand) p.set('brand', f.brand);
  if (f.family) p.set('family', f.family);
  if (f.maxPrice) p.set('max_price', f.maxPrice);
  if (f.onSale) p.set('on_sale', '1');
  if (f.isNew) p.set('new', '1');
  if (f.inStock) p.set('in_stock', '1');
  if (f.sort) p.set('sort', f.sort);
  if (!withFacets) p.set('facets', '0');
  return p.toString();
}

const activeFilterCount = () => {
  const f = state.filters;
  return [f.category, f.kind, f.brand, f.family, f.maxPrice, f.onSale, f.isNew, f.inStock, f.q].filter(Boolean).length;
};

function applyFilters(change) {
  Object.assign(state.filters, { page: '' }, change); // cualquier cambio de filtro vuelve a la página 1
  syncUrl();
  renderFilters();
  renderCatPills();
  syncNav();
  fetchList();
}

// Pide al servidor la página actual (state.filters.page). Los conteos de filtros solo se piden si cambió algún filtro.
async function fetchList({ facets = true } = {}) {
  state.ac?.abort();
  state.ac = new AbortController();
  const req = ++state.req;
  state.loading = true;
  state.error = '';
  state.list = [];
  renderGrid(); // muestra los esqueletos mientras llega
  renderPager();
  renderCount();
  try {
    let r = await api(`/api/products?${queryString(facets)}`, { signal: state.ac.signal });
    if (req !== state.req) return;
    if (!r.products.length && r.total > 0) {
      // El enlace pedía una página que ya no existe (se agotaron o se ocultaron productos): se va a la última.
      state.filters.page = r.pages > 1 ? String(r.pages) : '';
      syncUrl();
      r = await api(`/api/products?${queryString(facets)}`, { signal: state.ac.signal });
      if (req !== state.req) return;
    }
    remember(r.products);
    state.list = r.products;
    Object.assign(state, { total: r.total, page: r.page, pages: r.pages, fetchedAt: Date.now() });
    if (r.facets) state.facets = r.facets;
    state.loading = false;
    if (r.facets) renderFilters();
    renderGrid();
  } catch (e) {
    if (e.name === 'AbortError') return;
    state.loading = false;
    state.error = e.message;
    renderGrid();
  } finally {
    if (req === state.req) {
      state.loading = false;
      renderPager();
      renderCount();
    }
  }
}

// Cambia de página: el enlace la recuerda y se vuelve al inicio del catálogo.
function goToPage(n) {
  n = Math.max(1, Math.min(Number(n) || 1, state.pages || 1));
  if (n === (Number(state.filters.page) || 1) && state.list.length) return;
  state.filters.page = n > 1 ? String(n) : '';
  syncUrl();
  fetchList({ facets: false });
  $('#catalogo').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

// ─── Catálogo ──────────────────────────────────────────────────────────────
const lowStock = (p) => p.total_stock > 0 && p.variants.some((v) => v.stock > 0 && v.stock <= LOW);

// opts.href: la tarjeta lleva a esa página (en vez de abrir el recuadro); se usa en los productos recomendados.
function cardHTML(p, i, opts = {}) {
  const out = p.total_stock === 0;
  const cheapest = p.variants.find((v) => v.price === p.min_price) || p.variants[0];
  // El porcentaje solo se muestra si el precio "desde" realmente tiene descuento; si la oferta es en otro tamaño, dice "Oferta".
  const pct = cheapest?.compare_at ? Math.round((1 - cheapest.price / cheapest.compare_at) * 100) : 0;
  const chips = out
    ? ['<span class="badge out">Agotado</span>']
    : [
        p.on_sale && `<span class="badge low">${pct ? `-${pct}%` : 'Oferta'}</span>`,
        p.is_new && '<span class="badge info">Nuevo</span>',
        p.kind !== 'Perfume' && `<span class="badge info">${esc(p.kind)}</span>`,
        lowStock(p) && '<span class="badge low">Últimas unidades</span>',
      ].filter(Boolean).slice(0, 2);
  const was = cheapest?.compare_at ? ` <s class="was">${money(cheapest.compare_at)}</s>` : '';
  return `<article class="card reveal ${out ? 'is-out' : ''}" style="--d:${(i % 4) * 70}ms">
    <${opts.href ? `a href="${esc(opts.href)}"` : `button type="button" data-open="${p.id}"`} class="card-tile" style="--tile:${tileColor(p.id)}" aria-label="Ver ${esc(p.name)}">
      <span class="card-chips">${chips.join('')}</span>
      ${productArt(p, { title: p.name })}
    </${opts.href ? 'a' : 'button'}>
    <div class="card-body">
      <p class="caption upper muted">${esc(p.brand || p.category)} · ${esc(p.category)}</p>
      <h3>${esc(p.name)}</h3>
      <p class="card-notes">${esc(p.notes || p.family)}</p>
      <div class="card-foot">
        <span class="card-price">${out ? 'No disponible' : `desde ${money(p.min_price)}${was}`}</span>
        ${opts.href ? `<a class="link-arrow" href="${esc(opts.href)}">Ver producto ${icon('arrowRight', 14)}</a>` : `<button type="button" class="link-arrow" data-open="${p.id}">Ver detalle ${icon('arrowRight', 14)}</button>`}
      </div>
    </div>
  </article>`;
}

const skeletonCard = () => '<article class="card skel" aria-hidden="true"><div class="card-tile"></div><div class="card-body"><i></i><i></i><i class="short"></i></div></article>';

function setLayout(mode, { save = true } = {}) {
  if (!LAYOUTS.includes(mode)) return;
  state.layout = mode;
  $('#grid').dataset.layout = mode;
  document.querySelectorAll('#view-switch .view-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if (save) {
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* sin almacenamiento */ }
  }
}

function renderGrid() {
  const grid = $('#grid');
  grid.setAttribute('aria-busy', String(state.loading));
  if (state.loading && !state.list.length) {
    grid.innerHTML = Array.from({ length: 8 }, skeletonCard).join('');
    return;
  }
  if (state.error) {
    grid.innerHTML = `<div class="empty"><p class="sub">No pudimos cargar el catálogo.</p><p class="muted">${esc(state.error)}</p>
      <button type="button" class="btn btn-solid" id="retry">Reintentar</button></div>`;
    return;
  }
  if (!state.list.length) {
    grid.innerHTML = `<div class="empty">
      <p class="sub">No encontramos productos con esos filtros.</p>
      <p class="muted">Prueba con otras palabras o quita algún filtro.</p>
      <button type="button" class="btn btn-solid js-clear">Limpiar filtros</button></div>`;
    return;
  }
  grid.innerHTML = state.list.map((p, i) => cardHTML(p, i)).join('');
  observeReveals(grid);
}

function renderCount() {
  const el = $('#result-count');
  if (state.loading && !state.list.length) return void (el.textContent = 'Buscando…');
  if (state.error) return void (el.textContent = '');
  const n = (x) => x.toLocaleString('es');
  const from = (state.page - 1) * PAGE + 1;
  const range = state.pages > 1 && state.list.length ? `${n(from)}–${n(from + state.list.length - 1)} de ` : '';
  el.textContent = `${range}${n(state.total)} ${state.total === 1 ? 'producto' : 'productos'}${activeFilterCount() ? ' con tus filtros' : ''}`;
}

// 1 … 4 5 [6] 7 8 … 20 (en pantallas chicas solo la página actual y sus vecinas inmediatas).
function pageItems(cur, total) {
  const near = innerWidth < 560 ? 0 : 1;
  const keep = new Set([1, total]);
  for (let i = cur - near; i <= cur + near; i++) if (i >= 1 && i <= total) keep.add(i);
  const out = [];
  let prev = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i - prev === 2) out.push(prev + 1); // un hueco de una sola página se muestra completo
    else if (i - prev > 2) out.push('…');
    out.push(i);
    prev = i;
  }
  return out;
}

function renderPager() {
  const nav = $('#pager');
  const { page, pages } = state;
  nav.hidden = state.error || pages <= 1 || (state.loading && !state.list.length && !page);
  if (nav.hidden) return;
  const busy = state.loading ? 'disabled' : '';
  nav.innerHTML =
    `<button type="button" class="pg-btn pg-nav" data-pg="${page - 1}" ${page <= 1 ? 'disabled' : busy} aria-label="Página anterior">${icon('arrowRight', 14, 'style="transform:scaleX(-1)"')}<span>Anterior</span></button>` +
    pageItems(page, pages)
      .map((i) => (i === '…' ? '<span class="pg-gap" aria-hidden="true">…</span>' : `<button type="button" class="pg-btn" data-pg="${i}" ${i === page ? 'aria-current="page"' : busy} aria-label="Página ${i}">${i}</button>`))
      .join('') +
    `<button type="button" class="pg-btn pg-nav" data-pg="${page + 1}" ${page >= pages ? 'disabled' : busy} aria-label="Página siguiente"><span>Siguiente</span>${icon('arrowRight', 14)}</button>`;
}

// Selectores y botones de filtro, con los conteos de la selección actual.
function renderFilters() {
  const f = state.filters;
  const fx = state.facets;
  const count = (arr, v) => arr?.find((x) => x.value === v)?.count;
  const withCount = (label, n) => (n === undefined ? esc(label) : `${esc(label)} <small>${n.toLocaleString('es')}</small>`);

  const catTotal = fx ? fx.categories.reduce((s, c) => s + c.count, 0) : undefined;
  $('#seg-cats').innerHTML = [['', 'Todos', catTotal], ...CATEGORIES.map((c) => [c, c, fx ? count(fx.categories, c) ?? 0 : undefined])]
    .map(([v, label, n]) => `<button type="button" class="seg-btn ${f.category === v ? 'is-active' : ''}" data-cat="${esc(v)}" aria-pressed="${f.category === v}" ${n === 0 && f.category !== v ? 'disabled' : ''}>${withCount(label, n)}</button>`)
    .join('');
  const kindTotal = fx ? fx.kinds.reduce((s, c) => s + c.count, 0) : undefined;
  $('#seg-kinds').innerHTML = [['', 'Todo', kindTotal], ...KINDS.map(([v, label]) => [v, label, fx ? count(fx.kinds, v) ?? 0 : undefined])]
    .map(([v, label, n]) => `<button type="button" class="seg-btn ${f.kind === v ? 'is-active' : ''}" data-kind="${esc(v)}" aria-pressed="${f.kind === v}" ${n === 0 && f.kind !== v ? 'disabled' : ''}>${withCount(label, n)}</button>`)
    .join('');

  const options = (arr, selected, all) => {
    const list = [...(arr || [])];
    if (selected && !list.some((x) => x.value === selected)) list.unshift({ value: selected, count: 0 });
    return `<option value="">${all}</option>` + list.map((x) => `<option value="${esc(x.value)}" ${x.value === selected ? 'selected' : ''}>${esc(x.value)} (${x.count})</option>`).join('');
  };
  $('#brand').innerHTML = options(fx?.brands, f.brand, 'Todas las marcas');
  $('#family').innerHTML = options(fx?.families, f.family, 'Todas las familias');

  const max = fx?.price?.max ?? 300;
  const steps = PRICE_STEPS.filter((s) => s <= Math.max(50, max * 1.4) || String(s) === f.maxPrice);
  $('#price-max').innerHTML = '<option value="">Cualquier precio</option>' + steps.map((s) => `<option value="${s}" ${String(s) === f.maxPrice ? 'selected' : ''}>Hasta ${money(s).replace('.00', '')}</option>`).join('');

  $('#f-sale').checked = f.onSale;
  $('#f-new').checked = f.isNew;
  $('#f-stock').checked = f.inStock;
  $('#sort').value = f.sort;
  const n = activeFilterCount();
  $('#clear-filters').hidden = n === 0;
  const badge = $('#filters-count');
  badge.hidden = n === 0;
  badge.textContent = n;
}

function syncNav() {
  const f = state.filters;
  document.querySelectorAll('#nav-cats .nav-link').forEach((a) => {
    const on = a.dataset.view === 'sale' ? f.onSale && !f.category : a.dataset.cat !== undefined ? !f.onSale && a.dataset.cat === f.category : false;
    a.classList.toggle('is-active', on);
  });
}

// ─── Hero y pieza destacada ────────────────────────────────────────────────
const loadImg = (src) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });

async function loadTop() {
  const r = await api('/api/products?limit=6&in_stock=1');
  remember(r.products);
  state.top = r.products;
  state.topFacets = r.facets;
}

async function renderHero() {
  const box = $('#hero-art');
  if (await loadImg('/img/hero.jpg')) {
    box.innerHTML = '<img class="hero-photo" src="/img/hero.jpg" alt="" fetchpriority="high" decoding="async">';
    return;
  }
  const top = state.top.slice(0, 3);
  if (top.length < 3) return;
  // Orden visual: laterales más chicos, el más vendido al centro.
  box.innerHTML = [top[1], top[0], top[2]].map((p) => bottleSVG(p.color, p.id, { title: p.name })).join('');
}

// Diseño "Shop": tarjetas flotantes, marca, búsqueda y píldoras de familia.
const FLOAT_SLOTS = [
  { x: -420, y: 44, r: -7, ad: -1.2 },
  { x: -215, y: -4, r: 4, ad: -3.1 },
  { x: 0, y: 36, r: -2, ad: -0.4 },
  { x: 215, y: -8, r: -4, ad: -4.6 },
  { x: 420, y: 40, r: 6, ad: -2.3 },
];

function renderShopHero() {
  const top = state.top.slice(0, 5);
  if (top.length >= 5) {
    const order = [top[3], top[1], top[0], top[2], top[4]]; // el más vendido al centro
    $('#float-row').innerHTML = order
      .map((p, i) => {
        const s = FLOAT_SLOTS[i];
        return `<button type="button" class="float-card" data-open="${p.id}" aria-label="Ver ${esc(p.name)}"
          style="--x:${s.x}px;--y:${s.y}px;--r:${s.r}deg;--ad:${s.ad}s;${i === 2 ? 'z-index:2;' : ''}">
          <span class="img" style="--tile:${tileColor(p.id)}">${productArt(p, { title: p.name, eager: true })}</span>
          <span class="name">${esc(p.name)}</span><span class="meta">desde ${money(p.min_price)}</span></button>`;
      })
      .join('');
  }
  $('.search-go').innerHTML = icon('arrowRight', 20);
  renderCatPills();
}

function renderCatPills() {
  const families = state.topFacets?.families || [];
  const items = [['', 'Todo', '#cccccc'], ...families.slice(0, 10).map((f) => [f.value, f.value, FAMILY_COLORS[f.value] || '#cccccc'])];
  $('#cat-pills').innerHTML = items
    .map(([val, label, c]) => {
      const on = state.filters.family === val;
      return `<button type="button" class="cat-pill ${on ? 'is-active' : ''}" data-family="${esc(val)}" aria-pressed="${on}"><i style="--c:${c}"></i>${esc(label)}</button>`;
    })
    .join('');
}

function renderFeature() {
  const p = state.top[0];
  const box = $('#feature');
  if (!p) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="feature-text reveal">
      <p class="caption upper muted">La pieza de la casa · ${esc(p.family || p.category)}</p>
      <h2 class="h-lg accent" id="feature-title">${esc(p.name)}</h2>
      <p class="body-lg">${esc(p.description || p.notes)}</p>
      <p class="muted">${esc(p.notes || '')}</p>
      <div><button type="button" class="btn btn-lemon" data-open="${p.id}">Elegir tamaño · desde ${money(p.min_price)}</button></div>
    </div>
    <div class="feature-art" style="--tile:${tileColor(p.id + 3)}">${productArt(p, { title: p.name, eager: true })}</div>`;
  observeReveals(box);
}

// ─── Marcas ────────────────────────────────────────────────────────────────
async function openBrands() {
  const dlg = $('#brands-dialog');
  if (!dlg.open) dlg.showModal();
  if (!state.brands) {
    $('#brands-body').innerHTML = '<p class="muted">Cargando…</p>';
    try { state.brands = await api('/api/brands'); } catch (e) { $('#brands-body').innerHTML = `<p class="err-text">${esc(e.message)}</p>`; return; }
  }
  const groups = new Map();
  for (const b of state.brands) {
    const letter = (b.name[0] || '#').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(b);
  }
  $('#brands-body').innerHTML = [...groups.entries()]
    .map(([l, bs]) => `<section class="b-group"><h3 class="caption upper accent">${esc(l)}</h3><div class="b-list">${bs
      .map((b) => `<button type="button" class="brand-btn" data-brand="${esc(b.name)}">${esc(b.name)} <small>${b.products}</small></button>`)
      .join('')}</div></section>`)
    .join('');
}

// ─── Información (envíos y pagos, contacto, nosotros) ───────────────────────
// Texto de ejemplo para la demo: se ajusta a las condiciones reales de la tienda.
const INFO = {
  envios: ['Envíos y pagos', () => `
    <section><h3 class="caption upper accent">Entrega</h3>
      <p><b>Retiro en tienda:</b> gratis; tu pedido queda listo en aproximadamente 1 hora dentro del horario de atención.</p>
      <p><b>Envío a domicilio:</b> coordinamos la entrega contigo por teléfono o WhatsApp una vez confirmado el pedido.</p></section>
    <section><h3 class="caption upper accent">Pagos</h3>
      <ul><li>Tarjeta de crédito o débito</li><li>Transferencia bancaria: te enviamos los datos por correo</li><li>Pago contra entrega o al retirar</li></ul>
      ${BRAND.taxIncluded && BRAND.taxRate > 0 ? `<p>Los precios incluyen el ${esc(BRAND.taxName)} (${Math.round(BRAND.taxRate * 100)}%).</p>` : ''}</section>
    <section><h3 class="caption upper accent">Existencias</h3>
      <p>El stock que ves es el real: se descuenta en el momento de cada compra, en la web y en el mostrador. Si algo se agota mientras compras, te avisamos antes de cobrar.</p></section>`],
  contacto: ['Contacto', () => {
    const rows = [
      BRAND.hours && ['Horario', esc(BRAND.hours)],
      BRAND.phone && ['Teléfono', `<a href="tel:${esc(BRAND.phone.replace(/[^\d+]/g, ''))}">${esc(BRAND.phone)}</a>`],
      BRAND.email && ['Correo', `<a href="mailto:${esc(BRAND.email)}">${esc(BRAND.email)}</a>`],
      BRAND.address && ['Dirección', esc(BRAND.address)],
      /^https:\/\//.test(BRAND.instagram || '') && ['Instagram', `<a href="${esc(BRAND.instagram)}" target="_blank" rel="noopener noreferrer">${esc(BRAND.instagram.replace(/^https:\/\/(www\.)?/, ''))}</a>`],
      /^https:\/\//.test(BRAND.facebook || '') && ['Facebook', `<a href="${esc(BRAND.facebook)}" target="_blank" rel="noopener noreferrer">${esc(BRAND.facebook.replace(/^https:\/\/(www\.)?/, ''))}</a>`],
    ].filter(Boolean);
    return `<dl class="info-dl">${rows.map(([k, v]) => `<dt class="caption upper muted">${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <p class="muted">${BRAND.phone || BRAND.email || BRAND.address ? '' : 'Los datos de contacto se configuran en brand.json (teléfono, correo, dirección). '}También puedes escribirle a Aura, nuestra asesora virtual, desde el botón de la esquina.</p>`;
  }],
};

// ─── Quiénes somos (el texto sale de brand.json) ───────────────────────────
function renderAbout() {
  const a = BRAND.about;
  const section = $('#nosotros');
  if (!a || !section) {
    section?.remove();
    $('#nav-about')?.remove();
    $('.footer a[href="#nosotros"]')?.closest('li')?.remove();
    return;
  }
  const years = BRAND.founded ? new Date().getFullYear() - BRAND.founded : 0;
  const fill = (s) => (/\{(years|founded)\}/.test(s) ? (BRAND.founded ? s.replace(/\{years\}/g, years).replace(/\{founded\}/g, BRAND.founded) : '') : s);
  $('#about-lead').textContent = a.lead;
  $('#about-pillars').innerHTML = a.pillars
    .map((p) => [fill(p.title), fill(p.text)])
    .filter(([title, text]) => title && text)
    .map(([title, text]) => `<li class="reveal"><strong class="about-pillar-title">${esc(title)}</strong><span class="about-pillar-text">${esc(text)}</span></li>`)
    .join('');
  for (const k of ['mission', 'vision', 'values']) $(`#about-${k}`).textContent = a[k];
  const where = $('#about-where');
  if (a.where) { where.innerHTML = `${icon('store', 20)}<span>${esc(a.where)}</span>`; where.hidden = false; }
  const note = $('#about-note');
  if (a.note) { note.textContent = a.note; note.hidden = false; }
  $('#about-chat').addEventListener('click', () => {
    const launcher = $('#chat-launcher');
    if (launcher) launcher.click();
  });
}

function openInfo(key) {
  const [title, body] = INFO[key] || [];
  if (!title) return;
  $('#info-title').textContent = title;
  $('#info-body').innerHTML = body();
  const dlg = $('#info-dialog');
  if (!dlg.open) dlg.showModal();
}

// ─── Detalle de producto ───────────────────────────────────────────────────
async function openProduct(id) {
  id = Number(id);
  // Se muestra lo que ya se conoce y se pide la versión fresca (el stock cambia con cada venta).
  let product = state.products.get(id);
  try {
    const fresh = await api(`/api/products/${id}`);
    remember([fresh]);
    product = fresh;
  } catch { /* se usa lo que ya había */ }
  if (!product) return toast('No pude abrir ese producto.', 'error');

  const first = product.variants.find((v) => v.stock > 0) || product.variants[0];
  state.pd = { product, variantId: first.id, qty: 1 };
  const dlg = $('#product-dialog');
  $('#pd-art').style.setProperty('--tile', tileColor(product.id));
  $('#pd-art').innerHTML = productArt(product, { title: product.name, eager: true });
  $('#pd-meta').textContent = [product.kind !== 'Perfume' && product.kind, product.brand, product.category, product.family].filter(Boolean).join(' · ');
  $('#pd-name').textContent = product.name;
  $('#pd-desc').textContent = product.description || '';
  $('#pd-notes').textContent = product.notes || '—';
  $('#pd-sizes').innerHTML = sizeOptionsHTML(product, first.id, 'pd-size');
  $('#pd-rating').innerHTML = product.rating ? ratingLine(product.rating) : '';
  $('#pd-page').href = productHref(product);
  updateProductPanel();
  if (!dlg.open) dlg.showModal();
}

function updateProductPanel() {
  const { product, variantId } = state.pd;
  const b = buyState(product, variantId, state.pd.qty, state.cart, LOW);
  state.pd.qty = b.qty;
  $('#pd-price').innerHTML = b.price;
  $('#pd-qty').textContent = b.qty;
  const stock = $('#pd-stock');
  stock.textContent = b.stock[0];
  stock.className = b.stock[1];
  $('#pd-minus').disabled = b.minusDisabled;
  $('#pd-plus').disabled = b.plusDisabled;
  const add = $('#pd-add');
  add.disabled = b.addDisabled;
  add.textContent = b.addLabel;
}

// ─── Bolsa ─────────────────────────────────────────────────────────────────
const cartLines = () =>
  state.cart
    .map((l) => {
      const f = findVariant(l.variantId);
      return f ? { ...l, ...f } : null;
    })
    .filter(Boolean);
const cartTotal = () => cartLines().reduce((s, l) => s + l.variant.price * l.qty, 0);
const cartCount = () => state.cart.reduce((s, l) => s + l.qty, 0);

// Los precios ya incluyen el impuesto (configurable en brand.json): se muestra cuánto es.
function taxText(total) {
  if (!BRAND.taxIncluded || !(BRAND.taxRate > 0)) return '';
  const tax = total - total / (1 + BRAND.taxRate);
  return `Incluye ${BRAND.taxName} ${Math.round(BRAND.taxRate * 100)}%: ${money(tax)}`;
}

async function addToCart(variantId, qty) {
  let f = findVariant(variantId);
  if (!f) {
    try { remember((await api(`/api/cart/lookup?variants=${variantId}`)).products); } catch { /* sin conexión */ }
    f = findVariant(variantId);
  }
  if (!f) return toast('No pude agregar ese producto.', 'error');
  const line = state.cart.find((l) => l.variantId === variantId);
  const next = Math.min((line?.qty || 0) + qty, f.variant.stock);
  if (line) line.qty = next;
  else state.cart.push({ variantId, qty: next });
  saveCart();
  renderCartBadge(true);
}

function setQty(variantId, qty) {
  const f = findVariant(variantId);
  const line = state.cart.find((l) => l.variantId === variantId);
  if (!f || !line) return;
  line.qty = Math.max(1, Math.min(qty, f.variant.stock));
  saveCart();
  renderCartBadge();
  renderCart();
}

function removeLine(variantId) {
  state.cart = state.cart.filter((l) => l.variantId !== variantId);
  saveCart();
  renderCartBadge();
  renderCart();
}

function renderCartBadge(bump = false) {
  const n = cartCount();
  const el = $('#cart-count');
  el.textContent = n;
  el.dataset.n = n;
  if (bump) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}

function lineHTML(l, { editable }) {
  const { product, variant } = l;
  return `<div class="line">
    <div class="line-art" style="--tile:${tileColor(product.id)}">${productArt(product, { title: product.name, eager: true })}</div>
    <div class="line-info">
      <div class="line-top">
        <div><p class="line-name">${esc(product.name)}</p><p class="caption upper muted">${sizeLabel(variant.size_ml)} · ${money(variant.price)}${variant.compare_at ? ` <s class="was">${money(variant.compare_at)}</s>` : ''}</p></div>
        ${editable ? `<button type="button" class="icon-btn sm" data-remove="${variant.id}" aria-label="Quitar ${esc(product.name)}">${icon('trash', 18)}</button>` : ''}
      </div>
      <div class="line-bottom">
        ${
          editable
            ? `<div class="stepper" role="group" aria-label="Cantidad de ${esc(product.name)}">
                <button type="button" data-dec="${variant.id}" aria-label="Menos" ${l.qty <= 1 ? 'disabled' : ''}>${icon('minus', 16)}</button>
                <output>${l.qty}</output>
                <button type="button" data-inc="${variant.id}" aria-label="Más" ${l.qty >= variant.stock ? 'disabled' : ''}>${icon('plus', 16)}</button>
              </div>`
            : `<span class="caption upper muted">Cantidad: ${l.qty}</span>`
        }
        <strong>${money(variant.price * l.qty)}</strong>
      </div>
    </div>
  </div>`;
}

function renderCart() {
  const lines = cartLines();
  const body = $('#cart-body');
  const foot = $('#cart-foot');
  if (!lines.length) {
    body.innerHTML = `<div class="drawer-empty"><p class="sub">Tu bolsa está vacía.</p><p class="muted">Cuando encuentres una fragancia que te guste, aparecerá aquí.</p>
      <button type="button" class="btn btn-lemon" data-close-go="#catalogo">Ver la colección</button></div>`;
    foot.innerHTML = '';
    return;
  }
  body.innerHTML = lines.map((l) => lineHTML(l, { editable: true })).join('');
  const tax = taxText(cartTotal());
  foot.innerHTML = `
    <div class="sum-row"><span class="caption upper muted">Subtotal</span><strong class="h-sm">${money(cartTotal())}</strong></div>
    <p class="caption muted">${tax ? `${tax}. ` : ''}El envío se coordina al finalizar.</p>
    <button type="button" class="btn btn-lemon btn-block" id="go-checkout">Finalizar compra ${icon('arrowRight', 16)}</button>`;
}

function openCart() {
  renderCart();
  const d = $('#cart-dialog');
  if (!d.open) d.showModal();
}

// ─── Finalizar compra ──────────────────────────────────────────────────────
const PAYMENTS = [
  ['tarjeta', 'Tarjeta (simulado)', 'No se cobra nada, es una demostración'],
  ['transferencia', 'Transferencia bancaria', 'Te enviamos los datos por correo'],
  ['contra_entrega', 'Pago contra entrega', 'Pagas al recibir o retirar'],
];

function openCheckout() {
  if (!cartLines().length) return;
  $('#cart-dialog').close();
  state.checkout = { delivery: 'retiro', payment: 'tarjeta', error: '', busy: false };
  renderCheckout();
  const d = $('#checkout-dialog');
  if (!d.open) d.showModal();
}

function renderCheckout() {
  const c = state.checkout;
  const lines = cartLines();
  const tax = taxText(cartTotal());
  $('#co-content').innerHTML = `
  <div class="co-grid">
    <form class="co-form" id="co-form" novalidate>
      <div class="co-head">
        <h2 class="h" id="co-title">Finalizar compra</h2>
        <button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('x', 22)}</button>
      </div>
      <div class="co-row">
        <label class="field"><span>Nombre completo</span><input type="text" name="name" autocomplete="name" required maxlength="80"></label>
        <label class="field"><span>Teléfono</span><input type="tel" name="phone" autocomplete="tel" required maxlength="30"></label>
      </div>
      <label class="field"><span>Correo electrónico</span><input type="email" name="email" autocomplete="email" required maxlength="120"></label>

      <fieldset class="opts"><legend>Entrega</legend>
        <label class="opt"><input type="radio" name="delivery" value="retiro" ${c.delivery === 'retiro' ? 'checked' : ''}><span>Retiro en tienda<small>Gratis · listo en 1 hora</small></span></label>
        <label class="opt"><input type="radio" name="delivery" value="envio" ${c.delivery === 'envio' ? 'checked' : ''}><span>Envío a domicilio<small>Coordinamos la entrega por teléfono</small></span></label>
      </fieldset>
      <label class="field" id="addr-field" ${c.delivery === 'envio' ? '' : 'hidden'}><span>Dirección de envío</span><input type="text" name="address" autocomplete="street-address" maxlength="200"></label>

      <fieldset class="opts"><legend>Pago</legend>
        ${PAYMENTS.map(
          ([v, t, s]) => `<label class="opt"><input type="radio" name="payment" value="${v}" ${c.payment === v ? 'checked' : ''}><span>${t}<small>${s}</small></span></label>`
        ).join('')}
      </fieldset>

      <p class="err-text" id="co-error" role="alert">${esc(c.error)}</p>
      <button type="submit" class="btn btn-lemon btn-block" ${c.busy ? 'disabled' : ''}>${c.busy ? 'Procesando…' : `Confirmar y pagar ${money(cartTotal())}`}</button>
    </form>
    <aside class="co-summary forest" aria-label="Resumen del pedido">
      <h3 class="sub">Tu pedido</h3>
      ${lines.map((l) => lineHTML(l, { editable: false })).join('')}
      <div class="sum-row co-total"><span class="caption upper muted">Total</span><strong class="h">${money(cartTotal())}</strong></div>
      ${tax ? `<p class="caption muted">${tax}</p>` : ''}
      <p class="demo-note">Demostración: al confirmar, el inventario se descuenta automáticamente y se registra el movimiento.</p>
    </aside>
  </div>`;
}

async function submitCheckout(form) {
  const c = state.checkout;
  const fd = new FormData(form);
  c.delivery = fd.get('delivery');
  c.payment = fd.get('payment');
  const name = String(fd.get('name') || '').trim();
  const email = String(fd.get('email') || '').trim();
  const phone = String(fd.get('phone') || '').trim();
  const address = String(fd.get('address') || '').trim();

  const err = !name ? 'Escribe tu nombre.' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Escribe un correo válido.'
    : !phone ? 'Escribe un teléfono de contacto.' : c.delivery === 'envio' && !address ? 'Escribe la dirección de envío.' : '';
  if (err) { $('#co-error').textContent = err; return; }

  c.busy = true;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  submit.textContent = 'Procesando…';
  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: {
        customer: { name, email, phone },
        delivery: c.delivery,
        address,
        payment_method: c.payment,
        items: state.cart.map((l) => ({ variant_id: l.variantId, qty: l.qty })),
      },
    });
    state.cart = [];
    saveCart();
    renderCartBadge();
    renderDone(order);
    fetchList(); // el stock cambió: se muestra al día
  } catch (e) {
    c.busy = false;
    // Si alguien más compró antes, refrescamos stock y ajustamos la bolsa.
    if (e instanceof ApiError && e.status === 409) {
      await refreshCart();
      fetchList();
    }
    c.error = e.message;
    // Conserva lo que ya escribió el cliente.
    const keep = Object.fromEntries(fd.entries());
    renderCheckout();
    for (const [k, v] of Object.entries(keep)) {
      const el = $(`#co-form [name="${k}"]`);
      if (el && el.type !== 'radio') el.value = v;
    }
    if (!cartLines().length) { $('#checkout-dialog').close(); toast('Tu bolsa quedó vacía porque los productos se agotaron.', 'error'); }
  }
}

function renderDone(order) {
  $('#co-content').innerHTML = `
  <div class="co-done">
    <span class="big-check">${icon('checkCircle', 48)}</span>
    <h2 class="h-lg" id="co-title">Gracias, ${esc(order.customer_name.split(' ')[0])}.</h2>
    <p class="body-lg">Tu pedido <strong>#${order.id}</strong> quedó confirmado. Enviamos el comprobante a ${esc(order.customer_email)}.</p>
    <table aria-label="Resumen del pedido">
      ${order.items.map((i) => `<tr><td>${esc(i.name)} · ${sizeLabel(i.size_ml)} × ${i.qty}</td><td>${money(i.unit_price * i.qty)}</td></tr>`).join('')}
      <tr><td><strong>Total</strong></td><td><strong>${money(order.total)}</strong></td></tr>
    </table>
    <p class="demo-note">Detrás de escena: el stock de ${order.items.length === 1 ? 'este producto' : 'estos productos'} bajó solo y quedó registrado el movimiento${
      order.replenished?.items ? `, y se generó una orden de compra automática (${order.replenished.items} ${order.replenished.items === 1 ? 'producto' : 'productos'} en stock bajo)` : ''
    }.</p>
    <div class="co-actions">
      <button type="button" class="btn btn-lemon" data-close data-go="#catalogo">Seguir comprando</button>
      <a class="btn btn-outline" href="/admin#movimientos">Ver el movimiento en el panel</a>
    </div>
  </div>`;
}

// ─── Movimiento ────────────────────────────────────────────────────────────
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let io = null;

// Revela los elementos al entrar en pantalla (con escalonado por columna).
function observeReveals(root = document) {
  const els = root.querySelectorAll('.reveal:not(.in)');
  if (reduceMotion || !('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
  io ??= new IntersectionObserver(
    (entries) => entries.forEach((en) => {
      if (en.isIntersecting) {
        en.target.classList.add('in');
        io.unobserve(en.target);
      }
    }),
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
  );
  els.forEach((e) => io.observe(e));
}

function renderMarquee() {
  const words = [BRAND.tagline, 'Stock en tiempo real', 'Retiro en tienda', 'Envíos a todo el país', 'Ofertas de temporada'];
  const item = `<div class="marquee-item">${words.map((w) => `<span>${esc(w)}</span>${icon('sparkle', 18)}`).join('')}</div>`;
  const half = item + item; // ancho de sobra para pantallas grandes; el bucle recorre -50%
  $('#marquee-track').innerHTML = half + half;
}

function renderFooter() {
  const rows = [BRAND.hours, BRAND.phone && `Tel. ${BRAND.phone}`, BRAND.email, BRAND.address].filter(Boolean);
  const fixed = ['Retiro en tienda o envío a domicilio', 'Pago con tarjeta, transferencia o contra entrega'];
  $('#footer-contact').innerHTML = [...rows, ...fixed].map((t) => `<li>${esc(t)}</li>`).join('');
}

let lastY = 0;
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const y = window.scrollY;
    const bar = $('.topbar');
    if (y > 240 && y > lastY + 4) bar.classList.add('is-hidden');
    else if (y < lastY - 4 || y <= 240) bar.classList.remove('is-hidden');
    lastY = y;
    $('#to-top').hidden = y < 700;
    parallax();
    ticking = false;
  });
}

function parallax() {
  const band = $('#band');
  if (reduceMotion || band.hidden) return;
  const r = band.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  const p = (r.top + r.height / 2 - innerHeight / 2) / innerHeight; // -1 … 1
  $('#band-img').style.transform = `translateY(${(p * -9).toFixed(2)}%)`;
}

// ─── Páginas: los perfumes (portada), «Quiénes somos» (#nosotros) y la página de un producto (#producto/12-nombre) ───
// Al entrar se ven los perfumes; las otras dos son vistas aparte. Se guardan en la dirección (después del #), así que el botón
// Atrás, recargar y compartir el enlace funcionan, y al volver la portada recupera el lugar donde estabas.
const BASE_TITLE = document.title;
let homeY = 0;
const parseRoute = () => {
  const m = /^#producto\/(\d+)/.exec(location.hash);
  if (m) return { page: 'producto', id: Number(m[1]) };
  return { page: location.hash === '#nosotros' ? 'nosotros' : 'inicio' };
};
function setPage(page) {
  const about = page === 'nosotros' && !!$('#nosotros');
  const next = about ? 'nosotros' : page === 'producto' ? 'producto' : 'inicio';
  const was = document.body.dataset.page || 'inicio';
  if (next !== 'inicio' && was === 'inicio') homeY = window.scrollY;
  document.body.dataset.page = next;
  if (next !== 'producto') document.title = about ? `Quiénes somos · ${BRAND.name}` : BASE_TITLE;
  const link = $('#nav-about');
  link?.classList.toggle('is-active', about);
  if (about) link?.setAttribute('aria-current', 'page');
  else link?.removeAttribute('aria-current');
  return was;
}
// Vuelve a los perfumes. push: deja la entrada en el historial (para que Atrás regrese a la vista de la que se sale); sin push se
// usa cuando el propio enlace ya va a cambiar la dirección.
function goHome({ push = true } = {}) {
  setPage('inicio');
  if (push && (location.hash === '#nosotros' || location.hash.startsWith('#producto/'))) history.pushState(null, '', location.pathname + location.search);
}
function route({ first = false } = {}) {
  const r = parseRoute();
  const was = setPage(r.page);
  const now = document.body.dataset.page;
  if (now === was && !first && !(now === 'producto' && r.id !== productPage.id())) return;
  if (now === 'nosotros') {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (!first) $('#about-title').focus({ preventScroll: true });
  } else if (now === 'producto') {
    window.scrollTo({ top: 0, behavior: 'instant' });
    productPage.show(r.id, { focus: !first });
  } else if (!first) {
    const target = location.hash.length > 1 ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo({ top: homeY, behavior: 'instant' });
  }
}

// ─── Eventos ───────────────────────────────────────────────────────────────
function bind() {
  window.addEventListener('hashchange', () => route());
  document.addEventListener('click', (e) => {
    const t = e.target;
    // Desde «Quiénes somos» o desde un producto, lo que lleva al catálogo vuelve antes a los perfumes (esa parte está oculta y no se
    // podría llegar a ella). Los enlaces con # ya cambian solos la dirección; el resto (botones, el logo) la cambian aquí.
    if (document.body.dataset.page !== 'inicio') {
      if (t.closest('a.wordmark[href="/"]')) {
        e.preventDefault();
        goHome();
        return void window.scrollTo({ top: 0, behavior: 'instant' });
      }
      if (t.closest('a[href="#catalogo"], [data-cat], [data-view="sale"], [data-brand], .cat-pill, [data-go], [data-close-go]')) goHome({ push: !t.closest('a[href^="#"]') });
    }
    // El enlace del recuadro a la página del producto: se cierra el recuadro y el propio enlace cambia la dirección.
    if (t.closest('#pd-page')) $('#product-dialog').close();
    // Dentro de un iframe en otra página, el panel no se puede mostrar (por seguridad nunca se incrusta): se abre en una pestaña nueva.
    const adminLink = t.closest('a[href^="/admin"]');
    if (adminLink && window.self !== window.top) {
      e.preventDefault();
      return void window.open(adminLink.href, '_blank', 'noopener');
    }
    const open = t.closest('[data-open]');
    if (open) return openProduct(open.dataset.open);
    const info = t.closest('[data-info]');
    if (info) return openInfo(info.dataset.info);

    // Categoría (barra superior, filtros y pie), tipo, familia, marca y vistas especiales
    const view = t.closest('[data-view]');
    if (view) {
      if (view.dataset.view === 'brands') return openBrands();
      if (view.dataset.view === 'sale') return applyFilters({ ...EMPTY, onSale: true, sort: 'descuento' });
    }
    const cat = t.closest('[data-cat]');
    if (cat && !cat.disabled) {
      applyFilters({ category: cat.dataset.cat, onSale: false });
      if (cat.closest('.seg')) return;
      return $('#catalogo').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    const kind = t.closest('[data-kind]');
    if (kind && !kind.disabled) return applyFilters({ kind: kind.dataset.kind });
    const pill = t.closest('.cat-pill');
    if (pill) {
      applyFilters({ family: pill.dataset.family });
      return $('#catalogo').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    const brand = t.closest('[data-brand]');
    if (brand) {
      $('#brands-dialog').close();
      applyFilters({ brand: brand.dataset.brand });
      return $('#catalogo').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    const mode = t.closest('#view-switch [data-mode]');
    if (mode) return setLayout(mode.dataset.mode);
    if (t.closest('.js-clear')) {
      $('#q').value = '';
      $('#q-hero').value = '';
      // "Mayor descuento" solo tiene sentido dentro de las ofertas: al limpiar vuelve al orden normal.
      return applyFilters({ ...EMPTY, sort: state.filters.sort === 'descuento' ? '' : state.filters.sort });
    }
    if (t.closest('#retry')) return fetchList();
    const pg = t.closest('[data-pg]');
    if (pg && !pg.disabled) return goToPage(pg.dataset.pg);
    if (t.closest('#filters-toggle')) {
      const f = $('#filters');
      const on = f.classList.toggle('is-open');
      $('#filters-toggle').setAttribute('aria-expanded', String(on));
      return;
    }

    const close = t.closest('[data-close]');
    if (close) {
      close.closest('dialog')?.close();
      if (close.dataset.go) document.querySelector(close.dataset.go)?.scrollIntoView();
      return;
    }
    const go = t.closest('[data-close-go]');
    if (go) {
      $('#cart-dialog').close();
      return document.querySelector(go.dataset.closeGo)?.scrollIntoView();
    }
    const rm = t.closest('[data-remove]');
    if (rm) return removeLine(Number(rm.dataset.remove));
    const inc = t.closest('[data-inc]');
    if (inc) return setQty(Number(inc.dataset.inc), (state.cart.find((l) => l.variantId === Number(inc.dataset.inc))?.qty || 0) + 1);
    const dec = t.closest('[data-dec]');
    if (dec) return setQty(Number(dec.dataset.dec), (state.cart.find((l) => l.variantId === Number(dec.dataset.dec))?.qty || 2) - 1);
    if (t.closest('#go-checkout')) return openCheckout();
    if (t.closest('#cart-btn')) return openCart();
  });

  // Cierra los diálogos al hacer clic en el fondo.
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('mousedown', (e) => { if (e.target === d) d.close(); })
  );

  // Búsqueda (con pausa para no pedir en cada tecla) y filtros
  let timer;
  const onSearch = (e) => {
    const v = e.target.value;
    $('#q').value = v;
    $('#q-hero').value = v;
    clearTimeout(timer);
    timer = setTimeout(() => applyFilters({ q: v.trim() }), 250);
  };
  $('#q').addEventListener('input', onSearch);
  $('#q-hero').addEventListener('input', onSearch);
  $('#hero-search').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#catalogo').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  });
  $('#brand').addEventListener('change', (e) => applyFilters({ brand: e.target.value }));
  $('#family').addEventListener('change', (e) => applyFilters({ family: e.target.value }));
  $('#price-max').addEventListener('change', (e) => applyFilters({ maxPrice: e.target.value }));
  $('#sort').addEventListener('change', (e) => applyFilters({ sort: e.target.value }));
  $('#f-sale').addEventListener('change', (e) => applyFilters({ onSale: e.target.checked }));
  $('#f-new').addEventListener('change', (e) => applyFilters({ isNew: e.target.checked }));
  $('#f-stock').addEventListener('change', (e) => applyFilters({ inStock: e.target.checked }));

  // Detalle de producto
  $('#pd-sizes').addEventListener('change', (e) => {
    if (e.target.name !== 'pd-size') return;
    state.pd.variantId = Number(e.target.value);
    state.pd.qty = 1;
    updateProductPanel();
  });
  $('#pd-minus').addEventListener('click', () => { state.pd.qty -= 1; updateProductPanel(); });
  $('#pd-plus').addEventListener('click', () => { state.pd.qty += 1; updateProductPanel(); });
  $('#pd-add').addEventListener('click', async () => {
    await addToCart(state.pd.variantId, state.pd.qty);
    $('#product-dialog').close();
    openCart();
  });

  // Compra
  const co = $('#co-content');
  co.addEventListener('submit', (e) => {
    e.preventDefault();
    submitCheckout(e.target);
  });
  co.addEventListener('change', (e) => {
    if (e.target.name === 'delivery') {
      state.checkout.delivery = e.target.value;
      $('#addr-field').hidden = e.target.value !== 'envio';
      if (e.target.value === 'envio') $('#addr-field input').focus();
    }
  });

  // Asistente (chat.js): conoce productos, agrega a la bolsa y la abre
  window.addEventListener('aurelia:remember', (e) => remember(e.detail?.products));
  window.addEventListener('aurelia:add-to-cart', (e) => {
    const { variantId, qty } = e.detail || {};
    if (Number.isInteger(variantId) && Number.isInteger(qty) && qty > 0) addToCart(variantId, qty);
  });
  window.addEventListener('aurelia:open-cart', openCart);

  // Volver arriba
  const top = $('#to-top');
  top.innerHTML = icon('chevronUp', 18);
  top.addEventListener('click', () => window.scrollTo({ top: 0 }));
  window.addEventListener('scroll', onScroll, { passive: true });

  // Al volver a la pestaña tras un rato, se actualiza el stock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshCart();
    if (Date.now() - state.fetchedAt > 60_000) fetchList();
  });
}

// ─── Inicio ────────────────────────────────────────────────────────────────
async function init() {
  $('#bag-icon').innerHTML = icon('bag', 18);
  $('#cart-close').innerHTML = icon('x', 22);
  $('#brands-close').innerHTML = icon('x', 22);
  $('#info-close').innerHTML = icon('x', 22);
  $('#product-dialog .pd-close').innerHTML = icon('x', 22);
  $('#pd-minus').innerHTML = icon('minus', 16);
  $('#pd-plus').innerHTML = icon('plus', 16);

  mountThemeSwitch();
  productPage = createProductPage({
    root: $('#pp-root'),
    getCart: () => state.cart,
    getLow: () => LOW,
    remember,
    addToCart,
    openCart,
    cardHTML,
    observeReveals,
    brandName: BRAND.name,
  });
  renderAbout();
  route({ first: true });
  const icons = { lista: 'list', grande: 'gridLarge', pequena: 'gridSmall' };
  document.querySelectorAll('#view-switch .view-btn').forEach((b) => { b.innerHTML = icon(icons[b.dataset.mode], 20); });
  setLayout(loadLayout(), { save: false });
  loadCart();
  state.filters = filtersFromUrl();
  $('#q').value = state.filters.q;
  $('#q-hero').value = state.filters.q;
  bind();
  renderMarquee();
  renderFooter();
  renderFilters();
  syncNav();
  renderCartBadge();

  fetchList(); // sin esperar: mientras llega se ven los esqueletos
  await Promise.allSettled([loadTop(), refreshCart()]);
  renderHero();
  renderShopHero();
  renderFeature();
  renderCartBadge();
  observeReveals();
  loadImg('/img/feature.jpg').then((ok) => {
    if (!ok) return;
    $('#band').hidden = false;
    parallax();
  });
}

init();
