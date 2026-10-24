// Impresión desde el panel: recibos de 80 mm, etiquetas con código de barras e informes. Cada documento se muestra primero en una
// vista previa dentro del diálogo, con el botón «Imprimir» (el navegador abre su cuadro de impresión sobre una página aparte).
import { esc, money, fmtDateTime } from './ui.js';
import { openModal } from './admin-kit.js';
import { barcodeSVG } from './barcode.js';

const BASE_CSS = `
  @page { size: auto; margin: 6mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: 12px; line-height: 1.35; color: #000; background: #fff; }
  h1, h2, p { margin: 0; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
  .rule { border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .small { font-size: 10px; }
`;

const RECEIPT_CSS = `${BASE_CSS}
  @page { size: 80mm auto; margin: 3mm; }
  body { width: 74mm; margin: 0 auto; }
  h1 { font-size: 16px; text-transform: uppercase; letter-spacing: .06em; }
`;

const LABEL_CSS = `${BASE_CSS}
  @page { size: 50mm 30mm; margin: 0; }
  body { margin: 0; }
  .label { width: 50mm; height: 30mm; padding: 2mm; display: grid; align-content: center; justify-items: center; gap: 1mm; page-break-after: always; overflow: hidden; }
  .label svg { width: 44mm; height: auto; max-height: 14mm; }
  .label .n { font-size: 9px; font-weight: 700; max-width: 46mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .label .p { font-size: 11px; font-weight: 700; }
`;

const REPORT_CSS = `${BASE_CSS}
  body { font-family: system-ui, 'Segoe UI', sans-serif; font-size: 12px; padding: 4mm; }
  h1 { font-size: 20px; margin-bottom: 4px; } h2 { font-size: 14px; margin: 12px 0 4px; }
  table td, table th { padding: 3px 6px; border-bottom: 1px solid #ccc; text-align: left; }
  table th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .r { text-align: right; }
`;

