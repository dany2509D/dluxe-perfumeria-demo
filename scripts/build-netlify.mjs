// Arma el sitio estático para Netlify: copia public/ a dist/, reemplaza los marcadores de marca en las páginas y escribe las cabeceras
// de seguridad. La API (todo lo de /api/) la atiende la función netlify/functions/api.mjs.
//   node scripts/build-netlify.mjs
// Variables de entorno (del entorno de compilación de Netlify):
//   FRAME_ORIGINS  sitios que pueden mostrar la tienda en un iframe ("https://tu-sitio.com", varios separados por coma)
//   EMBED_ORIGINS  sitios que pueden mostrar el chat (embed.js) en un iframe
//   DEMO_SHOW_ADMIN_PASSWORD=1  muestra en el acceso del panel la contraseña de ADMIN_PASSWORD (solo para demostraciones públicas)
//   BUILD_OUT      carpeta de salida (por defecto dist)
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand, renderBrandHtml } from '../brand.js';
import { ancestors } from '../frames.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = process.env.BUILD_OUT || join(ROOT, 'dist');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true });

const brand = loadBrand(process.env);
const adminHint = process.env.DEMO_SHOW_ADMIN_PASSWORD === '1' ? process.env.ADMIN_PASSWORD || 'admin123' : '';

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
let pages = 0;
for (const file of walk(OUT).filter((f) => f.endsWith('.html'))) {
  writeFileSync(file, renderBrandHtml(readFileSync(file, 'utf8'), brand, { adminHint }));
  pages++;
}

const store = ancestors(process.env.FRAME_ORIGINS);
const chat = ancestors(process.env.EMBED_ORIGINS);
writeFileSync(
  join(OUT, '_headers'),
  `# Generado por scripts/build-netlify.mjs
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/
  Content-Security-Policy: frame-ancestors ${store}
/index.html
  Content-Security-Policy: frame-ancestors ${store}
/admin
  Content-Security-Policy: frame-ancestors 'self'
/admin.html
  Content-Security-Policy: frame-ancestors 'self'
/pago-demo.html
  Content-Security-Policy: frame-ancestors 'self'
/embed
  Content-Security-Policy: frame-ancestors ${chat}
/embed.html
  Content-Security-Policy: frame-ancestors ${chat}
/img/*
  Cache-Control: public, max-age=86400
`
);

console.log(`Sitio armado en ${OUT}: ${pages} páginas, marca "${brand.name}", la tienda se puede mostrar en: ${store}`);
