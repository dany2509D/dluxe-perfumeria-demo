// Página de un producto (#producto/12-nombre): detalle completo, productos recomendados y reseñas.
// La arma store.js con lo que ya existe (bolsa, tarjetas, avisos) y la deja lista para mostrarse dentro de #producto.
import { api, ApiError, money, esc, icon, productArt, tileColor, toast, sizeLabel } from './ui.js';

// ─── Utilidades que también usa el detalle en recuadro ─────────────────────
export const slugify = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
export const productHref = (p) => `#producto/${p.id}-${slugify(p.name)}`;

const fmtAvg = (avg) => avg.toFixed(1).replace('.', ',');
// Estrellas que se rellenan según el promedio (0 a 5), con texto para lectores de pantalla.
export const starsHTML = (avg) =>
  `<span class="stars" style="--pct:${Math.max(0, Math.min(100, (avg / 5) * 100))}%" role="img" aria-label="${avg ? `${fmtAvg(avg)} de 5 estrellas` : 'Sin calificaciones todavía'}"></span>`;
export const ratingLine = (r) => (r && r.count ? `${starsHTML(r.avg)}<span class="rating-n">${fmtAvg(r.avg)}</span><span class="muted">(${r.count} ${r.count === 1 ? 'reseña' : 'reseñas'})</span>` : '<span class="muted">Aún sin reseñas</span>');

export const sizeOptionsHTML = (product, selectedId, name) =>
  product.variants
    .map(
      (v) => `<label class="size-opt ${v.stock === 0 ? 'is-out' : ''}">
        <input type="radio" name="${name}" value="${v.id}" ${v.id === selectedId ? 'checked' : ''} ${v.stock === 0 ? 'disabled' : ''}>
        <span class="ml">${sizeLabel(v.size_ml)}</span><span class="pr">${v.stock === 0 ? 'Agotado' : `${money(v.price)}${v.compare_at ? ` <s class="was">${money(v.compare_at)}</s>` : ''}`}</span></label>`
    )
    .join('');

// Lo que muestran el precio, el stock, la cantidad y el botón de agregar para un tamaño y una cantidad (igual en el recuadro y en la página).
export function buyState(product, variantId, qty, cart, low = 3) {
  const v = product.variants.find((x) => x.id === variantId) || product.variants[0];
  const q = Math.max(1, Math.min(qty, v.stock || 1));
  const inCart = cart.find((l) => l.variantId === v.id)?.qty || 0;
  return {
    v,
    qty: q,
    price: `${money(v.price * q)}${v.compare_at ? ` <s class="was">${money(v.compare_at * q)}</s>` : ''}`,
    stock: v.stock === 0 ? ['Agotado', 'caption upper stock-out'] : v.stock <= low ? [`Solo quedan ${v.stock} unidades`, 'caption upper stock-low'] : ['Disponible', 'caption upper muted'],
    minusDisabled: q <= 1,
    plusDisabled: q + inCart >= v.stock,
    addDisabled: v.stock === 0 || inCart >= v.stock,
    addLabel: v.stock === 0 ? 'Agotado' : inCart >= v.stock ? 'Ya tienes todo el stock en tu bolsa' : 'Agregar a la bolsa',
  };
}

const fmtDate = (s) => {
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
};
const RATE_TEXT = ['', 'Malo', 'Regular', 'Bueno', 'Muy bueno', 'Excelente'];
const REVIEW_PAGE = 6;

