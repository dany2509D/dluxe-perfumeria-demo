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


// Columnas de la tabla de pedidos (se reutilizan al reconstruir una base antigua: SQLite no permite cambiar un CHECK).
// total = lo que vale la venta (subtotal − descuento). gift_amount es la parte pagada con una tarjeta de regalo.
const ORDERS_COLUMNS = `
  id             INTEGER PRIMARY KEY,
  channel        TEXT NOT NULL CHECK (channel IN ('online','mostrador')),
  customer_name  TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  delivery       TEXT,
  address        TEXT,
  payment_method TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pagado' CHECK (status IN ('pendiente_pago','pagado','entregado','cancelado')),
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  gift_code      TEXT,
  gift_amount    REAL NOT NULL DEFAULT 0,
  coupon_code    TEXT,
  promo_label    TEXT,
  refunded       REAL NOT NULL DEFAULT 0,        -- suma de las devoluciones ya hechas
  customer_id    INTEGER,                        -- cuenta de cliente (si compró con sesión iniciada)
  user_id        INTEGER,                        -- quién cobró (mostrador)
  user_name      TEXT,
  shift_id       INTEGER,                        -- turno de caja en el que se cobró
  tracking_code  TEXT,                           -- código para seguir el pedido sin iniciar sesión
  notify_opt_in  INTEGER NOT NULL DEFAULT 0,     -- el cliente aceptó avisos por WhatsApp
  created_at     TEXT NOT NULL DEFAULT (${LOCAL_NOW})
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
  active      INTEGER NOT NULL DEFAULT 1,
  barcode     TEXT,                                 -- código de barras (EAN/UPC) que lee el escáner del mostrador
  is_set      INTEGER NOT NULL DEFAULT 0            -- 1 = set de regalo: su stock sale de los productos que incluye (bundle_items)
);

CREATE INDEX IF NOT EXISTS idx_products_cat ON products(active, category);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_kind ON products(kind);
CREATE INDEX IF NOT EXISTS idx_products_sold ON products(sold DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_external ON products(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_external ON variants(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_barcode ON variants(barcode) WHERE barcode IS NOT NULL;

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
  user_name  TEXT,                                  -- quién hizo el ajuste manual (las ventas y compras se ligan por su pedido)
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_mov_variant ON stock_movements(variant_id, id);

CREATE TABLE IF NOT EXISTS orders (${ORDERS_COLUMNS});

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  variant_id INTEGER NOT NULL REFERENCES variants(id),
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price REAL NOT NULL,
  unit_cost  REAL NOT NULL DEFAULT 0,
  returned_qty INTEGER NOT NULL DEFAULT 0,          -- unidades ya devueltas por el cliente
  bundle_variant_id INTEGER,                        -- si la línea viene de un set de regalo: la variante del set
  bundle_units INTEGER                              -- cuántos sets se vendieron en ese pedido
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_code) WHERE tracking_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id) WHERE customer_id IS NOT NULL;

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
     SET sold = MAX(0, sold - COALESCE((SELECT SUM(oi.qty - oi.returned_qty) FROM order_items oi JOIN variants v ON v.id = oi.variant_id
                                         WHERE oi.order_id = NEW.id AND v.product_id = products.id), 0))
   WHERE id IN (SELECT v.product_id FROM order_items oi JOIN variants v ON v.id = oi.variant_id WHERE oi.order_id = NEW.id);
END;

-- Cancelar un pedido => el stock vuelve solo.
CREATE TRIGGER IF NOT EXISTS trg_order_cancel
AFTER UPDATE OF status ON orders
WHEN NEW.status = 'cancelado' AND OLD.status <> 'cancelado'
BEGIN
  INSERT INTO stock_movements (variant_id, type, qty, reason, ref_type, ref_id)
  SELECT variant_id, 'entrada', qty - returned_qty, 'Cancelación del pedido #' || NEW.id, 'order', NEW.id
    FROM order_items WHERE order_id = NEW.id AND qty - returned_qty > 0;
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

-- ─── Personal, bitácora y clientes ─────────────────────────────────────────
-- Usuarios del panel (ver auth.js). La clave se guarda con scrypt, nunca en claro.
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','gerente','cajero','inventario')),
  pass_hash  TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  last_login TEXT
);

-- Bitácora: quién hizo qué y cuándo (se escribe desde la API; nunca guarda claves).
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER,
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);

-- Cuentas de clientes de la tienda (ver accounts.js).
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT NOT NULL DEFAULT '',
  pass_hash     TEXT NOT NULL,
  notify_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  last_login    TEXT
);
CREATE TABLE IF NOT EXISTS customer_favorites (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  PRIMARY KEY (customer_id, product_id)
);

-- ─── Caja y devoluciones ───────────────────────────────────────────────────
-- Un turno de caja por cajero: se abre con un fondo y se cierra contando el efectivo (ver shifts.js).
CREATE TABLE IF NOT EXISTS cash_shifts (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  user_name     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto','cerrado')),
  opening_cash  REAL NOT NULL DEFAULT 0,
  opened_at     TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  closed_at     TEXT,
  expected_cash REAL,
  counted_cash  REAL,
  difference    REAL,
  notes         TEXT NOT NULL DEFAULT '',
  summary       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_open ON cash_shifts(user_id) WHERE status = 'abierto';
CREATE TABLE IF NOT EXISTS cash_movements (
  id         INTEGER PRIMARY KEY,
  shift_id   INTEGER NOT NULL REFERENCES cash_shifts(id),
  kind       TEXT NOT NULL CHECK (kind IN ('ingreso','retiro')),
  amount     REAL NOT NULL CHECK (amount > 0),
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

CREATE TABLE IF NOT EXISTS returns (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  user_id       INTEGER,
  user_name     TEXT NOT NULL DEFAULT '',
  shift_id      INTEGER,
  reason        TEXT NOT NULL,
  refund_method TEXT NOT NULL CHECK (refund_method IN ('efectivo','metodo_original','nota_credito')),
  amount        REAL NOT NULL,
  credit_code   TEXT,
  created_at    TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_returns_order ON returns(order_id);
CREATE TABLE IF NOT EXISTS return_items (
  id            INTEGER PRIMARY KEY,
  return_id     INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  variant_id    INTEGER NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_refund   REAL NOT NULL,
  unit_cost     REAL NOT NULL DEFAULT 0,
  restock       INTEGER NOT NULL DEFAULT 1
);

-- ─── Ofertas, tarjetas de regalo y sets ────────────────────────────────────
-- Una promoción con código es un cupón; sin código se aplica sola en la bolsa (ver pricing.js).
CREATE TABLE IF NOT EXISTS promotions (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  code         TEXT UNIQUE COLLATE NOCASE,
  kind         TEXT NOT NULL CHECK (kind IN ('percent','fixed','bundle')),
  amount       REAL NOT NULL DEFAULT 0,
  buy_qty      INTEGER NOT NULL DEFAULT 0,
  scope        TEXT NOT NULL DEFAULT 'todo' CHECK (scope IN ('todo','marca','categoria','tipo')),
  scope_value  TEXT NOT NULL DEFAULT '',
  min_total    REAL NOT NULL DEFAULT 0,
  skip_sale    INTEGER NOT NULL DEFAULT 1,
  channel      TEXT NOT NULL DEFAULT 'ambos' CHECK (channel IN ('ambos','online','mostrador')),
  starts_at    TEXT,
  ends_at      TEXT,
  max_uses     INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  per_customer INTEGER NOT NULL DEFAULT 0,
  featured     INTEGER NOT NULL DEFAULT 0,   -- 1 = el código se anuncia en la tienda (los demás cupones son secretos)
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

CREATE TABLE IF NOT EXISTS gift_cards (
  id              INTEGER PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  initial_amount  REAL NOT NULL CHECK (initial_amount > 0),
  balance         REAL NOT NULL CHECK (balance >= 0),
  status          TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('pendiente','activa','anulada')),
  source          TEXT NOT NULL DEFAULT 'venta' CHECK (source IN ('venta','nota_credito','manual')),
  buyer_name      TEXT NOT NULL DEFAULT '',
  buyer_email     TEXT,
  buyer_phone     TEXT,
  recipient_name  TEXT NOT NULL DEFAULT '',
  recipient_email TEXT,
  recipient_phone TEXT,
  message         TEXT NOT NULL DEFAULT '',
  payment_method  TEXT,
  user_id         INTEGER,
  shift_id        INTEGER,
  expires_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE TABLE IF NOT EXISTS gift_card_uses (
  id           INTEGER PRIMARY KEY,
  gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id),
  order_id     INTEGER,
  kind         TEXT NOT NULL CHECK (kind IN ('canje','reverso','ajuste')),
  amount       REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

-- Qué incluye cada set de regalo. El set es una variante más (is_set = 1) y su stock sale de estas filas.
CREATE TABLE IF NOT EXISTS bundle_items (
  bundle_variant_id    INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  component_variant_id INTEGER NOT NULL REFERENCES variants(id),
  qty                  INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (bundle_variant_id, component_variant_id)
);
CREATE INDEX IF NOT EXISTS idx_bundle_component ON bundle_items(component_variant_id);

-- ─── Seguimiento, avisos y archivos ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  user_name  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, id);

-- «Avísame cuando llegue»: quien pidió que le avisen cuando vuelva un producto agotado.
CREATE TABLE IF NOT EXISTS stock_alerts (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  INTEGER REFERENCES variants(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('email','whatsapp')),
  contact     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  notified_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_alert_open ON stock_alerts(product_id, COALESCE(variant_id, 0), contact) WHERE notified_at IS NULL;

-- Bandeja de salida de avisos (WhatsApp / correo). Ver notify.js.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  to_addr    TEXT NOT NULL,
  template   TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','enviado','error','simulado')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status, id);

-- Fotos subidas desde el panel (ver media.js).
CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  size       INTEGER NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);

-- Pagos con pasarela externa y facturas electrónicas (ver payments.js e invoicing.js).
CREATE TABLE IF NOT EXISTS payment_attempts (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  reference  TEXT NOT NULL UNIQUE,
  amount     REAL NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','pagado','fallido','vencido')),
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW}),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS fiscal_docs (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  return_id  INTEGER,
  kind       TEXT NOT NULL CHECK (kind IN ('factura','nota_credito')),
  number     TEXT,
  auth_code  TEXT,
  url        TEXT,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pendiente','emitida','error','simulada')),
  amount     REAL NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (${LOCAL_NOW})
);
CREATE INDEX IF NOT EXISTS idx_fiscal_order ON fiscal_docs(order_id);

-- El stock de un set es el de su componente más escaso: se recalcula solo cuando cambia el de un componente.
CREATE TRIGGER IF NOT EXISTS trg_set_stock
AFTER UPDATE OF stock ON variants
WHEN NEW.stock <> OLD.stock AND EXISTS (SELECT 1 FROM bundle_items WHERE component_variant_id = NEW.id)
BEGIN
  UPDATE variants
     SET stock = COALESCE((SELECT MIN(cv.stock / bi.qty) FROM bundle_items bi JOIN variants cv ON cv.id = bi.component_variant_id
                            WHERE bi.bundle_variant_id = variants.id), 0)
   WHERE is_set = 1 AND id IN (SELECT bundle_variant_id FROM bundle_items WHERE component_variant_id = NEW.id);
END;

-- Cuando un producto agotado vuelve a tener existencias, se avisa a quienes lo pidieron.
CREATE TRIGGER IF NOT EXISTS trg_stock_back
AFTER UPDATE OF stock ON variants
WHEN OLD.stock = 0 AND NEW.stock > 0
BEGIN
  INSERT OR IGNORE INTO notifications (channel, to_addr, template, payload, status, dedupe_key)
  SELECT a.channel, a.contact, 'stock_disponible',
         json_object('alert_id', a.id, 'product_id', a.product_id, 'variant_id', NEW.id, 'name', a.name),
         CASE COALESCE((SELECT value FROM settings WHERE key = 'notify_mode'), 'simulado') WHEN 'webhook' THEN 'pendiente' ELSE 'simulado' END,
         'back:' || a.id
    FROM stock_alerts a
   WHERE a.notified_at IS NULL AND a.product_id = NEW.product_id AND (a.variant_id IS NULL OR a.variant_id = NEW.id);
  UPDATE stock_alerts SET notified_at = ${LOCAL_NOW}
   WHERE notified_at IS NULL AND product_id = NEW.product_id AND (variant_id IS NULL OR variant_id = NEW.id);
END;

-- Stock bajo: un aviso al encargado (una vez al día por producto) cuando una variante cruza su mínimo.
CREATE TRIGGER IF NOT EXISTS trg_low_stock
AFTER UPDATE OF stock ON variants
WHEN NEW.is_set = 0 AND NEW.active = 1 AND NEW.stock <= NEW.min_stock AND OLD.stock > OLD.min_stock
BEGIN
  INSERT OR IGNORE INTO notifications (channel, to_addr, template, payload, status, dedupe_key)
  SELECT 'whatsapp', s.value, 'stock_bajo', json_object('variant_id', NEW.id, 'stock', NEW.stock, 'min', NEW.min_stock),
         CASE COALESCE((SELECT value FROM settings WHERE key = 'notify_mode'), 'simulado') WHEN 'webhook' THEN 'pendiente' ELSE 'simulado' END,
         'low:w:' || NEW.id || ':' || date('now', 'localtime')
    FROM settings s WHERE s.key = 'alert_whatsapp' AND s.value <> '';
  INSERT OR IGNORE INTO notifications (channel, to_addr, template, payload, status, dedupe_key)
  SELECT 'email', s.value, 'stock_bajo', json_object('variant_id', NEW.id, 'stock', NEW.stock, 'min', NEW.min_stock),
         CASE COALESCE((SELECT value FROM settings WHERE key = 'notify_mode'), 'simulado') WHEN 'webhook' THEN 'pendiente' ELSE 'simulado' END,
         'low:e:' || NEW.id || ':' || date('now', 'localtime')
    FROM settings s WHERE s.key = 'alert_email' AND s.value <> '';
END;

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

export const SCHEMA_VERSION = 4;

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
  migrateV4(db, vcols);
}

// Versión 4: usuarios, caja, devoluciones, ofertas, tarjetas de regalo, sets, avisos… Las tablas nuevas las crea SCHEMA; aquí
// se agregan las columnas a las tablas que ya existían y se reconstruye `orders` (un CHECK no se puede cambiar en SQLite).
function migrateV4(db, vcols) {
  const addColumn = (table, name, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.length && !cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const ordersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get()?.sql || '';
  const rebuildOrders = ordersSql && !ordersSql.includes('pendiente_pago');

  // Los triggers se vuelven a crear al abrir (CREATE TRIGGER IF NOT EXISTS): hay que soltar los viejos para que tomen la
  // definición nueva (la cancelación ya no devuelve dos veces lo devuelto) y para poder reconstruir `orders` sin que
  // ninguno apunte a una tabla ausente.
  if (version < 4 || rebuildOrders) {
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
  }

  if (!vcols.includes('barcode')) db.exec('ALTER TABLE variants ADD COLUMN barcode TEXT');
  if (!vcols.includes('is_set')) db.exec('ALTER TABLE variants ADD COLUMN is_set INTEGER NOT NULL DEFAULT 0');
  addColumn('stock_movements', 'user_name', 'TEXT');
  addColumn('order_items', 'returned_qty', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('order_items', 'bundle_variant_id', 'INTEGER');
  addColumn('order_items', 'bundle_units', 'INTEGER');

  if (rebuildOrders) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`CREATE TABLE orders_new (${ORDERS_COLUMNS})`);
      const oldCols = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name));
      const shared = db.prepare('PRAGMA table_info(orders_new)').all().map((c) => c.name).filter((c) => oldCols.has(c));
      db.exec(`INSERT INTO orders_new (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM orders`);
      db.exec('UPDATE orders_new SET subtotal = total WHERE subtotal = 0'); // los pedidos anteriores no tenían descuento
      db.exec('DROP TABLE orders');
      db.exec('ALTER TABLE orders_new RENAME TO orders');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
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

// Ejecuta fn dentro de una transacción; si algo falla, no queda nada a medias. Si ya hay una abierta, se une a ella:
// así una operación que usa otra (confirmar un pago que cancela un pedido) sigue siendo todo-o-nada.
export function tx(db, fn) {
  if (db.isTransaction) return fn();
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
