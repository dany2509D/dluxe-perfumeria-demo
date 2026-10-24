// Sets de regalo: varios perfumes a un precio especial. Cada set se vende como un producto más; al venderlo, cada pieza descuenta su stock.
import { api, money, esc, icon, toast, sizeLabel } from './ui.js';
import { $, attempt, debounce, openModal, kit, qs } from './admin-kit.js';

let sets = [];

async function renderSets() {
  sets = (await api('/api/admin/sets')).sets;
  const html = `<section class="panel light">
    <p class="muted rev-intro">Un set junta perfumes que ya tienes en el inventario y los vende a un precio menor que por separado. No tiene stock propio: se pueden vender tantos sets como alcancen sus piezas.</p>
    ${sets.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Set</th><th>Incluye</th><th class="r">Precio</th><th class="r">Por separado</th><th class="r">Ahorro</th><th class="r">Disponibles</th><th>Tienda</th><th></th></tr></thead><tbody>
      ${sets.map((s) => `<tr class="${s.active ? '' : 'is-inactive'}"><td><span class="name">${esc(s.name)}</span><span class="sub-line">${esc(s.sku)}</span></td>
        <td>${s.components.map((c) => `${c.qty > 1 ? `${c.qty} × ` : ''}${esc(c.name)} ${sizeLabel(c.size_ml)}`).join('<br>')}</td>
        <td class="r"><b>${money(s.price)}</b></td><td class="r">${money(s.compare_at)}</td><td class="r plus">${money(s.compare_at - s.price)}</td>
        <td class="r"><span class="pos-qty">${s.stock}</span></td><td>${s.active ? '<span class="badge ok">Visible</span>' : '<span class="badge">Oculto</span>'}</td>
        <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="set-edit" data-id="${s.product_id}">Editar</button>
          <button type="button" class="btn btn-sm btn-outline" data-act="set-toggle" data-id="${s.product_id}">${s.active ? 'Ocultar' : 'Mostrar'}</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty-note">Todavía no hay sets. Crea el primero con «Nuevo set».</p>'}
  </section>`;
  return { html, actions: `<button type="button" class="btn btn-lemon" data-act="set-new">${icon('plus', 18)} Nuevo set</button>` };
}

const compRow = (c) => `<li class="comp-row" data-variant="${c.variant_id}" data-price="${c.price}">
  <div class="who"><b>${esc(c.name)} · ${sizeLabel(c.size_ml)}</b><span>${money(c.price)} c/u</span></div>
  <div class="stepper" role="group" aria-label="Cantidad"><button type="button" data-comp="dec" aria-label="Menos">${icon('minus', 14)}</button><output>${c.qty}</output><button type="button" data-comp="inc" aria-label="Más">${icon('plus', 14)}</button></div>
  <button type="button" class="icon-btn sm" data-comp="del" aria-label="Quitar">${icon('trash', 16)}</button></li>`;

function dialog(set = null) {
  openModal({
    title: set ? `Editar · ${set.name}` : 'Nuevo set de regalo',
    wide: true,
    submit: set ? 'Guardar' : 'Crear set',
    body: `<div class="grid-2">
        <label class="field"><span>Nombre del set</span><input type="text" name="name" required maxlength="120" value="${esc(set?.name || '')}" placeholder="Set Noche Especial"></label>
        <label class="field"><span>Precio del set ($)</span><input type="number" name="price" min="0.01" step="0.01" required value="${set?.price ?? ''}" id="set-price"><small id="set-help">Debe ser menor que la suma de sus piezas.</small></label>
      </div>
      <div class="field"><span>Productos que incluye</span>
        <input type="search" id="set-search" placeholder="Busca un perfume para agregarlo" autocomplete="off">
        <div class="set-results" id="set-results"></div>
        <ul class="list" id="set-comps">${(set?.components || []).map((c) => compRow({ ...c })).join('')}</ul>
      </div>
      <label class="field"><span>Descripción (opcional)</span><textarea name="description" maxlength="1200" rows="3" placeholder="Si la dejas vacía, se arma sola con la lista de productos.">${set ? '' : ''}</textarea></label>`,
    onOpen: (dlg) => {
      const list = dlg.querySelector('#set-comps');
      const help = dlg.querySelector('#set-help');
      const price = dlg.querySelector('#set-price');
      const sum = () => [...list.querySelectorAll('.comp-row')].reduce((s, li) => s + Number(li.dataset.price) * Number(li.querySelector('output').textContent), 0);
      const refresh = () => {
        const t = sum();
        const p = Number(price.value);
        help.innerHTML = t ? `Por separado cuestan <b>${money(t)}</b>${p > 0 && p < t ? ` · el cliente ahorra <b>${money(t - p)}</b> (${Math.round(((t - p) / t) * 100)}%)` : p >= t && p > 0 ? ' · <span class="err-text">el precio del set debe ser menor</span>' : ''}.` : 'Debe ser menor que la suma de sus piezas.';
      };
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-comp]');
        if (!b) return;
        const li = b.closest('.comp-row');
        const out = li.querySelector('output');
        if (b.dataset.comp === 'del') li.remove();
        else out.textContent = Math.max(1, Math.min(20, Number(out.textContent) + (b.dataset.comp === 'inc' ? 1 : -1)));
        refresh();
      });
      price.addEventListener('input', refresh);
      const search = debounce(async () => {
        const q = dlg.querySelector('#set-search').value.trim();
        const box = dlg.querySelector('#set-results');
        if (q.length < 2) { box.innerHTML = ''; return; }
        const r = await api(`/api/admin/inventory?${qs({ sellable: 1, limit: 8, q })}`).catch(() => ({ rows: [] }));
        box.innerHTML = r.rows.filter((v) => !v.is_set).map((v) => `<button type="button" class="pos-item" data-add="${v.id}" data-name="${esc(v.name)}" data-size="${v.size_ml}" data-price="${v.price}"><span class="who" style="display:grid"><b>${esc(v.name)} · ${sizeLabel(v.size_ml)}</b><span class="muted caption">${esc(v.sku)} · ${v.stock} disp.</span></span><strong>${money(v.price)}</strong></button>`).join('') || '<p class="empty-note">Sin resultados.</p>';
      }, 250);
      dlg.querySelector('#set-search').addEventListener('input', search);
      dlg.querySelector('#set-results').addEventListener('click', (e) => {
        const b = e.target.closest('[data-add]');
        if (!b) return;
        const id = b.dataset.add;
        const existing = list.querySelector(`[data-variant="${id}"] output`);
        if (existing) existing.textContent = Math.min(20, Number(existing.textContent) + 1);
        else list.insertAdjacentHTML('beforeend', compRow({ variant_id: Number(id), name: b.dataset.name, size_ml: Number(b.dataset.size), price: Number(b.dataset.price), qty: 1 }));
        dlg.querySelector('#set-search').value = '';
        dlg.querySelector('#set-results').innerHTML = '';
        refresh();
      });
      refresh();
      dlg.querySelector('[name=name]').focus();
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const components = [...form.querySelectorAll('.comp-row')].map((li) => ({ variant_id: Number(li.dataset.variant), qty: Number(li.querySelector('output').textContent) }));
      const body = { name: f.get('name'), price: f.get('price'), components };
      if (String(f.get('description')).trim()) body.description = f.get('description');
      await api(set ? `/api/admin/sets/${set.product_id}` : '/api/admin/sets', { method: set ? 'PATCH' : 'POST', body });
      toast(set ? 'Set actualizado.' : 'Set creado: ya aparece en la tienda.');
      kit.refresh();
    },
  });
}

kit.add({
  nav: { id: 'sets', label: 'Sets de regalo', icon: 'layers', perm: 'sets', group: 'Inventario', order: 30 },
  views: { sets: { title: 'Sets de regalo', kicker: 'Perfumes que se venden juntos', render: renderSets } },
  actions: {
    'set-new': () => dialog(),
    'set-edit': (el) => dialog(sets.find((s) => s.product_id === Number(el.dataset.id))),
    'set-toggle': (el) => attempt(async () => {
      const s = sets.find((x) => x.product_id === Number(el.dataset.id));
      await api(`/api/admin/sets/${s.product_id}`, { method: 'PATCH', body: { active: !s.active } });
      toast(s.active ? 'Set oculto en la tienda.' : 'Set visible en la tienda.');
      kit.refresh();
    }),
  },
});
