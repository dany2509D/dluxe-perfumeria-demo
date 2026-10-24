// Punto de venta: busca o escanea, arma el ticket con ofertas, cupón, tarjeta de regalo y descuento manual, cobra y entrega el recibo.
import { api, ApiError, money, num, esc, icon, productArt, tileColor, toast, sizeLabel } from './ui.js';
import { $, qs, debounce, attempt, openModal, kit } from './admin-kit.js';
import { showReceipt } from './admin-print.js';
import { beep, cameraScanSupported, scanWithCamera } from './admin-scan.js';

const pos = {
  q: '', lines: [], results: [], total: 0, pay: 'efectivo', customer: '', coupon: '', gift: '', discount: null, received: '',
  quote: null, quoteError: '', shift: null, requireShift: false,
};
let posReq = 0;
let quoteReq = 0;

const artOf = (v) => productArt({ image: v.image, color: v.color, id: v.product_id, name: v.name }, { title: v.name });
const posQty = (id) => pos.lines.find((l) => l.id === id)?.qty || 0;
const subtotal = () => Math.round(pos.lines.reduce((s, l) => s + l.v.price * l.qty, 0) * 100) / 100;
const due = () => (pos.quote ? pos.quote.due : subtotal());

async function renderPos() {
  if (kit.can('caja')) {
    const s = await api('/api/admin/shift');
    pos.shift = s.shift;
    pos.requireShift = s.require_shift;
  }
  const html = `
  <div class="pos">
    <section class="panel light">
      <div id="pos-shift"></div>
      <div class="pos-search">
        <label class="field"><span class="sr-only">Buscar producto</span>
          <input type="search" id="pos-q" placeholder="Busca por nombre o marca, o escanea el código y presiona Enter" autocomplete="off" value="${esc(pos.q)}"></label>
        ${cameraScanSupported() ? `<button type="button" class="btn btn-outline" data-act="pos-camera" title="Escanear con la cámara">${icon('scan', 18)} Cámara</button>` : ''}
      </div>
      <div class="pos-list" id="pos-list"></div>
    </section>
    <aside class="panel forest ticket" id="ticket" aria-label="Ticket de venta"></aside>
  </div>`;
  return {
    html,
    actions: kit.can('regalos') ? `<button type="button" class="btn btn-outline" data-act="sell-gift">${icon('gift', 18)} Vender tarjeta de regalo</button>` : '',
    after: () => { drawShift(); searchPos(); drawTicket(); requote(); $('#pos-q').focus(); },
  };
}

function drawShift() {
  const el = $('#pos-shift');
  if (!el) return;
  if (!kit.can('caja')) { el.innerHTML = ''; return; }
  const s = pos.shift;
  el.innerHTML = s
    ? `<p class="shift-bar ok">${icon('wallet', 16)} <span>Caja abierta desde las ${esc(s.opened_at.slice(11, 16))} · efectivo esperado <b>${money(s.totals.expected_cash)}</b></span> <a class="link-arrow" href="#caja">Ver caja</a></p>`
    : `<p class="shift-bar ${pos.requireShift ? 'warn' : ''}">${icon('wallet', 16)} <span>${pos.requireShift ? 'Abre tu caja para poder cobrar.' : 'No tienes una caja abierta: las ventas no quedarán en ningún turno.'}</span> <button type="button" class="btn btn-sm btn-outline" data-act="caja-open">Abrir caja</button></p>`;
}

async function searchPos() {
  const req = ++posReq;
  try {
    const r = await api(`/api/admin/inventory?${qs({ sellable: 1, limit: 40, sort: pos.q.trim() ? 'nombre' : 'stock-desc', q: pos.q.trim() })}`);
    if (req !== posReq || kit.view !== 'pos') return;
    pos.results = r.rows;
    pos.total = r.total;
    drawPosList();
  } catch (e) {
    if (req === posReq && $('#pos-list') && !(e instanceof ApiError && e.status === 401)) $('#pos-list').innerHTML = `<p class="empty-note">${esc(e.message)}</p>`;
  }
}
const searchPosSoon = debounce(searchPos, 220);

