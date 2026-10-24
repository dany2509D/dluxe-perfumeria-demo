// Tarjetas de regalo: venta en el mostrador, consulta de saldo y movimientos, activar las que esperan una transferencia, anular.
import { api, money, esc, icon, toast, fmtDateTime } from './ui.js';
import { $, attempt, pagerHTML, debounce, openModal, kit } from './admin-kit.js';
import { showGiftCard } from './admin-print.js';

const state = { q: '', status: '', page: 1 };
const brandName = () => (window.__BRAND?.name || 'Tienda');
const BADGE = { activa: ['ok', 'Activa'], pendiente: ['low', 'Espera pago'], anulada: ['danger', 'Anulada'] };
const badge = (c) => (c.status === 'activa' && c.balance === 0 ? '<span class="badge">Agotada</span>' : c.expired ? '<span class="badge danger">Vencida</span>' : `<span class="badge ${BADGE[c.status]?.[0] || ''}">${BADGE[c.status]?.[1] || esc(c.status)}</span>`);

async function fetchCards() {
  const q = new URLSearchParams({ page: state.page, ...(state.q ? { q: state.q } : {}), ...(state.status ? { status: state.status } : {}) });
  return api(`/api/admin/gift-cards?${q}`);
}

function tableHTML(d) {
  return d.rows.length
    ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Código</th><th>Estado</th><th class="r">Monto</th><th class="r">Saldo</th><th>Comprador</th><th>Para</th><th>Creada</th><th>Vence</th><th></th></tr></thead><tbody>
      ${d.rows.map((c) => `<tr><td class="nowrap"><b>${esc(c.code)}</b>${c.source === 'nota_credito' ? '<span class="sub-line">nota de crédito</span>' : c.source === 'manual' ? '<span class="sub-line">de ejemplo</span>' : ''}</td><td>${badge(c)}</td>
        <td class="r">${money(c.initial_amount)}</td><td class="r"><b>${money(c.balance)}</b></td><td>${esc(c.buyer_name || '—')}${c.buyer_email ? `<span class="sub-line">${esc(c.buyer_email)}</span>` : ''}</td><td>${esc(c.recipient_name || '—')}</td>
        <td class="nowrap">${esc(fmtDateTime(c.created_at))}</td><td class="nowrap">${esc(c.expires_at || '—')}</td>
        <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="gift-view" data-id="${c.id}">Ver</button>
          ${c.status === 'pendiente' ? `<button type="button" class="btn btn-sm btn-solid" data-act="gift-activate" data-id="${c.id}">Activar</button>` : ''}</div></td></tr>`).join('')}
      </tbody></table></div>${pagerHTML(d, 'pg-gift')}`
    : '<p class="empty-note">No hay tarjetas con ese filtro.</p>';
}

async function renderGifts() {
  const d = await fetchCards();
  state.page = d.page;
  const filters = [['', 'Todas'], ['activa', 'Activas'], ['pendiente', 'Esperan pago'], ['anulada', 'Anuladas']];
  const html = `
  <div class="row cols-3">
    <section class="panel light kpi"><p class="label">Saldo por usar</p><p class="kpi-value num">${money(d.outstanding)}</p><p class="kpi-sub">${d.active_count} ${d.active_count === 1 ? 'tarjeta activa' : 'tarjetas activas'}. Es dinero que ya cobraste y todavía debes en mercancía.</p></section>
  </div>
  <section class="panel light">
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar tarjeta</span><input type="search" id="gift-q" placeholder="Código, comprador o destinatario" value="${esc(state.q)}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Estado">${filters.map(([v, t]) => `<button type="button" class="seg-btn ${state.status === v ? 'is-active' : ''}" data-act="gift-filter" data-status="${v}">${t}</button>`).join('')}</div>
    </div>
    <div id="gift-table">${tableHTML(d)}</div>
  </section>`;
  return { html, actions: `<button type="button" class="btn btn-lemon" data-act="sell-gift">${icon('gift', 18)} Vender tarjeta</button>` };
}

async function detail(id) {
  const c = await api(`/api/admin/gift-cards/${id}`);
  const kinds = { canje: 'Pago de pedido', reverso: 'Devuelto por cancelación', ajuste: 'Ajuste' };
  openModal({
    title: `Tarjeta ${c.code}`,
    closeLabel: 'Cerrar',
    extraFoot: `${c.status === 'activa' ? `<button type="button" class="btn btn-outline" data-act="gift-print" data-id="${c.id}">${icon('printer', 16)} Imprimir tarjeta</button>` : ''}
      ${c.status !== 'anulada' ? `<button type="button" class="btn btn-outline" data-act="gift-void" data-id="${c.id}">Anular</button>` : ''}`,
    body: `<div class="grid-3 order-info">
        <div><p class="label">Saldo</p><p class="kpi-value num">${money(c.balance)}</p><p class="muted">de ${money(c.initial_amount)}</p></div>
        <div><p class="label">Comprador</p><p>${esc(c.buyer_name || '—')}</p>${c.buyer_email ? `<p class="muted">${esc(c.buyer_email)}</p>` : ''}${c.payment_method ? `<p class="muted caption">Pagó con ${esc(c.payment_method)}</p>` : ''}</div>
        <div><p class="label">Para</p><p>${esc(c.recipient_name || '—')}</p>${c.recipient_email ? `<p class="muted">${esc(c.recipient_email)}</p>` : ''}<p class="muted caption">Vence ${esc(c.expires_at || '—')}</p></div>
      </div>
      ${c.message ? `<p class="hint">«${esc(c.message)}»</p>` : ''}
      <h3 class="sub">Movimientos</h3>
      ${c.uses.length ? `<ul class="list">${c.uses.map((u) => `<li><div class="who"><b>${kinds[u.kind] || u.kind}${u.order_id ? ` · pedido <a href="#pedidos/${u.order_id}" data-modal-close>#${u.order_id}</a>` : ''}</b><span>${esc(fmtDateTime(u.created_at))}</span></div><strong class="${u.kind === 'canje' ? 'minus' : 'plus'}">${u.kind === 'canje' ? '−' : '+'}${money(u.amount)}</strong></li>`).join('')}</ul>` : '<p class="muted">Todavía no se ha usado.</p>'}`,
  });
}

export function sellGiftDialog() {
  openModal({
    title: 'Vender tarjeta de regalo',
    submit: 'Cobrar y emitir',
    body: `<div class="field"><span>Monto</span><div class="chips" id="gift-amounts">${[25, 50, 100, 150].map((n) => `<button type="button" class="chip" data-amount="${n}">${money(n)}</button>`).join('')}</div>
        <input type="number" name="amount" min="5" max="1000" step="0.01" required placeholder="Otro monto ($5 a $1.000)" inputmode="decimal"></div>
      <div class="grid-2">
        <label class="field"><span>Quién compra</span><input type="text" name="buyer_name" maxlength="80" placeholder="Opcional"></label>
        <label class="field"><span>Correo de quien compra</span><input type="email" name="buyer_email" maxlength="120" placeholder="Para enviarle el código"></label>
        <label class="field"><span>Para quién es</span><input type="text" name="recipient_name" maxlength="80" placeholder="Opcional"></label>
        <label class="field"><span>Correo de quien recibe</span><input type="email" name="recipient_email" maxlength="120" placeholder="Opcional"></label>
      </div>
      <label class="field"><span>Mensaje</span><input type="text" name="message" maxlength="240" placeholder="¡Feliz cumpleaños!"></label>
      <fieldset class="opts" style="border:0;padding:0;margin:0"><legend class="label">Pago</legend>
        ${[['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia']].map(([v, t], i) => `<label class="opt"><input type="radio" name="payment_method" value="${v}" ${i === 0 ? 'checked' : ''}>${t}</label>`).join('')}
      </fieldset>`,
    onOpen: (dlg) => {
      const amount = dlg.querySelector('input[name=amount]');
      dlg.querySelector('#gift-amounts').addEventListener('click', (e) => {
        const b = e.target.closest('[data-amount]');
        if (!b) return;
        amount.value = b.dataset.amount;
        dlg.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === b));
      });
      amount.focus();
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const card = await api('/api/admin/gift-cards', {
        method: 'POST',
        body: { amount: f.get('amount'), payment_method: f.get('payment_method'), message: f.get('message'), buyer: { name: f.get('buyer_name'), email: f.get('buyer_email') }, recipient: { name: f.get('recipient_name'), email: f.get('recipient_email') } },
      });
      toast(`Tarjeta ${card.code} emitida por ${money(card.initial_amount)}.`);
      if (kit.view === 'regalos') kit.refresh();
      kit.posRefreshShift?.();
      setTimeout(() => showGiftCard(card, brandName()), 0);
    },
  });
}

kit.add({
  nav: { id: 'regalos', label: 'Tarjetas de regalo', icon: 'gift', perm: 'regalos', group: 'Venta', order: 40 },
  views: { regalos: { title: 'Tarjetas de regalo', kicker: 'Venta, saldo y movimientos', render: renderGifts } },
  actions: {
    'sell-gift': sellGiftDialog,
    'gift-filter': (el) => { state.status = el.dataset.status; state.page = 1; kit.refresh(); },
    'pg-gift': (el) => { state.page = Number(el.dataset.page); kit.refresh(); },
    'gift-view': (el) => attempt(() => detail(Number(el.dataset.id))),
    'gift-print': (el) => attempt(async () => showGiftCard(await api(`/api/admin/gift-cards/${el.dataset.id}`), brandName())),
    'gift-activate': (el) => attempt(async () => {
      if (!confirm('¿Confirmas que ya recibiste el pago? La tarjeta quedará activa y se enviará el código.')) return;
      await api(`/api/admin/gift-cards/${el.dataset.id}/status`, { method: 'POST', body: { status: 'activa' } });
      toast('Tarjeta activada.');
      kit.refresh();
    }),
    'gift-void': (el) => attempt(async () => {
      if (!confirm('¿Anular esta tarjeta? Dejará de poder usarse y no se puede deshacer.')) return;
      await api(`/api/admin/gift-cards/${el.dataset.id}/status`, { method: 'POST', body: { status: 'anulada' } });
      toast('Tarjeta anulada.');
      kit.refresh();
      if ($('#modal')?.open) await detail(Number(el.dataset.id));
    }),
  },
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'gift-q') { state.q = e.target.value.trim(); state.page = 1; soon(); }
});
const soon = debounce(() => attempt(async () => { const box = $('#gift-table'); if (box) box.innerHTML = tableHTML(await fetchCards()); }), 350);
