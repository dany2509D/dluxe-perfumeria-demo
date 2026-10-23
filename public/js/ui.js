// Utilidades compartidas: API, formato, iconos, frasco SVG y avisos.

// ─── API ───────────────────────────────────────────────────────────────────
let authToken = null;
try { authToken = sessionStorage.getItem('aurelia-token'); } catch { /* sin almacenamiento */ }

export function setToken(t) {
  authToken = t;
  try { t ? sessionStorage.setItem('aurelia-token', t) : sessionStorage.removeItem('aurelia-token'); } catch { /* ignorar */ }
}
export const hasToken = () => !!authToken;

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, signal, raw, contentType } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': contentType || 'application/octet-stream' } : {}), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e; // la búsqueda anterior se descartó a propósito
    throw new ApiError(0, 'No se pudo conectar con el servidor. ¿Sigue encendido?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authToken) {
      setToken(null);
      window.dispatchEvent(new Event('aurelia:logout'));
    }
    throw new ApiError(res.status, data.error || 'Ocurrió un error inesperado', data.details);
  }
  return data;
}

// ─── Formato ───────────────────────────────────────────────────────────────
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); // "$45.00" (es-PA lo muestra como "USD 45.00")
export const money = (n) => usd.format(Number(n) || 0);
export const sizeLabel = (ml) => (ml ? `${ml} ml` : 'Tamaño único');
export const num = (n) => new Intl.NumberFormat('es').format(Number(n) || 0);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const parseLocal = (s) => new Date(String(s).replace(' ', 'T'));
export const fmtDateTime = (s) =>
  parseLocal(s).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDay = (s) => parseLocal(s + ' 00:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' });

// ─── Iconos (trazos estilo Lucide, 24x24) ──────────────────────────────────
const PATHS = {
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  register: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  store: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  sparkle: '<path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
};

export function icon(name, size = 20, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${extra}>${PATHS[name] || ''}</svg>`;
}

// ─── Frasco SVG ────────────────────────────────────────────────────────────
// Sin fotos reales en la demo: cada perfume se dibuja plano, con el color de su líquido,
// sobre un azulejo de tono cálido (el "editorial still-life" del sistema de diseño).
const TILES = ['#c4573a', '#f0b48f', '#a98aa5', '#d98e5b', '#e8c9a6', '#b5624a', '#e2a39a', '#c9a27e'];
export const tileColor = (id) => TILES[Math.abs(Number(id) || 0) % TILES.length];

export function bottleSVG(color = '#c9a24b', seed = 0, { title = '' } = {}) {
  const id = `bt${Math.random().toString(36).slice(2, 8)}`;
  const shape = Math.abs(seed) % 3;
  const body = (i) =>
    [
      `<rect x="${50 + i}" y="${72 + i}" width="${100 - 2 * i}" height="${138 - 2 * i}" rx="${6 - i / 2}"/>`,
      `<circle cx="100" cy="148" r="${64 - i}"/>`,
      `<rect x="${64 + i}" y="${62 + i}" width="${72 - 2 * i}" height="${148 - 2 * i}" rx="${34 - i}"/>`,
    ][shape];
  const top = [72, 84, 62][shape];
  const neckTop = [50, 54, 46][shape];
  const cap = [
    `<rect x="80" y="14" width="40" height="38" rx="1" fill="#1d0b0d"/>`,
    `<circle cx="100" cy="34" r="22" fill="#1d0b0d"/>`,
    `<rect x="86" y="12" width="28" height="36" rx="14" fill="#1d0b0d"/>`,
  ][shape];
  const level = top + 34;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" role="img" aria-label="${esc(title || 'Frasco de perfume')}">
    <defs><clipPath id="${id}">${body(4)}</clipPath></defs>
    <rect x="91" y="${neckTop}" width="18" height="${top - neckTop + 6}" fill="#dbe2dc"/>
    ${cap}
    <g fill="#fcf9f0" stroke="#1d0b0d" stroke-width="3">${body(0)}</g>
    <g clip-path="url(#${id})"><rect x="0" y="${level}" width="200" height="240" fill="${color}"/></g>
    <rect x="72" y="${level + 36}" width="56" height="38" fill="#f7ea48"/>
    <path d="M80 ${level + 50}h40M86 ${level + 60}h28" stroke="#1d0b0d" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}

// Foto real si el producto la tiene; si no, el frasco ilustrado.
export function productArt(p, { title = '', eager = false } = {}) {
  if (p.image) {
    return `<img class="tile-img" src="${esc(p.image)}" alt="${esc(title || p.name || 'Perfume')}" ${eager ? '' : 'loading="lazy"'} decoding="async" draggable="false" onload="this.classList.add('is-in')">`;
  }
  return bottleSVG(p.color, p.id, { title: title || p.name });
}

// ─── Avisos ────────────────────────────────────────────────────────────────
export function toast(message, kind = 'ok') {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'checkCircle', 18)}<span>${esc(message)}</span>`;
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6500 : 4200);
}