function drawPosList() {
  const list = $('#pos-list');
  if (!list) return;
  const rows = pos.results;
  const more = pos.total > rows.length ? `<p class="empty-note">Mostrando ${rows.length} de ${num(pos.total)}. Escribe para afinar la búsqueda.</p>` : '';
  list.innerHTML = rows.length
    ? rows
        .map((v) => {
          const left = v.stock - posQty(v.id);
          return `<button type="button" class="pos-item" data-act="pos-add" data-id="${v.id}" ${left <= 0 ? 'disabled' : ''}>
            <span class="pos-art" style="--tile:${tileColor(v.product_id)}">${artOf(v)}</span>
            <span class="who" style="display:grid"><b>${esc(v.name)} · ${sizeLabel(v.size_ml)}${v.is_set ? ' <span class="badge info">Set</span>' : ''}</b><span class="muted caption">${esc(v.sku)} · ${left <= 0 ? 'sin stock' : `${left} disp.`}</span></span>
            <strong>${money(v.price)}</strong></button>`;
        })
        .join('') + more
    : '<p class="empty-note">No hay productos que coincidan.</p>';
}

function drawTicket() {
  const el = $('#ticket');
  if (!el) return;
  const lines = pos.lines;
  const q = pos.quote;
  const pays = [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transf.']];
  const canDiscount = kit.can(['descuento_manual', 'descuento_libre']);
  const need = pos.requireShift && !pos.shift;
  const received = Number(pos.received);
  const change = pos.pay === 'efectivo' && received > 0 ? Math.round((received - due()) * 100) / 100 : null;
  el.innerHTML = `
    <div class="panel-head" style="margin:0"><h2>Ticket</h2>${lines.length ? '<button type="button" class="btn btn-sm btn-text" data-act="pos-clear">Vaciar</button>' : ''}</div>
    ${
      lines.length
        ? lines
            .map(
              (l) => `<div class="line"><div class="line-top"><div><p class="line-name">${esc(l.v.name)}${l.v.is_set ? ' <span class="badge info">Set</span>' : ''}</p><p class="caption upper muted">${sizeLabel(l.v.size_ml)} · ${money(l.v.price)}</p></div>
              <button type="button" class="icon-btn sm" data-act="pos-del" data-id="${l.id}" aria-label="Quitar ${esc(l.v.name)}">${icon('trash', 18)}</button></div>
              <div class="line-bottom"><div class="stepper" role="group" aria-label="Cantidad">
                <button type="button" data-act="pos-dec" data-id="${l.id}" aria-label="Menos" ${l.qty <= 1 ? 'disabled' : ''}>${icon('minus', 16)}</button><output>${l.qty}</output>
                <button type="button" data-act="pos-inc" data-id="${l.id}" aria-label="Más" ${l.qty >= l.v.stock ? 'disabled' : ''}>${icon('plus', 16)}</button></div>
              <strong>${money(l.v.price * l.qty)}</strong></div></div>`
            )
            .join('')
        : '<p class="ticket-empty">Agrega productos desde la lista o escanea un código.</p>'
    }
    ${
      lines.length
        ? `<div class="ticket-promo">
            <div class="grid-2">
              <label class="field"><span>Cupón</span><input type="text" id="pos-coupon" maxlength="24" value="${esc(pos.coupon)}" placeholder="Opcional" autocomplete="off"></label>
              <label class="field"><span>Tarjeta de regalo</span><input type="text" id="pos-gift" maxlength="24" value="${esc(pos.gift)}" placeholder="GC-XXXX-XXXX-XXXX" autocomplete="off"></label>
            </div>
            ${pos.quoteError ? `<p class="err-text caption" role="alert">${esc(pos.quoteError)}</p>` : ''}
            ${q?.coupon_note ? `<p class="caption muted">${esc(q.coupon_note)}</p>` : ''}
            ${canDiscount ? `<p><button type="button" class="btn btn-sm btn-outline" data-act="pos-discount">${icon('percent', 14)} ${pos.discount ? 'Cambiar descuento' : 'Descuento manual'}</button></p>` : ''}
          </div>`
        : ''
    }
    <div class="ticket-sum">
      ${q && q.discount > 0 ? `<div class="sum-line"><span>Subtotal</span><span>${money(q.subtotal)}</span></div>
        <div class="sum-line disc"><span>${esc(q.applied?.name || 'Descuento')}${pos.discount ? ` <button type="button" class="btn-link" data-act="pos-discount-clear">quitar</button>` : ''}</span><span>−${money(q.discount)}</span></div>` : ''}
      ${q?.gift ? `<div class="sum-line"><span>Tarjeta de regalo</span><span>−${money(q.gift.applied)}</span></div>` : ''}
      <div class="sum-row" style="display:flex;justify-content:space-between;align-items:baseline"><span class="caption upper muted">${q?.gift ? 'Resto a cobrar' : 'Total'}</span><strong class="h">${money(due())}</strong></div>
    </div>
    <fieldset class="opts" style="border:0;padding:0;margin:0"><legend class="sr-only">Método de pago</legend>
      ${pays.map(([v, t]) => `<label class="opt"><input type="radio" name="pos-pay" value="${v}" ${pos.pay === v ? 'checked' : ''}>${t}</label>`).join('')}
    </fieldset>
    ${pos.pay === 'efectivo' && due() > 0 ? `<label class="field"><span>Efectivo recibido (opcional)</span><input type="number" id="pos-received" min="0" step="0.01" inputmode="decimal" value="${esc(pos.received)}" placeholder="${money(due())}"><small>${change === null ? 'Calcula el vuelto.' : change >= 0 ? `Vuelto: <b>${money(change)}</b>` : `<span class="err-text">Faltan ${money(-change)}</span>`}</small></label>` : ''}
    <label class="field"><span>Cliente (opcional)</span><input type="text" id="pos-customer" maxlength="80" value="${esc(pos.customer)}" placeholder="Cliente mostrador"></label>
    <button type="button" class="btn btn-lemon btn-block" data-act="pos-pay" ${lines.length && !need && !pos.quoteError ? '' : 'disabled'}>Cobrar ${money(due())}</button>
    ${need ? '<p class="caption muted">Abre tu caja para cobrar.</p>' : ''}`;
}

// Pide al servidor el precio real (ofertas, cupón, descuento, tarjeta); si no hay nada especial, el total local basta.
async function requote() {
  const req = ++quoteReq;
  if (!pos.lines.length) { pos.quote = null; pos.quoteError = ''; return; }
  const body = { items: pos.lines.map((l) => ({ variant_id: l.id, qty: l.qty })), coupon: pos.coupon.trim(), gift_code: pos.gift.trim(), discount: pos.discount };
  try {
    const q = await api('/api/admin/pos/quote', { method: 'POST', body });
    if (req !== quoteReq) return;
    pos.quote = q;
    pos.quoteError = '';
  } catch (e) {
    if (req !== quoteReq || (e instanceof ApiError && e.status === 401)) return;
    pos.quoteError = e.message;
    try {
      pos.quote = await api('/api/admin/pos/quote', { method: 'POST', body: { items: body.items } });
    } catch { pos.quote = null; }
  }
  drawTicket();
}
const requoteSoon = debounce(requote, 350);

function posAdd(v) {
  if (!v || !v.active || !v.product_active) return false;
  const line = pos.lines.find((l) => l.id === v.id);
  if ((line?.qty || 0) >= v.stock) { toast(`No hay más stock de ${v.name} ${sizeLabel(v.size_ml)}`, 'error'); return false; }
  if (line) line.qty += 1;
  else pos.lines.push({ id: v.id, qty: 1, v });
  drawPosList();
  drawTicket();
  requote();
  return true;
}

// Un código (SKU o código de barras) agrega su producto al ticket. Devuelve false si no existe.
async function addByCode(code) {
  try {
    const v = await api(`/api/admin/lookup?code=${encodeURIComponent(code)}`);
    return posAdd(v) !== false;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return false;
    throw e;
  }
}

async function posPay() {
  const lines = pos.lines;
  if (!lines.length) return;
  const btn = document.querySelector('[data-act="pos-pay"]');
  if (btn) btn.disabled = true;
  try {
    const order = await api('/api/admin/pos/orders', {
      method: 'POST',
      body: {
        customer: { name: pos.customer.trim() || 'Cliente mostrador' },
        payment_method: pos.pay,
        items: lines.map((l) => ({ variant_id: l.id, qty: l.qty })),
        coupon: pos.coupon.trim() || undefined,
        gift_code: pos.gift.trim() || undefined,
        discount: pos.discount || undefined,
      },
    });
    const received = Number(pos.received);
    const paid = Math.round((order.total - order.gift_amount) * 100) / 100;
    const change = pos.pay === 'efectivo' && received > 0 ? Math.round((received - paid) * 100) / 100 : null;
    Object.assign(pos, { lines: [], customer: '', coupon: '', gift: '', discount: null, received: '', quote: null, quoteError: '' });
    if (order.replenished?.items) toast('Algo llegó al mínimo: se generó una orden de compra automática.');
    beep(true);
    openModal({
      title: `Venta #${order.id} cobrada`,
      body: `<div class="sale-done">
        <p class="kpi-value num">${money(order.total)}</p>
        <p class="muted">${order.discount ? `Incluye ${money(order.discount)} de descuento${order.promo_label ? ` (${esc(order.promo_label)})` : ''}. ` : ''}${order.gift_amount ? `Pagado con tarjeta de regalo: ${money(order.gift_amount)}. ` : ''}El stock ya se descontó.</p>
        ${change !== null && change >= 0 ? `<p class="change-box">Vuelto: <b>${money(change)}</b></p>` : ''}
      </div>`,
      closeLabel: 'Nueva venta',
      extraFoot: `<button type="button" class="btn btn-lemon" data-act="pos-receipt" data-id="${order.id}">${icon('printer', 16)} Imprimir recibo</button>`,
    });
    if (pos.shift) {
      const s = await api('/api/admin/shift').catch(() => null);
      if (s) pos.shift = s.shift;
    }
  } catch (e) {
    toast(e.message, 'error');
  }
  await searchPos();
  drawShift();
  drawTicket();
}

function discountDialog() {
  const cap = pos.quote?.max_discount_pct ?? 10;
  openModal({
    title: 'Descuento manual',
    submit: 'Aplicar descuento',
    body: `<p class="hint">Reemplaza las ofertas y cupones de esta venta. ${cap < 100 ? `Tu rol permite hasta <b>${cap}%</b>; para más, pide a un gerente.` : 'Sin tope para tu rol.'} Queda anotado en la bitácora.</p>
      <div class="grid-2">
        <label class="field"><span>Tipo</span><select name="type"><option value="percent" ${pos.discount?.type !== 'fixed' ? 'selected' : ''}>Porcentaje (%)</option><option value="fixed" ${pos.discount?.type === 'fixed' ? 'selected' : ''}>Monto ($)</option></select></label>
        <label class="field"><span>Valor</span><input type="number" name="value" min="0.01" step="0.01" required value="${pos.discount?.value ?? ''}"></label>
      </div>
      <label class="field"><span>Motivo</span><input type="text" name="reason" required maxlength="60" value="${esc(pos.discount?.reason || '')}" placeholder="Cliente frecuente, producto con detalle…"></label>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      const before = { discount: pos.discount, coupon: pos.coupon };
      pos.discount = { type: f.get('type'), value: Number(f.get('value')), reason: String(f.get('reason')).trim() };
      pos.coupon = '';
      await requote();
      if (pos.quoteError) {
        // El servidor no lo aceptó (por ejemplo, pasa del tope del rol): se deja todo como estaba, cupón incluido.
        const msg = pos.quoteError;
        Object.assign(pos, before, { quoteError: '' });
        await requote();
        throw new ApiError(400, msg);
      }
    },
  });
}

kit.add({
  nav: { id: 'pos', label: 'Punto de venta', icon: 'register', perm: 'pos', group: 'Venta', order: 10 },
  views: { pos: { title: 'Punto de venta', kicker: 'Ventas de mostrador', render: renderPos } },
  actions: {
    'pos-add': (el) => posAdd(pos.results.find((v) => v.id === Number(el.dataset.id))),
    'pos-inc': (el) => posAdd(pos.lines.find((l) => l.id === Number(el.dataset.id))?.v),
    'pos-dec': (el) => { const l = pos.lines.find((x) => x.id === Number(el.dataset.id)); if (l && l.qty > 1) l.qty -= 1; drawPosList(); drawTicket(); requote(); },
    'pos-del': (el) => { pos.lines = pos.lines.filter((x) => x.id !== Number(el.dataset.id)); drawPosList(); drawTicket(); requote(); },
    'pos-clear': () => { Object.assign(pos, { lines: [], coupon: '', gift: '', discount: null, received: '', quote: null, quoteError: '' }); drawPosList(); drawTicket(); },
    'pos-pay': () => posPay(),
    'pos-discount': discountDialog,
    'pos-discount-clear': () => { pos.discount = null; requote(); },
    'pos-camera': () => scanWithCamera(addByCode),
    'pos-receipt': (el) => attempt(async () => showReceipt(await api(`/api/admin/orders/${el.dataset.id}/receipt`))),
  },
});
kit.onReset = () => Object.assign(pos, { lines: [], coupon: '', gift: '', discount: null, quote: null, quoteError: '' });
kit.posRefreshShift = async () => { const s = await api('/api/admin/shift').catch(() => null); if (s) { pos.shift = s.shift; drawShift(); drawTicket(); } };

document.addEventListener('input', (e) => {
  if (e.target.id === 'pos-q') { pos.q = e.target.value; searchPosSoon(); }
  if (e.target.id === 'pos-customer') pos.customer = e.target.value;
  if (e.target.id === 'pos-received') {
    pos.received = e.target.value;
    const small = e.target.parentElement.querySelector('small');
    const r = Number(pos.received);
    const ch = Math.round((r - due()) * 100) / 100;
    if (small) small.innerHTML = !(r > 0) ? 'Calcula el vuelto.' : ch >= 0 ? `Vuelto: <b>${money(ch)}</b>` : `<span class="err-text">Faltan ${money(-ch)}</span>`;
  }
  if (e.target.id === 'pos-coupon') { pos.coupon = e.target.value.toUpperCase(); if (pos.discount) pos.discount = null; requoteSoon(); }
  if (e.target.id === 'pos-gift') { pos.gift = e.target.value.toUpperCase(); requoteSoon(); }
});
document.addEventListener('change', (e) => {
  if (e.target.name === 'pos-pay') { pos.pay = e.target.value; drawTicket(); }
});

// Lector de códigos: el escáner escribe el código y termina con Enter.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'pos-q') return;
  e.preventDefault();
  const input = e.target;
  const q = pos.q.trim();
  if (!q) return;
  attempt(async () => {
    const looksLikeCode = !/\s/.test(q) && q.length >= 4;
    if (looksLikeCode && (await addByCode(q))) {
      beep(true);
      pos.q = '';
      input.value = '';
      return searchPos();
    }
    const r = await api(`/api/admin/inventory?${qs({ sellable: 1, limit: 10, q })}`);
    const pick = r.rows.length === 1 ? r.rows[0] : null;
    if (!pick) {
      beep(false);
      return toast(r.rows.length ? 'Hay varias coincidencias: elige una de la lista.' : `No hay ningún producto con «${q}».`, 'error');
    }
    posAdd(pick);
    beep(true);
    pos.q = '';
    input.value = '';
    searchPos();
  });
});
