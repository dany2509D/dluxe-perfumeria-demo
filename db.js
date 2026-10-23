// Base de datos SQLite (módulo nativo de Node, sin dependencias).
// La automatización del inventario vive AQUÍ, en triggers: da igual quién
// registre la venta (web, mostrador, API), el stock siempre se mueve igual.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { searchText } from './text.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LOCAL_NOW = "datetime('now','localtime')";

// Columnas de la tabla de productos (se reutilizan al migrar una base antigua).
const PRODUCT_COLUMNS = `
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'Unisex',   -- Damas, Caballeros, Infantil, Unisex o "Sin clasificar"
  subcategory TEXT,                              -- p. ej. Niñas / Niños
  kind        TEXT NOT NULL DEFAULT 'Perfume',   -- Perfume, Estuche o Tester
  family      TEXT NOT NULL DEFAULT '',
  notes       TEXT,
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#c9a24b',
  image       TEXT,
  is_new      INTEGER NOT NULL DEFAULT 0,
  sold        INTEGER NOT NULL DEFAULT 0,        -- unidades vendidas (se mantiene solo, por triggers)
  permalink   TEXT,                              -- página del producto en otro sitio (p. ej. WooCommerce)
  external_id TEXT,                              -- id en el sistema de origen
  search_text TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (${LOCAL_NOW})
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppliers (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  contact   TEXT,
  lead_days INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS products (${PRODUCT_COLUMNS});

-- Una variante = un tamaño (30 ml, 50 ml, 100 ml; 0 = tamaño único). Es lo que realmente se vende y se cuenta.
-- price es el precio vigente; compare_at, si es mayor, es el precio normal tachado (oferta).
CREATE TABLE IF NOT EXISTS variants (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  sku         TEXT NOT NULL UNIQUE,
  size_ml     INTEGER NOT NULL DEFAULT 0,
  price       REAL NOT NULL CHECK (price >= 0),
  compare_at  REAL,
  cost        REAL NOT NULL DEFAULT 0 CHECK (cost >= 0),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  min_stock   INTEGER NOT NULL DEFAULT 3,
  reorder_qty INTEGER NOT NULL DEFAULT 12,
  supplier_id INTEGER REFERENCES suppliers(id),
  external_id TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_products_cat ON products(active, category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind);
CREATE INDEX IF NOT EXISTS idx_products_sold ON products(sold DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_external ON products(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_external ON variants(external_id) WHERE external_id IS NOT NULL;

-- Libro de movimientos: el stock de una variante es la suma de sus movimientos.
CREATE TABLE IF NOT EXISTS stock_movements (
  id         INTEGER PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  type       TEXT NOT NULL CHECK (type IN ('entrada','salida','ajuste')),
  qty        INTEGER NOT NULL CHECK (qty <> 0),
  reason     TEXT NOT NULL,
  ref_type   TEXT,
  ref_id     INTEGER,
  balance    INTEGER,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_mov_variant ON stock_movements(variant_id, id);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY,
  channel        TEXT NOT NULL CHECK (channel IN ('online','mostrador')),
  customer_name  TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  delivery       TEXT,
  address        TEXT,
  payment_method TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pagado' CHECK (status IN ('pagado','entregado','cancelado')),
  total          REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL,
  unit_cost  REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status      TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','recibida','cancelada')),
  auto        INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  variant_id  INTEGER NOT NULL REFERENCES variants(id),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  unit_cost   REAL NOT NULL CHECK (unit_cost >= 0)
);

-- ─── Automatizaciones ──────────────────────────────────────────────────────

-- Red de seguridad: jamás se puede vender lo que no existe.
CREATE TRIGGER IF NOT EXISTS trg_mov_no_negative
BEFORE INSERT ON stock_movements
WHEN (SELECT stock FROM variants WHERE id = NEW.variant_id) + NEW.qty < 0
BEGIN
  SELECT RAISE(ABORT, 'STOCK_INSUFICIENTE');
END;

-- Cada movimiento actualiza el stock de la variante y guarda el saldo resultante.
CREATE TRIGGER IF NOT EXISTS trg_mov_apply
AFTER INSERT ON stock_movements
BEGIN
  UPDATE variants SET stock = stock + NEW.qty WHERE id = NEW.variant_id;
  UPDATE stock_movements
     SET balance = (SELECT stock FROM variants WHERE id = NEW.variant_id)
   WHERE id = NEW.id;
END;

-- Vender un producto => salida de stock automática.
CREATE TRIGGER IF NOT EXISTS trg_item_sale
AFTER INSERT ON order_items
BEGIN
  INSERT INTO stock_movements (variant_id, type, qty, reason, ref_type, ref_id, created_at)
  SELECT NEW.variant_id, 'salida', -NEW.qty,
         'Venta #' || o.id || ' (' || o.channel || ')', 'order', o.id, o.created_at
    FROM orders o WHERE o.id = NEW.order_id;
END;

-- Mantiene el contador de vendidos de cada producto (para ordenar por "más vendidos" sin recalcular nada).
CREATE TRIGGER IF NOT EXISTS trg_sold_up
AFTER INSERT ON order_items
BEGIN
  UPDATE products SET sold = sold + NEW.qty WHERE id = (SELECT product_id FROM variants WHERE id = NEW.variant_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_sold_down
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelado' AND OLD.status <> 'cancelado'
BEGIN
  UPDATE products
     SET sold = MAX(0, sold - COALESCE((SELECT SUM(oi.qty) FROM order_items oi JOIN variants v ON v.id = oi.variant_id
                                         WHERE oi.order_id = NEW.id AND v.product_id = products.id), 0))
   WHERE id IN (SELECT v.product_id FROM order_items oi JOIN variants v ON v.id = oi.variant_id WHERE oi.order_id = NEW.id);
END;

-- Cancelar un pedido => el stock vuelve solo.
CREATE TRIGGER IF NOT EXISTS trg_order_cancel
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelado' AND OLD.status <> 'cancelado'
BEGIN
  INSERT INTO stock_movements (variant_id, type, qty, reason, ref_type, ref_id)
  SELECT variant_id, 'entrada', qty, 'Cancelación del pedido #' || NEW.id, 'order', NEW.id
    FROM order_items WHERE order_id = NEW.id;
END;

-- Recibir una compra => entrada de stock + costo actualizado.
CREATE TRIGGER IF NOT EXISTS trg_purchase_receive
AFTER UPDATE OF status ON purchases
WHEN NEW.status = 'recibida' AND OLD.status = 'pendiente'
BEGIN
  INSERT INTO stock_movements (variant_id, type, qty, reason, ref_type, ref_id)
  SELECT variant_id, 'entrada', qty, 'Compra #' || NEW.id || ' recibida', 'purchase', NEW.id
    FROM purchase_items WHERE purchase_id = NEW.id;
  UPDATE variants
     SET cost = (SELECT pi.unit_cost FROM purchase_items pi
                  WHERE pi.purchase_id = NEW.id AND pi.variant_id = variants.id)
   WHERE id IN (SELECT variant_id FROM purchase_items WHERE purchase_id = NEW.id);
  UPDATE purchases SET received_at = ${LOCAL_NOW} WHERE id = NEW.id;
END;

-- ─── Integración con WooCommerce (ver woo-sync.js) ─────────────────────────
-- Bandeja de salida: el stock nuevo de cada variante enlazada que hay que avisarle a WooCommerce. Una sola fila por
-- variante (si cambia varias veces antes de enviarse, se envía solo el último valor).
CREATE TABLE IF NOT EXISTS woo_outbox (
  variant_id INTEGER PRIMARY KEY,
  stock      INTEGER NOT NULL,
  queued_at  TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
-- Eventos recibidos por webhook (el id de entrega evita procesar dos veces el mismo aviso).
CREATE TABLE IF NOT EXISTS woo_events (
  delivery_id  TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,
  woo_order_id TEXT,
  status       TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
-- Pedidos de WooCommerce ya descontados del inventario (un pedido nunca se descuenta dos veces).
CREATE TABLE IF NOT EXISTS woo_orders (
  woo_order_id TEXT PRIMARY KEY,
  order_id     INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

-- Reseñas de los clientes en la página de cada producto. sample = 1: reseña de ejemplo de la demostración.
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL,
  sample     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews (product_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_woo_outbox
AFTER UPDATE OF stock ON variants
WHEN NEW.external_id IS NOT NULL AND NEW.stock <> OLD.stock
 AND COALESCE((SELECT value FROM settings WHERE key = 'woo_push'), '0') = '1'
 AND COALESCE((SELECT value FROM settings WHERE key = 'woo_pause'), '0') <> '1'
BEGIN
  INSERT INTO woo_outbox (variant_id, stock) VALUES (NEW.id, NEW.stock)
  ON CONFLICT(variant_id) DO UPDATE SET stock = excluded.stock, queued_at = excluded.queued_at, attempts = 0, last_error = NULL;
END;
`;

