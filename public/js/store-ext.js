// La tienda más allá del catálogo: ofertas, favoritos, cuenta de cliente, seguimiento del pedido, buscador guiado, tarjetas de regalo y
// «avísame cuando llegue». Cada función abre su propio diálogo; la bolsa y el pago siguen en store.js.
import { api, ApiError, money, esc, icon, toast, productArt, tileColor, sizeLabel, fmtDateTime } from './ui.js';
import * as acct from './account.js';
import { productHref } from './product-page.js';

const $ = (sel, root = document) => root.querySelector(sel);
const BRAND = window.__BRAND || { name: 'Tienda', short: 'Tienda' };
const phoneOk = (s) => String(s).replace(/\D/g, '').length >= 8;

// ─── Diálogo genérico ──────────────────────────────────────────────────────
function openX({ title, body, wide = false, onOpen = null }) {
  const dlg = $('#x-dialog');
  dlg.classList.toggle('wide', wide);
  $('#x-title').textContent = title;
  $('#x-body').innerHTML = body;
  if (!dlg.open) dlg.showModal();
  onOpen?.(dlg);
  return dlg;
}
const closeX = () => $('#x-dialog').close();
const errBox = (msg) => `<p class="err-text x-err" role="alert" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>`;
const showErr = (root, msg) => { const el = root.querySelector('.x-err'); if (el) { el.textContent = msg || ''; el.hidden = !msg; } };
const busy = (btn, on, label) => { btn.disabled = on; if (label) { btn.dataset.l ??= btn.textContent; btn.textContent = on ? label : btn.dataset.l; } };

