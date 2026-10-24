// Usuarios del panel (con su rol), bitácora de quién hizo qué, mi cuenta (cambiar clave) y las políticas de la tienda.
import { api, setToken, esc, icon, toast, fmtDateTime } from './ui.js';
import { $, attempt, pagerHTML, debounce, openModal, kit } from './admin-kit.js';

const ROLE_INFO = {
  admin: 'Todo, incluidos usuarios, conexiones y reiniciar la demostración.',
  gerente: 'Ventas, caja de todos, devoluciones, descuentos sin tope, reportes, inventario, promociones y facturas. No gestiona usuarios.',
  cajero: 'Cobra en el mostrador, abre y cierra su caja, ve pedidos y tarjetas de regalo. No ve costos ni reportes.',
  inventario: 'Existencias, productos, sets, compras y movimientos, con costos. No cobra ni ve ventas.',
};
const ROLE_BADGE = { admin: 'danger', gerente: 'low', cajero: 'info', inventario: 'ok' };

let users = [];
let roles = {};

async function renderUsers() {
  const d = await api('/api/admin/users');
  users = d.users;
  roles = d.roles;
  const html = `<section class="panel light">
    <p class="muted rev-intro">Cada persona entra con su propio usuario y ve solo lo que su rol permite. Todo lo que hacen queda en la <a href="#bitacora">bitácora</a>. Los usuarios de ejemplo de la demostración (gerente, cajero, bodega) comparten la contraseña del administrador: en una tienda real, desactívalos o cámbiales la clave.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead><tbody>
    ${users.map((u) => `<tr class="${u.active ? '' : 'is-inactive'}"><td><span class="name">${esc(u.name)}</span>${u.id === kit.user.id ? '<span class="sub-line">(tú)</span>' : ''}</td><td>${esc(u.username)}</td>
      <td><span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.role_label)}</span></td><td>${u.active ? '<span class="badge ok">Activo</span>' : '<span class="badge">Desactivado</span>'}</td>
      <td class="nowrap">${u.last_login ? esc(fmtDateTime(u.last_login)) : '<span class="muted">nunca</span>'}</td>
      <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="user-edit" data-id="${u.id}">Editar</button>
        <button type="button" class="btn btn-sm btn-outline" data-act="user-pass" data-id="${u.id}">${icon('lock', 14)} Clave</button></div></td></tr>`).join('')}
    </tbody></table></div>
    <h3 class="sub" style="margin-top:24px">Qué puede hacer cada rol</h3>
    <ul class="list">${Object.entries(roles).map(([k, label]) => `<li><div class="who"><b><span class="badge ${ROLE_BADGE[k] || ''}">${esc(label)}</span></b><span>${esc(ROLE_INFO[k] || '')}</span></div></li>`).join('')}</ul>
  </section>`;
  return { html, actions: `<button type="button" class="btn btn-lemon" data-act="user-new">${icon('plus', 18)} Nuevo usuario</button>` };
}

const roleOptions = (sel) => Object.entries(roles).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

function userDialog(u = null) {
  openModal({
    title: u ? `Editar · ${u.name}` : 'Nuevo usuario',
    submit: u ? 'Guardar' : 'Crear usuario',
    body: `<div class="grid-2">
        <label class="field"><span>Nombre</span><input type="text" name="name" required maxlength="60" value="${esc(u?.name || '')}"></label>
        <label class="field"><span>Usuario (para entrar)</span><input type="text" name="username" required maxlength="30" value="${esc(u?.username || '')}" ${u ? 'disabled' : ''} autocapitalize="none" spellcheck="false" placeholder="laura"><small>Minúsculas, números, punto o guion.</small></label>
        <label class="field"><span>Rol</span><select name="role" id="role-sel">${roleOptions(u?.role || 'cajero')}</select></label>
        ${u ? '' : '<label class="field"><span>Contraseña inicial</span><input type="password" name="password" required minlength="8" maxlength="100" autocomplete="new-password"><small>Mínimo 8 caracteres. Que la cambie al entrar.</small></label>'}
      </div>
      <p class="hint" id="role-info">${esc(ROLE_INFO[u?.role || 'cajero'])}</p>
      ${u ? `<label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${u.id === kit.user.id ? 'disabled' : ''}><span class="track" aria-hidden="true"></span><span>Puede entrar al panel</span></label>` : ''}`,
    onOpen: (dlg) => {
      dlg.querySelector('#role-sel').addEventListener('change', (e) => { dlg.querySelector('#role-info').textContent = ROLE_INFO[e.target.value] || ''; });
      dlg.querySelector('[name=name]').focus();
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      if (u) {
        const body = { name: f.get('name'), role: f.get('role') };
        if (u.id !== kit.user.id) body.active = f.get('active') === 'on';
        await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
        toast('Usuario actualizado.');
      } else {
        await api('/api/admin/users', { method: 'POST', body: { name: f.get('name'), username: f.get('username'), role: f.get('role'), password: f.get('password') } });
        toast('Usuario creado.');
      }
      kit.refresh();
    },
  });
}