export const SCHEMA_VERSION = 3;

// Convierte una base creada con versiones anteriores sin perder datos: categorías Mujer/Hombre → Damas/Caballeros,
// columnas nuevas (tipo, ofertas, contador de vendidos, texto de búsqueda…).
function migrate(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'products'").get()) return; // base nueva
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  if (!cols.includes('search_text')) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE products_new (${PRODUCT_COLUMNS})`);
      db.exec(`INSERT INTO products_new (id, name, brand, category, family, notes, description, color, image, active, created_at, sold)
        SELECT id, name, brand,
               CASE category WHEN 'Mujer' THEN 'Damas' WHEN 'Hombre' THEN 'Caballeros' ELSE category END,
               family, notes, description, color, ${cols.includes('image') ? 'image' : 'NULL'}, active, created_at,
               COALESCE((SELECT SUM(oi.qty) FROM order_items oi
                           JOIN orders o ON o.id = oi.order_id AND o.status <> 'cancelado'
                           JOIN variants v ON v.id = oi.variant_id WHERE v.product_id = products.id), 0)
          FROM products`);
      db.exec('DROP TABLE products');
      db.exec('ALTER TABLE products_new RENAME TO products');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  const vcols = db.prepare('PRAGMA table_info(variants)').all().map((c) => c.name);
  if (!vcols.includes('compare_at')) db.exec('ALTER TABLE variants ADD COLUMN compare_at REAL');
  if (!vcols.includes('external_id')) db.exec('ALTER TABLE variants ADD COLUMN external_id TEXT');
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  db.exec(SCHEMA);
  // Completa el texto de búsqueda de los productos que aún no lo tienen (por ejemplo tras migrar).
  const missing = db.prepare("SELECT id, name, brand, category, subcategory, kind, family, notes FROM products WHERE search_text = ''").all();
  if (missing.length) {
    const upd = db.prepare('UPDATE products SET search_text = ? WHERE id = ?');
    db.exec('BEGIN');
    for (const p of missing) upd.run(searchText(p), p.id);
    db.exec('COMMIT');
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

// Ejecuta fn dentro de una transacción; si algo falla, no queda nada a medias.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
