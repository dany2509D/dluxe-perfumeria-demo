import { api, ApiError, hasToken, setToken, money, num, esc, icon, productArt, tileColor, toast, fmtDateTime, fmtDay, sizeLabel } from './ui.js';
import { mountThemeSwitch } from './theme.js';
import { $, qs, debounce, attempt, pagerHTML, openModal, closeModal, bindModal, kit, GROUPS } from './admin-kit.js';
import { showLabelsNow } from './admin-print.js';
import { photoField, bindPhotoField } from './admin-photo.js';
// Secciones del panel: cada módulo se anota en `kit` con sus pantallas, acciones y entrada de menú.
import './admin-pos.js';
import './admin-caja.js';
import './admin-pedidos.js';
import './admin-regalos.js';
import './admin-promos.js';
import './admin-sets.js';
import './admin-reportes.js';
import './admin-avisos.js';
import './admin-usuarios.js';

const BRAND = window.__BRAND || { name: "Maison Aurora Perfumería", short: "Maison Aurora" };
const CATEGORIES = ['Damas', 'Caballeros', 'Infantil', 'Unisex'];
const KINDS = ['Perfume', 'Estuche', 'Tester'];
const PAGE = 50;

const state = {
  view: 'resumen',
  counts: null,
  inv: { q: '', filter: 'todos', page: 1, data: null },
  prod: { q: '', category: '', status: '', page: 1, data: null },
  movType: '',
  rev: { page: 1 },
  woo: { file: null, fileName: '', report: null, preview: null, done: null, updateStock: null },
  chartTable: false,
};
let renderToken = 0;

// Menú: cada entrada solo se muestra a quien tiene el permiso. Las secciones nuevas se suman desde sus módulos.
kit.add({
  nav: [
    { id: 'resumen', label: 'Resumen', icon: 'chart', perm: 'resumen', group: '', order: 0 },
    { id: 'inventario', label: 'Inventario', icon: 'box', perm: 'inventario', group: 'Inventario', order: 10 },
    { id: 'productos', label: 'Productos', icon: 'package', perm: 'productos', group: 'Inventario', order: 20 },
    { id: 'compras', label: 'Compras', icon: 'truck', perm: 'compras', group: 'Inventario', order: 40 },
    { id: 'movimientos', label: 'Movimientos', icon: 'history', perm: 'movimientos', group: 'Inventario', order: 50 },
    { id: 'resenas', label: 'Reseñas', icon: 'star', perm: 'resenas', group: 'Análisis', order: 20 },
    { id: 'woocommerce', label: 'WooCommerce', icon: 'link', perm: 'woocommerce', group: 'Conexión', order: 30 },
  ],
});

// ─── Utilidades de estado ──────────────────────────────────────────────────
const artOf = (v) => productArt({ image: v.image, color: v.color, id: v.product_id, name: v.name }, { title: v.name });
const isLow = (v) => v.stock > 0 && v.stock <= v.min_stock;

function stockBadges(v) {
  if (v.is_set) return '<span class="badge info">Set</span>' + (v.stock === 0 ? ' <span class="badge out">Agotado</span>' : '');
  const main = v.stock === 0 ? '<span class="badge out">Agotado</span>' : isLow(v) ? '<span class="badge low">Stock bajo</span>' : '<span class="badge ok">OK</span>';
  return main + (v.on_order ? ' <span class="badge info">En camino</span>' : '');
}

const typeBadge = (t) => `<span class="badge ${{ entrada: 'ok', salida: '', ajuste: 'low' }[t] || ''}">${esc(t)}</span>`;
const signed = (n) => `<span class="pos-qty ${n > 0 ? 'plus' : 'minus'}">${n > 0 ? '+' : '−'}${Math.abs(n)}</span>`;

const getVariant = (id) => api(`/api/admin/variants/${id}`); // siempre fresca: el stock cambia con cada venta
const supplierList = () => kit.suppliers;

// ─── Acceso ────────────────────────────────────────────────────────────────
function showLogin(msg = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-err').textContent = msg;
  $('#login-pw').value = '';
  ($('#login-user').value ? $('#login-pw') : $('#login-user')).focus();
}

async function enter() {
  kit.user = await api('/api/admin/me');
  if (kit.can(['compras', 'inventario'])) kit.suppliers = await api('/api/admin/suppliers').catch(() => []);
  buildNav();
  $('#login').hidden = true;
  $('#app').hidden = false;
  route();
}

// ─── Navegación ────────────────────────────────────────────────────────────
const allowedNav = () => kit.nav.filter((n) => kit.can(n.perm)).sort((a, b) => (GROUPS.indexOf(a.group) + 1 || 0) - (GROUPS.indexOf(b.group) + 1 || 0) || (a.order ?? 50) - (b.order ?? 50));

function buildNav() {
  let last = null;
  $('#side-nav').innerHTML = allowedNav()
    .map((n) => {
      const head = n.group !== last && n.group ? `<p class="side-group">${esc(n.group)}</p>` : '';
      last = n.group;
      return `${head}<a class="side-link" href="#${n.id}" data-nav="${n.id}" aria-label="${esc(n.label)}" title="${esc(n.label)}">${icon(n.icon, 18)}<span>${esc(n.label)}</span><span class="pill" data-pill="${n.id}" hidden></span></a>`;
    })
    .join('');
  const u = kit.user;
  $('#side-user').innerHTML = `<b>${esc(u.name)}</b><span>${esc(u.role_label)}</span>`;
  const foot = [
    ['#link-store', 'store', 'Ver tienda', true],
    ['#btn-account', 'user', 'Mi cuenta', true],
    ['#btn-policy', 'sliders', 'Ajustes de la tienda', kit.can('configuracion')],
    ['#btn-seed', 'package', 'Catálogo masivo', kit.can('ajustes')],
    ['#btn-reset', 'refresh', 'Reiniciar demo', kit.can('ajustes')],
    ['#btn-logout', 'logout', 'Salir', true],
  ];
  for (const [sel, ic, label, on] of foot) {
    const el = $(sel);
    el.hidden = !on;
    el.innerHTML = `${icon(ic, 18)}<span>${label}</span>`;
    el.setAttribute('aria-label', label);
    el.title = label;
  }
  $('#modal-x').innerHTML = icon('x', 22);
}

// d: lo que devuelve /api/admin/badges, o el resumen completo (/api/admin/dashboard)
function setBadges(d) {
  const set = (id, n) => {
    const el = $(`[data-pill="${id}"]`);
    if (!el) return;
    el.textContent = n;
    el.hidden = !n;
  };
  const inv = typeof d.inventory === 'number' ? d.inventory : d.inventory.out_count + d.inventory.low_count;
  set('inventario', inv);
  set('compras', d.pendingPurchases ?? d.purchases ?? 0);
  kit.onBadges?.(d);
}
kit.badges = setBadges;

function route() {
  if ($('#app').hidden) return; // sin sesión no se pide nada
  const [name, ...rest] = location.hash.slice(1).split('/');
  kit.arg = rest.join('/');
  const allowed = new Set(allowedNav().map((n) => n.id));
  if (VIEWS[name] && allowed.has(name)) return show(name);
  // lo que no existe o no se permite lleva a la primera pantalla disponible
  const first = ['resumen', 'pos', 'pedidos', 'inventario', 'caja', 'reportes'].find((id) => allowed.has(id)) || [...allowed][0];
  if (first && first !== name) location.hash = `#${first}`;
  else if (first) show(first);
}

async function show(name, { silent = false } = {}) {
  const token = ++renderToken;
  state.view = name;
  kit.view = name;
  const meta = VIEWS[name];
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('#page-title').textContent = meta.title;
  $('#page-kicker').textContent = meta.kicker;
  document.title = `${meta.title} · Panel ${BRAND.short}`;
  if (!silent) {
    $('#view').innerHTML = '<div class="panel light"><p class="muted">Cargando…</p></div>';
    $('#page-actions').innerHTML = '';
  }
  try {
    const out = await meta.render();
    if (token !== renderToken) return;
    $('#view').innerHTML = out.html;
    $('#page-actions').innerHTML = out.actions || '';
    out.after?.();
    if (name !== 'resumen') api('/api/admin/badges').then(setBadges).catch(() => {});
    if (!silent) window.scrollTo({ top: 0 });
  } catch (e) {
    if (token !== renderToken || (e instanceof ApiError && e.status === 401)) return;
    $('#view').innerHTML = `<div class="panel light"><p class="sub">No se pudo cargar esta sección.</p><p class="muted">${esc(e.message)}</p><p><button type="button" class="btn btn-solid" data-act="reload">Reintentar</button></p></div>`;
  }
}
kit.refresh = () => show(state.view, { silent: true });

