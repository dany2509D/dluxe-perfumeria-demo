// Reportes de gerencia: ventas y margen del período, marcas, canales, rotación del inventario y existencias que no se mueven.
import { api, money, num, esc, icon, toast, fmtDay, sizeLabel } from './ui.js';
import { $, attempt, kit } from './admin-kit.js';
import { showReport } from './admin-print.js';

const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d); };
const state = { tab: 'ventas', from: ago(29), to: day(new Date()), days: 90 };

const PRESETS = [['7 días', () => [ago(6), day(new Date())]], ['30 días', () => [ago(29), day(new Date())]], ['Este mes', () => { const d = new Date(); return [day(new Date(d.getFullYear(), d.getMonth(), 1)), day(d)]; }], ['90 días', () => [ago(89), day(new Date())]], ['Este año', () => [`${new Date().getFullYear()}-01-01`, day(new Date())]]];
const PAY = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', contra_entrega: 'Contra entrega', tarjeta_regalo: 'Tarjeta de regalo' };
const CHAN = { online: 'Tienda en línea', mostrador: 'Mostrador' };

// Barras horizontales: cada fila lleva su nombre, la barra y el valor (la tabla de abajo es el respaldo accesible).
function bars(rows, { value = (r) => r.revenue, label = (r) => r.name, fmt = money, max = null } = {}) {
  const top = max ?? Math.max(...rows.map(value), 1);
  return `<div class="hbars">${rows.map((r) => `<div class="hbar"><span class="hbar-name" title="${esc(label(r))}">${esc(label(r))}</span><span class="hbar-track"><i style="width:${Math.max(2, (value(r) / top) * 100)}%"></i></span><b class="hbar-val num">${fmt(value(r))}</b></div>`).join('')}</div>`;
}

