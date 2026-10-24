// La API de la tienda como función de Netlify: todo lo que empieza con /api/ lo atiende la misma app que corre en local
// (src: app.js), con la base de datos de ejemplo sincronizada entre instancias (netlify/lib/demo-state.mjs).
// La tienda y el panel (HTML, CSS, JS, fotos) los sirve la red de Netlify como archivos estáticos (carpeta dist/, ver scripts/build-netlify.mjs).
import { getStore } from '@netlify/blobs';
import brandFile from '../../brand.json' with { type: 'json' };
import { resolveBrand } from '../../brand.js';
import { buildChat } from '../../chat-env.js';
import { createDemoState, perCallStore } from '../lib/demo-state.mjs';

let state = null;

export function demoState(store = perCallStore(() => getStore({ name: 'dluxe-demo', consistency: 'strong' })), env = process.env) {
  const brand = resolveBrand(brandFile, env);
  return createDemoState({
    store,
    createOptions: {
      password: env.ADMIN_PASSWORD || 'admin123', // en el panel de Netlify: Site configuration → Environment variables → ADMIN_PASSWORD
      brand,
      trustProxy: true, // detrás de Netlify: la IP del visitante viene en x-nf-client-connection-ip
      demoUsers: env.DEMO_USERS !== '0', // gerente, cajero y bodega de ejemplo (DEMO_USERS=0 los desactiva)
      publicUrl: env.PUBLIC_URL || env.URL || '', // la dirección del sitio, para los enlaces de los avisos
      chatFactory: (db) => buildChat(db, env, brand),
      embedOrigins: env.EMBED_ORIGINS || '',
      frameOrigins: env.FRAME_ORIGINS || '',
    },
  });
}

export default async (req) => {
  state ??= demoState();
  try {
    return await state.handle(req);
  } catch (e) {
    console.error('[demo]', e);
    return Response.json({ error: 'La demostración no pudo responder. Inténtalo de nuevo en unos segundos.' }, { status: 503 });
  }
};

export const config = { path: '/api/*' };
