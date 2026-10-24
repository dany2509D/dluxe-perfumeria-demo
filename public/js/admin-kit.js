// Piezas compartidas del panel: utilidades, el diálogo genérico y un registro donde cada sección (módulo) se anota con sus
// pantallas, sus acciones y su entrada en el menú. admin.js arma el panel con lo que se haya registrado.
import { ApiError, esc, num, toast } from './ui.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

export const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// Ejecuta una acción mostrando el error como aviso (la sesión vencida la maneja admin.js).
export const attempt = async (fn) => {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast(e.message, 'error');
  }
};

export function pagerHTML(d, act) {
  if (!d || d.total === 0) return '';
  const from = (d.page - 1) * d.limit + 1;
  const to = Math.min(d.page * d.limit, d.total);
  return `<nav class="pager" aria-label="Paginación"><span class="caption upper muted">${num(from)}–${num(to)} de ${num(d.total)}</span>
    <div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="${act}" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Anterior</button>
    <span class="pager-n">Página ${d.page} de ${d.pages}</span>
    <button type="button" class="btn btn-sm btn-outline" data-act="${act}" data-page="${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>Siguiente</button></div></nav>`;
}

// ─── Diálogo genérico ──────────────────────────────────────────────────────
let modalSubmit = null;

export function openModal({ title, body, submit = 'Guardar', wide = false, onSubmit = null, onOpen = null, closeLabel = 'Cerrar', extraFoot = '' }) {
  const dlg = $('#modal');
  dlg.classList.toggle('wide', wide);
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-err').innerHTML = '';
  $('#modal-foot').innerHTML = onSubmit
    ? `${extraFoot}<button type="button" class="btn btn-outline" data-modal-close>Cancelar</button><button type="submit" class="btn btn-solid" id="modal-submit">${esc(submit)}</button>`
    : `${extraFoot}<button type="button" class="btn btn-solid" data-modal-close>${esc(closeLabel)}</button>`;
  modalSubmit = onSubmit;
  if (!dlg.open) dlg.showModal();
  onOpen?.(dlg);
  if (!onOpen) $('#modal-body input:not([type=hidden]), #modal-body select, #modal-body textarea')?.focus();
}
export const closeModal = () => $('#modal').close();

export function showModalError(e) {
  const details = Array.isArray(e.details) && e.details.length ? `<ul class="errors">${e.details.slice(0, 12).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  $('#modal-err').innerHTML = `${esc(e.message)}${details}`;
}

export function bindModal() {
  $('#modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!modalSubmit) return closeModal();
    const form = e.target;
    if (!form.reportValidity()) return;
    const btn = $('#modal-submit');
    btn.disabled = true;
    $('#modal-err').innerHTML = '';
    try {
      await modalSubmit(form);
      closeModal();
    } catch (err) {
      showModalError(err);
    } finally {
      btn.disabled = false;
    }
  });
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
}

// ─── Registro de secciones ─────────────────────────────────────────────────
// nav:     [{ id, label, icon, perm, group }]  entrada del menú (solo se muestra a quien tenga el permiso)
// views:   { id: { title, kicker, render() → { html, actions?, after? } } }
// actions: { 'nombre-de-data-act': (elemento, evento) => void }
export const GROUPS = ['Venta', 'Inventario', 'Análisis', 'Conexión', 'Administración'];

export const kit = {
  nav: [],
  views: {},
  actions: {},
  user: null,
  suppliers: [],
  can(perm) {
    const p = this.user?.perms || [];
    return Array.isArray(perm) ? perm.some((x) => p.includes(x)) : p.includes(perm);
  },
  refresh: () => {}, // admin.js lo sustituye: vuelve a dibujar la pantalla actual sin parpadeo
  go: (id) => { location.hash = `#${id}`; },
  badges: (d) => d, // admin.js lo sustituye
  add({ nav, views, actions }) {
    if (nav) this.nav.push(...[].concat(nav));
    Object.assign(this.views, views || {});
    Object.assign(this.actions, actions || {});
  },
};

// Pantalla vacía con mensaje (se repite en muchas listas).
export const emptyNote = (msg) => `<p class="empty-note">${esc(msg)}</p>`;

// Formulario → objeto (los campos con name). Los vacíos se omiten salvo que se pida lo contrario.
export function formData(form, { keepEmpty = false } = {}) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) if (keepEmpty || String(v).trim() !== '') out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}
