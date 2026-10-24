// Identidad de la tienda. Se edita en brand.json (o con variables de entorno BRAND_NAME, BRAND_SHORT,
// STORE_PHONE, STORE_EMAIL, STORE_ADDRESS, STORE_WHATSAPP) y se aplica a la tienda, el panel y el asistente.
// Cambiar el nombre de toda la demo es cambiar una línea.
import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_BRAND = {
  name: "D'Luxe Perfumería",
  short: "D'Luxe",
  tagline: 'Perfumería',
  skuPrefix: 'DLX',
  country: 'Panamá',
  currency: 'USD',
  taxName: 'ITBMS',
  taxRate: 0.07,
  taxIncluded: true,
  hours: 'Lunes a sábado, de 9:00 a 19:00',
  phone: '',
  email: '',
  address: '',
  instagram: '',
  facebook: '',
  whatsapp: '',
  demoNote: 'Propuesta de demostración. Los productos, marcas y precios de ejemplo son ficticios.',
  founded: 0,
};

const str = (v, fallback, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);

// Rellena {years} y {founded} en un texto de «Quiénes somos». Sin año de fundación devuelve '' para que se omita esa línea.
export function fillAbout(text, founded, now = new Date()) {
  if (!/\{(years|founded)\}/.test(text)) return text;
  if (!founded) return '';
  return text.replace(/\{years\}/g, now.getFullYear() - founded).replace(/\{founded\}/g, founded);
}

// «Quiénes somos»: si brand.json no trae texto, se usa uno genérico con el nombre de la tienda. En los textos valen {years} y {founded}.
function resolveAbout(raw, name) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const pillars = (Array.isArray(a.pillars) ? a.pillars : [])
    .map((p) => ({ title: str(p?.title, '', 40), text: str(p?.text, '', 180) }))
    .filter((p) => p.title && p.text)
    .slice(0, 4);
  return {
    lead: str(a.lead, `${name} es una tienda de perfumes para damas, caballeros y niños, con atención personalizada y compra en línea.`, 420),
    pillars: pillars.length
      ? pillars
      : [
          { title: 'Para toda la familia', text: 'Perfumes, estuches de regalo y testers para damas, caballeros y niños.' },
          { title: 'Atención personalizada', text: 'Te ayudamos a elegir la fragancia que va contigo.' },
          { title: 'Tienda y en línea', text: 'Compra desde casa o pasa a recoger tu pedido.' },
        ],
    mission: str(a.mission, 'Ayudarte a encontrar la fragancia que te represente, con productos de calidad y un trato cercano.', 320),
    vision: str(a.vision, 'Ser la primera opción de quienes buscan perfumes, en la tienda y en línea.', 320),
    values: str(a.values, 'Respeto, dedicación, trabajo en equipo y compromiso con cada cliente.', 320),
    where: str(a.where, '', 200), // dónde está la tienda (se muestra solo en «Quiénes somos»)
    note: str(a.note, '', 220),
  };
}


// Identidad a partir de los datos de brand.json (ya leídos) y las variables de entorno. No toca el disco.
export function resolveBrand(fromFile = {}, env = process.env) {
  const merged = { ...DEFAULT_BRAND, ...fromFile };
  const rate = Number(merged.taxRate);
  const digits = String(env.STORE_WHATSAPP ?? merged.whatsapp ?? '').replace(/\D/g, '');
  return {
    name: str(env.BRAND_NAME, str(merged.name, DEFAULT_BRAND.name, 80), 80),
    short: str(env.BRAND_SHORT, str(merged.short, DEFAULT_BRAND.short, 40), 40),
    tagline: str(merged.tagline, DEFAULT_BRAND.tagline, 60),
    skuPrefix: str(merged.skuPrefix, DEFAULT_BRAND.skuPrefix, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SKU',
    country: str(merged.country, DEFAULT_BRAND.country, 60),
    currency: str(merged.currency, DEFAULT_BRAND.currency, 3).toUpperCase(),
    taxName: str(merged.taxName, DEFAULT_BRAND.taxName, 20),
    taxRate: Number.isFinite(rate) && rate >= 0 && rate <= 0.3 ? rate : DEFAULT_BRAND.taxRate,
    taxIncluded: merged.taxIncluded !== false,
    hours: str(merged.hours, DEFAULT_BRAND.hours, 120),
    phone: str(env.STORE_PHONE, str(merged.phone, '', 40), 40),
    email: str(env.STORE_EMAIL, str(merged.email, '', 120), 120),
    address: str(env.STORE_ADDRESS, str(merged.address, '', 200), 200),
    instagram: str(merged.instagram, '', 200),
    facebook: str(merged.facebook, '', 200),
    whatsapp: /^\d{8,15}$/.test(digits) ? digits : '',
    demoNote: str(merged.demoNote, DEFAULT_BRAND.demoNote, 200),
    founded: Number.isInteger(Number(merged.founded)) && Number(merged.founded) >= 1900 && Number(merged.founded) <= new Date().getFullYear() ? Number(merged.founded) : 0,
    about: resolveAbout(merged.about, str(env.BRAND_NAME, str(merged.name, DEFAULT_BRAND.name, 80), 80)),
  };
}

export function loadBrand(env = process.env, file = new URL('./brand.json', import.meta.url)) {
  let fromFile = {};
  try {
    if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* un brand.json dañado no debe tumbar la tienda: se usan los valores por defecto */
  }
  return resolveBrand(fromFile, env);
}

// Lo que el navegador puede ver.
export const publicBrand = (b) => ({
  name: b.name, short: b.short, tagline: b.tagline, country: b.country, currency: b.currency,
  taxName: b.taxName, taxRate: b.taxRate, taxIncluded: b.taxIncluded, hours: b.hours,
  phone: b.phone, email: b.email, address: b.address, instagram: b.instagram, facebook: b.facebook,
  whatsapp: !!b.whatsapp, demoNote: b.demoNote, founded: b.founded, about: b.about,
});

export const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Las páginas llevan marcadores ({{BRAND_NAME}}…) que se reemplazan al servirlas (o al armar el sitio estático): cambiar brand.json cambia todo.
export function renderBrandHtml(html, brand, { adminHint = '' } = {}) {
  const data = JSON.stringify(publicBrand(brand)).replace(/</g, '\\u003c');
  // adminHint: la contraseña a mostrar en el acceso al panel (solo en demostraciones), o vacío para no mostrar nada.
  const hint = adminHint ? `<p class="muted caption">Demo: la contraseña es <strong>${escHtml(adminHint)}</strong> (se cambia con la variable ADMIN_PASSWORD). Usuarios de ejemplo: <strong>admin</strong>, <strong>gerente</strong>, <strong>cajero</strong> y <strong>bodega</strong>: cada uno ve solo lo que su rol permite.</p>` : '';
  return html
    .replaceAll('{{BRAND_NAME}}', escHtml(brand.name))
    .replaceAll('{{BRAND_SHORT}}', escHtml(brand.short))
    .replaceAll('{{BRAND_TAGLINE}}', escHtml(brand.tagline))
    .replaceAll('{{BRAND_INITIAL}}', escHtml(brand.short.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toLowerCase() || 'a')) // inicial del logo compacto (diseño Shop)
    .replaceAll('{{DEMO_NOTE}}', escHtml(brand.demoNote))
    .replaceAll('{{ADMIN_HINT}}', hint)
    .replace('<!--BRAND-->', `<script>window.__BRAND=${data}</script>`);
}
