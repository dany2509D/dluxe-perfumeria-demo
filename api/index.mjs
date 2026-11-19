// La API de la tienda como función de Vercel (todo lo de /api/*): la misma app que en local y en Netlify, con la base de datos de ejemplo
// sincronizada entre instancias en Vercel Blob. La tienda y el panel salen como archivos estáticos (dist/, ver scripts/build-netlify.mjs).
import brandFile from '../brand.json' with { type: 'json' };
import { resolveBrand } from '../brand.js';
import { buildChat } from '../chat-env.js';
import { createDemoState } from '../netlify/lib/demo-state.mjs';
import { vercelBlobStore } from '../vercel/blob-store.mjs';

let state = null;

function demoState(env = process.env) {
  const brand = resolveBrand(brandFile, env);
  return createDemoState({
    store: vercelBlobStore(),
    createOptions: {
      password: env.ADMIN_PASSWORD || 'admin123',
      brand,
      trustProxy: true,
      demoUsers: env.DEMO_USERS !== '0',
      publicUrl: env.PUBLIC_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : ''),
      chatFactory: (db) => buildChat(db, env, brand),
      embedOrigins: env.EMBED_ORIGINS || '',
      frameOrigins: env.FRAME_ORIGINS || '',
    },
  });
}

export default {
  async fetch(req) {
    state ??= demoState();
    try {
      return await state.handle(req);
    } catch (e) {
      console.error('[demo]', e);
      return Response.json({ error: 'La demostración no pudo responder. Inténtalo de nuevo en unos segundos.' }, { status: 503 });
    }
  },
};
