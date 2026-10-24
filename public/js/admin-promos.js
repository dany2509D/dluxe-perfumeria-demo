// Promociones: ofertas que se aplican solas a la bolsa y cupones con código. En cada compra se aplica una sola: la que más descuenta.
import { api, money, esc, icon, toast } from './ui.js';
import { attempt, openModal, kit } from './admin-kit.js';

const KIND = { percent: 'Porcentaje', fixed: 'Monto fijo', bundle: 'Llévate N por…' };
const STATE = { vigente: ['ok', 'Vigente'], programada: ['info', 'Programada'], vencida: ['', 'Vencida'], agotada: ['', 'Agotada'], inactiva: ['', 'Inactiva'] };
let cache = null;

const describe = (p) => (p.kind === 'percent' ? `${p.amount}% de descuento` : p.kind === 'fixed' ? `${money(p.amount)} menos` : `Llévate ${p.buy_qty} por ${money(p.amount)}`);
const scopeText = (p) => ({ todo: 'Toda la tienda', marca: `Marca: ${p.scope_value}`, categoria: `Categoría: ${p.scope_value}`, tipo: `Tipo: ${p.scope_value}` }[p.scope]);
const dates = (p) => (p.starts_at || p.ends_at ? `${p.starts_at || 'ya'} → ${p.ends_at || 'sin fin'}` : 'Sin fecha');