// ─── Ofertas ───────────────────────────────────────────────────────────────
async function loadOffers() {
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('aurelia-offers-off') === '1'; } catch { /* sin almacenamiento */ }
  if (dismissed) return;
  try {
    const { offers } = await api('/api/offers');
    if (!offers.length) return;
    const text = (o) => {
      const what = o.kind === 'percent' ? `${o.amount}% de descuento` : o.kind === 'fixed' ? `${money(o.amount)} menos` : `llévate ${o.buy_qty} por ${money(o.amount)}`;
      const until = o.ends_at ? ` hasta el ${new Date(`${o.ends_at}T00:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'long' })}` : '';
      return o.code ? `Código <b>${esc(o.code)}</b>: ${esc(o.name.replace(/^.*?:\s*/, ''))}` : `${esc(o.name)}${until}`;
    };
    const bar = $('#offer-bar');
    bar.innerHTML = `<div class="offer-in"><p>${offers.slice(0, 3).map((o) => `<span>${text(o)}</span>`).join('')}</p><button type="button" class="icon-btn sm" id="offer-x" aria-label="Cerrar este aviso">${icon('x', 16)}</button></div>`;
    bar.hidden = false;
  } catch { /* sin ofertas visibles */ }
}

// ─── Favoritos ─────────────────────────────────────────────────────────────
function refreshFavUI() {
  document.querySelectorAll('[data-fav]').forEach((b) => {
    const on = acct.isFav(b.dataset.fav);
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
    b.title = on ? 'Quitar de favoritos' : 'Guardar en favoritos';
  });
  const n = acct.favIds().length;
  const c = $('#fav-count');
  if (c) { c.textContent = n; c.hidden = !n; }
  const lbl = $('#acct-lbl');
  const c2 = acct.getCustomer();
  if (lbl) lbl.textContent = c2 ? c2.name.split(/\s+/)[0] : 'Entrar';
}

async function openFavorites() {
  const ids = acct.favIds();
  const dlg = openX({ title: 'Mis favoritos', body: ids.length ? '<p class="muted">Cargando…</p>' : emptyFavs(), wide: true });
  if (!ids.length) return;
  try {
    const { products } = await api(`/api/products-by-ids?ids=${ids.join(',')}`);
    const shown = ids.map((id) => products.find((p) => p.id === id)).filter(Boolean);
    $('#x-body', dlg).innerHTML = shown.length
      ? `<ul class="fav-list">${shown.map((p) => {
          const out = p.total_stock === 0;
          return `<li class="fav-row ${out ? 'is-out' : ''}"><a class="fav-art" href="${productHref(p)}" data-xclose style="--tile:${tileColor(p.id)}">${productArt(p, { title: p.name })}</a>
            <div class="fav-info"><a href="${productHref(p)}" data-xclose class="fav-name">${esc(p.name)}</a><p class="caption upper muted">${esc(p.brand || p.category)}</p><p>${out ? '<span class="badge out">Agotado</span>' : `desde ${money(p.min_price)}`}</p></div>
            <div class="fav-acts">${out ? '' : `<button type="button" class="btn btn-sm btn-lemon" data-fav-add="${p.id}">Agregar</button>`}<button type="button" class="btn btn-sm btn-text" data-fav="${p.id}" aria-pressed="true">Quitar</button></div></li>`;
        }).join('')}</ul>
        ${acct.loggedIn() ? '<p class="caption muted">Tus favoritos se guardan en tu cuenta.</p>' : '<p class="hint">Estos favoritos se guardan solo en este navegador. <button type="button" class="link-btn" data-x="account">Crea una cuenta</button> para tenerlos en todos tus aparatos.</p>'}`
      : emptyFavs();
    window.__favProducts = new Map(shown.map((p) => [p.id, p]));
  } catch (e) {
    $('#x-body', dlg).innerHTML = `<p class="err-text">${esc(e.message)}</p>`;
  }
}
const emptyFavs = () => `<div class="x-empty"><p class="sub">Todavía no tienes favoritos.</p><p class="muted">Toca el corazón de un perfume para guardarlo aquí.</p><button type="button" class="btn btn-lemon" data-close data-go="#catalogo">Ver la colección</button></div>`;

// ─── Cuenta del cliente ────────────────────────────────────────────────────
function authForm(mode = 'login') {
  const reg = mode === 'register';
  return `<div class="x-tabs" role="tablist"><button type="button" class="x-tab ${reg ? '' : 'is-on'}" data-auth="login" role="tab" aria-selected="${!reg}">Entrar</button><button type="button" class="x-tab ${reg ? 'is-on' : ''}" data-auth="register" role="tab" aria-selected="${reg}">Crear cuenta</button></div>
  <form class="x-form" id="auth-form" data-mode="${mode}" novalidate>
    ${reg ? '<label class="field"><span>Nombre completo</span><input type="text" name="name" required maxlength="80" autocomplete="name"></label>' : ''}
    <label class="field"><span>Correo electrónico</span><input type="email" name="email" required maxlength="120" autocomplete="email"></label>
    ${reg ? '<label class="field"><span>Teléfono (opcional)</span><input type="tel" name="phone" maxlength="30" autocomplete="tel"></label>' : ''}
    <label class="field"><span>Contraseña</span><input type="password" name="password" required minlength="${reg ? 8 : 1}" maxlength="100" autocomplete="${reg ? 'new-password' : 'current-password'}">${reg ? '<small>Mínimo 8 caracteres.</small>' : ''}</label>
    ${reg ? '<div class="pp-trap" aria-hidden="true"><label>Sitio web <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>' : ''}
    ${errBox('')}
    <button type="submit" class="btn btn-lemon btn-block">${reg ? 'Crear mi cuenta' : 'Entrar'}</button>
    <p class="caption muted">${reg ? 'Con tu cuenta ves tus pedidos y guardas tus favoritos. Comprar no la exige.' : 'Comprar no exige tener cuenta.'}</p>
  </form>`;
}

async function accountView() {
  const c = acct.getCustomer();
  const dlg = openX({
    title: `Hola, ${c.name.split(/\s+/)[0]}`,
    wide: true,
    body: `<div class="acct-grid">
      <section><h3 class="sub">Mis datos</h3>
        <form class="x-form" id="profile-form" novalidate>
          <label class="field"><span>Nombre</span><input type="text" name="name" required maxlength="80" value="${esc(c.name)}"></label>
          <label class="field"><span>Correo</span><input type="email" value="${esc(c.email)}" disabled></label>
          <label class="field"><span>Teléfono</span><input type="tel" name="phone" maxlength="30" value="${esc(c.phone || '')}"></label>
          <label class="chk"><input type="checkbox" name="notify_opt_in" ${c.notify_opt_in ? 'checked' : ''}><span>Quiero recibir por WhatsApp el estado de mis pedidos</span></label>
          ${errBox('')}
          <button type="submit" class="btn btn-outline">Guardar</button>
        </form>
        <h3 class="sub" style="margin-top:22px">Cambiar contraseña</h3>
        <form class="x-form" id="pass-form" novalidate>
          <label class="field"><span>Contraseña actual</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="field"><span>Contraseña nueva</span><input type="password" name="next" required minlength="8" autocomplete="new-password"></label>
          ${errBox('')}
          <button type="submit" class="btn btn-outline">Cambiar contraseña</button>
        </form>
        <p style="margin-top:18px"><button type="button" class="btn btn-text" data-x="favorites">${icon('heart', 16)} Mis favoritos (${acct.favIds().length})</button> <button type="button" class="btn btn-text" id="acct-logout">Cerrar sesión</button></p>
      </section>
      <section><h3 class="sub">Mis pedidos</h3><div id="acct-orders"><p class="muted">Cargando…</p></div></section>
    </div>`,
  });
  try {
    const orders = await acct.myOrders();
    const STATUS = { pendiente_pago: 'Esperando pago', pagado: 'En proceso', entregado: 'Entregado', cancelado: 'Cancelado' };
    $('#acct-orders', dlg).innerHTML = orders.length
      ? `<ul class="acct-orders">${orders.map((o) => `<li><div><b>Pedido #${o.id}</b><span class="caption muted">${esc(fmtDateTime(o.created_at))} · ${esc(STATUS[o.status] || o.status)}</span><span class="caption">${o.items.slice(0, 2).map((i) => `${i.qty}× ${esc(i.name)}`).join(', ')}${o.items.length > 2 ? ` y ${o.items.length - 2} más` : ''}</span></div><div class="acct-right"><b>${money(o.total)}</b>${o.tracking_code ? `<button type="button" class="btn btn-sm btn-outline" data-track-code="${esc(o.tracking_code)}">Seguir</button>` : ''}</div></li>`).join('')}</ul>`
      : '<p class="muted">Todavía no hiciste pedidos con tu cuenta. Los que hagas con la sesión iniciada aparecerán aquí.</p>';
  } catch (e) {
    $('#acct-orders', dlg).innerHTML = `<p class="err-text">${esc(e.message)}</p>`;
  }
}

function openAccount(mode = 'login') {
  if (acct.loggedIn()) return void accountView();
  openX({ title: mode === 'register' ? 'Crear cuenta' : 'Mi cuenta', body: authForm(mode) });
}

// ─── Seguimiento ───────────────────────────────────────────────────────────
let trackTimer = null;
const stopTrack = () => { clearInterval(trackTimer); trackTimer = null; };

function trackForm(prefill = {}) {
  return `<p class="muted">Mira en qué paso va tu pedido. Escribe el <b>código de seguimiento</b> que te enviamos, o el <b>número de pedido</b> con el correo o teléfono de tu compra.</p>
  <form class="x-form" id="track-form" novalidate>
    <label class="field"><span>Código de seguimiento</span><input type="text" name="code" maxlength="10" autocapitalize="characters" autocomplete="off" placeholder="K7Q2M9XPA4" value="${esc(prefill.code || '')}"></label>
    <p class="caption upper muted x-or">o bien</p>
    <div class="grid-2x">
      <label class="field"><span>Número de pedido</span><input type="text" name="order" inputmode="numeric" maxlength="9" placeholder="123" value="${esc(prefill.order || '')}"></label>
      <label class="field"><span>Correo o teléfono de la compra</span><input type="text" name="contact" maxlength="120" autocomplete="off" value="${esc(prefill.contact || '')}"></label>
    </div>
    ${errBox('')}
    <button type="submit" class="btn btn-lemon btn-block">Ver mi pedido</button>
  </form>`;
}

function trackView(t, query) {
  const step = (s) => `<li class="tl-step ${s.done ? 'is-done' : ''}"><span class="tl-dot" aria-hidden="true">${s.done ? icon('check', 12) : ''}</span><div><b>${esc(s.label)}</b>${s.at ? `<span class="caption muted">${esc(fmtDateTime(s.at))}</span>` : ''}</div></li>`;
  const cancelled = t.cancelled;
  const last = t.steps.filter((s) => s.done).at(-1);
  return `<div class="track-head"><p class="caption upper muted">Pedido #${t.id} · ${esc(fmtDateTime(t.created_at))}</p>
      <h3 class="h">${cancelled ? 'Pedido cancelado' : t.payment_pending ? 'Esperando la confirmación del pago' : t.status === 'entregado' ? '¡Entregado!' : esc(last?.label || 'Pedido recibido')}</h3>
      <p class="muted">Hola, ${esc(t.first_name)}.${t.payment_pending ? ' Apenas se confirme el pago empezamos a preparar tu pedido. Esta pantalla se actualiza sola.' : cancelled ? ' Este pedido se canceló; si tienes dudas, escríbenos.' : t.delivery === 'envio' ? ' Tu pedido se entrega a domicilio.' : ' Lo retiras en la tienda.'}</p></div>
    ${cancelled ? '' : `<ol class="timeline-s">${t.steps.map(step).join('')}</ol>`}
    ${t.events.some((e) => e.kind === 'devolucion') ? `<p class="hint">${t.events.filter((e) => e.kind === 'devolucion').map((e) => esc(e.note)).join(' · ')}</p>` : ''}
    <h4 class="label" style="margin-top:18px">Tu compra</h4>
    <ul class="track-items">${t.items.map((i) => `<li><span>${i.qty} × ${esc(i.name)} <span class="muted">${sizeLabel(i.size_ml)}</span></span><b>${money(i.unit_price * i.qty)}</b></li>`).join('')}</ul>
    <div class="track-totals">
      ${t.totals.discount ? `<p><span>Descuento</span><span>−${money(t.totals.discount)}</span></p>` : ''}
      ${t.totals.gift ? `<p><span>Pagado con tarjeta de regalo</span><span>−${money(t.totals.gift)}</span></p>` : ''}
      <p class="b"><span>Total</span><span>${money(t.totals.total)}</span></p>
    </div>
    <p class="caption muted" style="margin-top:12px"><button type="button" class="link-btn" data-x="track-again">Consultar otro pedido</button></p>`;
}

async function openTrack(query = null) {
  stopTrack();
  if (!query || (!query.code && !(query.order && query.contact))) {
    const dlg = openX({ title: 'Seguimiento de pedido', body: trackForm(query || {}) });
    if (query) showErr(dlg, 'Escribe el código, o el número de pedido y el correo o teléfono.');
    return;
  }
  const dlg = openX({ title: 'Seguimiento de pedido', body: '<p class="muted">Buscando tu pedido…</p>' });
  const load = async (first) => {
    try {
      const qs = query.code ? `code=${encodeURIComponent(query.code)}` : `order=${encodeURIComponent(query.order)}&contact=${encodeURIComponent(query.contact)}`;
      const t = await api(`/api/track?${qs}`);
      if (!dlg.open) return stopTrack();
      $('#x-body').innerHTML = trackView(t, query);
      if (t.payment_pending) {
        if (!trackTimer) trackTimer = setInterval(() => load(false), 4000);
      } else stopTrack();
    } catch (e) {
      stopTrack();
      if (first) $('#x-body').innerHTML = trackForm(query) + '';
      if (first) showErr(dlg, e.message);
    }
  };
  await load(true);
}

// ─── Buscador guiado ───────────────────────────────────────────────────────
const finder = { qs: null, step: 0, answers: {} };

async function openFinder() {
  finder.step = 0;
  finder.answers = {};
  const dlg = openX({ title: 'Encuentra tu perfume', body: '<p class="muted">Cargando…</p>', wide: true });
  try {
    finder.qs = (await api('/api/finder/questions')).questions;
    drawFinder();
  } catch (e) {
    $('#x-body', dlg).innerHTML = `<p class="err-text">${esc(e.message)}</p>`;
  }
}

function drawFinder() {
  const q = finder.qs[finder.step];
  const n = finder.qs.length;
  $('#x-body').innerHTML = `<div class="fd-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${finder.step + 1}"><i style="width:${((finder.step + 1) / n) * 100}%"></i></div>
    <p class="caption upper muted">Pregunta ${finder.step + 1} de ${n}</p>
    <h3 class="h fd-q">${esc(q.title)}</h3>
    <div class="fd-opts">${q.options.map(([v, t]) => `<button type="button" class="fd-opt ${finder.answers[q.id] === v && q.id in finder.answers ? 'is-on' : ''}" data-fd="${esc(v)}">${esc(t)}</button>`).join('')}</div>
    ${finder.step ? '<p><button type="button" class="btn btn-text" data-fd-back>← Atrás</button></p>' : ''}`;
}

async function finderResult() {
  $('#x-body').innerHTML = '<p class="muted">Buscando lo que mejor te va…</p>';
  try {
    const r = await api('/api/finder', { method: 'POST', body: { answers: finder.answers } });
    window.__finderProducts = new Map(r.products.map((p) => [p.id, p]));
    $('#x-body').innerHTML = r.products.length
      ? `${r.relaxed.length ? `<p class="hint">No encontré algo que cumpla todo lo que pediste, así que te muestro lo más cercano (aflojé: ${esc(r.relaxed.join(', '))}).</p>` : '<p class="muted">Estas son mis recomendaciones según lo que me contaste:</p>'}
        <ol class="fd-results">${r.products.map((p, i) => `<li class="fd-card"><span class="fd-rank" aria-hidden="true">${i + 1}</span>
          <a class="fd-art" href="${productHref(p)}" data-xclose style="--tile:${tileColor(p.id)}">${productArt(p, { title: p.name })}</a>
          <div class="fd-info"><p class="caption upper muted">${esc(p.brand || p.category)} · ${esc(p.category)}${p.kind !== 'Perfume' ? ` · ${esc(p.kind)}` : ''}</p>
            <h4 class="sub"><a href="${productHref(p)}" data-xclose>${esc(p.name)}</a></h4>
            <p class="fd-price">${p.min_price === p.max_price ? money(p.min_price) : `desde ${money(p.min_price)}`}</p>
            <ul class="fd-why">${p.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
            <div class="fd-acts"><button type="button" class="btn btn-sm btn-lemon" data-fd-add="${p.id}">Agregar a la bolsa</button><a class="btn btn-sm btn-outline" href="${productHref(p)}" data-xclose>Ver producto</a></div></div></li>`).join('')}</ol>`
      : '<div class="x-empty"><p class="sub">No encontré perfumes con esas respuestas.</p><p class="muted">Prueba con otro presupuesto o estilo.</p></div>';
    $('#x-body').insertAdjacentHTML('beforeend', '<p><button type="button" class="btn btn-outline" data-x="finder">Empezar de nuevo</button></p>');
  } catch (e) {
    $('#x-body').innerHTML = `<p class="err-text">${esc(e.message)}</p><p><button type="button" class="btn btn-outline" data-x="finder">Intentar otra vez</button></p>`;
  }
}

// ─── Tarjetas de regalo ────────────────────────────────────────────────────
function giftForm(tab = 'buy') {
  const c = acct.getCustomer();
  return `<div class="x-tabs" role="tablist"><button type="button" class="x-tab ${tab === 'buy' ? 'is-on' : ''}" data-gift-tab="buy" role="tab" aria-selected="${tab === 'buy'}">Comprar una tarjeta</button><button type="button" class="x-tab ${tab === 'check' ? 'is-on' : ''}" data-gift-tab="check" role="tab" aria-selected="${tab === 'check'}">Consultar saldo</button></div>
  ${tab === 'check'
    ? `<form class="x-form" id="gift-check" novalidate><label class="field"><span>Código de la tarjeta</span><input type="text" name="code" required maxlength="24" placeholder="GC-XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off"></label>${errBox('')}<div id="gift-balance"></div><button type="submit" class="btn btn-lemon btn-block">Ver saldo</button></form>`
    : `<p class="muted">Un regalo que siempre queda bien: la persona elige su perfume. La tarjeta vale en la tienda en línea y en el mostrador, y vence en un año.</p>
    <form class="x-form" id="gift-buy" novalidate>
      <div class="field"><span>Monto</span><div class="chips" id="gift-chips">${[25, 50, 100, 150].map((n) => `<button type="button" class="chip" data-amount="${n}">${money(n)}</button>`).join('')}</div>
        <input type="number" name="amount" min="5" max="1000" step="0.01" required placeholder="Otro monto ($5 a $1.000)" inputmode="decimal"></div>
      <div class="grid-2x"><label class="field"><span>Tu nombre</span><input type="text" name="buyer_name" required maxlength="80" autocomplete="name" value="${esc(c?.name || '')}"></label>
        <label class="field"><span>Tu correo (te enviamos el código)</span><input type="email" name="buyer_email" required maxlength="120" autocomplete="email" value="${esc(c?.email || '')}"></label></div>
      <div class="grid-2x"><label class="field"><span>Para quién es (opcional)</span><input type="text" name="recipient_name" maxlength="80"></label>
        <label class="field"><span>Correo de quien la recibe (opcional)</span><input type="email" name="recipient_email" maxlength="120"><small>Le enviamos la tarjeta con tu mensaje.</small></label></div>
      <label class="field"><span>Mensaje (opcional)</span><input type="text" name="message" maxlength="240" placeholder="¡Feliz cumpleaños!"></label>
      <fieldset class="opts"><legend>Pago</legend>
        <label class="opt"><input type="radio" name="payment_method" value="tarjeta" checked><span>Tarjeta (simulado)<small>No se cobra nada, es una demostración</small></span></label>
        <label class="opt"><input type="radio" name="payment_method" value="transferencia"><span>Transferencia bancaria<small>La tarjeta se activa cuando confirmamos el pago</small></span></label></fieldset>
      <div class="pp-trap" aria-hidden="true"><label>Sitio web <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      ${errBox('')}
      <button type="submit" class="btn btn-lemon btn-block">Comprar tarjeta de regalo</button>
    </form>`}`;
}
const openGift = (tab = 'buy') => openX({ title: 'Tarjetas de regalo', body: giftForm(tab), wide: true });

function giftDone(card, amount) {
  return card.pending
    ? `<div class="x-empty"><span class="big-check">${icon('checkCircle', 44)}</span><h3 class="h">¡Listo! Tu tarjeta está reservada</h3><p class="muted">Haz la transferencia por <b>${money(card.amount)}</b> indicando la referencia <b>${esc(card.reference)}</b>. Cuando la confirmemos, activamos la tarjeta y te enviamos el código por correo.</p><button type="button" class="btn btn-lemon" data-close>Cerrar</button></div>`
    : `<div class="x-empty"><span class="big-check">${icon('checkCircle', 44)}</span><h3 class="h">¡Tu tarjeta está lista!</h3>
        <div class="gift-card-v"><p class="caption upper">${esc(BRAND.name)}</p><p class="gc-amount">${money(card.amount)}</p>${card.recipient_name ? `<p>Para ${esc(card.recipient_name)}</p>` : ''}${card.message ? `<p class="gc-msg">«${esc(card.message)}»</p>` : ''}<p class="gc-code" id="gc-code">${esc(card.code)}</p>${card.expires_at ? `<p class="caption">Válida hasta el ${esc(card.expires_at)}</p>` : ''}</div>
        <p class="muted">También te la enviamos por correo. Pega el código en la bolsa al pagar.</p>
        <div class="btn-row-x"><button type="button" class="btn btn-lemon" data-copy="${esc(card.code)}">Copiar código</button><button type="button" class="btn btn-outline" data-print-card>Imprimir</button></div></div>`;
}

// ─── Avísame cuando llegue ─────────────────────────────────────────────────
function renderNotify({ product, root }) {
  const slot = root?.querySelector('.notify-slot');
  if (!slot || !product) return;
  const out = product.variants.filter((v) => v.stock === 0);
  if (!out.length) { slot.innerHTML = ''; return; }
  const key = `${product.id}:${out.map((v) => v.id).join(',')}`;
  if (slot.dataset.key === key && slot.querySelector('form, .notify-done')) return; // ya dibujado: no se borra lo que el cliente va escribiendo
  slot.dataset.key = key;
  const c = acct.getCustomer();
  const all = out.length === product.variants.length;
  slot.innerHTML = `<details class="notify-box" ${all ? 'open' : ''}><summary>${all ? 'Agotado: avísame cuando llegue' : '¿No hay tu tamaño? Avísame cuando llegue'}</summary>
    <form class="x-form notify-form" data-notify="${product.id}" novalidate>
      ${out.length > 1 || !all ? `<label class="field"><span>Tamaño</span><select name="variant_id">${all && out.length > 1 ? '<option value="">Cualquier tamaño</option>' : ''}${out.map((v) => `<option value="${v.id}">${esc(sizeLabel(v.size_ml))}</option>`).join('')}</select></label>` : `<input type="hidden" name="variant_id" value="${out[0].id}">`}
      <fieldset class="opts opts-inline"><legend class="sr-only">Cómo avisarte</legend>
        <label class="opt"><input type="radio" name="channel" value="email" checked><span>Por correo</span></label>
        <label class="opt"><input type="radio" name="channel" value="whatsapp"><span>Por WhatsApp</span></label></fieldset>
      <label class="field"><span class="notify-label">Tu correo</span><input type="text" name="contact" required maxlength="120" value="${esc(c?.email || '')}" autocomplete="email"></label>
      <label class="chk notify-consent" hidden><input type="checkbox" name="consent"><span>Acepto que me escriban por WhatsApp solo para avisarme de este producto</span></label>
      <div class="pp-trap" aria-hidden="true"><label>Sitio web <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      ${errBox('')}
      <button type="submit" class="btn btn-outline btn-sm">Avísame</button>
    </form></details>`;
}

// ─── Eventos ───────────────────────────────────────────────────────────────
const X = { account: () => openAccount(), favorites: openFavorites, track: () => openTrack(), 'track-again': () => openTrack(), finder: openFinder, gift: () => openGift() };

function bind() {
  document.addEventListener('click', async (e) => {
    const t = e.target;
    const fav = t.closest('[data-fav]');
    if (fav) {
      e.preventDefault();
      const on = await acct.toggleFav(fav.dataset.fav);
      if (!acct.favIds().length || fav.closest('#x-dialog') ) { if ($('#x-dialog').open && $('#x-title').textContent === 'Mis favoritos') openFavorites(); }
      if (on) toast('Guardado en tus favoritos.');
      return;
    }
    const x = t.closest('[data-x]');
    if (x && X[x.dataset.x]) { e.preventDefault(); return X[x.dataset.x](); }
    if (t.closest('#fav-btn')) return openFavorites();
    if (t.closest('#acct-btn')) return openAccount();
    if (t.closest('#offer-x')) { $('#offer-bar').hidden = true; try { sessionStorage.setItem('aurelia-offers-off', '1'); } catch { /* ok */ } return; }
    if (t.closest('#x-close')) return closeX();
    if (t.closest('[data-xclose]')) { setTimeout(closeX, 0); return; } // el enlace cambia la dirección por sí solo
    const close = t.closest('#x-dialog [data-close]');
    if (close) { closeX(); if (close.dataset.go) document.querySelector(close.dataset.go)?.scrollIntoView(); return; }

    const auth = t.closest('[data-auth]');
    if (auth) return void ($('#x-body').innerHTML = authForm(auth.dataset.auth));
    if (t.closest('#acct-logout')) { acct.logout(); toast('Cerraste tu sesión.'); return closeX(); }
    const tc = t.closest('[data-track-code]');
    if (tc) return openTrack({ code: tc.dataset.trackCode });

    // buscador guiado
    const fd = t.closest('[data-fd]');
    if (fd) {
      finder.answers[finder.qs[finder.step].id] = fd.dataset.fd;
      if (finder.step + 1 < finder.qs.length) { finder.step += 1; return drawFinder(); }
      return finderResult();
    }
    if (t.closest('[data-fd-back]')) { finder.step = Math.max(0, finder.step - 1); return drawFinder(); }
    const fa = t.closest('[data-fd-add]') || t.closest('[data-fav-add]');
    if (fa) {
      const id = Number(fa.dataset.fdAdd || fa.dataset.favAdd);
      const p = (window.__finderProducts?.get(id)) || window.__favProducts?.get(id);
      const v = p?.variants.find((x) => x.stock > 0);
      if (!v) return toast('Ese producto no tiene existencias ahora.', 'error');
      window.dispatchEvent(new CustomEvent('aurelia:remember', { detail: { products: [p] } }));
      window.dispatchEvent(new CustomEvent('aurelia:add-to-cart', { detail: { variantId: v.id, qty: 1 } }));
      closeX();
      return void setTimeout(() => window.dispatchEvent(new Event('aurelia:open-cart')), 150);
    }

    // tarjetas de regalo
    const gt = t.closest('[data-gift-tab]');
    if (gt) return void ($('#x-body').innerHTML = giftForm(gt.dataset.giftTab));
    const chip = t.closest('#gift-chips [data-amount]');
    if (chip) { $('#gift-buy [name=amount]').value = chip.dataset.amount; document.querySelectorAll('#gift-chips .chip').forEach((c) => c.classList.toggle('is-active', c === chip)); return; }
    const copy = t.closest('[data-copy]');
    if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Código copiado.'); } catch { toast('Selecciona el código y cópialo.', 'error'); } return; }
    if (t.closest('[data-print-card]')) {
      const w = window.open('', '_blank', 'noopener,width=420,height=560');
      if (w) { w.document.write(`<!doctype html><title>Tarjeta de regalo</title><body style="font-family:system-ui;text-align:center;padding:24px">${$('.gift-card-v').outerHTML}</body>`); w.document.close(); w.focus(); w.print(); }
      return;
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.name === 'channel' && e.target.closest('.notify-form')) {
      const f = e.target.closest('form');
      const wa = e.target.value === 'whatsapp';
      f.querySelector('.notify-label').textContent = wa ? 'Tu número de WhatsApp' : 'Tu correo';
      f.querySelector('[name=contact]').placeholder = wa ? '507 6000-0000' : '';
      f.querySelector('.notify-consent').hidden = !wa;
      const c = acct.getCustomer();
      f.querySelector('[name=contact]').value = wa ? c?.phone || '' : c?.email || '';
    }
  });

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    const data = Object.fromEntries(new FormData(f));
    try {
      if (f.id === 'auth-form') {
        e.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.email || '').trim())) return showErr(f, 'Escribe un correo válido.');
        busy(btn, true, 'Un momento…');
        if (f.dataset.mode === 'register') await acct.register({ name: data.name, email: data.email, phone: data.phone, password: data.password, website: data.website });
        else await acct.login(data.email, data.password);
        toast(f.dataset.mode === 'register' ? '¡Cuenta creada! Ya puedes ver tus pedidos.' : 'Sesión iniciada.');
        await accountView();
      } else if (f.id === 'profile-form') {
        e.preventDefault();
        busy(btn, true, 'Guardando…');
        await acct.updateProfile({ name: data.name, phone: data.phone, notify_opt_in: f.elements.notify_opt_in.checked });
        toast('Datos guardados.');
        busy(btn, false);
        showErr(f, '');
      } else if (f.id === 'pass-form') {
        e.preventDefault();
        busy(btn, true, 'Cambiando…');
        await acct.changePassword(data.current, data.next);
        f.reset();
        toast('Contraseña cambiada. Se cerraron tus otras sesiones.');
        busy(btn, false);
        showErr(f, '');
      } else if (f.id === 'track-form') {
        e.preventDefault();
        const code = String(data.code || '').trim().toUpperCase();
        if (code) return void openTrack({ code });
        if (!data.order || !String(data.contact || '').trim()) return showErr(f, 'Escribe el código de seguimiento, o el número de pedido y el correo o teléfono.');
        openTrack({ order: data.order, contact: data.contact });
      } else if (f.id === 'gift-buy') {
        e.preventDefault();
        if (!(Number(data.amount) >= 5)) return showErr(f, 'Elige un monto de $5 a $1.000.');
        busy(btn, true, 'Procesando…');
        const card = await api('/api/gift-cards', { method: 'POST', token: null, body: { amount: data.amount, payment_method: data.payment_method, message: data.message, website: data.website, buyer: { name: data.buyer_name, email: data.buyer_email }, recipient: { name: data.recipient_name, email: data.recipient_email } } });
        $('#x-body').innerHTML = giftDone(card);
      } else if (f.id === 'gift-check') {
        e.preventDefault();
        busy(btn, true, 'Consultando…');
        const r = await api('/api/gift-cards/check', { method: 'POST', body: { code: data.code } });
        $('#gift-balance').innerHTML = `<p class="hint">Saldo: <b>${money(r.balance)}</b>${r.expires_at ? ` · vence el ${esc(r.expires_at)}` : ''}</p>`;
        showErr(f, '');
        busy(btn, false);
      } else if (f.classList.contains('notify-form')) {
        e.preventDefault();
        const wa = data.channel === 'whatsapp';
        if (wa && !phoneOk(data.contact)) return showErr(f, 'Escribe un número de WhatsApp válido.');
        if (wa && !f.elements.consent.checked) return showErr(f, 'Acepta que te escribamos por WhatsApp para avisarte.');
        if (!wa && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.contact || '').trim())) return showErr(f, 'Escribe un correo válido.');
        busy(btn, true, 'Guardando…');
        await api(`/api/products/${f.dataset.notify}/notify`, { method: 'POST', body: { variant_id: data.variant_id || null, channel: data.channel, contact: data.contact, consent: wa && f.elements.consent.checked, website: data.website } });
        f.closest('.notify-box').innerHTML = `<p class="notify-done">${icon('checkCircle', 18)} Listo: te avisamos ${wa ? 'por WhatsApp' : 'por correo'} apenas llegue.</p>`;
      }
    } catch (err) {
      if (btn) busy(btn, false);
      showErr(f, err instanceof ApiError ? err.message : 'No se pudo completar. Inténtalo de nuevo.');
    }
  });

  window.addEventListener('aurelia:account', refreshFavUI);
  window.addEventListener('aurelia:product-state', (e) => renderNotify(e.detail || {}));
  window.addEventListener('aurelia:fav-refresh', refreshFavUI);
  $('#x-dialog').addEventListener('close', () => { stopTrack(); if (/^#(seguimiento|pedido)\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search); });
  $('#x-dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'x-dialog') closeX(); });

  // Direcciones que abren el seguimiento: #seguimiento/CODIGO (avisos al cliente) y #pedido/CODIGO (al volver de la pasarela de pago).
  const fromHash = () => {
    const m = /^#(?:seguimiento|pedido)\/([A-Za-z0-9]{10})$/.exec(location.hash);
    if (m) openTrack({ code: m[1].toUpperCase() });
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();
  // Observa las tarjetas que se dibujan después (catálogo, recomendados) para marcar sus corazones.
  new MutationObserver(() => refreshFavUI()).observe($('main'), { childList: true, subtree: true });
}

(async function init() {
  $('#fav-icon').innerHTML = icon('heart', 18);
  $('#acct-icon').innerHTML = icon('user', 18);
  $('#x-close').innerHTML = icon('x', 22);
  bind();
  refreshFavUI();
  await acct.restore();
  refreshFavUI();
  loadOffers();
})();