function chart(series) {
  const W = 720, H = 220, L = 46, R = 8, T = 12, B = 30;
  const max = Math.max(...series.map((s) => s.total), 1);
  const nice = 10 ** Math.floor(Math.log10(max)) * Math.ceil(max / 10 ** Math.floor(Math.log10(max)));
  const pw = W - L - R, ph = H - T - B, col = pw / series.length, bw = Math.max(2, col * 0.62);
  const y = (v) => T + ph - (v / nice) * ph;
  const every = Math.ceil(series.length / 12);
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ventas por día">
    ${[0, 0.5, 1].map((f) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(nice * f)}" y2="${y(nice * f)}"/><text x="${L - 6}" y="${y(nice * f) + 4}" text-anchor="end">${money(nice * f).replace('.00', '')}</text>`).join('')}
    ${series.map((s, i) => `<g><title>${esc(fmtDay(s.day))}: ${money(s.total)} · ${s.n} pedidos</title><rect class="bar" x="${L + i * col + (col - bw) / 2}" y="${y(s.total)}" width="${bw}" height="${Math.max(s.total > 0 ? 2 : 0, (s.total / nice) * ph)}"/>${i % every === 0 ? `<text x="${L + i * col + col / 2}" y="${H - 10}" text-anchor="middle">${new Date(s.day + 'T00:00:00').getDate()}/${new Date(s.day + 'T00:00:00').getMonth() + 1}</text>` : ''}</g>`).join('')}
  </svg></div>`;
}

const kpi = (label, value, sub = '') => `<section class="panel light kpi"><p class="label">${label}</p><p class="kpi-value num">${value}</p>${sub ? `<p class="kpi-sub">${sub}</p>` : ''}</section>`;
const pct = (n) => `${String(n.toFixed(1)).replace('.', ',')}%`;

function table(cols, rows) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}">${c.h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

async function sales() {
  const r = await api(`/api/admin/reports/sales?from=${state.from}&to=${state.to}`);
  const k = r.kpis;
  const html = `
  <div class="row cols-4">
    ${kpi('Ventas netas', money(k.net), `${num(k.orders)} pedidos · ticket promedio ${money(k.avg_ticket)}`)}
    ${kpi('Margen', money(k.margin), `${pct(k.margin_pct)} sobre las ventas netas`)}
    ${kpi('Descuentos', money(k.discounts), 'cupones, ofertas y descuentos manuales')}
    ${kpi('Devoluciones', money(k.returns_amount), `${k.returns_count} ${k.returns_count === 1 ? 'devolución' : 'devoluciones'} registradas en el período`)}
  </div>
  <section class="panel forest"><div class="panel-head"><h2>Ventas por día</h2><span class="caption upper muted">${money(r.byDay.reduce((s, d) => s + d.total, 0))} en ${r.byDay.length} días</span></div>${chart(r.byDay)}</section>
  <div class="row cols-2e">
    <section class="panel light"><div class="panel-head"><h2>Por marca</h2></div>${r.brands.length ? bars(r.brands.slice(0, 10)) : '<p class="empty-note">Sin ventas en el período.</p>'}
      ${r.brands.length ? `<details class="more"><summary>Ver tabla con margen</summary>${table([{ h: 'Marca', f: (x) => esc(x.name) }, { h: 'Unid.', r: 1, f: (x) => num(x.units) }, { h: 'Ventas', r: 1, f: (x) => money(x.revenue) }, { h: 'Margen', r: 1, f: (x) => money(x.margin) }, { h: '%', r: 1, f: (x) => pct(x.margin_pct) }], r.brands)}</details>` : ''}</section>
    <section class="panel light"><div class="panel-head"><h2>Por categoría</h2></div>${r.categories.length ? bars(r.categories) : '<p class="empty-note">—</p>'}
      <div class="panel-head" style="margin-top:20px"><h2>Por familia olfativa</h2></div>${r.families.length ? bars(r.families.slice(0, 6)) : '<p class="empty-note">—</p>'}</section>
  </div>
  <div class="row cols-3">
    <section class="panel light"><div class="panel-head"><h2>Canal</h2></div>${table([{ h: 'Canal', f: (x) => esc(CHAN[x.name] || x.name) }, { h: 'Pedidos', r: 1, f: (x) => x.orders }, { h: 'Ventas', r: 1, f: (x) => money(x.revenue) }], r.channel)}</section>
    <section class="panel light"><div class="panel-head"><h2>Forma de pago</h2></div>${table([{ h: 'Pago', f: (x) => esc(PAY[x.name] || x.name) }, { h: 'Pedidos', r: 1, f: (x) => x.orders }, { h: 'Ventas', r: 1, f: (x) => money(x.revenue) }], r.payment)}</section>
    <section class="panel light"><div class="panel-head"><h2>Quién vendió</h2></div>${table([{ h: 'Persona', f: (x) => esc(x.name) }, { h: 'Pedidos', r: 1, f: (x) => x.orders }, { h: 'Ventas', r: 1, f: (x) => money(x.revenue) }], r.seller)}</section>
  </div>
  <div class="row cols-2e">
    <section class="panel light"><div class="panel-head"><h2>Lo más vendido</h2></div>${r.products.length ? table([{ h: 'Producto', f: (x) => esc(x.name) }, { h: 'Unid.', r: 1, f: (x) => num(x.units) }, { h: 'Ventas', r: 1, f: (x) => money(x.revenue) }, { h: 'Margen', r: 1, f: (x) => money(x.margin) }], r.products.slice(0, 12)) : '<p class="empty-note">—</p>'}</section>
    <section class="panel light"><div class="panel-head"><h2>Descuentos dados</h2></div>${r.promos.length ? table([{ h: 'Promoción', f: (x) => esc(x.name) }, { h: 'Pedidos', r: 1, f: (x) => x.orders }, { h: 'Descontado', r: 1, f: (x) => money(x.discount) }], r.promos) : '<p class="empty-note">No se dieron descuentos.</p>'}
      <p class="caption muted" style="margin-top:14px">Tarjetas de regalo: se vendieron ${k.gift_sold_count} por ${money(k.gift_sold_amount)} (dinero por adelantado, no es venta hasta que se usan) y se pagaron ${money(k.gift_redeemed)} de pedidos con ellas.</p></section>
  </div>`;
  return { html, data: r };
}

async function rotation() {
  const r = await api(`/api/admin/reports/rotation?days=${state.days}`);
  const t = r.totals;
  const cover = (x) => (x.cover_days === null ? '—' : x.cover_days > 365 ? 'más de 1 año' : `${x.cover_days} días`);
  const html = `
  <div class="row cols-4">
    ${kpi('Capital en inventario', money(t.capital), `${num(t.products)} productos con existencias (a costo)`)}
    ${kpi('Sin movimiento', money(t.dead_capital), `${num(t.dead_count)} productos sin ninguna venta en ${r.days} días`)}
    ${kpi('Historial disponible', `${r.history_days} días`, r.history_days < r.days ? `Menos que los ${r.days} del reporte: lo «sin movimiento» puede ser solo falta de historial.` : 'Suficiente para el período elegido.')}
  </div>
  <div class="row cols-2e">
    <section class="panel light"><div class="panel-head"><h2>Capital parado</h2><span class="caption upper muted">Con existencias y sin ventas en ${r.days} días</span></div>
      ${r.dead.length ? table([{ h: 'Producto', f: (x) => `<span class="name">${esc(x.name)}</span><span class="sub-line">${esc(x.brand)}</span>` }, { h: 'Stock', r: 1, f: (x) => num(x.stock) }, { h: 'Capital (costo)', r: 1, f: (x) => `<b>${money(x.capital)}</b>` }, { h: 'Última venta', f: (x) => esc(x.last_sale || 'nunca') }], r.dead) : '<p class="empty-note">Todo lo que tienes se ha vendido en el período.</p>'}</section>
    <section class="panel light"><div class="panel-head"><h2>Se acaba pronto</h2><span class="caption upper muted">Cobertura de 14 días o menos</span></div>
      ${r.low_cover.length ? table([{ h: 'Producto', f: (x) => `<span class="name">${esc(x.name)}</span><span class="sub-line">${esc(x.brand)}</span>` }, { h: 'Stock', r: 1, f: (x) => num(x.stock) }, { h: 'Vende / día', r: 1, f: (x) => String(x.per_day).replace('.', ',') }, { h: 'Alcanza', r: 1, f: (x) => `<b>${cover(x)}</b>` }], r.low_cover) : '<p class="empty-note">Nada está por agotarse.</p>'}</section>
  </div>
  <div class="row cols-2e">
    <section class="panel light"><div class="panel-head"><h2>Lo que más rota</h2></div>
      ${r.fast.length ? table([{ h: 'Producto', f: (x) => esc(x.name) }, { h: 'Vendidas', r: 1, f: (x) => num(x.sold) }, { h: 'Stock', r: 1, f: (x) => num(x.stock) }, { h: 'Cobertura', r: 1, f: cover }], r.fast) : '<p class="empty-note">—</p>'}</section>
    <section class="panel light"><div class="panel-head"><h2>Sobrestock</h2><span class="caption upper muted">Alcanza para más de 6 meses</span></div>
      ${r.slow.length ? table([{ h: 'Producto', f: (x) => esc(x.name) }, { h: 'Stock', r: 1, f: (x) => num(x.stock) }, { h: 'Capital', r: 1, f: (x) => money(x.capital) }, { h: 'Cobertura', r: 1, f: cover }], r.slow) : '<p class="empty-note">Ningún producto con exceso.</p>'}</section>
  </div>`;
  return { html, data: r };
}

async function renderReports() {
  const tabs = `<div class="seg" role="tablist">${[['ventas', 'Ventas y márgenes'], ['rotacion', 'Rotación del inventario']].map(([v, t]) => `<button type="button" class="seg-btn ${state.tab === v ? 'is-active' : ''}" data-act="rep-tab" data-tab="${v}" role="tab" aria-selected="${state.tab === v}">${t}</button>`).join('')}</div>`;
  const controls = state.tab === 'ventas'
    ? `<div class="toolbar-adm rep-controls">${PRESETS.map(([t, fn], i) => { const [a, b] = fn(); return `<button type="button" class="seg-btn ${state.from === a && state.to === b ? 'is-active' : ''}" data-act="rep-preset" data-i="${i}">${t}</button>`; }).join('')}
        <label class="field"><span class="sr-only">Desde</span><input type="date" id="rep-from" value="${state.from}" max="${state.to}"></label>
        <label class="field"><span class="sr-only">Hasta</span><input type="date" id="rep-to" value="${state.to}"></label></div>`
    : `<div class="toolbar-adm rep-controls"><span class="caption upper muted">Ventas de los últimos</span>${[30, 60, 90, 180].map((n) => `<button type="button" class="seg-btn ${state.days === n ? 'is-active' : ''}" data-act="rep-days" data-n="${n}">${n} días</button>`).join('')}</div>`;
  const body = state.tab === 'ventas' ? await sales() : await rotation();
  return {
    html: `<section class="panel light">${tabs}${controls}</section>${body.html}`,
    actions: state.tab === 'ventas'
      ? `<button type="button" class="btn btn-outline" data-act="rep-csv" data-what="ventas">${icon('download', 18)} Pedidos (CSV)</button><button type="button" class="btn btn-outline" data-act="rep-csv" data-what="productos">${icon('download', 18)} Productos (CSV)</button><button type="button" class="btn btn-lemon" data-act="rep-print">${icon('printer', 18)} Imprimir</button>`
      : `<button type="button" class="btn btn-lemon" data-act="rep-print">${icon('printer', 18)} Imprimir</button>`,
  };
}

async function download(what) {
  const res = await fetch(`/api/admin/reports/export?what=${what}&from=${state.from}&to=${state.to}`, { headers: { Authorization: `Bearer ${sessionStorage.getItem('aurelia-token')}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo exportar');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${what}-${state.from}-${state.to}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

kit.add({
  nav: { id: 'reportes', label: 'Reportes', icon: 'trending', perm: 'reportes', group: 'Análisis', order: 10 },
  views: { reportes: { title: 'Reportes', kicker: 'Ventas, márgenes y rotación', render: renderReports } },
  actions: {
    'rep-tab': (el) => { state.tab = el.dataset.tab; kit.refresh(); },
    'rep-preset': (el) => { [state.from, state.to] = PRESETS[Number(el.dataset.i)][1](); kit.refresh(); },
    'rep-days': (el) => { state.days = Number(el.dataset.n); kit.refresh(); },
    'rep-csv': (el) => attempt(() => download(el.dataset.what)),
    'rep-print': () => {
      const body = [...document.querySelectorAll('#view > .panel:not(:first-child), #view > .row')].map((n) => n.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '')).join('');
      showReport(state.tab === 'ventas' ? `Ventas del ${state.from} al ${state.to}` : `Rotación del inventario (${state.days} días)`, body);
    },
  },
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'rep-from' || e.target.id === 'rep-to') {
    const from = $('#rep-from').value;
    const to = $('#rep-to').value;
    if (from && to && from <= to) { state.from = from; state.to = to; kit.refresh(); }
    else toast('La fecha de inicio debe ser anterior a la de fin.', 'error');
  }
});
