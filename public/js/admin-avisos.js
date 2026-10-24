// Avisos a clientes y al equipo (WhatsApp y correo) y facturas electrónicas: la bandeja de salida con lo que se envió o se enviaría.
import { api, num, money, esc, icon, toast, fmtDateTime } from './ui.js';
import { $, attempt, pagerHTML, debounce, openModal, kit } from './admin-kit.js';

const n = { status: '', channel: '', page: 1 };
const f = { kind: '', status: '', q: '', page: 1 };

const NSTATUS = { pendiente: ['low', 'Pendiente'], enviado: ['ok', 'Enviado'], error: ['danger', 'Error'], simulado: ['info', 'Simulado'] };
const TEMPLATES = { pedido_estado: 'Estado del pedido', stock_disponible: 'Ya llegó (avísame)', stock_bajo: 'Stock bajo', tarjeta_regalo: 'Tarjeta de regalo', tarjeta_regalo_comprador: 'Tarjeta de regalo (comprador)', prueba: 'Prueba' };

async function renderNotifications() {
  const q = new URLSearchParams({ page: n.page, ...(n.status ? { status: n.status } : {}), ...(n.channel ? { channel: n.channel } : {}) });
  const d = await api(`/api/admin/notifications?${q}`);
  n.page = d.page;
  const live = d.mode === 'webhook';
  const c = d.counts;
  const canConfig = kit.can('configuracion');
  const html = `
  <section class="panel ${live ? 'light' : 'light'} mode-card">
    <div class="panel-head"><h2>${live ? 'Conectado a tu flujo de avisos' : 'Modo demostración: no se envía nada'}</h2>${live ? '<span class="badge ok">En vivo</span>' : '<span class="badge info">Simulado</span>'}</div>
    <p class="muted">${live
      ? 'Cada aviso sale firmado hacia tu flujo de n8n, que lo entrega por WhatsApp Business (plantillas aprobadas) o por correo.'
      : 'Los avisos se guardan con el texto exacto que recibiría el cliente, pero no salen a ningún lado. Para enviarlos de verdad, conecta tu flujo de n8n con las variables NOTIFY_WEBHOOK_URL y NOTIFY_WEBHOOK_SECRET (el README explica el contrato).'}
      A WhatsApp solo se escribe a quien lo aceptó al comprar o al pedir el aviso.</p>
    <div class="grid-2 contact-grid">
      <label class="field"><span>WhatsApp del encargado (alertas de stock bajo)</span><input type="tel" id="alert-wa" value="${esc(d.settings.alert_whatsapp)}" placeholder="507 6000-0000" ${canConfig ? '' : 'disabled'}></label>
      <label class="field"><span>Correo del encargado</span><input type="email" id="alert-mail" value="${esc(d.settings.alert_email)}" placeholder="inventario@tutienda.com" ${canConfig ? '' : 'disabled'}></label>
    </div>
    <div class="btn-row">
      ${canConfig ? '<button type="button" class="btn btn-solid" data-act="aviso-save">Guardar contactos</button>' : ''}
      <button type="button" class="btn btn-outline" data-act="aviso-test">${icon('send', 16)} Enviar aviso de prueba</button>
      ${live ? `<button type="button" class="btn btn-outline" data-act="aviso-flush">${icon('refresh', 16)} Enviar pendientes ahora</button>` : ''}
    </div>
  </section>
  <div class="row cols-4">
    <section class="panel light kpi"><p class="label">${live ? 'Pendientes' : 'Simulados'}</p><p class="kpi-value num">${num(live ? c.pendiente : c.simulado)}</p></section>
    <section class="panel light kpi"><p class="label">Enviados</p><p class="kpi-value num">${num(c.enviado)}</p></section>
    <section class="panel light kpi"><p class="label">Con error</p><p class="kpi-value num">${num(c.error)}</p></section>
    <section class="panel light kpi"><p class="label">Esperando stock</p><p class="kpi-value num">${num(d.waiting)}</p><p class="kpi-sub">clientes que pidieron «avísame cuando llegue»</p></section>
  </div>
  <section class="panel light">
    <div class="toolbar-adm">
      <div class="seg" role="group" aria-label="Estado">${[['', 'Todos'], ['pendiente', 'Pendientes'], ['enviado', 'Enviados'], ['simulado', 'Simulados'], ['error', 'Con error']].map(([v, t]) => `<button type="button" class="seg-btn ${n.status === v ? 'is-active' : ''}" data-act="aviso-filter" data-k="status" data-v="${v}">${t}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Canal">${[['', 'Ambos'], ['whatsapp', 'WhatsApp'], ['email', 'Correo']].map(([v, t]) => `<button type="button" class="seg-btn ${n.channel === v ? 'is-active' : ''}" data-act="aviso-filter" data-k="channel" data-v="${v}">${t}</button>`).join('')}</div>
    </div>
    ${d.rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Canal</th><th>Para</th><th>Evento</th><th>Mensaje</th><th>Estado</th><th></th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td class="nowrap">${esc(fmtDateTime(r.created_at))}</td><td>${r.channel === 'whatsapp' ? `${icon('phone', 14)} WhatsApp` : `${icon('mail', 14)} Correo`}</td><td class="nowrap">${esc(r.to)}</td><td>${esc(TEMPLATES[r.template] || r.template)}</td>
        <td class="rev-text msg-cell">${esc(r.text).replace(/\n/g, '<br>')}</td>
        <td><span class="badge ${NSTATUS[r.status]?.[0] || ''}">${NSTATUS[r.status]?.[1] || esc(r.status)}</span>${r.last_error ? `<span class="sub-line minus">${esc(r.last_error)} · ${r.attempts} intentos</span>` : ''}</td>
        <td>${r.status === 'error' ? `<button type="button" class="btn btn-sm btn-outline" data-act="aviso-retry" data-id="${r.id}">Reintentar</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>${pagerHTML(d, 'pg-aviso')}` : '<p class="empty-note">Todavía no hay avisos. Aparecerán aquí cuando un cliente compre, pida un aviso o un producto llegue al mínimo.</p>'}
  </section>`;
  return { html };
}

function testDialog() {
  openModal({
    title: 'Aviso de prueba',
    submit: 'Enviar prueba',
    body: `<div class="grid-2"><label class="field"><span>Canal</span><select name="channel"><option value="whatsapp">WhatsApp</option><option value="email">Correo</option></select></label>
      <label class="field"><span>Número o correo</span><input type="text" name="to" required maxlength="120" placeholder="507 6000-0000"></label></div>
      <p class="hint">Se agrega a la bandeja como cualquier aviso. En modo demostración no sale a ningún lado; con tu flujo conectado, llega de verdad.</p>`,
    onSubmit: async (form) => {
      const x = new FormData(form);
      await api('/api/admin/notifications/test', { method: 'POST', body: { channel: x.get('channel'), to: x.get('to') } });
      toast('Aviso de prueba creado.');
      kit.refresh();
    },
  });
}

// ─── Facturas ──────────────────────────────────────────────────────────────
const FSTATUS = { simulada: ['info', 'Simulada'], emitida: ['ok', 'Emitida'], pendiente: ['low', 'Pendiente'], error: ['danger', 'Error'] };

async function fetchDocs() {
  const q = new URLSearchParams({ page: f.page, ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}), ...(f.q ? { q: f.q } : {}) });
  return api(`/api/admin/fiscal?${q}`);
}
const docsTable = (d) => d.rows.length
  ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Número</th><th>Tipo</th><th>Pedido</th><th>Cliente</th><th class="r">Monto</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>
    ${d.rows.map((r) => `<tr><td class="nowrap"><b>${esc(r.number || '(sin número)')}</b>${r.auth_code ? `<span class="sub-line">${esc(r.auth_code)}</span>` : ''}</td><td>${r.kind === 'factura' ? 'Factura' : 'Nota de crédito'}</td><td><a href="#pedidos/${r.order_id}">#${r.order_id}</a></td><td>${esc(r.customer_name)}</td>
      <td class="r">${money(r.amount)}</td><td><span class="badge ${FSTATUS[r.status]?.[0] || ''}">${FSTATUS[r.status]?.[1] || esc(r.status)}</span>${r.error ? `<span class="sub-line minus">${esc(r.error)}</span>` : ''}</td><td class="nowrap">${esc(fmtDateTime(r.created_at))}</td>
      <td>${r.status === 'error' ? `<button type="button" class="btn btn-sm btn-outline" data-act="fiscal-retry" data-id="${r.id}">Reintentar</button>` : ''}${r.url ? ` <a class="btn btn-sm btn-outline" href="${esc(r.url)}" target="_blank" rel="noopener">Ver</a>` : ''}</td></tr>`).join('')}
    </tbody></table></div>${pagerHTML(d, 'pg-fiscal')}`
  : '<p class="empty-note">No hay documentos con ese filtro.</p>';

async function renderFiscal() {
  const d = await fetchDocs();
  f.page = d.page;
  const demo = d.provider === 'demo';
  const html = `
  <section class="panel light mode-card">
    <div class="panel-head"><h2>${demo ? 'Facturación de demostración' : d.provider === 'webhook' ? 'Conectada a tu servicio de facturación' : 'Facturación apagada'}</h2><span class="badge ${demo ? 'info' : d.provider === 'webhook' ? 'ok' : ''}">${demo ? 'Sin validez fiscal' : d.provider === 'webhook' ? 'En vivo' : 'Apagada'}</span></div>
    <p class="muted">${demo
      ? 'Cada venta pagada genera una factura numerada «FE-DEMO» y cada devolución, una nota de crédito. Sirve para ver el flujo completo, pero NO son documentos fiscales válidos: en Panamá la factura electrónica se emite a través de un Proveedor Autorizado Calificado (PAC) de la DGI. El README explica cómo conectarlo.'
      : d.provider === 'webhook' ? 'Cada documento se envía firmado a tu servicio, que lo traduce al formato del PAC y responde con el número y el código de autorización.' : 'No se emiten documentos. Se activa con la variable FISCAL_PROVIDER.'}</p>
    ${d.provider === 'webhook' ? `<div class="btn-row"><button type="button" class="btn btn-outline" data-act="fiscal-flush">${icon('refresh', 16)} Enviar pendientes ahora</button></div>` : ''}
  </section>
  <section class="panel light">
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar</span><input type="search" id="fiscal-q" placeholder="Número, cliente o pedido" value="${esc(f.q)}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Tipo">${[['', 'Todos'], ['factura', 'Facturas'], ['nota_credito', 'Notas de crédito']].map(([v, t]) => `<button type="button" class="seg-btn ${f.kind === v ? 'is-active' : ''}" data-act="fiscal-filter" data-k="kind" data-v="${v}">${t}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Estado">${[['', 'Cualquier estado'], ['pendiente', `Pendientes${d.counts.pendiente ? ` (${d.counts.pendiente})` : ''}`], ['error', `Con error${d.counts.error ? ` (${d.counts.error})` : ''}`]].map(([v, t]) => `<button type="button" class="seg-btn ${f.status === v ? 'is-active' : ''}" data-act="fiscal-filter" data-k="status" data-v="${v}">${t}</button>`).join('')}</div>
    </div>
    <div id="fiscal-table">${docsTable(d)}</div>
  </section>`;
  return { html };
}

kit.add({
  nav: [
    { id: 'avisos', label: 'Avisos', icon: 'bell', perm: 'notificaciones', group: 'Conexión', order: 10 },
    { id: 'facturas', label: 'Facturas', icon: 'file', perm: 'facturas', group: 'Conexión', order: 20 },
  ],
  views: {
    avisos: { title: 'Avisos', kicker: 'WhatsApp y correo a clientes y al equipo', render: renderNotifications },
    facturas: { title: 'Facturas', kicker: 'Facturas y notas de crédito electrónicas', render: renderFiscal },
  },
  actions: {
    'aviso-filter': (el) => { n[el.dataset.k] = el.dataset.v; n.page = 1; kit.refresh(); },
    'pg-aviso': (el) => { n.page = Number(el.dataset.page); kit.refresh(); },
    'aviso-test': testDialog,
    'aviso-save': () => attempt(async () => {
      await api('/api/admin/policy', { method: 'PATCH', body: { alert_whatsapp: $('#alert-wa').value, alert_email: $('#alert-mail').value } });
      toast('Contactos guardados: las alertas de stock bajo llegarán ahí.');
      kit.refresh();
    }),
    'aviso-flush': () => attempt(async () => {
      const r = await api('/api/admin/notifications/flush', { method: 'POST', body: {} });
      toast(`Enviados: ${r.sent}${r.failed ? ` · con error: ${r.failed}` : ''}.`, r.failed ? 'error' : 'ok');
      kit.refresh();
    }),
    'aviso-retry': (el) => attempt(async () => {
      await api(`/api/admin/notifications/${el.dataset.id}/retry`, { method: 'POST', body: {} });
      toast('Aviso puesto en cola otra vez.');
      kit.refresh();
    }),
    'fiscal-filter': (el) => { f[el.dataset.k] = el.dataset.v; f.page = 1; kit.refresh(); },
    'pg-fiscal': (el) => { f.page = Number(el.dataset.page); kit.refresh(); },
    'fiscal-flush': () => attempt(async () => {
      const r = await api('/api/admin/fiscal/flush', { method: 'POST', body: {} });
      toast(`Enviados: ${r.sent}${r.failed ? ` · con error: ${r.failed}` : ''}.`, r.failed ? 'error' : 'ok');
      kit.refresh();
    }),
    'fiscal-retry': (el) => attempt(async () => {
      await api(`/api/admin/fiscal/${el.dataset.id}/retry`, { method: 'POST', body: {} });
      toast('Documento puesto en cola otra vez.');
      kit.refresh();
    }),
  },
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'fiscal-q') { f.q = e.target.value.trim(); f.page = 1; soon(); }
});
const soon = debounce(() => attempt(async () => { const box = $('#fiscal-table'); if (box) box.innerHTML = docsTable(await fetchDocs()); }), 350);