const docHtml = (title, css, body) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`;

// Imprime ya, sin vista previa (para botones dentro de un formulario, como la etiqueta de un producto).
export function printNow(css, body, title = 'Imprimir') {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  f.onload = () => {
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => f.remove(), 4000);
  };
  f.srcdoc = docHtml(title, css, body);
  document.body.append(f);
}

// Muestra el documento en un diálogo con vista previa y botón de imprimir.
export function previewDocument({ title, css, body, wide = false, frameHeight = 520 }) {
  const html = docHtml(title, css, body);
  openModal({
    title,
    wide,
    body: `<iframe class="print-frame" id="print-frame" title="Vista previa" style="width:100%;height:${frameHeight}px;border:1px solid var(--line);background:#fff"></iframe>`,
    closeLabel: 'Cerrar',
    extraFoot: '<button type="button" class="btn btn-lemon" id="print-go">Imprimir</button>',
    onOpen: (dlg) => {
      const frame = dlg.querySelector('#print-frame');
      frame.srcdoc = html;
      dlg.querySelector('#print-go').addEventListener('click', () => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      });
    },
  });
}

const PAY = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', contra_entrega: 'Contra entrega', tarjeta_regalo: 'Tarjeta de regalo' };

// Recibo de venta (datos de GET /api/admin/orders/:id/receipt).
export function receiptHTML(r) {
  const o = r.order;
  const lines = [];
  const seenSets = new Set();
  for (const i of o.items) {
    if (i.bundle_variant_id) {
      if (!seenSets.has(i.bundle_variant_id)) {
        seenSets.add(i.bundle_variant_id);
        lines.push(`<tr><td colspan="2" class="b">${esc(i.bundle_name || 'Set de regalo')} × ${i.bundle_units || 1}</td></tr>`);
      }
      lines.push(`<tr><td class="small">&nbsp;&nbsp;${i.qty} × ${esc(i.name)}${i.size_ml ? ` ${i.size_ml} ml` : ''}</td><td class="r small">${money(i.unit_price * i.qty)}</td></tr>`);
    } else {
      lines.push(`<tr><td>${i.qty} × ${esc(i.name)}${i.size_ml ? ` ${i.size_ml} ml` : ''}<br><span class="small">${esc(i.sku)} · ${money(i.unit_price)} c/u</span></td><td class="r">${money(i.unit_price * i.qty)}</td></tr>`);
    }
  }
  const doc = o.documents.find((d) => d.kind === 'factura');
  const paid = o.total - o.gift_amount;
  return `
    <div class="c"><h1>${esc(r.store.short)}</h1><p>${esc(r.store.name)}</p>${r.store.address ? `<p class="small">${esc(r.store.address)}</p>` : ''}${r.store.phone ? `<p class="small">Tel. ${esc(r.store.phone)}</p>` : ''}</div>
    <div class="rule"></div>
    <p>Pedido #${o.id} · ${esc(fmtDateTime(o.created_at))}</p>
    <p class="small">${o.channel === 'mostrador' ? 'Venta de mostrador' : 'Compra en línea'}${o.user_name ? ` · Atendió: ${esc(o.user_name)}` : ''}</p>
    ${o.customer_name && o.customer_name !== 'Cliente mostrador' ? `<p class="small">Cliente: ${esc(o.customer_name)}</p>` : ''}
    <div class="rule"></div>
    <table>${lines.join('')}</table>
    <div class="rule"></div>
    <table>
      <tr><td>Subtotal</td><td class="r">${money(o.subtotal)}</td></tr>
      ${o.discount ? `<tr><td>Descuento${o.promo_label ? ` (${esc(o.promo_label)})` : ''}</td><td class="r">−${money(o.discount)}</td></tr>` : ''}
      <tr class="b"><td>TOTAL</td><td class="r">${money(o.total)}</td></tr>
      ${o.gift_amount ? `<tr><td>Tarjeta de regalo</td><td class="r">−${money(o.gift_amount)}</td></tr>` : ''}
      <tr><td>${esc(PAY[o.payment_method] || o.payment_method)}${o.gift_amount ? ' (resto)' : ''}</td><td class="r">${money(paid)}</td></tr>
      ${r.tax ? `<tr class="small"><td>Incluye ${esc(r.store.tax_name)} ${Math.round(r.store.tax_rate * 100)}%</td><td class="r">${money(r.tax)}</td></tr>` : ''}
      ${o.refunded ? `<tr class="small"><td>Devuelto</td><td class="r">−${money(o.refunded)}</td></tr>` : ''}
    </table>
    <div class="rule"></div>
    ${doc ? `<p class="small c">Factura ${esc(doc.number || '(pendiente)')}</p>` : ''}
    ${r.fiscal_demo ? '<p class="small c b">SIN VALIDEZ FISCAL — documento de demostración</p>' : ''}
    ${r.url ? `<p class="small c">Seguimiento: ${esc(r.url)}</p>` : ''}
    <p class="c" style="margin-top:6px">¡Gracias por tu compra!</p>
    ${r.store.hours ? `<p class="small c">${esc(r.store.hours)}</p>` : ''}`;
}

export const showReceipt = (r) => previewDocument({ title: `Recibo del pedido #${r.order.id}`, css: RECEIPT_CSS, body: receiptHTML(r), frameHeight: 560 });

// Etiquetas de góndola/frasco: una por unidad, con el código de barras (el propio o el SKU).
export function labelsHTML(items) {
  return items
    .flatMap((it) => Array.from({ length: Math.max(1, it.copies || 1) }, () => it))
    .map((it) => `<div class="label"><p class="n">${esc(it.name)}${it.size_ml ? ` · ${it.size_ml} ml` : ''}</p>${barcodeSVG(it.code, { height: 40, module: 2 })}<p class="p">${money(it.price)}</p></div>`)
    .join('');
}
export const showLabelsNow = (items) => printNow(LABEL_CSS, labelsHTML(items), 'Etiquetas');
export const showLabels = (items) => previewDocument({ title: 'Etiquetas', css: LABEL_CSS, body: labelsHTML(items), frameHeight: 380 });

