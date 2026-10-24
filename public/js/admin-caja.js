// Caja: abrir el turno con un fondo, registrar ingresos y retiros, y cerrar contando el efectivo.
import { api, money, esc, icon, toast, fmtDateTime } from './ui.js';
import { $, attempt, pagerHTML, openModal, kit } from './admin-kit.js';
import { showShiftReport } from './admin-print.js';

const state = { page: 1 };
const brandName = () => (window.__BRAND?.name || 'Tienda');

const diffBadge = (d) => (d == null ? '' : d === 0 ? '<span class="badge ok">Cuadra</span>' : `<span class="badge ${d < 0 ? 'danger' : 'low'}">${d < 0 ? 'Faltó' : 'Sobró'} ${money(Math.abs(d))}</span>`);

function totalsTable(s) {
  const t = s.totals;
  const row = (k, v, strong = false) => `<tr><td>${strong ? `<b>${k}</b>` : k}</td><td class="r">${strong ? `<b>${v}</b>` : v}</td></tr>`;
  return `<table class="tbl"><tbody>
    ${row('Fondo inicial', money(s.opening_cash))}
    ${row(`Ventas en efectivo`, money(t.cash_sales))}
    ${t.gift_cards_cash ? row(`Tarjetas de regalo vendidas (efectivo)`, money(t.gift_cards_cash)) : ''}
    ${t.income ? row('Ingresos', money(t.income)) : ''}
    ${t.withdrawals ? row('Retiros', `−${money(t.withdrawals)}`) : ''}
    ${t.refunds_cash ? row('Devoluciones en efectivo', `−${money(t.refunds_cash)}`) : ''}
    ${row('Efectivo esperado en caja', money(t.expected_cash), true)}
    ${s.status === 'cerrado' ? row('Efectivo contado', money(s.counted_cash), true) : ''}
  </tbody></table>
  <p class="caption muted" style="margin-top:10px">Otros cobros del turno: tarjeta ${money(t.card_sales)} · transferencia ${money(t.transfer_sales)}${t.gift_redeemed ? ` · tarjetas de regalo ${money(t.gift_redeemed)}` : ''} · ${t.tickets} ${t.tickets === 1 ? 'ticket' : 'tickets'} por ${money(t.sales_total)}.</p>`;
}