// ═══ RESUMEN ═══════════════════════════════════════════════════════════════
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function chartHTML(series) {
  const W = 720, H = 340, L = 52, R = 8, T = 14, B = 40;
  const pw = W - L - R, ph = H - T - B;
  const max = niceMax(Math.max(...series.map((s) => s.total), 1));
  const col = pw / series.length;
  const bw = col * 0.56;
  const y = (v) => T + ph - (v / max) * ph;
  const grid = [0, 0.5, 1]
    .map((f) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}"/><text x="${L - 8}" y="${y(max * f) + 4}" text-anchor="end">${money(max * f).replace('.00', '')}</text>`)
    .join('');
  const bars = series
    .map((s, i) => {
      const x = L + i * col;
      const h = (s.total / max) * ph;
      const d = new Date(s.day + 'T00:00:00');
      const wd = i === series.length - 1 ? 'hoy' : d.toLocaleDateString('es', { weekday: 'short' }).replace('.', '');
      const cx = x + col / 2;
      return `<g>
        <rect class="hit" x="${x}" y="${T}" width="${col}" height="${ph}" data-i="${i}" tabindex="0" role="img" aria-label="${esc(fmtDay(s.day))}: ${money(s.total)}, ${s.n} pedidos"/>
        <rect class="bar" x="${x + (col - bw) / 2}" y="${y(s.total)}" width="${bw}" height="${Math.max(h, s.total > 0 ? 2 : 0)}"/>
        <text x="${cx}" y="${H - 20}" text-anchor="middle">${wd}</text>
        <text x="${cx}" y="${H - 6}" text-anchor="middle">${d.getDate()}</text>
      </g>`;
    })
    .join('');
  return `<div class="chart" id="chart" data-w="${W}" data-h="${H}" data-l="${L}" data-col="${col}" data-t="${T}" data-ph="${ph}" data-max="${max}">
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Ventas de los últimos 14 días">${grid}${bars}</svg>
    <div class="tip" id="chart-tip" hidden></div></div>`;
}

