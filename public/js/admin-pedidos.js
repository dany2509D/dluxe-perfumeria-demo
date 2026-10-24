// Pedidos: lista con filtros, ficha completa (historial, pagos, facturas, devoluciones), avance de la entrega y devoluciones.
import { api, money, num, esc, icon, toast, fmtDateTime, sizeLabel } from './ui.js';
import { $, attempt, pagerHTML, debounce, openModal, kit } from './admin-kit.js';
import { showReceipt, showGiftCard } from './admin-print.js';

const state = { status: '', q: '', tab: 'pedidos', retPage: 1 };
const brandName = () => (window.__BRAND?.name || 'Tienda');

const PAY = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', contra_entrega: 'Contra entrega', tarjeta_regalo: 'Tarjeta de regalo' };
const STATUS = { pendiente_pago: ['low', 'Esperando pago'], pagado: ['info', 'Pagado'], entregado: ['ok', 'Entregado'], cancelado: ['danger', 'Cancelado'] };
export const orderBadge = (s) => `<span class="badge ${STATUS[s]?.[0] || ''}">${esc(STATUS[s]?.[1] || s)}</span>`;
const METHODS = { efectivo: 'Efectivo de la caja', metodo_original: 'Al mismo método de pago (se hace aparte, en el banco)', nota_credito: 'Nota de crédito (tarjeta de regalo)' };

async function renderOrders() {
  const tabs = `<div class="seg" role="tablist" aria-label="Sección">
    <button type="button" class="seg-btn ${state.tab === 'pedidos' ? 'is-active' : ''}" data-act="ord-tab" data-tab="pedidos" role="tab" aria-selected="${state.tab === 'pedidos'}">Pedidos</button>
    ${kit.can('devoluciones') ? `<button type="button" class="seg-btn ${state.tab === 'devoluciones' ? 'is-active' : ''}" data-act="ord-tab" data-tab="devoluciones" role="tab" aria-selected="${state.tab === 'devoluciones'}">Devoluciones</button>` : ''}
  </div>`;
  const after = () => { if (kit.arg && /^\d+$/.test(kit.arg)) { const id = kit.arg; kit.arg = ''; history.replaceState(null, '', '#pedidos'); attempt(() => detailDialog(Number(id))); } };
  if (state.tab === 'devoluciones' && kit.can('devoluciones')) {
    const d = await api(`/api/admin/returns?page=${state.retPage}`);
    const html = `<section class="panel light">${tabs}
      ${d.rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Fecha</th><th>Pedido</th><th>Cliente</th><th>Motivo</th><th>Forma</th><th class="r">Unid.</th><th class="r">Monto</th><th>Atendió</th></tr></thead><tbody>
        ${d.rows.map((r) => `<tr><td><b>#${r.id}</b></td><td class="nowrap">${esc(fmtDateTime(r.created_at))}</td><td><a href="#pedidos/${r.order_id}">#${r.order_id}</a></td><td>${esc(r.customer_name)}</td><td class="rev-text">${esc(r.reason)}</td>
          <td>${esc(METHODS[r.refund_method]?.split(' (')[0] || r.refund_method)}${r.credit_code ? `<span class="sub-line">${esc(r.credit_code)}</span>` : ''}</td><td class="r">${r.units}</td><td class="r"><b>${money(r.amount)}</b></td><td>${esc(r.user_name)}</td></tr>`).join('')}
        </tbody></table></div>${pagerHTML(d, 'pg-ret')}` : '<p class="empty-note">Todavía no hay devoluciones.</p>'}</section>`;
    return { html, after };
  }
  const orders = await fetchOrders();
  const filters = [['', 'Todos'], ['pendiente_pago', 'Esperando pago'], ['pagado', 'Por entregar'], ['entregado', 'Entregados'], ['cancelado', 'Cancelados']];
  const html = `<section class="panel light">
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar pedido</span><input type="search" id="ord-q" placeholder="Número, cliente, correo o código de seguimiento" value="${esc(state.q)}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Filtrar por estado" id="ord-filter">${filters.map(([v, t]) => `<button type="button" class="seg-btn ${state.status === v ? 'is-active' : ''}" data-act="ord-filter" data-status="${v}" aria-pressed="${state.status === v}">${t}</button>`).join('')}</div>
    </div>
    ${tabs.includes('devoluciones') ? tabs : ''}
    <div id="ord-table">${tableHTML(orders)}</div></section>`;
  return { html, after };
}

const fetchOrders = () => api(`/api/admin/orders?${new URLSearchParams({ limit: 200, ...(state.status ? { status: state.status } : {}), ...(state.q ? { q: state.q } : {}) })}`);

function tableHTML(orders) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Fecha</th><th>Canal</th><th>Cliente</th><th>Productos</th><th>Pago</th><th class="r">Total</th><th>Estado</th><th></th></tr></thead><tbody>
    ${orders.map((o) => {
      const first = o.items[0];
      const more = o.items.length - 1;
      return `<tr><td class="nowrap"><b>#${o.id}</b></td><td class="nowrap">${esc(fmtDateTime(o.created_at))}</td>
        <td><span class="badge">${o.channel === 'online' ? 'Online' : 'Mostrador'}</span></td>
        <td><span class="name">${esc(o.customer_name)}</span>${o.delivery ? `<span class="sub-line">${o.delivery === 'envio' ? 'Envío' : 'Retiro en tienda'}</span>` : ''}</td>
        <td title="${esc(o.items.map((i) => `${i.qty}× ${i.name} ${sizeLabel(i.size_ml)}`).join(', '))}">${first ? `${first.qty}× ${esc(first.name)} ${sizeLabel(first.size_ml)}` : ''}${more > 0 ? ` <span class="muted">+${more} más</span>` : ''}</td>
        <td>${esc(PAY[o.payment_method] || o.payment_method)}</td><td class="r nowrap"><b>${money(o.total)}</b>${o.discount ? `<span class="sub-line">−${money(o.discount)} desc.</span>` : ''}${o.refunded ? `<span class="sub-line minus">devuelto ${money(o.refunded)}</span>` : ''}</td><td>${orderBadge(o.status)}</td>
        <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="ord-view" data-id="${o.id}">Ver</button>${o.status === 'pagado' ? `<button type="button" class="btn btn-sm btn-outline" data-act="deliver" data-id="${o.id}">Entregado</button>` : ''}</div></td></tr>`;
    }).join('')}</tbody></table></div>${orders.length ? '' : '<p class="empty-note">No hay pedidos con ese filtro.</p>'}`;
}