async function renderCaja() {
  const [cur, list] = await Promise.all([api('/api/admin/shift'), api(`/api/admin/shifts?page=${state.page}`)]);
  const s = cur.shift;
  const mine = s
    ? `<section class="panel light">
        <div class="panel-head"><h2>Tu caja está abierta</h2><span class="caption upper muted">Desde ${esc(fmtDateTime(s.opened_at))}</span></div>
        ${totalsTable(s)}
        ${s.movements.length ? `<h3 class="sub" style="margin-top:18px">Ingresos y retiros</h3><ul class="list">${s.movements.map((m) => `<li><div class="who"><b>${m.kind === 'ingreso' ? 'Ingreso' : 'Retiro'} · ${esc(m.reason)}</b><span>${esc(fmtDateTime(m.created_at))}</span></div><strong class="${m.kind === 'ingreso' ? 'plus' : 'minus'}">${m.kind === 'ingreso' ? '+' : '−'}${money(m.amount)}</strong></li>`).join('')}</ul>` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn-outline" data-act="caja-move" data-kind="ingreso">${icon('plus', 16)} Registrar ingreso</button>
          <button type="button" class="btn btn-outline" data-act="caja-move" data-kind="retiro">${icon('minus', 16)} Registrar retiro</button>
          <button type="button" class="btn btn-solid" data-act="caja-close">Cerrar caja</button>
        </div>
      </section>`
    : `<section class="panel light">
        <div class="panel-head"><h2>Caja cerrada</h2></div>
        <p class="muted">Abre tu turno con el efectivo que dejas en la gaveta. Todo lo que cobres en el mostrador quedará en este turno y, al cerrar, el sistema te dice cuánto debería haber.${cur.require_shift ? ' <b>La tienda exige caja abierta para cobrar.</b>' : ''}</p>
        <div class="btn-row"><button type="button" class="btn btn-solid" data-act="caja-open">${icon('wallet', 16)} Abrir caja</button></div>
      </section>`;
  const history = `<section class="panel light">
      <div class="panel-head"><h2>Turnos${kit.can('caja_todas') ? ' de todo el equipo' : ''}</h2></div>
      ${list.rows.length
        ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Cajero</th><th>Abierta</th><th>Cerrada</th><th class="r">Fondo</th><th class="r">Esperado</th><th class="r">Contado</th><th>Resultado</th><th></th></tr></thead><tbody>
          ${list.rows.map((r) => `<tr><td><b>#${r.id}</b></td><td>${esc(r.user_name)}</td><td class="nowrap">${esc(fmtDateTime(r.opened_at))}</td><td class="nowrap">${r.closed_at ? esc(fmtDateTime(r.closed_at)) : '<span class="badge info">Abierta</span>'}</td>
            <td class="r">${money(r.opening_cash)}</td><td class="r">${money(r.status === 'cerrado' ? r.expected_cash : r.totals.expected_cash)}</td><td class="r">${r.status === 'cerrado' ? money(r.counted_cash) : '—'}</td><td>${diffBadge(r.difference)}</td>
            <td><div class="acts"><button type="button" class="btn btn-sm btn-outline" data-act="caja-view" data-id="${r.id}">${icon('printer', 14)} Ver</button>
            ${r.status === 'abierto' && r.user_id !== kit.user.id && kit.can('caja_todas') ? `<button type="button" class="btn btn-sm btn-outline" data-act="caja-force" data-id="${r.id}">Cerrar</button>` : ''}</div></td></tr>`).join('')}
          </tbody></table></div>${pagerHTML(list, 'pg-caja')}`
        : '<p class="empty-note">Todavía no hay turnos.</p>'}
    </section>`;
  return { html: mine + history };
}

export function openCajaDialog() {
  openModal({
    title: 'Abrir caja',
    submit: 'Abrir caja',
    body: `<label class="field"><span>Efectivo en la gaveta ($)</span><input type="number" name="cash" min="0" step="0.01" value="0" required inputmode="decimal"><small>El fondo con el que empiezas el turno (cambio).</small></label>`,
    onSubmit: async (form) => {
      await api('/api/admin/shift/open', { method: 'POST', body: { opening_cash: new FormData(form).get('cash') } });
      toast('Caja abierta.');
      kit.posRefreshShift?.();
      if (kit.view === 'caja') kit.refresh();
    },
  });
}

function moveDialog(kind) {
  openModal({
    title: kind === 'ingreso' ? 'Registrar ingreso' : 'Registrar retiro',
    submit: 'Registrar',
    body: `<p class="hint">${kind === 'ingreso' ? 'Dinero que entra a la gaveta y no es una venta (por ejemplo, más cambio).' : 'Dinero que sale de la gaveta (por ejemplo, un pago a un proveedor o llevar efectivo al banco).'}</p>
      <label class="field"><span>Monto ($)</span><input type="number" name="amount" min="0.01" step="0.01" required inputmode="decimal"></label>
      <label class="field"><span>Motivo</span><input type="text" name="reason" required maxlength="120" placeholder="${kind === 'ingreso' ? 'Cambio adicional' : 'Pago al mensajero'}"></label>`,
    onSubmit: async (form) => {
      const f = new FormData(form);
      await api('/api/admin/shift/movement', { method: 'POST', body: { kind, amount: f.get('amount'), reason: f.get('reason') } });
      toast(kind === 'ingreso' ? 'Ingreso registrado.' : 'Retiro registrado.');
      kit.refresh();
    },
  });
}

async function closeDialog(shiftId = null) {
  const s = shiftId ? await api(`/api/admin/shifts/${shiftId}`) : (await api('/api/admin/shift')).shift;
  if (!s) return toast('No hay una caja abierta.', 'error');
  openModal({
    title: shiftId ? `Cerrar la caja #${s.id} de ${s.user_name}` : 'Cerrar caja',
    submit: 'Cerrar caja',
    body: `${totalsTable(s)}
      <label class="field"><span>Efectivo contado en la gaveta ($)</span><input type="number" name="counted" min="0" step="0.01" required inputmode="decimal" id="counted"><small id="counted-diff">Cuenta el efectivo y escríbelo; el sistema calcula la diferencia.</small></label>
      <label class="field"><span>Nota (opcional)</span><input type="text" name="notes" maxlength="200" placeholder="Por ejemplo, faltó cambio de $20"></label>`,
    onOpen: (dlg) => {
      const input = dlg.querySelector('#counted');
      input.addEventListener('input', () => {
        const d = Math.round((Number(input.value) - s.totals.expected_cash) * 100) / 100;
        dlg.querySelector('#counted-diff').innerHTML = input.value === '' ? 'Cuenta el efectivo y escríbelo; el sistema calcula la diferencia.' : d === 0 ? '<b>Cuadra exacto.</b>' : `Diferencia: <b class="${d < 0 ? 'minus' : 'plus'}">${d < 0 ? 'faltan' : 'sobran'} ${money(Math.abs(d))}</b>`;
      });
      input.focus();
    },
    onSubmit: async (form) => {
      const f = new FormData(form);
      const done = await api(shiftId ? `/api/admin/shifts/${shiftId}/close` : '/api/admin/shift/close', { method: 'POST', body: { counted: f.get('counted'), notes: f.get('notes') } });
      toast(done.difference === 0 ? 'Caja cerrada: cuadra exacto.' : `Caja cerrada con una diferencia de ${money(done.difference)}.`);
      kit.posRefreshShift?.();
      setTimeout(() => { kit.refresh(); showShiftReport(done, brandName()); }, 0);
    },
  });
}

kit.add({
  nav: { id: 'caja', label: 'Caja', icon: 'wallet', perm: 'caja', group: 'Venta', order: 20 },
  views: { caja: { title: 'Caja', kicker: 'Turno, efectivo y cierre', render: renderCaja } },
  actions: {
    'caja-open': openCajaDialog,
    'caja-move': (el) => moveDialog(el.dataset.kind),
    'caja-close': () => attempt(() => closeDialog()),
    'caja-force': (el) => attempt(() => closeDialog(Number(el.dataset.id))),
    'caja-view': (el) => attempt(async () => showShiftReport(await api(`/api/admin/shifts/${el.dataset.id}`), brandName())),
    'pg-caja': (el) => { state.page = Number(el.dataset.page); kit.refresh(); },
  },
});
