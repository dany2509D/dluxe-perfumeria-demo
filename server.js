import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_PATH = process.env.DB_PATH || fileURLToPath(new URL('./data/aurelia.db', import.meta.url));

const { server, brand, wooClient } = createApp({ dbPath: DB_PATH, password: PASSWORD });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`El puerto ${PORT} ya está en uso. Prueba con: set PORT=3001 && npm start`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ${brand.name} (demo)`);
  console.log(`  Tienda: http://localhost:${PORT}`);
  console.log(`  Panel:  http://localhost:${PORT}/admin   (contraseña: ${PASSWORD})`);
  console.log(`  WooCommerce: ${wooClient ? 'conectado' : 'sin conectar (se puede importar el CSV desde el panel)'}\n`);
});