function passDialog(u) {
  openModal({
    title: `Nueva clave · ${u.name}`,
    submit: 'Cambiar clave',
    body: `<p class="hint">Si ${esc(u.name)} tiene una sesión abierta, se cerrará. Entrégale la clave nueva por un medio seguro.</p>
      <label class="field"><span>Contraseña nueva</span><input type="password" name="password" required minlength="8" maxlength="100" autocomplete="new-password"></label>`,
    onSubmit: async (form) => {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password: new FormData(form).get('password') } });
      toast('Clave cambiada.');
      if (u.id === kit.user.id) { setToken(null); location.reload(); }
    },
  });
}

// ─── Mi cuenta ─────────────────────────────────────────────────────────────
function accountDialog() {
  const u = kit.user;
  openModal({
    title: 'Mi cuenta',
    submit: 'Cambiar mi clave',
    body: `<div class="order-head"><span class="badge ${ROLE_BADGE[u.role] || ''}">${esc(u.role_label)}</span> <b>${esc(u.name)}</b> <span class="muted">· usuario ${esc(u.username)}</span></div>
      <p class="hint">${esc(ROLE_INFO[u.role] || '')}</p>
      <h3 class="sub">Cambiar mi contraseña</h3>
      <label class="field"><span>Contraseña actual</span><input type="password" name="current" required autocomplete="current-password"></label>
      <div class="grid-2">
        <label class="field"><span>Contraseña nueva</span><input type="password" name="next" required minlength="8" maxlength="100" autocomplete="new-password"><small>Mínimo 8 caracteres.</small></label>
        <label class="field"><span>Repite la nueva</span><input type="password" name="again" required minlength="8" maxlength="100" autocomplete="new-password"></label>
      </div>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      if (f.get('next') !== f.get('again')) throw new Error('Las contraseñas nuevas no coinciden.');
      const r = await api('/api/admin/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      setToken(r.token);
      toast('Contraseña cambiada. Las demás sesiones se cerraron.');
    },
  });
}

// ─── Políticas de la tienda ────────────────────────────────────────────────
async function policyDialog() {
  const p = await api('/api/admin/policy');
  const mode = (v, names) => names[v] || v;
  openModal({
    title: 'Ajustes de la tienda',
    submit: 'Guardar',
    body: `<label class="switch"><input type="checkbox" name="require_shift" ${p.require_shift ? 'checked' : ''}><span class="track" aria-hidden="true"></span><span>Exigir caja abierta para cobrar en el mostrador</span></label>
      <div class="grid-2">
        <label class="field"><span>Plazo de devolución (días)</span><input type="number" name="return_days" min="0" max="365" step="1" value="${p.return_days}" required><small>Pasado este plazo, solo un gerente puede autorizar una devolución.</small></label>
        <label class="field"><span>Descuento manual máximo del cajero (%)</span><input type="number" name="max_manual_discount" min="0" max="100" step="1" value="${p.max_manual_discount}" required><small>Gerentes y administradores no tienen tope.</small></label>
      </div>
      <h3 class="sub">Conexiones (se configuran con variables de entorno)</h3>
      <ul class="kv">
        <li><span>Pagos en línea</span><b>${esc(mode(p.payments, { instant: 'Tarjeta simulada (se da por pagada)', 'demo-hosted': 'Página de pago de demostración', http: 'Pasarela externa' }))}</b></li>
        <li><span>Facturación electrónica</span><b>${esc(mode(p.fiscal, { demo: 'Demostración (sin validez fiscal)', webhook: 'Servicio externo', off: 'Apagada' }))}</b></li>
        <li><span>Avisos por WhatsApp y correo</span><b>${esc(mode(p.notify, { simulado: 'Simulados (no se envía nada)', webhook: 'Conectados a tu flujo de n8n' }))}</b></li>
        <li><span>Usuarios de ejemplo</span><b>${p.demo_users ? 'Activos (gerente, cajero, bodega)' : 'No hay'}</b></li>
      </ul>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      await api('/api/admin/policy', { method: 'PATCH', body: { require_shift: f.get('require_shift') === 'on', return_days: f.get('return_days'), max_manual_discount: f.get('max_manual_discount') } });
      toast('Ajustes guardados.');
    },
  });
}