function chartTableHTML(series) {
  return `<div class="chart-table tbl-wrap"><table class="tbl"><thead><tr><th>Día</th><th class="r">Pedidos</th><th class="r">Ventas</th></tr></thead><tbody>
    ${series.map((s) => `<tr><td>${esc(fmtDay(s.day))}</td><td class="r">${s.n}</td><td class="r">${money(s.total)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function renderDashboard() {
  const d = await api('/api/admin/dashboard');
  setBadges(d);
  const alerts = d.inventory.out_count + d.inventory.low_count;
  const total14 = d.series.reduce((s, x) => s + x.total, 0);
  const maxUnits = Math.max(...d.top.map((t) => t.units), 1);
  const chanTotal = d.channels.reduce((s, c) => s + c.total, 0) || 1;
  const chanName = { online: 'Tienda online', mostrador: 'Mostrador' };

  const html = `
  <div class="row cols-4">
    <section class="panel light kpi"><p class="label">Ventas hoy</p><p class="kpi-value num">${money(d.today.total)}</p><p class="kpi-sub">${d.today.n} ${d.today.n === 1 ? 'pedido' : 'pedidos'}</p></section>
    <section class="panel light kpi"><p class="label">Ventas · 30 días</p><p class="kpi-value num">${money(d.month.total)}</p><p class="kpi-sub">${d.month.n} pedidos · margen ${money(d.month.margin)}</p></section>
    <section class="panel light kpi"><p class="label">Inventario a costo</p><p class="kpi-value num">${money(d.inventory.cost_value)}</p><p class="kpi-sub">${num(d.inventory.units)} unidades · ${money(d.inventory.retail_value)} a precio de venta</p></section>
    <button type="button" class="panel light kpi" data-act="goto-alerts"><p class="label">Alertas de stock</p><p class="kpi-value num">${alerts}</p><p class="kpi-sub">${d.inventory.out_count} agotados · ${d.inventory.low_count} con stock bajo</p></button>
  </div>

  <div class="row cols-2">
    <section class="panel forest">
      <div class="panel-head"><h2>Ventas de los últimos 14 días</h2>
        <span class="caption upper muted">${money(total14)} en total</span></div>
      <div id="chart-box">${state.chartTable ? chartTableHTML(d.series) : chartHTML(d.series)}</div>
      <p style="margin-top:12px"><button type="button" class="btn btn-sm btn-outline" data-act="toggle-chart">${state.chartTable ? 'Ver gráfico' : 'Ver tabla'}</button></p>
    </section>

    <section class="panel light">
      <div class="panel-head"><h2>Ciclo automático</h2></div>
      <label class="switch"><input type="checkbox" id="auto-toggle" ${d.autoReorder ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Reposición automática</span></label>
      <ol class="steps">
        <li><b>Se vende</b><span>Por la web o en mostrador: el stock se descuenta solo.</span></li>
        <li><b>Cae al mínimo</b><span>${alerts} ${alerts === 1 ? 'variante en alerta' : 'variantes en alerta'} ahora mismo.</span></li>
        <li><b>Se crea la compra</b><span>${d.pendingPurchases} ${d.pendingPurchases === 1 ? 'orden pendiente' : 'órdenes pendientes'} de recibir. <a href="#compras"><u>Ver compras</u></a></span></li>
        <li><b>Llega la mercancía</b><span>La marcas como recibida y el stock sube solo.</span></li>
      </ol>
    </section>
  </div>

  <div class="row cols-3">
    <section class="panel light">
      <div class="panel-head"><h2>Por reponer</h2><a class="link-arrow" href="#inventario" data-act="goto-alerts">Ver todo ${icon('arrowRight', 14)}</a></div>
      ${
        d.alerts.length
          ? `<ul class="list">${d.alerts
              .map(
                (a) => `<li><div class="who"><b>${esc(a.name)}</b><span>${sizeLabel(a.size_ml)} · ${esc(a.sku)}</span></div>
                <div class="tags">${a.stock === 0 ? '<span class="badge out">Agotado</span>' : `<span class="badge low">${a.stock} ${a.stock === 1 ? 'ud' : 'uds'}</span>`}${a.on_order ? '<span class="badge info">En camino</span>' : '<span class="badge danger">Sin orden</span>'}</div></li>`
              )
              .join('')}</ul>`
          : '<p class="empty-note">Todo el inventario está por encima del mínimo.</p>'
      }
    </section>
    <section class="panel light">
      <div class="panel-head"><h2>Más vendidos · 30 días</h2></div>
      ${
        d.top.length
          ? d.top.map((t) => `<div class="bar-row"><div style="display:flex;justify-content:space-between;gap:10px"><b>${esc(t.name)}</b><span class="num">${t.units} uds · ${money(t.revenue)}</span></div><div class="meter"><i style="width:${(t.units / maxUnits) * 100}%"></i></div></div>`).join('')
          : '<p class="empty-note">Aún no hay ventas.</p>'
      }
    </section>
    <section class="panel light">
      <div class="panel-head"><h2>Canales · 30 días</h2></div>
      ${
        d.channels.length
          ? d.channels.map((c) => `<div class="bar-row"><div style="display:flex;justify-content:space-between;gap:10px"><b>${chanName[c.channel] || c.channel}</b><span class="num">${money(c.total)} · ${c.n} pedidos</span></div><div class="meter"><i style="width:${(c.total / chanTotal) * 100}%"></i></div></div>`).join('')
          : '<p class="empty-note">Aún no hay ventas.</p>'
      }
    </section>
  </div>`;

  return {
    html,
    actions: `<a class="btn btn-lemon" href="#pos">${icon('register', 18)} Nueva venta</a>`,
    after: () => bindChart(d.series),
  };
}

function bindChart(series) {
  const chart = $('#chart');
  if (!chart) return;
  const tip = $('#chart-tip');
  const { w, h, l, col, t, ph, max } = Object.fromEntries(Object.entries(chart.dataset).map(([k, v]) => [k, Number(v)]));
  const show = (hit) => {
    const s = series[Number(hit.dataset.i)];
    const cx = l + (Number(hit.dataset.i) + 0.5) * col;
    const yy = t + ph - (s.total / max) * ph;
    tip.innerHTML = `${esc(fmtDay(s.day))}<br><strong>${money(s.total)}</strong> · ${s.n} ${s.n === 1 ? 'pedido' : 'pedidos'}`;
    tip.style.left = `${(cx / w) * 100}%`;
    tip.style.top = `${(Math.min(yy, t + ph - 6) / h) * 100}%`;
    tip.hidden = false;
  };
  chart.querySelectorAll('.hit').forEach((hit) => {
    hit.addEventListener('pointerenter', () => show(hit));
    hit.addEventListener('focus', () => show(hit));
    hit.addEventListener('pointerleave', () => (tip.hidden = true));
    hit.addEventListener('blur', () => (tip.hidden = true));
  });
}

// ═══ INVENTARIO ════════════════════════════════════════════════════════════
async function fetchInv() {
  const { q, filter, page } = state.inv;
  state.inv.data = await api(`/api/admin/inventory?${qs({ q: q.trim(), filter, page, limit: PAGE })}`);
  if (state.inv.page > state.inv.data.pages) { // la lista se achicó: vuelve a la última página
    state.inv.page = state.inv.data.pages;
    state.inv.data = await api(`/api/admin/inventory?${qs({ q: q.trim(), filter, page: state.inv.page, limit: PAGE })}`);
  }
}

async function renderInventory() {
  [state.counts] = await Promise.all([api('/api/admin/inventory/counts'), fetchInv()]);
  const html = `
  <section class="panel light">
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar</span><input type="search" id="inv-q" placeholder="Buscar producto, marca o SKU" value="${esc(state.inv.q)}" autocomplete="off"></label>
      <div class="seg" role="group" aria-label="Filtrar por estado" id="inv-filter"></div>
    </div>
    <div class="tbl-wrap" id="inv-table"></div>
    <div id="inv-pager"></div>
  </section>`;
  return {
    html,
    actions: kit.can('inventario_editar') ? `<button type="button" class="btn btn-lemon" data-act="import">${icon('upload', 18)} Importar entradas (CSV)</button>` : '',
    after: () => { drawInvFilters(); drawInv(); },
  };
}

function drawInvFilters() {
  const c = state.counts || {};
  const opts = [['todos', 'Todos', c.total], ['bajo', 'Stock bajo', c.low_count], ['agotado', 'Agotados', c.out_count], ['encamino', 'En camino'], ['oculto', 'Ocultos', c.hidden_count]];
  $('#inv-filter').innerHTML = opts
    .map(([v, t, n]) => `<button type="button" class="seg-btn ${state.inv.filter === v ? 'is-active' : ''}" data-filter="${v}" aria-pressed="${state.inv.filter === v}">${t}${n === undefined ? '' : ` <small>${num(n)}</small>`}</button>`)
    .join('');
}

function drawInv() {
  const rows = state.inv.data.rows;
  const showCost = kit.can('costos');
  const canEdit = kit.can('inventario_editar');
  $('#inv-table').innerHTML = rows.length
    ? `<table class="tbl"><thead><tr><th>Producto</th><th>SKU</th><th class="r">Tamaño</th><th class="r">Stock</th><th>Estado</th><th class="r">Mín.</th>${showCost ? '<th class="r">Costo</th>' : ''}<th class="r">Precio</th>${showCost ? '<th>Proveedor</th>' : ''}<th></th></tr></thead><tbody>
      ${rows
        .map(
          (v) => `<tr class="${v.active && v.product_active ? '' : 'is-inactive'}">
        <td><span class="name">${esc(v.name)}</span><span class="sub-line">${esc(v.brand)}${v.kind !== 'Perfume' ? ` · ${esc(v.kind)}` : ''}${v.active && v.product_active ? '' : ' · oculto'}</span></td>
        <td class="nowrap">${esc(v.sku)}${v.barcode ? `<span class="sub-line">${esc(v.barcode)}</span>` : ''}</td><td class="r nowrap">${sizeLabel(v.size_ml)}</td>
        <td class="r"><span class="pos-qty">${num(v.stock)}</span></td><td>${stockBadges(v)}</td>
        <td class="r">${v.is_set ? '—' : v.min_stock}</td>${showCost ? `<td class="r">${money(v.cost)}</td>` : ''}<td class="r">${money(v.price)}${v.compare_at ? ` <s class="was">${money(v.compare_at)}</s>` : ''}</td>
        ${showCost ? `<td>${esc(v.supplier_name || '—')}</td>` : ''}
        <td><div class="acts">
          ${canEdit && !v.is_set ? `<button type="button" class="btn btn-sm btn-outline" data-act="adjust" data-id="${v.id}">Ajustar</button>` : ''}
          <button type="button" class="icon-btn sm" data-act="history" data-id="${v.id}" aria-label="Historial de ${esc(v.name)} ${sizeLabel(v.size_ml)}" title="Historial">${icon('history', 18)}</button>
          ${canEdit && !v.is_set ? `<button type="button" class="icon-btn sm" data-act="edit-variant" data-id="${v.id}" aria-label="Editar ${esc(v.name)} ${sizeLabel(v.size_ml)}" title="Editar precio, mínimo, proveedor y código de barras">${icon('edit', 18)}</button>` : ''}
        </div></td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="empty-note">No hay variantes con ese filtro.</p>';
  $('#inv-pager').innerHTML = pagerHTML(state.inv.data, 'pg-inv');
}

async function reloadInv() {
  try {
    await fetchInv();
    if (state.view === 'inventario') { drawInvFilters(); drawInv(); }
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast(e.message, 'error');
  }
}
const reloadInvSoon = debounce(reloadInv);

const REASONS = ['Conteo físico', 'Merma o rotura', 'Muestra o cortesía', 'Corrección de error', 'Devolución de cliente'];

async function adjustDialog(id) {
  const v = await getVariant(id);
  openModal({
    title: 'Ajustar stock',
    submit: 'Aplicar ajuste',
    body: `<p><b>${esc(v.name)}</b> · ${sizeLabel(v.size_ml)} <span class="muted">(${esc(v.sku)})</span></p>
      <p class="hint">Stock actual: <strong>${v.stock}</strong> unidades. Cada ajuste queda registrado en Movimientos.</p>
      <fieldset class="opts"><legend class="label">Tipo de ajuste</legend>
        <label class="opt"><input type="radio" name="mode" value="delta" checked><span>Sumar o restar</span></label>
        <label class="opt"><input type="radio" name="mode" value="count"><span>Conteo físico</span></label></fieldset>
      <label class="field"><span id="adj-label">Cantidad (negativa para restar)</span><input type="number" name="value" step="1" required></label>
      <label class="field"><span>Motivo</span><input type="text" name="reason" list="reasons" required maxlength="120" placeholder="Elige o escribe un motivo"><datalist id="reasons">${REASONS.map((r) => `<option value="${r}">`).join('')}</datalist></label>`,
    onOpen: (dlg) =>
      dlg.querySelectorAll('[name=mode]').forEach((r) =>
        r.addEventListener('change', () => {
          $('#adj-label').textContent = r.value === 'count' ? 'Unidades contadas en el estante' : 'Cantidad (negativa para restar)';
        })
      ),
    onSubmit: async (form) => {
      const f = new FormData(form);
      const body = { reason: f.get('reason') };
      if (f.get('mode') === 'count') body.count = f.get('value');
      else body.delta = Number(f.get('value'));
      const r = await api(`/api/admin/variants/${id}/adjust`, { method: 'POST', body });
      toast(`Stock actualizado: ahora hay ${r.stock} unidades.`);
      if (r.replenished?.items) toast('Quedó en el mínimo: se agregó a una orden de compra automática.');
      show(state.view, { silent: true });
    },
  });
}

async function historyDialog(id) {
  const [v, moves] = await Promise.all([getVariant(id), api(`/api/admin/movements?variant_id=${id}&limit=100`)]);
  openModal({
    title: `Historial · ${v.name} ${sizeLabel(v.size_ml)}`,
    wide: true,
    body: moves.length
      ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Tipo</th><th class="r">Cantidad</th><th class="r">Saldo</th><th>Motivo</th></tr></thead><tbody>
        ${moves.map((m) => `<tr><td class="nowrap">${fmtDateTime(m.created_at)}</td><td>${typeBadge(m.type)}</td><td class="r">${signed(m.qty)}</td><td class="r num">${m.balance ?? '—'}</td><td>${esc(m.reason)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-note">Sin movimientos todavía.</p>',
  });
}

function supplierOptions(selected) {
  return `<option value="">Sin proveedor</option>${kit.suppliers.map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
}

async function editVariantDialog(id) {
  const v = await getVariant(id);
  openModal({
    title: `Editar · ${v.name} ${sizeLabel(v.size_ml)}`,
    body: `<div class="grid-2">
        <label class="field"><span>Precio de venta ($)</span><input type="number" name="price" min="0" step="0.01" value="${v.price}" required></label>
        <label class="field"><span>Precio normal tachado ($)</span><input type="number" name="compare_at" min="0" step="0.01" value="${v.compare_at ?? ''}"><small>Opcional. Si es mayor al precio, el producto sale en oferta con su % de descuento.</small></label>
        <label class="field"><span>Costo ($)</span><input type="number" name="cost" min="0" step="0.01" value="${v.cost}" required></label>
        <label class="field"><span>Stock mínimo</span><input type="number" name="min_stock" min="0" step="1" value="${v.min_stock}" required><small>Al llegar aquí se pide reposición.</small></label>
        <label class="field"><span>Cantidad a reponer</span><input type="number" name="reorder_qty" min="1" step="1" value="${v.reorder_qty}" required><small>Lo que se pide en la compra automática.</small></label>
      </div>
      <label class="field"><span>Proveedor</span><select name="supplier_id">${supplierOptions(v.supplier_id)}</select></label>
      <label class="field"><span>Código de barras</span><input type="text" name="barcode" maxlength="32" inputmode="numeric" value="${esc(v.barcode || '')}" placeholder="Escanéalo o escríbelo"><small>EAN-13 u otro. El lector del mostrador lo reconoce al escanear; si no tiene, se usa el SKU.</small></label>
      <div class="label-tools"><label class="field"><span>Copias de la etiqueta</span><input type="number" id="label-copies" min="1" max="100" value="1"></label><button type="button" class="btn btn-sm btn-outline" data-act="print-label" data-id="${id}">${icon('printer', 16)} Imprimir etiqueta</button></div>
      <label class="switch"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Disponible para la venta</span></label>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      await api(`/api/admin/variants/${id}`, {
        method: 'PATCH',
        body: {
          price: f.get('price'), compare_at: f.get('compare_at') || null, cost: f.get('cost'), min_stock: f.get('min_stock'), reorder_qty: f.get('reorder_qty'),
          supplier_id: f.get('supplier_id') || null, barcode: f.get('barcode') || '', active: f.get('active') === 'on',
        },
      });
      toast('Cambios guardados.');
      show(state.view, { silent: true });
    },
  });
}

function importDialog() {
  openModal({
    title: 'Importar entradas de stock',
    submit: 'Importar',
    wide: true,
    body: `<p>Sube un CSV (puedes guardarlo desde Excel) con las columnas <b>sku; cantidad; costo</b>. El costo es opcional. Cada fila suma stock y queda registrada. <b>Si una fila tiene error, no se aplica nada.</b></p>
      <div><button type="button" class="btn btn-sm btn-outline" data-act="template">${icon('download', 16)} Descargar plantilla</button></div>
      <label class="field"><span>Archivo CSV</span><input type="file" id="csv-file" accept=".csv,text/csv,text/plain"></label>
      <label class="field"><span>O pega el contenido aquí</span><textarea name="csv" rows="6" spellcheck="false" placeholder="sku;cantidad;costo&#10;DLX-00001-50;12;31.50"></textarea></label>`,
    onOpen: (dlg) =>
      $('#csv-file', dlg).addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) $('textarea[name=csv]', dlg).value = await file.text();
      }),
    onSubmit: async (form) => {
      const r = await api('/api/admin/import', { method: 'POST', body: { csv: new FormData(form).get('csv') } });
      toast(`Importado: ${r.applied} ${r.applied === 1 ? 'fila' : 'filas'}, ${num(r.units)} unidades nuevas en stock.`);
      show(state.view, { silent: true });
    },
  });
}

async function downloadTemplate() {
  const { rows } = await api('/api/admin/inventory?limit=3');
  const sample = rows.map((v) => `${v.sku};10;${v.cost}`);
  const blob = new Blob(['sku;cantidad;costo\r\n' + sample.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'plantilla-entradas.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ═══ PRODUCTOS ═════════════════════════════════════════════════════════════
async function fetchProducts() {
  const { q, category, status, page } = state.prod;
  const ask = (pg) => api(`/api/admin/products?${qs({ q: q.trim(), category, status, page: pg, limit: PAGE })}`);
  state.prod.data = await ask(page);
  if (state.prod.page > state.prod.data.pages) {
    state.prod.page = state.prod.data.pages;
    state.prod.data = await ask(state.prod.page);
  }
}

async function renderProducts() {
  await fetchProducts();
  const p = state.prod;
  const cats = [...CATEGORIES, 'Sin clasificar'];
  const html = `<section class="panel light">
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar</span><input type="search" id="prod-q" placeholder="Buscar producto, marca o nota" value="${esc(p.q)}" autocomplete="off"></label>
      <label class="field"><span class="sr-only">Categoría</span><select id="prod-cat"><option value="">Todas las categorías</option>${cats.map((c) => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field"><span class="sr-only">Estado</span><select id="prod-status">${[['', 'Todos'], ['visible', 'Visibles'], ['oculto', 'Ocultos'], ['sin_clasificar', 'Sin clasificar'], ['sin_imagen', 'Sin foto']].map(([v, t]) => `<option value="${v}" ${v === p.status ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    </div>
    <div class="tbl-wrap" id="prod-table"></div>
    <div id="prod-pager"></div></section>`;
  return {
    html,
    actions: `<a class="btn btn-outline" href="#woocommerce">${icon('link', 18)} Importar de WooCommerce</a><button type="button" class="btn btn-lemon" data-act="new-product">${icon('plus', 18)} Nuevo producto</button>`,
    after: drawProducts,
  };
}

const sizesText = (list) => {
  const sizes = [...new Set(String(list || '').split(',').map(Number))].sort((a, b) => a - b);
  if (!sizes.length) return '—';
  const ml = sizes.filter(Boolean);
  return (sizes.includes(0) ? ['Único'] : []).concat(ml.length ? [`${ml.join(' · ')} ml`] : []).join(' · ');
};

function drawProducts() {
  const rows = state.prod.data.rows;
  $('#prod-table').innerHTML = rows.length
    ? `<table class="tbl"><thead><tr><th>Producto</th><th>Categoría</th><th>Familia</th><th>Tamaños</th><th class="r">Stock total</th><th>En la tienda</th><th></th></tr></thead><tbody>
    ${rows
      .map(
        (p) => `<tr class="${p.active ? '' : 'is-inactive'}">
      <td><span class="name">${esc(p.name)}${p.is_new ? ' <span class="badge info">Nuevo</span>' : ''}</span><span class="sub-line">${esc(p.brand)}${p.kind !== 'Perfume' ? ` · ${esc(p.kind)}` : ''}</span></td>
      <td>${p.category === 'Sin clasificar' ? '<span class="badge low">Sin clasificar</span>' : esc(p.category)}${p.subcategory ? `<span class="sub-line">${esc(p.subcategory)}</span>` : ''}</td><td>${esc(p.family || '—')}</td>
      <td class="nowrap">${sizesText(p.size_list)}</td><td class="r"><span class="pos-qty">${num(p.stock)}</span></td>
      <td>${p.active ? '<span class="badge ok">Visible</span>' : '<span class="badge">Oculto</span>'}</td>
      <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="edit-product" data-id="${p.id}">Editar</button>
        <button type="button" class="btn btn-sm btn-outline" data-act="toggle-product" data-id="${p.id}">${p.active ? 'Ocultar' : 'Mostrar'}</button></div></td></tr>`
      )
      .join('')}</tbody></table>`
    : '<p class="empty-note">No hay productos con ese filtro.</p>';
  $('#prod-pager').innerHTML = pagerHTML(state.prod.data, 'pg-prod');
}

async function reloadProducts() {
  try {
    await fetchProducts();
    if (state.view === 'productos') drawProducts();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast(e.message, 'error');
  }
}
const reloadProductsSoon = debounce(reloadProducts);

const vrowHTML = (v = {}) => `<div class="vrow">
  <label class="field"><span>Tamaño (ml)</span><input type="number" data-k="size_ml" min="0" step="1" value="${v.size_ml ?? ''}" required><small>0 = tamaño único</small></label>
  <label class="field"><span>Precio ($)</span><input type="number" data-k="price" min="0" step="0.01" value="${v.price ?? ''}" required></label>
  <label class="field"><span>Precio tachado ($)</span><input type="number" data-k="compare_at" min="0" step="0.01" value="${v.compare_at ?? ''}"></label>
  <label class="field"><span>Costo ($)</span><input type="number" data-k="cost" min="0" step="0.01" value="${v.cost ?? ''}" required></label>
  <label class="field"><span>Stock inicial</span><input type="number" data-k="stock" min="0" step="1" value="${v.stock ?? 10}" required></label>
  <label class="field"><span>Mínimo</span><input type="number" data-k="min_stock" min="0" step="1" value="${v.min_stock ?? 3}" required></label>
  <label class="field"><span>Reponer</span><input type="number" data-k="reorder_qty" min="1" step="1" value="${v.reorder_qty ?? 12}" required></label>
  <label class="field"><span>Código de barras</span><input type="text" data-k="barcode" maxlength="32" inputmode="numeric" placeholder="Opcional"></label>
  <button type="button" class="icon-btn sm" data-act="del-vrow" aria-label="Quitar este tamaño" title="Quitar">${icon('trash', 18)}</button>
</div>`;

const select = (name, items, selected) => `<select name="${name}">${items.map((c) => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`;

async function newProductDialog() {
  const families = ['Floral', 'Oriental', 'Amaderado', 'Fresco', 'Cítrico', 'Gourmand', 'Frutal', 'Aromático'];
  const brands = await api('/api/brands').catch(() => []);
  openModal({
    title: 'Nuevo producto',
    wide: true,
    submit: 'Crear producto',
    onOpen: (dlg) => { bindPhotoField(dlg); dlg.querySelector('input[name=name]')?.focus(); },
    body: `<div class="grid-2">
        <label class="field"><span>Nombre</span><input type="text" name="name" required maxlength="120"></label>
        <label class="field"><span>Marca</span><input type="text" name="brand" list="brands-list" required maxlength="60" placeholder="Elige o escribe una marca"><datalist id="brands-list">${brands.map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist></label>
        <label class="field"><span>Categoría</span>${select('category', CATEGORIES, 'Unisex')}</label>
        <label class="field"><span>Subcategoría</span><input type="text" name="subcategory" maxlength="30" placeholder="Opcional (ej. Niñas)"></label>
        <label class="field"><span>Tipo</span>${select('kind', KINDS, 'Perfume')}</label>
        <label class="field"><span>Familia olfativa</span><input type="text" name="family" list="families" maxlength="40"><datalist id="families">${families.map((f) => `<option value="${f}">`).join('')}</datalist></label>
      </div>
      <label class="field"><span>Notas olfativas</span><input type="text" name="notes" maxlength="160" placeholder="Jazmín, vainilla, almizcle"></label>
      <label class="field"><span>Descripción</span><textarea name="description" maxlength="1200"></textarea></label>
      <div class="field"><span>Foto</span>${photoField('')}</div>
      <label class="switch"><input type="checkbox" name="is_new"><span class="track" aria-hidden="true"></span><span>Marcar como novedad</span></label>
      <label class="field"><span>Color del líquido</span><input type="color" name="color" value="#d4a84b"><small>Se usa en la ilustración mientras el producto no tenga foto.</small></label>
      <div><p class="label">Tamaños y stock inicial</p><div id="vrows">${vrowHTML({ size_ml: 50 })}${vrowHTML({ size_ml: 100 })}</div>
        <p style="margin-top:10px"><button type="button" class="btn btn-sm btn-outline" data-act="add-vrow">${icon('plus', 16)} Agregar tamaño</button></p></div>
      <label class="field"><span>Proveedor</span><select name="supplier_id">${supplierOptions(kit.suppliers[0]?.id)}</select></label>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      const variants = [...form.querySelectorAll('.vrow')].map((row) => {
        const o = {};
        row.querySelectorAll('[data-k]').forEach((i) => (o[i.dataset.k] = i.value));
        o.supplier_id = f.get('supplier_id') || null;
        return o;
      });
      await api('/api/admin/products', {
        method: 'POST',
        body: {
          name: f.get('name'), brand: f.get('brand'), category: f.get('category'), subcategory: f.get('subcategory'), kind: f.get('kind'),
          family: f.get('family'), notes: f.get('notes'), description: f.get('description'), color: f.get('color'), image: f.get('image') || '', is_new: f.get('is_new') === 'on', variants,
        },
      });
      toast('Producto creado. Ya aparece en la tienda y su stock inicial quedó registrado.');
      show(state.view, { silent: true });
    },
  });
}

function editProductDialog(id) {
  const p = state.prod.data.rows.find((x) => x.id === id);
  if (!p) return;
  const cats = p.category === 'Sin clasificar' ? [...CATEGORIES, 'Sin clasificar'] : CATEGORIES;
  openModal({
    title: `Editar · ${p.name}`,
    wide: true,
    body: `<div class="grid-2">
        <label class="field"><span>Nombre</span><input type="text" name="name" required maxlength="120" value="${esc(p.name)}"></label>
        <label class="field"><span>Marca</span><input type="text" name="brand" maxlength="60" value="${esc(p.brand)}"></label>
        <label class="field"><span>Categoría</span>${select('category', cats, p.category)}</label>
        <label class="field"><span>Subcategoría</span><input type="text" name="subcategory" maxlength="30" value="${esc(p.subcategory || '')}"></label>
        <label class="field"><span>Tipo</span>${select('kind', KINDS, p.kind)}</label>
        <label class="field"><span>Familia olfativa</span><input type="text" name="family" maxlength="40" value="${esc(p.family || '')}"></label>
      </div>
      <label class="field"><span>Notas olfativas</span><input type="text" name="notes" maxlength="160" value="${esc(p.notes || '')}" placeholder="Jazmín, vainilla, almizcle"></label>
      <label class="field"><span>Descripción</span><textarea name="description" maxlength="1200" rows="5">${esc(p.description || '')}</textarea><small>Es el texto que ve el cliente en la ficha del producto.</small></label>
      <div class="field"><span>Foto</span>${photoField(p.image || '')}</div>
      <label class="switch"><input type="checkbox" name="is_new" ${p.is_new ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Marcar como novedad</span></label>`,
    onOpen: (dlg) => { bindPhotoField(dlg); dlg.querySelector('input[name=name]')?.focus(); },
    onSubmit: async (form) => {
      const f = new FormData(form);
      await api(`/api/admin/products/${id}`, {
        method: 'PATCH',
        body: { name: f.get('name'), brand: f.get('brand'), category: f.get('category'), subcategory: f.get('subcategory'), kind: f.get('kind'), family: f.get('family'), notes: f.get('notes'), description: f.get('description'), image: f.get('image') || '', is_new: f.get('is_new') === 'on' },
      });
      toast('Producto actualizado.');
      show(state.view, { silent: true });
    },
  });
}

// ═══ COMPRAS ═══════════════════════════════════════════════════════════════
async function renderPurchases() {
  const purchases = await api('/api/admin/purchases');
  const stBadge = { pendiente: '<span class="badge low">Pendiente</span>', recibida: '<span class="badge ok">Recibida</span>', cancelada: '<span class="badge danger">Cancelada</span>' };
  const html = purchases.length
    ? purchases
        .map(
          (p) => `<section class="panel light pcard">
      <div class="pcard-head"><div><h3>Compra #${p.id} · ${esc(p.supplier_name)}</h3><p class="caption upper muted">${fmtDateTime(p.created_at)}${p.received_at ? ` · recibida ${fmtDateTime(p.received_at)}` : ''}</p></div>
        <div class="tags">${stBadge[p.status]}${p.auto ? '<span class="badge info">Automática</span>' : ''}</div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Producto</th><th>SKU</th><th class="r">Cantidad</th><th class="r">Costo unit.</th><th class="r">Subtotal</th></tr></thead><tbody>
        ${p.items.map((i) => `<tr><td>${esc(i.name)} · ${sizeLabel(i.size_ml)}</td><td class="nowrap">${esc(i.sku)}</td><td class="r">${i.qty}</td><td class="r">${money(i.unit_cost)}</td><td class="r">${money(i.qty * i.unit_cost)}</td></tr>`).join('')}</tbody></table></div>
      <div class="pcard-foot"><strong class="h-sm">${money(p.total)}</strong>
        ${p.status === 'pendiente' ? `<div class="pcard-acts"><button type="button" class="btn btn-solid btn-sm" data-act="receive" data-id="${p.id}">${icon('check', 16)} Marcar como recibida</button><button type="button" class="btn btn-outline btn-sm" data-act="cancel-purchase" data-id="${p.id}">Cancelar</button></div>` : ''}</div>
    </section>`
        )
        .join('')
    : '<section class="panel light"><p class="empty-note">Aún no hay órdenes de compra. Se crean solas cuando un producto llega a su stock mínimo.</p></section>';
  return {
    html,
    actions: `<button type="button" class="btn btn-outline" data-act="auto-purchases">${icon('zap', 18)} Generar sugeridas</button><button type="button" class="btn btn-lemon" data-act="new-purchase">${icon('plus', 18)} Nueva orden</button>`,
  };
}

// En lugar de un selector con miles de opciones, cada fila busca en el servidor.
function purchaseRowHTML() {
  return `<div class="vrow purchase">
    <label class="field"><span>Producto</span>
      <input type="search" data-k="q" placeholder="Buscar por nombre o SKU" autocomplete="off">
      <select data-k="variant_id" required><option value="">Escribe para buscar…</option></select></label>
    <label class="field"><span>Cantidad</span><input type="number" data-k="qty" min="1" step="1" value="12" required></label>
    <label class="field"><span>Costo unit. ($)</span><input type="number" data-k="unit_cost" min="0" step="0.01" value="0" required></label>
    <button type="button" class="icon-btn sm" data-act="del-vrow" aria-label="Quitar" title="Quitar">${icon('trash', 18)}</button></div>`;
}

async function fillPurchaseOptions(row) {
  const q = row.querySelector('[data-k=q]').value.trim();
  const sel = row.querySelector('[data-k=variant_id]');
  if (q.length < 2) return void (sel.innerHTML = '<option value="">Escribe para buscar…</option>');
  const r = await api(`/api/admin/inventory?${qs({ q, limit: 15 })}`);
  sel.innerHTML = r.rows.length
    ? r.rows.map((v) => `<option value="${v.id}" data-cost="${v.cost}">${esc(v.name)} · ${sizeLabel(v.size_ml)} (${esc(v.sku)})</option>`).join('') + (r.total > r.rows.length ? `<option disabled>… y ${r.total - r.rows.length} más: afina la búsqueda</option>` : '')
    : '<option value="">Sin coincidencias</option>';
  const first = sel.selectedOptions[0];
  if (first?.dataset.cost !== undefined) row.querySelector('[data-k=unit_cost]').value = first.dataset.cost;
}
const fillPurchaseOptionsSoon = debounce((row) => fillPurchaseOptions(row).catch(() => {}));

function newPurchaseDialog() {
  openModal({
    title: 'Nueva orden de compra',
    wide: true,
    submit: 'Crear orden',
    body: `<label class="field"><span>Proveedor</span><select name="supplier_id" required>${kit.suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <div><p class="label">Productos</p><div id="vrows">${purchaseRowHTML()}</div>
      <p style="margin-top:10px"><button type="button" class="btn btn-sm btn-outline" data-act="add-prow">${icon('plus', 16)} Agregar producto</button></p></div>
      <label class="field"><span>Notas (opcional)</span><input type="text" name="notes" maxlength="160"></label>`,
    onOpen: (dlg) => {
      dlg.addEventListener('input', (e) => {
        if (e.target.dataset.k === 'q') fillPurchaseOptionsSoon(e.target.closest('.vrow'));
      });
      dlg.addEventListener('change', (e) => {
        if (e.target.dataset.k !== 'variant_id') return;
        const cost = e.target.selectedOptions[0]?.dataset.cost;
        const input = e.target.closest('.vrow').querySelector('[data-k=unit_cost]');
        if (cost !== undefined) input.value = cost;
      });
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const items = [...form.querySelectorAll('.vrow')].map((row) => ({
        variant_id: row.querySelector('[data-k=variant_id]').value,
        qty: row.querySelector('[data-k=qty]').value,
        unit_cost: row.querySelector('[data-k=unit_cost]').value,
      }));
      if (items.some((i) => !i.variant_id)) throw new ApiError(400, 'Elige un producto en cada fila (escribe para buscarlo).');
      await api('/api/admin/purchases', { method: 'POST', body: { supplier_id: f.get('supplier_id'), notes: f.get('notes'), items } });
      toast('Orden de compra creada.');
      show(state.view, { silent: true });
    },
  });
}

// ═══ RESEÑAS ═══════════════════════════════════════════════════════════════
// Moderación: cualquiera puede escribir una reseña en la página de un producto; aquí se eliminan las que no deban mostrarse.
async function renderReviewsAdmin() {
  const d = await api(`/api/admin/reviews?page=${state.rev.page}&limit=25`);
  state.rev.page = d.page;
  const rows = d.reviews
    .map(
      (r) => `<tr><td class="nowrap">${fmtDateTime(r.created_at)}</td>
        <td><span class="name">${esc(r.product_name)}</span><span class="sub-line">${esc(r.product_brand)}</span></td>
        <td class="nowrap"><b>${r.rating}</b>/5</td>
        <td class="rev-text">${r.title ? `<b>${esc(r.title)}</b><br>` : ''}${esc(r.body)}</td>
        <td>${esc(r.author)}${r.sample ? ' <span class="badge">Ejemplo</span>' : ''}</td>
        <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="del-review" data-id="${r.id}" data-author="${esc(r.author)}">Eliminar</button></div></td></tr>`
    )
    .join('');
  const html = `<section class="panel light">
    <p class="muted rev-intro">${num(d.total)} ${d.total === 1 ? 'reseña' : 'reseñas'}${d.total ? ` · promedio ${String(d.avg.toFixed(1)).replace('.', ',')} de 5` : ''}. Las más recientes primero; las de ejemplo de la demostración llevan la marca «Ejemplo».</p>
    ${d.total ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Producto</th><th>Calificación</th><th>Reseña</th><th>Autor</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${pagerHTML(d, 'pg-rev')}` : '<p class="sub">Todavía no hay reseñas.</p>'}
  </section>`;
  return { html };
}

// ═══ MOVIMIENTOS ═══════════════════════════════════════════════════════════
async function renderMovements() {
  const moves = await api(`/api/admin/movements?limit=200&type=${state.movType}`);
  const html = `<section class="panel light">
    <div class="toolbar-adm"><div class="seg" role="group" aria-label="Filtrar por tipo" id="mov-filter">
      ${[['', 'Todos'], ['entrada', 'Entradas'], ['salida', 'Salidas'], ['ajuste', 'Ajustes']].map(([v, t]) => `<button type="button" class="seg-btn ${state.movType === v ? 'is-active' : ''}" data-type="${v}" aria-pressed="${state.movType === v}">${t}</button>`).join('')}
    </div><span class="caption upper muted">Se actualiza solo cada pocos segundos</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Producto</th><th>SKU</th><th>Tipo</th><th class="r">Cantidad</th><th class="r">Saldo</th><th>Motivo</th></tr></thead><tbody>
    ${moves.map((m) => `<tr><td class="nowrap">${fmtDateTime(m.created_at)}</td><td><span class="name">${esc(m.name)}</span><span class="sub-line">${sizeLabel(m.size_ml)}</span></td><td class="nowrap">${esc(m.sku)}</td><td>${typeBadge(m.type)}</td><td class="r">${signed(m.qty)}</td><td class="r num">${m.balance ?? '—'}</td><td>${esc(m.reason)}</td></tr>`).join('')}
    </tbody></table></div></section>`;
  return { html };
}

// ═══ WOOCOMMERCE ═══════════════════════════════════════════════════════════
const LEVELS = { error: ['danger', 'Error'], warn: ['low', 'Revisar'], info: ['info', 'Aviso'] };

function reportHTML(rep, { preview = null, applied = null } = {}) {
  const c = rep.completeness;
  const bars = [['Marca', c.marca], ['Categoría reconocida', c.categoria], ['Foto', c.foto], ['Precio', c.precio], ['Inventario controlado', c.inventario], ['Descripción', c.descripcion]]
    .map(([l, p]) => `<div class="bar-row"><div class="bar-top"><b>${l}</b><span class="num">${p}%</span></div><div class="meter"><i style="width:${p}%"></i></div></div>`)
    .join('');
  const list = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<li><span>${k === 'Sin clasificar' ? '<span class="badge low">Sin clasificar</span>' : esc(k)}</span><b class="num">${num(n)}</b></li>`)
      .join('');
  const toReview = rep.issues.filter((i) => i.level !== 'info').reduce((n, i) => n + i.count, 0);
  const second = applied
    ? `<p class="label">Creados · actualizados</p><p class="kpi-value num">${num(applied.products.created)} · ${num(applied.products.updated)}</p><p class="kpi-sub">${num(applied.variants.created)} variantes nuevas · ${num(applied.stock_adjusted)} ajustes de stock</p>`
    : preview
      ? `<p class="label">Nuevos · existentes</p><p class="kpi-value num">${num(preview.products.create)} · ${num(preview.products.update)}</p><p class="kpi-sub">${num(preview.variants.create)} variantes nuevas · ${num(preview.variants.update)} existentes</p>`
      : `<p class="label">Ocultos</p><p class="kpi-value num">${num(rep.inactive)}</p><p class="kpi-sub">borradores o sin precio</p>`;
  const issues = rep.issues.length
    ? rep.issues
        .map((i) => {
          const [cls, label] = LEVELS[i.level];
          return `<details class="issue"><summary><span class="badge ${cls}">${label}</span><b>${esc(i.label)}</b><span class="num">${num(i.count)}</span></summary>
            <p class="muted">${esc(i.help)}</p>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fila</th><th>SKU</th><th>Producto</th><th>Detalle</th></tr></thead><tbody>
              ${i.samples.slice(0, 8).map((x) => `<tr><td class="nowrap">${esc(x.row)}</td><td class="nowrap">${esc(x.sku || '—')}</td><td>${esc(x.name || '—')}</td><td>${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></div>
            ${i.count > 8 ? `<p class="caption muted">Mostrando 8 de ${num(i.count)}. El informe completo se descarga abajo.</p>` : ''}</details>`;
        })
        .join('')
    : '<p class="empty-note">No se encontró ningún problema en los datos.</p>';
  return `<div class="row cols-4">
      <section class="panel light kpi"><p class="label">Productos</p><p class="kpi-value num">${num(rep.products)}</p><p class="kpi-sub">${num(rep.variants)} variantes · ${num(rep.records)} filas leídas</p></section>
      <section class="panel light kpi">${second}</section>
      <section class="panel light kpi"><p class="label">Salud de los datos</p><p class="kpi-value num">${rep.score}%</p><p class="kpi-sub">promedio de completitud</p></section>
      <section class="panel light kpi"><p class="label">Por revisar</p><p class="kpi-value num">${num(toReview)}</p><p class="kpi-sub">${num(rep.mapping.categories['Sin clasificar'] || 0)} sin clasificar</p></section>
    </div>
    <div class="row cols-3">
      <section class="panel light"><div class="panel-head"><h2>Completitud</h2></div>${bars}</section>
      <section class="panel light"><div class="panel-head"><h2>Categorías</h2></div><ul class="kv">${list(rep.mapping.categories)}</ul></section>
      <section class="panel light"><div class="panel-head"><h2>Tipos</h2></div><ul class="kv">${list(rep.mapping.kinds)}</ul></section>
    </div>
    <section class="panel light"><div class="panel-head"><h2>Qué hay que revisar</h2>
      <button type="button" class="btn btn-sm btn-outline" data-act="woo-issues-csv" ${rep.issues.length ? '' : 'disabled'}>${icon('download', 16)} Descargar informe (CSV)</button></div>${issues}</section>`;
}

async function renderWoo() {
  const s = await api('/api/admin/woo/status');
  const w = state.woo;
  const job = s.job;
  const badge = (ok, yes, no) => `<span class="badge ${ok ? 'ok' : ''}">${ok ? yes : no}</span>`;
  const pct = job.pages ? Math.round((job.page / job.pages) * 100) : 0;
  const events = s.events.length
    ? `<ul class="list">${s.events.map((e) => `<li><div class="who"><b>${esc(e.topic)}${e.woo_order_id ? ` · #${esc(e.woo_order_id)}` : ''}</b><span>${fmtDateTime(e.created_at)}${e.note ? ` · ${esc(e.note)}` : ''}</span></div><div class="tags"><span class="badge ${['descontado', 'sincronizado', 'revertido', 'actualizado'].includes(e.status) ? 'ok' : ''}">${esc(e.status)}</span></div></li>`).join('')}</ul>`
    : '<p class="empty-note">Todavía no llegó ningún aviso de WooCommerce.</p>';
  const stockFlag = w.updateStock ?? !s.push;
  const origin = location.origin;

  let jobHTML = '';
  if (job.running) jobHTML = `<div class="notice"><b>Leyendo tu catálogo…</b> ${esc(job.phase)}${job.pages ? ` · página ${job.page} de ${job.pages} (${pct}%)` : ''}<div class="meter"><i style="width:${pct}%"></i></div></div>`;
  else if (job.error) jobHTML = `<p class="err-text" role="alert">La última sincronización falló: ${esc(job.error)}</p>`;
  else if (job.result) jobHTML = `<div class="notice ok">${job.result.applied ? `Catálogo sincronizado: ${num(job.result.applied.products.created)} productos nuevos, ${num(job.result.applied.products.updated)} actualizados.` : 'Revisión terminada (no se guardó nada).'}</div>`;

  const html = `
  <div class="row cols-2">
    <section class="panel light">
      <div class="panel-head"><h2>Conexión</h2>${badge(s.configured, `Conectado a ${esc(s.host)}`, 'Sin configurar')}</div>
      ${
        s.configured
          ? `<ul class="kv">
              <li><span>Envío de stock a WooCommerce</span>${badge(s.push, 'Activo', 'Desactivado')}</li>
              <li><span>Avisos de pedidos (webhook)</span>${badge(s.webhook.configured, 'Listo', 'Sin secreto')}</li>
              <li><span>Productos enlazados</span><b class="num">${num(s.linked.products)} · ${num(s.linked.variants)} variantes</b></li>
              <li><span>Stock por enviar</span><b class="num">${num(s.outbox.pending)}${s.outbox.stuck ? ` · ${num(s.outbox.stuck)} atascados` : ''}</b></li>
            </ul>
            ${s.errors.length ? `<p class="err-text">Último error: ${esc(s.errors[0].sku)} → ${esc(s.errors[0].last_error)}</p>` : ''}
            ${jobHTML}
            <div class="btn-row">
              <button type="button" class="btn btn-sm btn-outline" data-act="woo-test">${icon('zap', 16)} Probar conexión</button>
              <button type="button" class="btn btn-sm btn-outline" data-act="woo-sync-dry" ${job.running ? 'disabled' : ''}>Revisar sin guardar</button>
              <button type="button" class="btn btn-sm btn-solid" data-act="woo-sync" ${job.running ? 'disabled' : ''}>${icon('refresh', 16)} Traer catálogo</button>
              ${s.push ? `<button type="button" class="btn btn-sm btn-outline" data-act="woo-flush">Enviar stock ahora</button>` : ''}
            </div>`
          : `<p>Para conectar tu tienda WooCommerce, crea una clave de lectura y escritura en <b>WooCommerce → Ajustes → Avanzado → API REST</b> y pásala al servidor como variables de entorno (nunca se guardan en archivos ni en la base):</p>
             <pre class="code">WOO_URL=https://tu-tienda.com
WOO_KEY=ck_…
WOO_SECRET=cs_…
WOO_WEBHOOK_SECRET=una-frase-larga
WOO_PUSH_STOCK=1   # opcional: este sistema manda en el stock</pre>
             <p class="muted">Mientras tanto puedes probarlo todo con el CSV de <b>Productos → Exportar</b>, aquí abajo.</p>`
      }
    </section>
    <section class="panel light">
      <div class="panel-head"><h2>Avisos recientes</h2></div>
      ${events}
      <p class="caption muted" style="margin-top:12px">En WooCommerce → Ajustes → Avanzado → Webhooks crea tres avisos (<i>Pedido creado</i>, <i>Pedido actualizado</i>, <i>Producto actualizado</i>) con la URL <b>${esc(origin)}/api/woo/webhook</b> y el mismo secreto. Cada venta de la web descuenta el inventario sola, y no se descuenta dos veces.</p>
    </section>
  </div>

  <section class="panel light">
    <div class="panel-head"><h2>Importar desde el CSV de WooCommerce</h2></div>
    <p>Sube el archivo de <b>Productos → Exportar</b> (en español o inglés). Antes de guardar nada se analiza: se agrupan los tamaños, se clasifican las categorías y se lista todo lo que conviene arreglar.
      <a href="/samples/woocommerce-export-demo.csv" download>Descargar un archivo de ejemplo</a>.</p>
    <div class="grid-2">
      <label class="field"><span>Archivo CSV</span><input type="file" id="woo-file" accept=".csv,text/csv,text/plain"><small>${w.fileName ? `Analizado: ${esc(w.fileName)}` : 'Se analiza al elegirlo; no se guarda nada todavía.'}</small></label>
      <label class="switch"><input type="checkbox" id="woo-stock" ${stockFlag ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Actualizar el stock de los productos que ya existen${s.push ? ' (con el envío activo, este sistema manda: déjalo apagado)' : ''}</span></label>
    </div>
    ${w.report ? `<div class="btn-row" style="margin-top:12px"><button type="button" class="btn btn-lemon" data-act="woo-import">${icon('upload', 18)} Importar ${num(w.report.products)} productos</button></div>` : ''}
  </section>
  <div id="woo-report" class="woo-report">${w.report ? reportHTML(w.report, { preview: w.preview }) : w.done ? `<div class="notice ok">Importación terminada. Los productos ya están en la tienda y en el inventario.</div>${reportHTML(w.done.report, { applied: w.done.applied })}` : ''}</div>
  ${job.result && !w.report ? `<div class="woo-report">${reportHTML(job.result.report, { preview: job.result.preview, applied: job.result.applied })}</div>` : ''}`;

  return {
    html,
    actions: `<a class="btn btn-outline" href="#productos">${icon('package', 18)} Ver productos</a>`,
    after: () => {
      if (job.running) setTimeout(() => state.view === 'woocommerce' && show('woocommerce', { silent: true }), 1200);
    },
  };
}

async function wooAnalyze(file) {
  const w = state.woo;
  const flag = $('#woo-stock')?.checked ?? true;
  const r = await api(`/api/admin/woo/preview?update_stock=${flag ? 1 : 0}`, { method: 'POST', raw: file, contentType: 'text/csv' });
  Object.assign(w, { file, fileName: file.name, report: r.report, preview: r.preview, done: null });
  toast(`Analizado: ${num(r.report.products)} productos, ${num(r.report.variants)} variantes.`);
  show('woocommerce', { silent: true });
}

function downloadIssues() {
  const rep = state.woo.report;
  if (!rep) return;
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['nivel;problema;fila;sku;producto;detalle'];
  for (const i of rep.issues) for (const x of i.samples) lines.push([i.level, i.label, x.row, x.sku, x.name, x.detail].map(cell).join(';'));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'informe-calidad-datos.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ═══ Vistas ════════════════════════════════════════════════════════════════
const VIEWS = {
  resumen: { title: 'Resumen', kicker: 'Hoy en la tienda', render: renderDashboard },
  inventario: { title: 'Inventario', kicker: 'Existencias por tamaño', render: renderInventory },
  productos: { title: 'Productos', kicker: 'Catálogo', render: renderProducts },
  compras: { title: 'Compras', kicker: 'Reposición con proveedores', render: renderPurchases },
  resenas: { title: 'Reseñas', kicker: 'Lo que dicen los clientes', render: renderReviewsAdmin },
  movimientos: { title: 'Movimientos', kicker: 'Libro de entradas y salidas', render: renderMovements },
  woocommerce: { title: 'WooCommerce', kicker: 'Conexión con tu tienda actual', render: renderWoo },
  ...kit.views,
};

// ═══ Acciones (delegación de eventos) ══════════════════════════════════════
const ACTIONS = {
  reload: () => show(state.view),
  'goto-alerts': () => { Object.assign(state.inv, { filter: 'bajo', page: 1, q: '' }); location.hash = '#inventario'; },
  'toggle-chart': () => { state.chartTable = !state.chartTable; show('resumen', { silent: true }); },
  adjust: (el) => attempt(() => adjustDialog(Number(el.dataset.id))),
  history: (el) => attempt(() => historyDialog(Number(el.dataset.id))),
  'edit-variant': (el) => attempt(() => editVariantDialog(Number(el.dataset.id))),
  'print-label': (el) => attempt(async () => {
    const v = await getVariant(Number(el.dataset.id));
    const copies = Math.max(1, Math.min(100, Number($('#label-copies')?.value) || 1));
    showLabelsNow([{ name: v.name, size_ml: v.size_ml, price: v.price, code: v.barcode || v.sku, copies }]);
  }),
  import: importDialog,
  template: () => attempt(downloadTemplate),
  'new-product': () => attempt(newProductDialog),
  'edit-product': (el) => editProductDialog(Number(el.dataset.id)),
  'toggle-product': (el) => attempt(async () => {
    const p = state.prod.data.rows.find((x) => x.id === Number(el.dataset.id));
    await api(`/api/admin/products/${p.id}`, { method: 'PATCH', body: { active: !p.active } });
    toast(p.active ? 'Producto oculto en la tienda.' : 'Producto visible en la tienda.');
    show(state.view, { silent: true });
  }),
  'pg-inv': (el) => { state.inv.page = Number(el.dataset.page); reloadInv(); },
  'pg-rev': (el) => { state.rev.page = Number(el.dataset.page); show('resenas', { silent: true }); },
  'del-review': (el) => attempt(async () => {
    if (!confirm(`¿Eliminar la reseña de ${el.dataset.author}? Dejará de mostrarse en la tienda.`)) return;
    await api(`/api/admin/reviews/${el.dataset.id}`, { method: 'DELETE' });
    toast('Reseña eliminada.');
    show('resenas', { silent: true });
  }),
  'pg-prod': (el) => { state.prod.page = Number(el.dataset.page); reloadProducts(); },
  'add-vrow': () => $('#vrows').insertAdjacentHTML('beforeend', vrowHTML()),
  'add-prow': () => $('#vrows').insertAdjacentHTML('beforeend', purchaseRowHTML()),
  'del-vrow': (el) => {
    const wrap = el.closest('#vrows');
    if (wrap.children.length > 1) el.closest('.vrow').remove();
  },
  'new-purchase': () => attempt(newPurchaseDialog),
  'auto-purchases': () => attempt(async () => {
    const r = await api('/api/admin/purchases/auto', { method: 'POST', body: {} });
    toast(r.items ? `Se agregaron ${r.items} ${r.items === 1 ? 'producto' : 'productos'} a ${r.purchases} ${r.purchases === 1 ? 'orden' : 'órdenes'}.` : 'No hay productos bajo el mínimo sin orden pendiente.');
    show(state.view, { silent: true });
  }),
  receive: (el) => attempt(async () => {
    await api(`/api/admin/purchases/${el.dataset.id}/status`, { method: 'POST', body: { status: 'recibida' } });
    toast('Compra recibida: el stock subió automáticamente.');
    show(state.view, { silent: true });
  }),
  'cancel-purchase': (el) => attempt(async () => {
    if (!confirm('¿Cancelar esta orden de compra?')) return;
    await api(`/api/admin/purchases/${el.dataset.id}/status`, { method: 'POST', body: { status: 'cancelada' } });
    toast('Orden cancelada.');
    show(state.view, { silent: true });
  }),
  'woo-test': () => attempt(async () => {
    const r = await api('/api/admin/woo/test', { method: 'POST', body: {} });
    toast(`Conexión correcta: ${num(r.products)} productos en WooCommerce.`);
  }),
  'woo-sync': () => attempt(async () => {
    if (!confirm('Se leerá todo el catálogo de WooCommerce y se actualizará este sistema (precios, datos y productos nuevos). ¿Continuar?')) return;
    await api('/api/admin/woo/sync', { method: 'POST', body: {} });
    show('woocommerce', { silent: true });
  }),
  'woo-sync-dry': () => attempt(async () => {
    state.woo.report = null;
    await api('/api/admin/woo/sync', { method: 'POST', body: { dry: true } });
    show('woocommerce', { silent: true });
  }),
  'woo-flush': () => attempt(async () => {
    const r = await api('/api/admin/woo/flush', { method: 'POST', body: {} });
    toast(`Stock enviado: ${r.sent} ${r.sent === 1 ? 'variante' : 'variantes'}${r.failed ? `, ${r.failed} con error` : ''}.`, r.failed ? 'error' : 'ok');
    show('woocommerce', { silent: true });
  }),
  'woo-import': () => attempt(async () => {
    const w = state.woo;
    if (!w.file) return;
    if (!confirm(`Se importarán ${num(w.report.products)} productos. Los que ya existen se actualizan (no se duplican). ¿Continuar?`)) return;
    const flag = $('#woo-stock')?.checked ?? true;
    const r = await api(`/api/admin/woo/import?update_stock=${flag ? 1 : 0}`, { method: 'POST', raw: w.file, contentType: 'text/csv' });
    toast(`Importado: ${num(r.applied.products.created)} productos nuevos, ${num(r.applied.products.updated)} actualizados.`);
    Object.assign(w, { file: null, fileName: '', report: null, preview: null, done: { report: r.report, applied: r.applied } });
    show('woocommerce', { silent: true });
  }),
  'woo-issues-csv': downloadIssues,
  ...kit.actions,
};

function bind() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const act = t.closest('[data-act]');
    if (act && ACTIONS[act.dataset.act]) {
      ACTIONS[act.dataset.act](act, e);
      return;
    }
    if (t.closest('[data-modal-close]')) return closeModal();
    const f = t.closest('#inv-filter [data-filter]');
    if (f) {
      Object.assign(state.inv, { filter: f.dataset.filter, page: 1 });
      return reloadInv();
    }
    const m = t.closest('#mov-filter [data-type]');
    if (m) {
      state.movType = m.dataset.type;
      return show('movimientos');
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'inv-q') { Object.assign(state.inv, { q: e.target.value, page: 1 }); reloadInvSoon(); }
    if (e.target.id === 'prod-q') { Object.assign(state.prod, { q: e.target.value, page: 1 }); reloadProductsSoon(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'woo-file' && e.target.files[0]) attempt(() => wooAnalyze(e.target.files[0]));
    if (e.target.id === 'woo-stock') state.woo.updateStock = e.target.checked;
    if (e.target.id === 'prod-cat') { Object.assign(state.prod, { category: e.target.value, page: 1 }); reloadProducts(); }
    if (e.target.id === 'prod-status') { Object.assign(state.prod, { status: e.target.value, page: 1 }); reloadProducts(); }
    if (e.target.id === 'auto-toggle') {
      attempt(async () => {
        await api('/api/admin/settings', { method: 'PATCH', body: { auto_reorder: e.target.checked } });
        toast(e.target.checked ? 'Reposición automática activada.' : 'Reposición automática desactivada.');
      });
    }
  });

  bindModal();

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('/api/login', { method: 'POST', body: { username: $('#login-user').value.trim() || 'admin', password: $('#login-pw').value } });
      setToken(token);
      await enter();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
  $('#btn-logout').addEventListener('click', () => { setToken(null); kit.user = null; showLogin(); });
  $('#btn-account').addEventListener('click', () => ACTIONS['my-account']?.());
  $('#btn-policy').addEventListener('click', () => ACTIONS.policy?.());
  $('#btn-reset').addEventListener('click', () => attempt(async () => {
    if (!confirm('Esto borra todas las ventas, compras y movimientos y vuelve a cargar los datos de ejemplo. Los usuarios del panel se conservan. ¿Continuar?')) return;
    await api('/api/admin/reset', { method: 'POST', body: {} });
    kit.onReset?.();
    Object.assign(state.inv, { q: '', filter: 'todos', page: 1 });
    Object.assign(state.prod, { q: '', category: '', status: '', page: 1 });
    toast('Demo reiniciada con los datos de ejemplo.');
    show(state.view);
  }));

  $('#btn-seed').addEventListener('click', () => attempt(async () => {
    if (!confirm('Esto reemplaza el catálogo por uno de prueba de 8.500 productos para mostrar el rendimiento a escala (tarda unos segundos). Las ventas actuales se borran. ¿Continuar?')) return;
    const btn = $('#btn-seed');
    btn.disabled = true;
    toast('Generando el catálogo de prueba…');
    try {
      const r = await api('/api/admin/seed-large', { method: 'POST', body: {} });
      kit.onReset?.();
      Object.assign(state.inv, { q: '', filter: 'todos', page: 1 });
      Object.assign(state.prod, { q: '', category: '', status: '', page: 1 });
      toast(`Listo: ${num(r.products)} productos y ${num(r.variants)} variantes.`);
      show(state.view);
    } finally {
      btn.disabled = false;
    }
  }));

  window.addEventListener('hashchange', route);
  window.addEventListener('aurelia:logout', () => showLogin('Tu sesión expiró. Vuelve a entrar.'));

  // Refresco silencioso: ideal para ver una compra de la tienda aparecer en vivo.
  setInterval(() => {
    if (document.hidden || $('#app').hidden || !['resumen', 'movimientos', 'pedidos', 'avisos'].includes(state.view)) return;
    if ($('dialog[open]') || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    show(state.view, { silent: true });
  }, 8000);
}

// ─── Inicio ────────────────────────────────────────────────────────────────
async function boot() {
  mountThemeSwitch();
  bind();
  if (!hasToken()) return showLogin();
  try {
    await enter();
  } catch {
    showLogin();
  }
}
boot();