// ─── La página ─────────────────────────────────────────────────────────────
// deps: { root, getCart, getLow, remember, addToCart, openCart, cardHTML, observeReveals, brandName }
export function createProductPage(deps) {
  const { root, remember, addToCart, openCart, cardHTML, observeReveals, brandName } = deps;
  const $ = (sel) => root.querySelector(sel);
  const s = { id: 0, product: null, variantId: 0, qty: 1, related: [], rev: null, token: 0, sending: false };

  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function reviewHTML(r) {
    return `<li class="pp-review"><div class="pp-review-top">${starsHTML(r.rating)}<strong class="pp-review-title">${esc(r.title || RATE_TEXT[r.rating])}</strong></div>
      <p class="pp-review-body">${esc(r.body)}</p>
      <p class="caption muted pp-review-by">${esc(r.author)}${fmtDate(r.created_at) ? ` · ${fmtDate(r.created_at)}` : ''}</p></li>`;
  }

  function summaryHTML(sum) {
    const max = Math.max(1, ...Object.values(sum.dist));
    return `<div class="pp-score"><p class="pp-score-n" aria-hidden="true">${sum.count ? fmtAvg(sum.avg) : '–'}</p>
        <div>${starsHTML(sum.avg)}<p class="muted pp-score-count">${sum.count ? `${sum.count} ${sum.count === 1 ? 'reseña' : 'reseñas'}` : 'Aún sin reseñas'}</p></div></div>
      <ul class="pp-dist" aria-label="Reseñas por calificación">${[5, 4, 3, 2, 1]
        .map((n) => `<li><span class="pp-dist-n">${n} ${n === 1 ? 'estrella' : 'estrellas'}</span><span class="pp-dist-bar" aria-hidden="true"><i style="width:${(sum.dist[n] / max) * 100}%"></i></span><span class="pp-dist-c">${sum.dist[n]}</span></li>`)
        .join('')}</ul>`;
  }

  function renderReviews() {
    const rev = s.rev;
    if (!rev) return;
    $('#pp-rev-summary').innerHTML = summaryHTML(rev.summary);
    $('#pp-rev-list').innerHTML = rev.reviews.length
      ? rev.reviews.map(reviewHTML).join('')
      : '<li class="pp-empty"><p class="sub">Todavía no hay reseñas de este perfume.</p><p class="muted">Sé la primera persona en contar cómo te fue con él.</p></li>';
    const more = $('#pp-more');
    more.hidden = rev.page >= rev.pages;
    more.disabled = false;
    $('#pp-rev-note').hidden = !rev.reviews.some((r) => r.sample);
    const line = $('#pp-rating-line');
    if (line) line.innerHTML = `${ratingLine(rev.summary)}${rev.summary.count ? '' : ''}`;
  }

  function relatedHTML() {
    if (!s.related.length) return '';
    return `<section class="pp-section" aria-labelledby="pp-related-title">
      <h2 class="h-lg" id="pp-related-title">También te puede gustar</h2>
      <div class="grid pp-related" id="pp-related" data-layout="pequena">${s.related.map((p, i) => cardHTML(p, i, { href: productHref(p) })).join('')}</div>
    </section>`;
  }

  function pageHTML() {
    const p = s.product;
    const first = s.variantId;
    const meta = [p.kind !== 'Perfume' && p.kind, p.brand, p.category, p.family].filter(Boolean).join(' · ');
    const pct = p.discount_pct || 0;
    const chips = [
      p.on_sale && `<span class="badge low">${pct ? `-${pct}%` : 'Oferta'}</span>`,
      p.is_new && '<span class="badge info">Nuevo</span>',
      p.kind !== 'Perfume' && `<span class="badge info">${esc(p.kind)}</span>`,
    ].filter(Boolean);
    const facts = [
      ['Marca', p.brand],
      ['Categoría', [p.category, p.subcategory].filter(Boolean).join(' · ')],
      ['Tipo', p.kind],
      ['Familia olfativa', p.family],
      ['Notas', p.notes],
      ['Tamaños', p.variants.map((v) => sizeLabel(v.size_ml)).join(', ')],
    ].filter(([, v]) => v);
    return `
    <nav class="pp-crumbs caption upper" aria-label="Ruta">
      <a href="#catalogo" data-cat="">Perfumes</a><span aria-hidden="true">/</span>
      <a href="#catalogo" data-cat="${esc(p.category)}">${esc(p.category)}</a><span aria-hidden="true">/</span>
      <span aria-current="page">${esc(p.name)}</span>
    </nav>
    <div class="pp-main">
      <div class="pp-art" style="--tile:${tileColor(p.id)}">${productArt(p, { title: p.name, eager: true })}</div>
      <div class="pp-info">
        <p class="caption upper muted">${esc(meta)}</p>
        <h1 class="h-lg" id="pp-name" tabindex="-1">${esc(p.name)}</h1>
        <p class="pp-rating"><span id="pp-rating-line">${ratingLine(s.rev?.summary)}</span><button type="button" class="link-btn" data-scroll="pp-reviews">Ver reseñas</button></p>
        ${chips.length ? `<p class="pp-chips">${chips.join('')}</p>` : ''}
        ${p.description ? `<p class="body-lg pp-desc">${esc(p.description)}</p>` : ''}
        ${p.notes ? `<p class="pd-notes"><span class="label">Notas</span><span class="pp-notes">${esc(p.notes)}</span></p>` : ''}
        <fieldset class="sizes"><legend class="label">Tamaño</legend><div class="size-list" id="pp-sizes">${sizeOptionsHTML(p, first, 'pp-size')}</div></fieldset>
        <div class="pp-buy">
          <div><p class="pp-price h" id="pp-price"></p><p class="caption" id="pp-stock" aria-live="polite"></p></div>
          <div class="stepper" role="group" aria-label="Cantidad">
            <button type="button" id="pp-minus" aria-label="Menos">${icon('minus', 16)}</button>
            <output id="pp-qty" aria-live="polite">1</output>
            <button type="button" id="pp-plus" aria-label="Más">${icon('plus', 16)}</button>
          </div>
        </div>
        <button type="button" class="btn btn-lemon btn-block" id="pp-add">Agregar a la bolsa</button>
        <ul class="pp-perks">
          <li>${icon('store', 18)}<span>Retiro en tienda sin costo o envío a domicilio</span></li>
          <li>${icon('receipt', 18)}<span>Pago con tarjeta, transferencia o contra entrega</span></li>
          <li>${icon('check', 18)}<span>El stock que ves es el real y cambia con cada venta</span></li>
        </ul>
      </div>
    </div>

    <section class="pp-section" aria-labelledby="pp-details-title">
      <h2 class="h-lg" id="pp-details-title">Detalles</h2>
      <div class="pp-details">
        ${p.description ? `<p class="body-lg pp-details-text">${esc(p.description)}</p>` : ''}
        <dl class="pp-facts">${facts.map(([k, v]) => `<div><dt class="caption upper muted">${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      </div>
    </section>

    ${relatedHTML()}

    <section class="pp-section" id="pp-reviews" aria-labelledby="pp-reviews-title">
      <h2 class="h-lg" id="pp-reviews-title">Reseñas</h2>
      <div class="pp-rev-grid">
        <div class="pp-rev-side" id="pp-rev-summary"></div>
        <form class="pp-form" id="pp-form" novalidate aria-labelledby="pp-form-title">
          <h3 class="sub" id="pp-form-title">Escribe tu reseña</h3>
          <fieldset class="pp-rate"><legend class="label">Tu calificación</legend>
            <div class="star-input" id="pp-stars">${[5, 4, 3, 2, 1]
              .map((n) => `<input type="radio" class="sr-only" name="rating" id="pp-star-${n}" value="${n}"><label for="pp-star-${n}" title="${RATE_TEXT[n]}"><span class="sr-only">${n} ${n === 1 ? 'estrella' : 'estrellas'}: ${RATE_TEXT[n]}</span><span aria-hidden="true">★</span></label>`)
              .join('')}</div>
            <span class="caption muted" id="pp-rate-text" aria-live="polite">Elige de 1 a 5 estrellas</span>
          </fieldset>
          <label class="field"><span>Tu nombre</span><input type="text" name="name" maxlength="40" autocomplete="given-name" required></label>
          <label class="field"><span>Título (opcional)</span><input type="text" name="title" maxlength="80"></label>
          <label class="field"><span>Tu opinión</span><textarea name="body" rows="4" maxlength="600" required></textarea><small id="pp-count">0 / 600</small></label>
          <div class="pp-trap" aria-hidden="true"><label>Sitio web <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
          <p class="err-text" id="pp-form-err" role="alert" hidden></p>
          <button type="submit" class="btn btn-solid" id="pp-submit">Publicar reseña</button>
          <p class="caption muted">Sin enlaces. Tu reseña se publica al instante.</p>
        </form>
      </div>
      <ol class="pp-rev-list" id="pp-rev-list"></ol>
      <p class="pp-more"><button type="button" class="btn btn-outline" id="pp-more" hidden>Ver más reseñas</button></p>
      <p class="caption muted" id="pp-rev-note" hidden>Las reseñas que ya aparecen son de ejemplo para esta demostración; las que escribas aquí se guardan en ella.</p>
    </section>`;
  }

  function updateBuy() {
    if (!s.product) return;
    const b = buyState(s.product, s.variantId, s.qty, deps.getCart(), deps.getLow());
    s.qty = b.qty;
    $('#pp-price').innerHTML = b.price;
    $('#pp-qty').textContent = b.qty;
    const stock = $('#pp-stock');
    stock.textContent = b.stock[0];
    stock.className = b.stock[1];
    $('#pp-minus').disabled = b.minusDisabled;
    $('#pp-plus').disabled = b.plusDisabled;
    const add = $('#pp-add');
    add.disabled = b.addDisabled;
    add.textContent = b.addLabel;
  }

  const message = (title, text, button) => {
    root.innerHTML = `<div class="empty pp-empty"><p class="sub">${esc(title)}</p><p class="muted">${esc(text)}</p>${button || ''}</div>`;
  };

  // Muestra el producto: primero un esqueleto y enseguida los datos frescos (el stock cambia con cada venta).
  async function show(id, { focus = true } = {}) {
    const token = ++s.token;
    s.id = id;
    s.product = null;
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<div class="pp-skel" aria-hidden="true"><div class="pp-skel-art"></div><div class="pp-skel-info"><i></i><i class="w"></i><i></i><i class="short"></i></div></div>';
    document.title = `Producto · ${brandName}`;
    try {
      const [product, rel, rev] = await Promise.all([
        api(`/api/products/${id}`),
        api(`/api/products/${id}/related?limit=8`).catch(() => ({ products: [] })),
        api(`/api/products/${id}/reviews?limit=${REVIEW_PAGE}`).catch(() => null),
      ]);
      if (token !== s.token) return;
      remember([product, ...rel.products]);
      s.product = product;
      s.related = rel.products;
      s.rev = rev;
      s.variantId = (product.variants.find((v) => v.stock > 0) || product.variants[0]).id;
      s.qty = 1;
      root.innerHTML = pageHTML();
      root.removeAttribute('aria-busy');
      document.title = `${product.name} · ${brandName}`;
      renderReviews();
      updateBuy();
      if (!rev) {
        $('#pp-rev-list').innerHTML = '<li class="pp-empty"><p class="muted">No pudimos cargar las reseñas ahora. Inténtalo de nuevo en unos segundos.</p></li>';
      }
      observeReveals($('#pp-related') || root);
      if (focus) $('#pp-name').focus({ preventScroll: true });
    } catch (e) {
      if (token !== s.token) return;
      root.removeAttribute('aria-busy');
      document.title = `Producto no encontrado · ${brandName}`;
      if (e instanceof ApiError && e.status === 404) message('No encontramos ese producto', 'Puede que ya no esté disponible.', '<a class="btn btn-solid" href="#catalogo">Ver la colección</a>');
      else message('No pudimos cargar el producto', e.message || 'Inténtalo de nuevo.', '<button type="button" class="btn btn-solid" data-pp-retry>Reintentar</button>');
    }
  }

  async function loadMore() {
    const rev = s.rev;
    if (!rev || rev.page >= rev.pages) return;
    const more = $('#pp-more');
    more.disabled = true;
    const token = s.token;
    try {
      const next = await api(`/api/products/${s.id}/reviews?limit=${REVIEW_PAGE}&page=${rev.page + 1}`);
      if (token !== s.token) return;
      const known = new Set(rev.reviews.map((r) => r.id));
      s.rev = { ...next, reviews: [...rev.reviews, ...next.reviews.filter((r) => !known.has(r.id))] };
      renderReviews();
    } catch (e) {
      more.disabled = false;
      toast(e.message || 'No pudimos cargar más reseñas.', 'error');
    }
  }

  const formError = (msg) => {
    const el = $('#pp-form-err');
    el.textContent = msg || '';
    el.hidden = !msg;
  };

  async function submitReview(form) {
    if (s.sending) return;
    const data = Object.fromEntries(new FormData(form));
    const name = String(data.name || '').trim();
    const body = String(data.body || '').trim();
    if (!data.rating) { formError('Elige una calificación de 1 a 5 estrellas.'); return void form.querySelector('.star-input input').focus(); }
    if (name.length < 2) { formError('Escribe tu nombre (de 2 a 40 letras).'); return void form.elements.name.focus(); }
    if (body.length < 10) { formError('Cuéntanos un poco más: la reseña necesita al menos 10 caracteres.'); return void form.elements.body.focus(); }
    formError('');
    s.sending = true;
    const btn = $('#pp-submit');
    btn.disabled = true;
    btn.textContent = 'Publicando…';
    const token = s.token;
    try {
      const out = await api(`/api/products/${s.id}/reviews`, { method: 'POST', body: { name, rating: Number(data.rating), title: String(data.title || ''), body, website: String(data.website || '') } });
      if (token !== s.token) return;
      s.rev = { ...s.rev, summary: out.summary, total: out.summary.count, reviews: [out.review, ...s.rev.reviews.filter((r) => r.id !== out.review.id)] };
      renderReviews();
      form.reset();
      $('#pp-count').textContent = '0 / 600';
      $('#pp-rate-text').textContent = 'Elige de 1 a 5 estrellas';
      toast('¡Gracias por tu reseña! Ya está publicada.');
      $('#pp-rev-list').firstElementChild?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
    } catch (e) {
      formError(e.message || 'No pudimos publicar tu reseña. Inténtalo de nuevo.');
    } finally {
      s.sending = false;
      btn.disabled = false;
      btn.textContent = 'Publicar reseña';
    }
  }

  // ─── Eventos (una sola vez, sobre el contenedor) ─────────────────────────
  root.addEventListener('click', async (e) => {
    const t = e.target;
    const scroll = t.closest('[data-scroll]');
    if (scroll) return void document.getElementById(scroll.dataset.scroll)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    if (t.closest('[data-pp-retry]')) return void show(s.id);
    if (!s.product) return;
    if (t.closest('#pp-minus')) { s.qty -= 1; return updateBuy(); }
    if (t.closest('#pp-plus')) { s.qty += 1; return updateBuy(); }
    if (t.closest('#pp-more')) return loadMore();
    if (t.closest('#pp-add')) {
      await addToCart(s.variantId, s.qty);
      s.qty = 1;
      updateBuy();
      openCart();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.name === 'pp-size') {
      s.variantId = Number(e.target.value);
      s.qty = 1;
      updateBuy();
    } else if (e.target.name === 'rating') {
      $('#pp-rate-text').textContent = `${e.target.value} ${e.target.value === '1' ? 'estrella' : 'estrellas'}: ${RATE_TEXT[e.target.value]}`;
      formError('');
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.name === 'body') $('#pp-count').textContent = `${e.target.value.length} / 600`;
  });
  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'pp-form') return;
    e.preventDefault();
    submitReview(e.target);
  });

  return { show, id: () => s.id, refreshBuy: updateBuy };
}