// ─── Bitácora ──────────────────────────────────────────────────────────────
const ACTION = {
  'sesion.entrar': 'Inició sesión', 'venta.mostrador': 'Venta de mostrador', 'inventario.ajuste': 'Ajustó existencias', 'inventario.editar': 'Editó una variante', 'inventario.importar': 'Importó entradas',
  'producto.crear': 'Creó un producto', 'producto.editar': 'Editó un producto', 'pedido.entregado': 'Marcó un pedido entregado', 'pedido.cancelado': 'Canceló un pedido', 'pedido.preparando': 'Pedido: preparando',
  'pedido.listo': 'Pedido: listo para retirar', 'pedido.enviado': 'Pedido: en camino', 'compra.crear': 'Creó una compra', 'compra.recibida': 'Recibió una compra', 'compra.cancelada': 'Canceló una compra',
  'compra.sugeridas': 'Generó compras sugeridas', 'devolucion.crear': 'Registró una devolución', 'caja.abrir': 'Abrió caja', 'caja.cerrar': 'Cerró caja', 'caja.cerrar_ajena': 'Cerró la caja de otra persona',
  'caja.ingreso': 'Ingreso a caja', 'caja.retiro': 'Retiro de caja', 'promocion.crear': 'Creó una promoción', 'promocion.editar': 'Editó una promoción', 'promocion.eliminar': 'Eliminó una promoción',
  'promocion.desactivar': 'Desactivó una promoción', 'regalo.vender': 'Vendió una tarjeta de regalo', 'regalo.activa': 'Activó una tarjeta', 'regalo.anulada': 'Anuló una tarjeta', 'set.crear': 'Creó un set', 'set.editar': 'Editó un set',
  'usuario.crear': 'Creó un usuario', 'usuario.editar': 'Editó un usuario', 'usuario.clave_propia': 'Cambió su contraseña', 'ajustes.politica': 'Cambió los ajustes de la tienda', 'ajustes.editar': 'Cambió un ajuste',
  'resena.eliminar': 'Eliminó una reseña', 'foto.subir': 'Subió una foto', 'reporte.exportar': 'Exportó un reporte', 'aviso.prueba': 'Envió un aviso de prueba', 'woo.importar': 'Importó de WooCommerce',
  'woo.sincronizar': 'Sincronizó con WooCommerce', 'woo.revisar': 'Revisó WooCommerce', 'demo.reiniciar': 'Reinició la demostración', 'demo.catalogo_masivo': 'Cargó el catálogo masivo',
};
const b = { area: '', q: '', from: '', to: '', page: 1 };

