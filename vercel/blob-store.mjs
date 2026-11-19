// Almacén compartido para la demo en Vercel: misma interfaz que Netlify Blobs ({ get(key, opts), set(key, value) }), sobre Vercel Blob privado.
// Se usa desde api/index.mjs con netlify/lib/demo-state.mjs. Las lecturas saltan la caché para ver siempre la última copia.
import { get as readBlob, put } from '@vercel/blob';

const PREFIX = 'dluxe-demo/';

export function vercelBlobStore() {
  return {
    async get(key, opts = {}) {
      const res = await readBlob(PREFIX + key, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200) return null;
      const bytes = await new Response(res.stream).arrayBuffer();
      return opts.type === 'arrayBuffer' ? bytes : new TextDecoder().decode(bytes);
    },
    async set(key, value) {
      await put(PREFIX + key, typeof value === 'string' ? value : Buffer.from(value), {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/octet-stream',
      });
    },
  };
}