async function renderPromos() {
  cache = await api('/api/admin/promotions');
  const rows = cache.promotions;
  const html = `<section class="panel light">
    <p class="muted rev-intro">Las <b>ofertas</b> (sin código) se aplican solas en la bolsa; los <b>cupones</b> los escribe el cliente. Se aplica una sola promoción por compra: la que más descuenta. Los productos que ya tienen precio tachado y los sets de regalo no entran, salvo que lo cambies aquí.</p>
    ${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Promoción</th><th>Código</th><th>Descuento</th><th>Aplica a</th><th>Vigencia</th><th class="r">Usos</th><th>Estado</th><th></th></tr></thead><tbody>
      ${rows.map((p) => `<tr class="${p.active ? '' : 'is-inactive'}"><td><span class="name">${esc(p.name)}</span><span class="sub-line">${p.channel === 'ambos' ? 'Tienda y mostrador' : p.channel === 'online' ? 'Solo en línea' : 'Solo mostrador'}${p.min_total ? ` · compra mínima ${money(p.min_total)}` : ''}${p.per_customer ? ' · una vez por cliente' : ''}</span></td>
        <td>${p.code ? `<b>${esc(p.code)}</b>` : '<span class="muted">automática</span>'}</td><td>${esc(describe(p))}</td><td>${esc(scopeText(p))}</td><td class="nowrap">${esc(dates(p))}</td>
        <td class="r">${p.uses}${p.max_uses ? ` / ${p.max_uses}` : ''}</td><td><span class="badge ${STATE[p.state]?.[0] || ''}">${STATE[p.state]?.[1] || esc(p.state)}</span></td>
        <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="promo-edit" data-id="${p.id}">Editar</button>
          <button type="button" class="btn btn-sm btn-outline" data-act="promo-toggle" data-id="${p.id}">${p.active ? 'Pausar' : 'Activar'}</button>
          <button type="button" class="icon-btn sm" data-act="promo-del" data-id="${p.id}" aria-label="Eliminar ${esc(p.name)}">${icon('trash', 16)}</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty-note">Todavía no hay promociones.</p>'}
  </section>`;
  return { html, actions: `<button type="button" class="btn btn-lemon" data-act="promo-new">${icon('plus', 18)} Nueva promoción</button>` };
}

function dialog(p = null) {
  const v = p || { kind: 'percent', amount: '', buy_qty: 2, scope: 'todo', scope_value: '', min_total: 0, skip_sale: 1, channel: 'ambos', active: 1 };
  const opts = (list, sel) => list.map(([k, t]) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const values = { marca: cache.brands, categoria: cache.categories, tipo: cache.kinds };
  openModal({
    title: p ? `Editar · ${p.name}` : 'Nueva promoción',
    wide: true,
    submit: p ? 'Guardar' : 'Crear promoción',
    body: `<div class="grid-2">
        <label class="field"><span>Nombre (lo ve el cliente)</span><input type="text" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="Temporada de verano: 15% en Atelier Sol"></label>
        <label class="field"><span>Código (déjalo vacío para que se aplique sola)</span><input type="text" name="code" maxlength="24" value="${esc(v.code || '')}" placeholder="VERANO15" style="text-transform:uppercase"></label>
        <label class="field"><span>Tipo de descuento</span><select name="kind">${opts(Object.entries(KIND), v.kind)}</select></label>
        <label class="field"><span id="amount-label">Valor</span><input type="number" name="amount" min="0.01" step="0.01" required value="${v.amount ?? ''}"><small id="amount-help"></small></label>
        <label class="field" id="buy-wrap"><span>Cantidad de productos</span><input type="number" name="buy_qty" min="2" max="12" step="1" value="${v.buy_qty || 2}"><small>«Llévate 2 por $50»: aquí va el 2.</small></label>
        <label class="field"><span>Compra mínima ($)</span><input type="number" name="min_total" min="0" step="0.01" value="${v.min_total || 0}"></label>
        <label class="field"><span>Aplica a</span><select name="scope">${opts([['todo', 'Toda la tienda'], ['marca', 'Una marca'], ['categoria', 'Una categoría'], ['tipo', 'Un tipo de producto']], v.scope)}</select></label>
        <label class="field" id="scope-wrap"><span>¿Cuál?</span><select name="scope_value" id="scope-value"></select></label>
        <label class="field"><span>Dónde vale</span><select name="channel">${opts([['ambos', 'Tienda en línea y mostrador'], ['online', 'Solo tienda en línea'], ['mostrador', 'Solo mostrador']], v.channel)}</select></label>
        <label class="field"><span>Máximo de usos (vacío = sin límite)</span><input type="number" name="max_uses" min="1" step="1" value="${v.max_uses ?? ''}"></label>
        <label class="field"><span>Desde</span><input type="date" name="starts_at" value="${esc(v.starts_at || '')}"></label>
        <label class="field"><span>Hasta (inclusive)</span><input type="date" name="ends_at" value="${esc(v.ends_at || '')}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="skip_sale" ${v.skip_sale ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>No aplicar a productos que ya están en oferta (precio tachado)</span></label>
      <label class="switch"><input type="checkbox" name="per_customer" ${v.per_customer ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Una sola vez por cliente (por correo)</span></label>
      <label class="switch"><input type="checkbox" name="featured" ${v.featured ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Anunciar el código en la tienda (si no, es un código secreto que tú entregas)</span></label>
      <label class="switch"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Activa</span></label>`,
    onOpen: (dlg) => {
      const kind = dlg.querySelector('[name=kind]');
      const scope = dlg.querySelector('[name=scope]');
      const sync = () => {
        const k = kind.value;
        dlg.querySelector('#amount-label').textContent = k === 'percent' ? 'Porcentaje (%)' : k === 'fixed' ? 'Monto a descontar ($)' : 'Precio por grupo ($)';
        dlg.querySelector('#amount-help').textContent = k === 'bundle' ? 'Lo que paga el cliente por cada grupo completo.' : '';
        dlg.querySelector('#buy-wrap').hidden = k !== 'bundle';
        const s = scope.value;
        dlg.querySelector('#scope-wrap').hidden = s === 'todo';
        const list = values[s] || [];
        const sel = dlg.querySelector('#scope-value');
        const current = sel.value || v.scope_value;
        sel.innerHTML = list.map((x) => `<option ${x === current ? 'selected' : ''}>${esc(x)}</option>`).join('');
      };
      kind.addEventListener('change', sync);
      scope.addEventListener('change', () => { dlg.querySelector('#scope-value').value = ''; sync(); });
      sync();
      dlg.querySelector('[name=name]').focus();
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const body = {
        name: f.get('name'), code: f.get('code'), kind: f.get('kind'), amount: f.get('amount'), buy_qty: f.get('buy_qty'), min_total: f.get('min_total'), scope: f.get('scope'),
        scope_value: f.get('scope') === 'todo' ? '' : f.get('scope_value'), channel: f.get('channel'), max_uses: f.get('max_uses'), starts_at: f.get('starts_at'), ends_at: f.get('ends_at'),
        skip_sale: f.get('skip_sale') === 'on', per_customer: f.get('per_customer') === 'on', featured: f.get('featured') === 'on', active: f.get('active') === 'on',
      };
      await api(p ? `/api/admin/promotions/${p.id}` : '/api/admin/promotions', { method: p ? 'PATCH' : 'POST', body });
      toast(p ? 'Promoción actualizada.' : 'Promoción creada.');
      kit.refresh();
    },
  });
}

kit.add({
  nav: { id: 'promociones', label: 'Promociones', icon: 'tag', perm: 'promociones', group: 'Venta', order: 50 },
  views: { promociones: { title: 'Promociones y cupones', kicker: 'Ofertas que se aplican solas y códigos', render: renderPromos } },
  actions: {
    'promo-new': () => dialog(),
    'promo-edit': (el) => dialog(cache.promotions.find((p) => p.id === Number(el.dataset.id))),
    'promo-toggle': (el) => attempt(async () => {
      const p = cache.promotions.find((x) => x.id === Number(el.dataset.id));
      await api(`/api/admin/promotions/${p.id}`, { method: 'PATCH', body: { active: !p.active } });
      toast(p.active ? 'Promoción pausada.' : 'Promoción activada.');
      kit.refresh();
    }),
    'promo-del': (el) => attempt(async () => {
      const p = cache.promotions.find((x) => x.id === Number(el.dataset.id));
      if (!confirm(`¿Eliminar «${p.name}»?${p.uses ? ' Ya se usó, así que solo se desactivará.' : ''}`)) return;
      const r = await api(`/api/admin/promotions/${p.id}`, { method: 'DELETE' });
      toast(r.removed ? 'Promoción eliminada.' : 'Ya se había usado: quedó desactivada.');
      kit.refresh();
    }),
  },
});