async function fetchAudit() {
  const q = new URLSearchParams({ page: b.page, limit: 50, ...(b.area ? { action: b.area } : {}), ...(b.q ? { q: b.q } : {}), ...(b.from ? { from: b.from } : {}), ...(b.to ? { to: b.to } : {}) });
  return api(`/api/admin/audit?${q}`);
}
const auditTable = (d) => d.rows.length
  ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Quién</th><th>Qué hizo</th><th>Detalle</th><th>Desde</th></tr></thead><tbody>
    ${d.rows.map((r) => `<tr><td class="nowrap">${esc(fmtDateTime(r.created_at))}</td><td>${esc(r.user_name || '—')}</td><td><span class="name">${esc(ACTION[r.action] || r.action)}</span>${r.entity_id ? `<span class="sub-line">${esc(r.entity)} ${esc(r.entity_id)}</span>` : ''}</td><td class="rev-text">${esc(r.detail)}</td><td class="muted caption">${esc(r.ip)}</td></tr>`).join('')}
    </tbody></table></div>${pagerHTML(d, 'pg-audit')}`
  : '<p class="empty-note">No hay registros con ese filtro.</p>';

async function renderAudit() {
  const d = await fetchAudit();
  b.page = d.page;
  const AREAS = { sesion: 'Accesos', venta: 'Ventas', inventario: 'Inventario', producto: 'Productos', pedido: 'Pedidos', compra: 'Compras', devolucion: 'Devoluciones', caja: 'Caja', promocion: 'Promociones', regalo: 'Tarjetas de regalo', set: 'Sets', usuario: 'Usuarios', ajustes: 'Ajustes', foto: 'Fotos', woo: 'WooCommerce', demo: 'Demostración' };
  const html = `<section class="panel light">
    <p class="muted rev-intro">Quién hizo qué y cuándo. Nunca se guardan contraseñas. Los intentos fallidos de entrar no se anotan aquí: quedan en el registro del servidor.</p>
    <div class="toolbar-adm">
      <label class="field"><span class="sr-only">Buscar</span><input type="search" id="audit-q" placeholder="Buscar en el detalle, el nombre o el número" value="${esc(b.q)}" autocomplete="off"></label>
      <label class="field"><span class="sr-only">Área</span><select id="audit-area"><option value="">Todas las áreas</option>${d.areas.map((a) => `<option value="${esc(a)}" ${b.area === a ? 'selected' : ''}>${esc(AREAS[a] || a)}</option>`).join('')}</select></label>
      <label class="field"><span class="sr-only">Desde</span><input type="date" id="audit-from" value="${esc(b.from)}"></label>
      <label class="field"><span class="sr-only">Hasta</span><input type="date" id="audit-to" value="${esc(b.to)}"></label>
    </div>
    <div id="audit-table">${auditTable(d)}</div></section>`;
  return { html };
}
const soonAudit = debounce(() => attempt(async () => { const box = $('#audit-table'); if (box) box.innerHTML = auditTable(await fetchAudit()); }), 350);

kit.add({
  nav: [
    { id: 'usuarios', label: 'Usuarios', icon: 'users', perm: 'usuarios', group: 'Administración', order: 10 },
    { id: 'bitacora', label: 'Bitácora', icon: 'shield', perm: 'bitacora', group: 'Administración', order: 20 },
  ],
  views: {
    usuarios: { title: 'Usuarios', kicker: 'Quién entra al panel y qué puede hacer', render: renderUsers },
    bitacora: { title: 'Bitácora', kicker: 'Quién hizo qué', render: renderAudit },
  },
  actions: {
    'user-new': () => userDialog(),
    'user-edit': (el) => userDialog(users.find((u) => u.id === Number(el.dataset.id))),
    'user-pass': (el) => passDialog(users.find((u) => u.id === Number(el.dataset.id))),
    'my-account': accountDialog,
    policy: () => attempt(policyDialog),
    'pg-audit': (el) => { b.page = Number(el.dataset.page); attempt(async () => { const box = $('#audit-table'); if (box) box.innerHTML = auditTable(await fetchAudit()); }); },
  },
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'audit-q') { b.q = e.target.value.trim(); b.page = 1; soonAudit(); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'audit-area') { b.area = e.target.value; b.page = 1; soonAudit(); }
  if (e.target.id === 'audit-from') { b.from = e.target.value; b.page = 1; soonAudit(); }
  if (e.target.id === 'audit-to') { b.to = e.target.value; b.page = 1; soonAudit(); }
});
