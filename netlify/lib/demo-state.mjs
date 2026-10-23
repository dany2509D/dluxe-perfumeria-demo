// Estado compartido de la demo cuando corre como función serverless (Netlify).
//
// Una función no tiene disco ni memoria permanentes, y Netlify puede atender dos peticiones seguidas con instancias distintas.
// Para que la demo sea coherente (la compra que haces en la tienda aparece en el panel), cada instancia mantiene su propia copia de
// la base de datos SQLite en /tmp y la sincroniza con una copia compartida en Netlify Blobs:
//   · antes de cada petición mira un número de versión (una lectura pequeña) y, si otra instancia guardó algo más nuevo, descarga esa copia;
//   · después de una petición que cambió datos, sube la copia nueva y cambia la versión.
// Las peticiones se atienden de a una por instancia. Si dos instancias escriben a la vez, gana la última (es una demo, no un sistema real).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../app.js';

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'];

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const rmDb = (file) => { for (const ext of ['', '-wal', '-shm']) rmSync(file + ext, { force: true }); };

// store: { get(key, opts), set(key, value) } (Netlify Blobs o un doble en las pruebas). createOptions: opciones de createApp.
export function createDemoState({ store, createOptions = {}, dir = join(tmpdir(), 'dluxe-demo'), retireAfterMs = 60_000 }) {
  mkdirSync(dir, { recursive: true });
  let current = null; // { app, port, file, version }
  let queue = Promise.resolve();

  async function open(file, version) {
    const app = createApp({ ...createOptions, dbPath: file });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    app.server.unref(); // el servidor interno nunca mantiene vivo el proceso por sí solo
    return { app, port: app.server.address().port, file, version };
  }

  // La instancia anterior se cierra un poco después: puede tener una respuesta en curso (el chat va en un flujo).
  function retire(old) {
    if (!old) return;
    const timer = setTimeout(() => {
      old.app.server.close();
      try { old.app.db.close(); } catch { /* ya cerrada */ }
      rmDb(old.file);
    }, retireAfterMs);
    timer.unref?.();
  }

  // Nombres únicos: si el entorno vuelve a cargar este módulo en el mismo proceso, no se pisa un archivo todavía abierto.
  const newFile = () => join(dir, `demo-${randomUUID()}.db`);

  async function upload(snapshot) {
    const file = join(dir, `snap-${randomUUID()}.db`);
    try {
      snapshot.app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      snapshot.app.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      await store.set('db', toArrayBuffer(readFileSync(file)));
      const version = randomUUID();
      await store.set('version', version); // primero la copia, después la versión: quien ve la versión nueva ya encuentra la copia
      snapshot.version = version;
    } finally {
      rmDb(file);
    }
  }

  // Deja la copia local al día con la compartida (o crea la inicial si todavía no hay ninguna).
  async function sync() {
    const version = await store.get('version');
    if (current && (version == null || version === current.version)) return;
    if (version == null) {
      current = await open(newFile(), null);
      await upload(current); // todas las instancias parten de la misma base
      return;
    }
    const bytes = await store.get('db', { type: 'arrayBuffer' });
    if (!bytes) { // versión sin copia (no debería pasar): se parte de una base nueva
      const fresh = await open(newFile(), null);
      retire(current);
      current = fresh;
      await upload(current);
      return;
    }
    const file = newFile();
    writeFileSync(file, Buffer.from(bytes));
    const next = await open(file, version);
    retire(current);
    current = next;
  }

  const changes = () => current.app.db.prepare('SELECT total_changes() AS n').get().n;

  async function run(req) {
    await sync();
    const before = changes();
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    for (const h of [...HOP_BY_HOP, 'host', 'content-length']) headers.delete(h);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    const init = { method: req.method, headers, redirect: 'manual' };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = Buffer.from(await req.arrayBuffer());
    const res = await fetch(`http://127.0.0.1:${current.port}${url.pathname}${url.search}`, init);
    // El servidor ya terminó de escribir cuando responde (el chat solo lee), así que se puede decidir si hay algo nuevo que guardar.
    if (changes() !== before) await upload(current);
    const out = new Headers(res.headers);
    for (const h of HOP_BY_HOP) out.delete(h);
    return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out });
  }

  return {
    // Atiende de a una por instancia (evita cambiar de copia a mitad de una petición).
    handle(req) {
      const task = queue.then(() => run(req));
      queue = task.catch(() => {});
      return task;
    },
    current: () => current,
    async close() {
      await queue.catch(() => {});
      if (current) { current.app.server.close(); try { current.app.db.close(); } catch { /* ya cerrada */ } rmDb(current.file); current = null; }
    },
  };
}