// Cierre de caja imprimible.
export function shiftReportHTML(s, brandName) {
  const t = s.totals;
  const row = (k, v, b = false) => `<tr${b ? ' class="b"' : ''}><td>${esc(k)}</td><td class="r">${v}</td></tr>`;
  return `
    <div class="c"><h1>${esc(brandName)}</h1><p class="b">Cierre de caja #${s.id}</p></div>
    <div class="rule"></div>
    <p>Cajero: ${esc(s.user_name)}</p><p>Abierta: ${esc(fmtDateTime(s.opened_at))}</p>${s.closed_at ? `<p>Cerrada: ${esc(fmtDateTime(s.closed_at))}</p>` : ''}
    <div class="rule"></div>
    <table>
      ${row('Fondo inicial', money(s.opening_cash))}
      ${row('Ventas en efectivo', money(t.cash_sales))}
      ${t.gift_cards_cash ? row('Tarjetas de regalo vendidas (efectivo)', money(t.gift_cards_cash)) : ''}
      ${t.income ? row('Ingresos', money(t.income)) : ''}
      ${t.withdrawals ? row('Retiros', `−${money(t.withdrawals)}`) : ''}
      ${t.refunds_cash ? row('Devoluciones en efectivo', `−${money(t.refunds_cash)}`) : ''}
      ${row('Efectivo esperado', money(t.expected_cash), true)}
      ${s.status === 'cerrado' ? `${row('Efectivo contado', money(s.counted_cash), true)}${row(s.difference < 0 ? 'Faltante' : s.difference > 0 ? 'Sobrante' : 'Diferencia', money(s.difference), true)}` : ''}
    </table>
    <div class="rule"></div>
    <p class="b">Otros cobros</p>
    <table>
      ${row('Tarjeta', money(t.card_sales))}${row('Transferencia', money(t.transfer_sales))}${t.gift_redeemed ? row('Tarjetas de regalo canjeadas', money(t.gift_redeemed)) : ''}
      ${row(`Tickets (${t.tickets})`, money(t.sales_total), true)}
    </table>
    ${s.notes ? `<div class="rule"></div><p class="small">Nota: ${esc(s.notes)}</p>` : ''}
    <p class="small" style="margin-top:18px">Firma: ______________________</p>`;
}
export const showShiftReport = (s, brandName) => previewDocument({ title: `Cierre de caja #${s.id}`, css: RECEIPT_CSS, body: shiftReportHTML(s, brandName), frameHeight: 520 });

// Tarjeta de regalo para imprimir o entregar.
export function giftCardHTML(card, brandName) {
  return `
    <div style="border:2px solid #000;padding:16px 18px;text-align:center;max-width:340px;margin:0 auto">
      <p class="small" style="letter-spacing:.2em;text-transform:uppercase">${esc(brandName)}</p>
      <p style="font-size:22px;font-weight:700;margin:6px 0">Tarjeta de regalo</p>
      <p style="font-size:34px;font-weight:700;margin:4px 0">${money(card.initial_amount ?? card.amount)}</p>
      ${card.recipient_name ? `<p>Para: ${esc(card.recipient_name)}</p>` : ''}
      ${card.message ? `<p class="small" style="margin:6px 0">«${esc(card.message)}»</p>` : ''}
      <div style="margin:10px 0">${barcodeSVG(card.code, { height: 40, module: 2 })}</div>
      <p style="font-size:15px;font-weight:700;letter-spacing:.08em">${esc(card.code)}</p>
      ${card.expires_at ? `<p class="small">Válida hasta el ${esc(card.expires_at)}</p>` : ''}
    </div>`;
}
export const showGiftCard = (card, brandName) => previewDocument({ title: 'Tarjeta de regalo', css: REPORT_CSS, body: giftCardHTML(card, brandName), frameHeight: 360 });

// Informe en tabla (reportes).
export const showReport = (title, body) => previewDocument({ title, css: REPORT_CSS, body: `<h1>${esc(title)}</h1>${body}`, wide: true, frameHeight: 560 });