const timelineHTML = (events) => events.length
  ? `<ol class="timeline">${events.map((e) => `<li><b>${esc({ recibido: 'Pedido recibido', pago_pendiente: 'Esperando el pago', pago_confirmado: 'Pago confirmado', preparando: 'Preparando', listo: 'Listo para retirar', enviado: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado', devolucion: 'Devolución' }[e.kind] || e.kind)}</b><span>${esc(fmtDateTime(e.created_at))}${e.user_name ? ` · ${esc(e.user_name)}` : ''}${e.note ? ` · ${esc(e.note)}` : ''}</span></li>`).join('')}</ol>`
  : '<p class="muted">Sin movimientos registrados.</p>';

async function detailDialog(id) {
  const o = await api(`/api/admin/orders/${id}`);
  const done = new Set(o.events.map((e) => e.kind));
  const seenSets = new Set();
  const itemRows = o.items.map((i) => {
    const head = i.bundle_variant_id && !seenSets.has(i.bundle_variant_id) ? (seenSets.add(i.bundle_variant_id), `<tr class="set-head"><td colspan="5"><b>${esc(i.bundle_name || 'Set de regalo')}</b> × ${i.bundle_units || 1}</td></tr>`) : '';
    return `${head}<tr><td>${i.bundle_variant_id ? '<span class="muted">└</span> ' : ''}${esc(i.name)} <span class="muted">${sizeLabel(i.size_ml)}</span><span class="sub-line">${esc(i.sku)}</span></td><td class="r">${i.qty}</td><td class="r">${money(i.unit_price)}</td><td class="r">${money(i.unit_price * i.qty)}</td><td class="r">${i.returned_qty ? `<span class="minus">${i.returned_qty}</span>` : '—'}</td></tr>`;
  }).join('');
  const nextSteps = o.channel === 'online' && o.status === 'pagado' ? (o.delivery === 'envio' ? ['preparando', 'enviado'] : ['preparando', 'listo']).filter((s) => !done.has(s)) : [];
  const stepLabel = { preparando: 'Preparando', listo: 'Listo para retirar', enviado: 'En camino' };
  const foot = [
    `<button type="button" class="btn btn-outline" data-act="ord-receipt" data-id="${o.id}">${icon('printer', 16)} Recibo</button>`,
    ...(kit.can('pedidos') ? nextSteps.map((s) => `<button type="button" class="btn btn-outline" data-act="ord-step" data-id="${o.id}" data-step="${s}">${stepLabel[s]}</button>`) : []),
    ...(o.status === 'pagado' && kit.can('pedidos') ? [`<button type="button" class="btn btn-solid" data-act="deliver" data-id="${o.id}">Marcar entregado</button>`] : []),
    ...(['pagado', 'pendiente_pago'].includes(o.status) && kit.can('pedidos_cancelar') ? [`<button type="button" class="btn btn-outline" data-act="cancel-order" data-id="${o.id}">Cancelar pedido</button>`] : []),
    ...(['pagado', 'entregado'].includes(o.status) && kit.can('devoluciones') ? [`<button type="button" class="btn btn-lemon" data-act="ord-return" data-id="${o.id}">${icon('undo', 16)} Devolver</button>`] : []),
  ].join('');
  openModal({
    title: `Pedido #${o.id}`,
    wide: true,
    closeLabel: 'Cerrar',
    extraFoot: foot,
    body: `<div class="order-head">${orderBadge(o.status)} <span class="muted">${esc(fmtDateTime(o.created_at))} · ${o.channel === 'online' ? 'Tienda en línea' : 'Mostrador'}${o.user_name ? ` · atendió ${esc(o.user_name)}` : ''}</span></div>
      <div class="grid-3 order-info">
        <div><p class="label">Cliente</p><p>${esc(o.customer_name)}</p>${o.customer_email ? `<p class="muted">${esc(o.customer_email)}</p>` : ''}${o.customer_phone ? `<p class="muted">${esc(o.customer_phone)}${o.notify_opt_in ? ' · acepta WhatsApp' : ''}</p>` : ''}</div>
        <div><p class="label">Entrega</p><p>${o.delivery === 'envio' ? 'Envío a domicilio' : o.delivery === 'retiro' ? 'Retiro en tienda' : '—'}</p>${o.address ? `<p class="muted">${esc(o.address)}</p>` : ''}${o.tracking_code ? `<p class="muted caption">Seguimiento: ${esc(o.tracking_code)}</p>` : ''}</div>
        <div><p class="label">Pago</p><p>${esc(PAY[o.payment_method] || o.payment_method)}</p>${o.gift_amount ? `<p class="muted">Tarjeta de regalo: ${money(o.gift_amount)}</p>` : ''}${o.payments.map((p) => `<p class="muted caption">${esc(p.provider)} · ${esc(p.status)}</p>`).join('')}</div>
      </div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Precio</th><th class="r">Importe</th><th class="r">Devuelto</th></tr></thead><tbody>${itemRows}</tbody>
        <tfoot><tr><td colspan="3" class="r">Subtotal</td><td class="r">${money(o.subtotal)}</td><td></td></tr>
        ${o.discount ? `<tr><td colspan="3" class="r">Descuento${o.promo_label ? ` · ${esc(o.promo_label)}` : ''}</td><td class="r">−${money(o.discount)}</td><td></td></tr>` : ''}
        <tr><td colspan="3" class="r"><b>Total</b></td><td class="r"><b>${money(o.total)}</b></td><td></td></tr>
        ${o.refunded ? `<tr><td colspan="3" class="r">Devuelto</td><td class="r minus">−${money(o.refunded)}</td><td></td></tr>` : ''}</tfoot></table></div>
      <div class="grid-2">
        <div><h3 class="sub">Historial</h3>${timelineHTML(o.events)}</div>
        <div><h3 class="sub">Documentos</h3>${o.documents.length ? `<ul class="list">${o.documents.map((d) => `<li><div class="who"><b>${d.kind === 'factura' ? 'Factura' : 'Nota de crédito'} ${esc(d.number || '(pendiente)')}</b><span>${esc(d.provider)} · ${esc(d.status)}</span></div><strong>${money(d.amount)}</strong></li>`).join('')}</ul>` : '<p class="muted">Sin documentos fiscales.</p>'}
          ${o.returns.length ? `<h3 class="sub" style="margin-top:14px">Devoluciones</h3><ul class="list">${o.returns.map((r) => `<li><div class="who"><b>${money(r.amount)} · ${esc(METHODS[r.refund_method]?.split(' (')[0] || r.refund_method)}</b><span>${esc(r.reason)}${r.credit_code ? ` · ${esc(r.credit_code)}` : ''}</span></div></li>`).join('')}</ul>` : ''}</div>
      </div>`,
  });
}

async function returnDialog(id) {
  const info = await api(`/api/admin/orders/${id}/returnable`);
  const rows = info.items.filter((i) => i.available > 0);
  const canOverride = kit.can('descuento_libre');
  openModal({
    title: `Devolución · pedido #${id}`,
    wide: true,
    submit: 'Registrar devolución',
    body: `<p class="hint">${info.in_window ? `Dentro del plazo (${info.days_since} de ${info.window_days} días).` : `<b>Fuera de plazo:</b> pasaron ${info.days_since} días y el plazo es de ${info.window_days}.`} Se devuelve lo que el cliente pagó${info.order.gift_amount ? ' (pagó con tarjeta de regalo: solo se devuelve como nota de crédito)' : ''}. Máximo a devolver: ${money(info.refundable)}.</p>
      <div class="tbl-wrap"><table class="tbl" id="ret-table"><thead><tr><th>Producto</th><th class="r">Reintegro c/u</th><th class="r">Disponible</th><th class="r">Devuelve</th><th>Vuelve al inventario</th></tr></thead><tbody>
        ${rows.map((i) => `<tr data-item="${i.id}" data-refund="${i.unit_refund}"><td>${i.bundle_variant_id ? '<span class="muted">└ set</span> ' : ''}${esc(i.name)} <span class="muted">${sizeLabel(i.size_ml)}</span></td><td class="r">${money(i.unit_refund)}</td><td class="r">${i.available}</td>
          <td class="r"><input type="number" class="ret-qty" min="0" max="${i.available}" value="0" step="1" style="width:78px"></td><td><label class="chk"><input type="checkbox" class="ret-restock" checked><span>Sí</span></label></td></tr>`).join('')}
      </tbody></table></div>
      <div class="grid-2">
        <label class="field"><span>Motivo</span><input type="text" name="reason" required maxlength="160" list="ret-reasons" placeholder="Elige o escribe el motivo"><datalist id="ret-reasons"><option value="Cambió de opinión"><option value="Producto defectuoso o dañado"><option value="Fragancia equivocada"><option value="Regalo repetido"><option value="Error en el pedido"></datalist></label>
        <label class="field"><span>Cómo se devuelve el dinero</span><select name="method">${info.allowed_methods.map((m) => `<option value="${m}">${esc(METHODS[m])}</option>`).join('')}</select></label>
      </div>
      ${!info.in_window && canOverride ? '<label class="chk"><input type="checkbox" name="override"><span>Autorizar fuera de plazo (queda anotado en la bitácora)</span></label>' : ''}
      <p class="sum-row" style="display:flex;justify-content:space-between;align-items:baseline"><span class="caption upper muted">Total a devolver</span><strong class="h" id="ret-total">${money(0)}</strong></p>`,
    onOpen: (dlg) => {
      const calc = () => {
        let t = 0;
        dlg.querySelectorAll('#ret-table tbody tr').forEach((tr) => { t += Number(tr.dataset.refund) * (Number(tr.querySelector('.ret-qty').value) || 0); });
        dlg.querySelector('#ret-total').textContent = money(Math.min(t, info.refundable));
      };
      dlg.querySelector('#ret-table').addEventListener('input', calc);
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const items = [...form.querySelectorAll('#ret-table tbody tr')]
        .map((tr) => ({ order_item_id: Number(tr.dataset.item), qty: Number(tr.querySelector('.ret-qty').value) || 0, restock: tr.querySelector('.ret-restock').checked }))
        .filter((i) => i.qty > 0);
      if (!items.length) throw new Error('Indica cuántas unidades se devuelven.');
      const r = await api(`/api/admin/orders/${id}/returns`, { method: 'POST', body: { items, reason: f.get('reason'), refund_method: f.get('method'), override_window: f.get('override') === 'on' } });
      toast(`Devolución registrada: ${money(r.amount)}${r.refund_method === 'nota_credito' ? ` · código ${r.credit_code}` : ''}.`);
      kit.refresh();
      if (r.credit_code) setTimeout(() => attempt(async () => { const card = await api('/api/gift-cards/check', { method: 'POST', body: { code: r.credit_code } }); showGiftCard({ code: card.code, initial_amount: card.balance, expires_at: card.expires_at, recipient_name: '', message: 'Nota de crédito' }, brandName()); }), 0);
    },
  });
}

kit.add({
  nav: { id: 'pedidos', label: 'Pedidos', icon: 'receipt', perm: 'pedidos', group: 'Venta', order: 30 },
  views: { pedidos: { title: 'Pedidos', kicker: 'Online y mostrador', render: renderOrders } },
  actions: {
    'ord-tab': (el) => { state.tab = el.dataset.tab; kit.refresh(); },
    'ord-filter': (el) => { state.status = el.dataset.status; kit.refresh(); },
    'pg-ret': (el) => { state.retPage = Number(el.dataset.page); kit.refresh(); },
    'ord-view': (el) => attempt(() => detailDialog(Number(el.dataset.id))),
    'ord-receipt': (el) => attempt(async () => showReceipt(await api(`/api/admin/orders/${el.dataset.id}/receipt`))),
    'ord-return': (el) => attempt(() => returnDialog(Number(el.dataset.id))),
    'ord-step': (el) => attempt(async () => {
      await api(`/api/admin/orders/${el.dataset.id}/progress`, { method: 'POST', body: { step: el.dataset.step } });
      toast('Paso registrado: el cliente recibe el aviso.');
      kit.refresh();
      await detailDialog(Number(el.dataset.id));
    }),
    deliver: (el) => attempt(async () => {
      await api(`/api/admin/orders/${el.dataset.id}/status`, { method: 'POST', body: { status: 'entregado' } });
      toast(`Pedido #${el.dataset.id} marcado como entregado.`);
      kit.refresh();
      if ($('#modal')?.open) await detailDialog(Number(el.dataset.id));
    }),
    'cancel-order': (el) => attempt(async () => {
      if (!confirm(`¿Cancelar el pedido #${el.dataset.id}? El stock volverá al inventario.`)) return;
      await api(`/api/admin/orders/${el.dataset.id}/status`, { method: 'POST', body: { status: 'cancelado' } });
      toast(`Pedido #${el.dataset.id} cancelado: el stock volvió al inventario.`);
      kit.refresh();
      if ($('#modal')?.open) await detailDialog(Number(el.dataset.id));
    }),
  },
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'ord-q') { state.q = e.target.value.trim(); searchSoon(); }
});
const searchSoon = debounce(() => attempt(async () => { const box = $('#ord-table'); if (box) box.innerHTML = tableHTML(await fetchOrders()); }), 350);
