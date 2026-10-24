# D'Luxe Perfumería — demo de tienda con inventario automático

Tienda online + punto de venta + inventario, todo conectado, pensada para un catálogo de **miles de productos**. Cuando se vende
algo (por la web o en mostrador) el stock baja solo, queda registrado el movimiento y, si llega al mínimo, se genera una orden de
compra automática.

Sirve de dos maneras, con el mismo código:

- **A. Tienda nueva**: reemplaza la web actual (catálogo con filtros, búsqueda, ofertas y cupones, marcas, favoritos, cuenta de cliente, seguimiento del pedido,
  buscador guiado, tarjetas y sets de regalo, bolsa, pago, punto de venta con caja, devoluciones y recibos, reportes y panel con usuarios y roles).
- **B. Capa de inventario para la tienda que ya existe** (WordPress/WooCommerce): importa el catálogo con un informe de calidad de
  datos, mantiene el stock al día en los dos sentidos y pone el asistente de compras dentro de la web actual con una sola línea.

Necesita **Node.js 22.16 o superior** (probado con Node 24). Una sola dependencia: el SDK oficial de Anthropic, que usa el asistente
de IA opcional. Sin ninguna clave ni cuenta externa, todo funciona igual.

## Cómo arrancar

```bash
npm install   # solo la primera vez
npm start
```

| Qué | Dónde |
|---|---|
| Tienda | http://localhost:3000 |
| Panel de administración | http://localhost:3000/admin — usuario **`admin`**, contraseña **`admin123`** (también hay `gerente`, `cajero` y `bodega`, con la misma contraseña: ver «Usuarios, roles y bitácora») |

En VS Code también puedes usar **Terminal → Ejecutar tarea → Iniciar demo**, o la tecla **F5** (depura el servidor).

```bash
npm test                      # 348 pruebas: backend, catálogo, migración, escala, usuarios y permisos, caja, devoluciones, reportes, ofertas, regalos, avisos, pagos, facturas, códigos de barras, WooCommerce, chat embebido y asistente
npm run seed                  # reinicia la base con los 27 productos de ejemplo
npm run seed:large            # catálogo de prueba de 8.500 productos (para ver el rendimiento a escala)
npm run build:netlify         # arma dist/ (sitio estático para Netlify)
npm run deploy                # publica en Netlify (ver «Demo en Netlify»)
```

Otro puerto o contraseña (PowerShell):

```powershell
$env:PORT = 3001; npm start
$env:ADMIN_PASSWORD = "otra-clave"; npm start
```

En el panel hay botones **Reiniciar demo** y **Catálogo masivo** (genera los 8.500 productos de prueba; tarda unos segundos).

## Marca

El nombre y los datos de la tienda están en **`brand.json`** (o variables `BRAND_NAME`, `BRAND_SHORT`, `STORE_PHONE`, `STORE_EMAIL`,
`STORE_ADDRESS`, `STORE_WHATSAPP`). Cambiarlos cambia la tienda, el panel, el chat y los textos de ayuda. También ahí: país, moneda,
impuesto (**ITBMS 7 % incluido en el precio**, configurable), horario y redes. El prefijo de los SKU nuevos es `DLX`.

La vista **Quiénes somos** (el botón de la barra, o la dirección `/#nosotros`; al entrar a la tienda se ven los perfumes) y lo que contesta el asistente a «¿quiénes son?» o «¿desde cuándo existen?») sale del bloque
`about` de `brand.json`: `lead` (presentación), `pillars` (hasta 4 datos clave con `title` y `text`), `mission`, `vision`, `values`,
`where` (dónde está la tienda) y `note`. En los textos valen `{years}` y `{founded}`, que se calculan con `founded` (año de fundación);
sin ese año, esos datos se omiten. Si falta el bloque, se usa un texto genérico con el nombre de la tienda. El texto de D'Luxe es de
ejemplo, redactado a partir de la información pública de su sitio: la empresa define el definitivo. El teléfono, el correo y la
dirección de contacto se dejan vacíos a propósito (la demo no debe mandar clientes de prueba al número real); se activan en `brand.json`.

## Qué hace

**Tienda**: categorías Damas · Caballeros · Infantil · Unisex; tipos Perfume · Estuche · Tester; búsqueda sin acentos ni mayúsculas
con relevancia; filtros por marca, familia olfativa, precio, ofertas, novedades y disponibilidad con **conteos por filtro**; orden
(recomendados, novedades, precio, mayor descuento); precio tachado y % de descuento; directorio de marcas; **paginación de 25 productos por página**; los
filtros y la página viven en la dirección (se pueden compartir como enlace); bolsa que se recupera entre visitas; envíos y pagos, contacto y
quiénes somos. Todo se filtra y pagina **en el servidor**: con 8.500 productos la portada responde en milisegundos.

**Página de producto** (`/#producto/12-nombre`): al tocar un perfume se abre el recuadro de siempre (con su botón de agregar) y un enlace lleva
a la página completa: foto grande, tamaños, precio, cantidad y **Agregar a la bolsa**; detalles (marca, familia olfativa, notas, tamaños);
**productos recomendados** (misma marca, familia, categoría y tipo; primero los que hay en existencia) y **reseñas** (promedio, reparto por
estrellas, lista paginada y formulario para escribir la suya). Se puede abrir directo por la dirección, compartir y volver con Atrás. Las
reseñas llevan antispam (sin enlaces, campo trampa, tope por visitante: `REVIEW_RATE_PER_HOUR`) y el HTML que alguien escriba se muestra siempre
como texto. En el panel, la sección **Reseñas** las lista y permite eliminar las que no deban mostrarse; «Reiniciar demo» las devuelve a las
de ejemplo (nombres inventados y comentarios generales).

**Panel** (`/admin`): el menú muestra a cada persona solo lo que su rol permite.
- **Resumen**: ventas, margen, valor del inventario, alertas, gráfico de 14 días, más vendidos, canales.
- **Venta**: **Punto de venta** (escáner, cupón, tarjeta de regalo, descuento manual, vuelto, recibo), **Caja**, **Pedidos** (ficha, entrega paso a paso, devoluciones), **Tarjetas de regalo**, **Promociones**.
- **Inventario**: **Inventario** (paginado, búsqueda, filtros, ajustes con motivo, historial, importación CSV, código de barras y etiquetas), **Productos** (crear, editar con descripción y foto, ocultar), **Sets de regalo**, **Compras** y **Movimientos**.
- **Análisis**: **Reportes** (ventas, márgenes, rotación, CSV) y **Reseñas**.
- **Conexión**: **Avisos** (WhatsApp y correo), **Facturas** y **WooCommerce**.
- **Administración**: **Usuarios** y **Bitácora**.

### Qué está automatizado

| Evento | Resultado automático |
|---|---|
| Se confirma una venta | Sale el stock y se registra el movimiento |
| Se cancela un pedido | El stock vuelve |
| Una variante cae al mínimo | Se agrega a una orden de compra pendiente de su proveedor |
| Se recibe una compra | Entra el stock y se actualiza el costo |
| Dos clientes compran la última unidad | Solo uno lo logra; el otro recibe un aviso |
| Algo falla a mitad de un pedido | Nada queda a medias (todo o nada) |
| Se vende algo en WooCommerce | Llega un aviso firmado y el stock baja aquí (una sola vez) |
| Se vende aquí (con el envío activo) | El stock nuevo se manda a WooCommerce, con reintentos |
| Se vende un set de regalo | Cada pieza descuenta su stock y el stock del set se recalcula solo |
| Un producto agotado vuelve a tener existencias | Sale un aviso a quienes pidieron «avísame cuando llegue» (una sola vez) |
| Una variante cruza su mínimo | Aviso al encargado (si hay contacto configurado) y orden de compra |
| Se cobra una venta o se devuelve algo | Factura o nota de crédito electrónica, y aviso al cliente |
| Un pedido espera un pago que nunca llega | Vence solo y el stock reservado vuelve |

La lógica vive en **triggers de la base de datos** (`db.js`), así que da igual por dónde entre la venta.

## Usuarios, roles y bitácora

El panel ya no tiene una sola contraseña: cada persona entra con **su usuario** y ve **solo lo que su rol permite**. Las claves se guardan con
scrypt (nunca en claro), las sesiones se firman y se cierran solas al cambiar la clave o desactivar al usuario, y entrar con una clave mala
varias veces bloquea ese usuario desde esa conexión por 15 minutos (`LOGIN_MAX_FAILS`, 8 por defecto).

| Rol | Qué puede hacer |
|---|---|
| **Administrador** | Todo: usuarios, conexiones (WooCommerce), reiniciar la demostración. |
| **Gerente** | Ventas, caja de todo el equipo, devoluciones, descuentos sin tope, reportes, inventario y precios, promociones, tarjetas de regalo, sets, avisos y facturas. No gestiona usuarios. |
| **Cajero** | Cobra en el mostrador, abre y cierra su caja, ve pedidos y tarjetas de regalo. No ve costos, reportes ni el resumen. Descuento manual hasta un tope (10 % por defecto). |
| **Inventario** | Existencias, productos, sets, compras y movimientos, con costos. No cobra ni ve ventas. |

La demostración trae un usuario de ejemplo por rol: **`admin`**, **`gerente`**, **`cajero`** y **`bodega`**, todos con la contraseña del administrador
(`ADMIN_PASSWORD`, o `admin123`). En una tienda real se desactivan o se les cambia la clave desde **Usuarios**. `ADMIN_PASSWORD` solo crea el
administrador inicial; después la clave se cambia en el panel (**Mi cuenta**). Cada ruta de la API declara el permiso que exige y la app no
arranca si alguna lo olvida; quien no tiene permiso para ver costos tampoco los recibe por la API.

La **Bitácora** anota quién hizo qué y cuándo (ventas, ajustes de stock con su motivo, cambios de precio con el valor anterior y el nuevo,
cancelaciones, devoluciones, cierres de caja, cambios de usuarios…). Nunca guarda claves; los movimientos de inventario también llevan el nombre de
quien los hizo. Los intentos fallidos de entrar solo quedan en el registro del servidor (así no escriben en la base de datos).

## Caja, devoluciones y recibos

- **Caja**: cada cajero abre su turno con un fondo, cobra, registra ingresos y retiros y, al terminar, cuenta el efectivo: el sistema calcula lo
  esperado (fondo + ventas en efectivo + tarjetas de regalo vendidas en efectivo + ingresos − retiros − devoluciones en efectivo) y muestra el
  faltante o sobrante. La tarjeta y la transferencia no cuentan como efectivo. El gerente ve y puede cerrar la caja de cualquiera. Ajuste
  **«Exigir caja abierta para cobrar»** en *Ajustes de la tienda*. El cierre se imprime.
- **Punto de venta**: además de buscar, **escanea** (lector USB: escribe el código y Enter; o la cámara, en navegadores que traen `BarcodeDetector`),
  aplica **cupón**, **tarjeta de regalo** y **descuento manual** (con motivo, dentro del tope del rol), calcula el **vuelto** y entrega el **recibo**
  (80 mm, con vista previa, factura de demostración y enlace de seguimiento).
- **Devoluciones** (desde la ficha del pedido): una parte o todo; se devuelve lo que el cliente **realmente pagó** (el descuento se prorratea);
  el producto vuelve al inventario salvo que llegue dañado; el dinero sale en efectivo de la caja, por el mismo método de pago (se hace aparte, en el
  banco) o como **nota de crédito** (una tarjeta de regalo con ese saldo). Pasado el plazo (30 días, configurable) solo un gerente la autoriza. Un
  pedido pagado con tarjeta de regalo solo se devuelve como nota de crédito. Cada devolución genera su nota de crédito electrónica y queda en la bitácora.
- **Pedidos**: la ficha muestra líneas, historial, pagos, facturas y devoluciones; se avanza la entrega (*preparando → listo para retirar / en camino →
  entregado*) y el cliente recibe el aviso de cada paso. Se abre directo con `/admin#pedidos/123`.

## Reportes

**Ventas y márgenes** (por período): ventas netas (después de descuentos y devoluciones), margen, ticket promedio, descuentos dados, ventas por día,
por marca, categoría, familia olfativa, canal, forma de pago, vendedor y producto; exporta **pedidos** y **productos** a CSV (separador `;`, con acentos
y a prueba de fórmulas de Excel) y se imprime. **Rotación del inventario**: capital parado en lo que no se vende (con el aviso de si el historial
alcanza), lo que se acaba pronto, lo que más rota y el sobrestock. Los sets no cuentan dos veces en el valor del inventario.

## Ofertas, cupones, sets y tarjetas de regalo

- **Promociones**: porcentaje, monto fijo o «llévate N por $X», para toda la tienda o una marca, categoría o tipo; con fechas, compra mínima, máximo de
  usos, una vez por cliente y canal (línea / mostrador). Sin código se aplican **solas**; con código son **cupones**. En cada compra se aplica
  **una sola** promoción (la que más descuenta); lo que ya está en oferta y los sets no entran, salvo que se cambie. Los códigos son secretos: la tienda
  solo anuncia las ofertas automáticas y los cupones marcados «anunciar en la tienda».
- **Sets de regalo**: se arman con perfumes del inventario a un precio menor que por separado. El set es un producto más de la tienda, sin stock propio:
  se pueden vender tantos como alcancen sus piezas, y al venderlo cada pieza descuenta lo suyo (y devuelve lo suyo si se cancela). El precio del set se
  reparte entre sus piezas al centavo, así que reportes y devoluciones siguen cuadrando.
- **Tarjetas de regalo**: se compran en la tienda o en el mostrador, tienen código imposible de adivinar (60 bits), saldo y vencimiento (12 meses); se pagan
  parcial o totalmente en el pedido y, si el pedido se cancela, el saldo vuelve. Por transferencia quedan «esperando pago» hasta que el gerente las
  activa. Una tarjeta es dinero recibido por adelantado, no una venta: los reportes la separan. La demostración trae una de ejemplo, **`GC-DEMO-0050`** ($50).

## La tienda más allá del catálogo

- **Favoritos** (corazón en cada producto; en el navegador y, con cuenta, también en ella), **cuenta de cliente** (opcional: comprar no la exige; ve sus
  pedidos y guarda favoritos), **seguimiento del pedido** (`/#seguimiento/CÓDIGO`, o con el número de pedido y el correo o teléfono; el código que
  se envía por aviso no se puede adivinar) y **buscador guiado** («Encuentra tu perfume»: cinco preguntas, tres recomendaciones con el motivo de cada
  una; reglas claras sobre el catálogo real, sin inteligencia artificial, gratis y siempre la misma respuesta).
- **«Avísame cuando llegue»**: en un tamaño agotado el cliente deja su correo o WhatsApp; cuando vuelve el stock sale un solo aviso.
- **Barra de ofertas**, **cupón** en la bolsa y en el pago, **tarjeta de regalo** en el pago y **aceptación de avisos por WhatsApp** (casilla sin marcar de
  antemano: es consentimiento).
- Límites contra abuso (por conexión, en memoria): reseñas, cuentas nuevas (`ACCOUNT_REGISTER_PER_HOUR`), consultas y compras de tarjetas, pedidos seguidos
  (`ORDER_RATE_PER_10MIN`), códigos de regalo falsos y pedidos que reservan stock esperando un pago (`PENDING_ORDERS_MAX`).
- Limitación conocida: el correo de una cuenta **no se verifica** (la demostración no envía correos de verdad), así que una cuenta nueva no recoge los pedidos
  que se hicieron antes como invitado. En producción hay que confirmar el correo (o el WhatsApp) con un código.

## Avisos por WhatsApp y correo (conexión con n8n)

Cada aviso (confirmación del pedido y cada paso de su entrega, «ya llegó lo que pediste», tarjetas de regalo, alertas de stock bajo al encargado) se guarda en una
**bandeja de salida** (sección **Avisos** del panel) con su texto exacto. Qué pasa después depende de la instalación:

- **Sin `NOTIFY_WEBHOOK_URL` (demostración)**: quedan como *simulados*: se ve lo que recibiría el cliente, pero no sale nada.
- **Con `NOTIFY_WEBHOOK_URL`**: cada aviso se envía por `POST` a ese enlace (un flujo de n8n, por ejemplo) y se reintenta hasta 5 veces; si sigue fallando
  queda en *error* para reintentarlo a mano. A WhatsApp solo se escribe a quien lo **aceptó** al comprar o al pedir el aviso, y a los números del propio equipo.

Contrato del `POST` (JSON), con la cabecera `X-Signature: sha256=<HMAC-SHA256 del cuerpo sin modificar, con NOTIFY_WEBHOOK_SECRET>` y `X-Notification-Id`:

```json
{
  "id": 41,
  "event": "pedido_estado",
  "channel": "whatsapp",
  "to": "50760001234",
  "subject": "D'Luxe: Tu pedido #55 está listo para retirar",
  "text": "D'Luxe: Hola Elena, tu pedido #55 ya está listo para retirar en tienda.\nhttps://…/#seguimiento/NZR7QW9BSF",
  "data": { "step": "listo", "order_id": 55, "name": "Elena Prueba", "total": 153.9, "tracking_code": "NZR7QW9BSF", "url": "https://…" },
  "store": "D'Luxe Perfumería",
  "created_at": "2026-10-23 17:02:11"
}
```

| `event` | Cuándo | Datos en `data` |
|---|---|---|
| `pedido_estado` | Pedido recibido, pago confirmado, preparando, listo para retirar, en camino, entregado, cancelado | `step`, `order_id`, `name`, `total`, `url`, `tracking_code`, `delivery`, `address`, `lines` |
| `stock_disponible` | Volvió el stock de algo que el cliente pidió | `alert_id`, `product_id`, `variant_id`, `name` |
| `stock_bajo` | Una variante cruzó su mínimo (al encargado; una vez al día por producto) | `variant_id`, `stock`, `min` |
| `tarjeta_regalo`, `tarjeta_regalo_comprador` | Tarjeta de regalo activa (a quien la recibe y a quien la compró) | `amount`, `code`, `expires_at`, `message`, `to`, `from` / `name`, `recipient` |
| `prueba` | El botón «Enviar aviso de prueba» | — |

En n8n: un nodo **Webhook** recibe esto, se verifica la firma sobre el cuerpo tal como llegó, un **Switch** por `event` decide la plantilla y el nodo de
**WhatsApp Business Cloud** (o el de correo) lo entrega. Dos cosas que vienen de las reglas de WhatsApp Business, no de este código: fuera de la ventana de
24 horas de la conversación solo se pueden enviar **plantillas aprobadas por Meta** (por eso `event` + `data` están pensados para llenar sus variables), y los
precios por mensaje cambian: confírmalos en la documentación de Meta antes de proyectar costos. Las alertas al encargado se activan poniendo su WhatsApp o correo
en **Avisos** (se guardan en los ajustes).

## Pagos en línea

Hoy el pago con tarjeta de la demostración es **simulado** (se da por pagado al confirmar). Una pasarela real funciona distinto, y esa mecánica ya está:
el pedido queda **«esperando pago»** con el stock reservado, el cliente va a la página de la pasarela, y al volver (o cuando la pasarela avisa) el pedido pasa a
*pagado* —con su factura y sus avisos— o se cancela y el stock vuelve. Si nadie paga en `PAYMENT_HOLD_MINUTES` (30) el pedido vence solo. Avisar dos veces lo
mismo no repite nada, y un aviso tardío de «fallido» no deshace un pago.

| `PAYMENTS_PROVIDER` | Qué hace |
|---|---|
| `instant` (por defecto) | Como siempre: la tarjeta se da por pagada. Simulado. |
| `demo-hosted` | Una página de pago de ejemplo dentro de esta misma app (`/pago-demo.html`, **sin pedir datos de tarjeta**) para ver el recorrido completo. Simulado. |
| `http` | Un servicio propio (por ejemplo un flujo de n8n) crea el cobro en la pasarela real. |

Contrato de `http`: la app hace `POST` a `PAYMENTS_CREATE_URL` con `{ "reference", "amount", "currency", "description", "customer": {name,email,phone}, "return_url", "cancel_url" }`
y espera `{ "url": "https://…" }` (la página de pago, siempre `https`). Cuando el cliente paga, ese servicio avisa con `POST /api/payments/webhook`,
cuerpo `{ "reference", "status": "pagado" | "fallido" }` y la cabecera `X-Signature: sha256=<HMAC del cuerpo con PAYMENTS_WEBHOOK_SECRET>`. **Lo que falta para cobrar de verdad
es el paso «crear el cobro» de la pasarela elegida** (necesita su cuenta y credenciales; no se inventó ninguna integración).

## Facturación electrónica

Cada venta pagada genera una factura y cada devolución o cancelación, una nota de crédito. **Importante:** en Panamá la factura electrónica se emite a través de un
Proveedor Autorizado Calificado (PAC) autorizado por la DGI. Esta demostración **no emite documentos fiscales válidos**; confirma los requisitos vigentes con la DGI y el PAC elegido.

| `FISCAL_PROVIDER` | Qué hace |
|---|---|
| `demo` (por defecto) | Numera los documentos `FE-DEMO-000001` / `NC-DEMO-000001` y los marca «SIN VALIDEZ FISCAL» (en el recibo y en el panel). |
| `webhook` | Envía cada documento, firmado (`X-Signature`, `FISCAL_WEBHOOK_SECRET`), a `FISCAL_WEBHOOK_URL`, que lo traduce al formato del PAC y responde `{ "number", "auth_code", "url"? }`. Los que fallan quedan en *error* para reintentar; **nunca se bloquea una venta por la facturación**. |
| `off` | No se emite nada. |

El documento que recibe el servicio trae `kind` (`factura` | `nota_credito`), `order_id`, `reference_number` (la factura original, en una nota de crédito), cliente, `lines`
(`sku`, `description`, `qty`, `unit_price`), `tax` (`name`, `rate`, `amount`, `included`), `total`, `currency` y `payment_method`. Los datos fiscales propios del PAC (RUC, formato XML, firma) los resuelve
ese servicio. Solo las ventas de ejemplo de la demostración generan facturas de ejemplo; con `webhook` no se envía nada de eso.

## Códigos de barras, fotos y descripciones

- **Código de barras** por tamaño (campo opcional; los productos de ejemplo traen EAN-13 válidos con prefijo 745). El lector del mostrador reconoce el código **o** el SKU;
  la carga de entradas en CSV también acepta cualquiera de los dos. **Etiquetas** (50×30 mm) desde la edición de una variante: EAN-13 si lo tiene, si no Code 128 con el SKU. Las tablas
  de ambos códigos se verifican por sus propiedades matemáticas (`test/barcode.test.js`); no se pudo probar con un lector físico.
- **Fotos** y **descripciones** desde el panel (Productos → Editar): la foto se reduce en el navegador (máx. 1000 px, JPEG) y se guarda **en la propia base de datos**
  (`/api/media/N`, caché largo); solo se aceptan JPG, PNG y WebP reconocidos por su contenido (nunca SVG) y hay tope de tamaño. En la demostración de Netlify cada foto agranda la base compartida:
  en una instalación real se usaría almacenamiento de archivos.

## Variables de entorno de lo nuevo

| Variable | Para qué |
|---|---|
| `DEMO_USERS=0` | (Netlify) No crear los usuarios de ejemplo gerente, cajero y bodega. |
| `PUBLIC_URL` | Dirección pública del sitio, para los enlaces de los avisos (en Netlify se toma de `URL`). |
| `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET` | Dónde y con qué firma salen los avisos (ver arriba). |
| `FISCAL_PROVIDER`, `FISCAL_WEBHOOK_URL`, `FISCAL_WEBHOOK_SECRET` | Facturación electrónica. |
| `PAYMENTS_PROVIDER`, `PAYMENTS_CREATE_URL`, `PAYMENTS_WEBHOOK_SECRET`, `PAYMENT_HOLD_MINUTES` | Pagos con pasarela. |
| `LOGIN_MAX_FAILS`, `LOGIN_IP_MAX_FAILS` | Intentos fallidos de entrar al panel (por usuario y conexión: 8; por conexión: 40) cada 15 minutos. |
| `ORDER_RATE_PER_10MIN`, `PENDING_ORDERS_MAX`, `ACCOUNT_REGISTER_PER_HOUR` | Topes por conexión (60, 8 y 10). |

Ninguna clave ni secreto se guarda en la base de datos ni en el repositorio: van en variables de entorno (en Netlify, **Site configuration → Environment variables**).

## Conectar con la tienda WooCommerce existente

Hay cuatro piezas independientes; úsalas en el orden que convenga.

### 1. Importar el CSV (sin dar acceso a nada)

En WooCommerce: **Productos → Exportar**. En el panel: pestaña **WooCommerce → Importar desde el CSV**. Se entiende el exporte en español o
inglés (también `;` o tabulador, y archivos guardados desde Excel). Antes de guardar nada se **analiza** y se muestra un informe:

- **Se agrupan los tamaños**: «Noche de Jazmín 50ml» y «…100ml» pasan a ser un producto con dos tamaños; las variaciones usan su atributo de tamaño; las onzas se convierten a ml.
- **Se clasifica** en Damas/Caballeros/Infantil/Unisex y Perfume/Estuche/Tester por las categorías, etiquetas y el nombre. Lo dudoso va a **«Sin clasificar»** (cola de revisión en Productos), no se adivina.
- **Informe de calidad**: completitud de marca, categoría, foto, precio, inventario y descripción, y la lista de lo que hay que arreglar (sin precio, SKU repetido, sin marca, stock negativo o sin control de inventario, ofertas inválidas, borradores, posibles duplicados…) con filas de ejemplo y descarga en CSV.
- **Seguro**: sin precio el producto queda oculto para la venta (nunca a $0); sin inventario en WooCommerce **no se inventa stock** (queda en 0 y se avisa); un ID repetido no rompe nada.
- **Reimportar no duplica**: se actualiza por ID o SKU. Un stock distinto queda como un movimiento de ajuste con motivo (se puede desactivar). No se generan órdenes de compra masivas.

Hay un archivo de ejemplo con problemas a propósito: `public/samples/woocommerce-export-demo.csv` (también se baja desde el panel).

### 2. Leer el catálogo por la API

En WooCommerce: **Ajustes → Avanzado → API REST → Añadir clave** (lectura y escritura). Las claves se pasan **solo como variables de entorno**:

```powershell
$env:WOO_URL = "https://tu-tienda.com"
$env:WOO_KEY = "ck_…"
$env:WOO_SECRET = "cs_…"
npm start
```

En el panel: **Probar conexión**, **Revisar sin guardar** y **Traer catálogo** (corre en segundo plano con barra de avance; usa las mismas reglas e informe que el CSV).

### 3. Avisos de WooCommerce y envío de stock

```powershell
$env:WOO_WEBHOOK_SECRET = "una-frase-larga"   # el mismo que pones en el webhook de WooCommerce
$env:WOO_PUSH_STOCK = "1"                      # opcional: este sistema manda en el stock y se lo envía a WooCommerce
```

En **WooCommerce → Ajustes → Avanzado → Webhooks** crea tres: *Pedido creado*, *Pedido actualizado*, *Producto actualizado*, con la URL
`https://TU-SERVIDOR/api/woo/webhook` y el mismo secreto.

- Cada aviso se acepta **solo con firma válida** (HMAC-SHA256, comparación en tiempo constante) y **no se procesa dos veces** (por id de entrega y por número de pedido).
- Pedido en *procesando / completado / en espera* → se descuenta el stock; *cancelado / reembolsado / fallido* → vuelve. Si WooCommerce vendió más de lo que hay aquí, **nunca queda stock negativo**: se descuenta lo que había y queda constancia del faltante.
- Con `WOO_PUSH_STOCK=1`, cada cambio de stock de una variante enlazada entra en una **bandeja de salida** (una fila por variante: se envía el último valor) y se manda cada 20 s con reintentos; el panel muestra lo pendiente y los errores. Con el envío activo manda este sistema: traer el catálogo o un aviso de producto **no pisan** el stock.
- Elige un solo «dueño» del stock. Si WooCommerce y este sistema lo modifican a la vez sin avisarse, habría diferencias.

### 4. El asistente dentro de la web actual (una línea)

```html
<script src="https://TU-SERVIDOR/embed.js" async></script>
```

Opciones: `data-label`, `data-theme="limon|shop"`, `data-position="left|right"`. El chat vive en un iframe de este servidor (no toca el CSS ni
el JavaScript de la web, y la web no ve lo que escribe el cliente). Por seguridad **ninguna página se puede incrustar en otro sitio** salvo que
autorices el origen:

```powershell
$env:EMBED_ORIGINS = "https://tu-tienda.com,https://www.tu-tienda.com"   # "*" solo para pruebas
```

Dentro de la web ajena, «agregar a la bolsa» se convierte en un enlace de compra: **producto simple** → `?add-to-cart=ID` de WooCommerce;
**variable** → su página para elegir tamaño (WooCommerce no agrega una variación sin sus atributos). Las tarjetas abren la página del producto.

## Asistente de compras («Aura»)

Un botón **Pregúntale a Aura** abre un chat en la tienda. Tiene **dos modos** y elige solo:

| | Modo local (por defecto) | Modo IA (opcional) |
|---|---|---|
| Necesita | Nada | Una clave de API de Claude |
| Costo | Cero | Centavos por mensaje |
| Cómo entiende | Palabras clave en español: ocasión, notas, categoría, presupuesto, nombres de perfumes | Lenguaje natural libre |
| Se presenta como | «Asistente básico» (no dice que es IA) | «Asesora virtual con IA» |

Los dos hacen lo mismo con el **catálogo real** (precios, tamaños y existencias salen de la base de datos): recomiendan según lo que cuenta el
cliente, muestran tarjetas con foto, dan la ficha de un perfume, responden envíos/pagos/horario, **agregan a la bolsa** (con seguimiento:
«agrégalo» → «el de 100 ml») y rechazan lo agotado. No cobran, no crean pedidos ni consultan pedidos, y no recuerdan al cliente entre visitas.

**Pasar con una persona.** Si defines el número, el chat ofrece un botón de WhatsApp cuando el cliente pide hablar con alguien:

```powershell
$env:STORE_WHATSAPP = "50760000000"; npm start   # código de país + número, solo dígitos
```

**Activar el modo IA** (opcional). Crea una clave en https://console.anthropic.com y ponla solo en tu terminal; no la escribas en archivos
del proyecto ni la compartas en chats:

```powershell
$env:ANTHROPIC_API_KEY = "tu-clave"; npm start
```

| Variable | Para qué | Por defecto |
|---|---|---|
| `STORE_WHATSAPP` | Número para pasar con una persona (solo dígitos, con código de país) | — |
| `ANTHROPIC_API_KEY` | Clave de Claude: activa el modo IA | — |
| `CHATBOT` | `off` apaga el chat; `local` fuerza el modo local aunque haya clave; `on` fuerza IA con credenciales del SDK | automático |
| `CHATBOT_MODEL` | Modelo de IA (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`) | `claude-haiku-5-5` |
| `CHATBOT_EFFORT` | Cuánto razona la IA: `low`, `medium`, `high`… (más = más lento y caro) | `medium` |
| `CHATBOT_FALLBACK` | `off` desactiva la reserva ante rechazos del modelo (solo Opus y Sonnet) | activa |
| `CHAT_RATE_PER_10MIN` | Mensajes por visitante cada 10 minutos | 60 local · 15 IA |
| `CHAT_DAILY_LIMIT` | Mensajes totales por día | 5000 local · 200 IA |
| `REVIEW_RATE_PER_HOUR` | Reseñas que puede publicar un visitante por hora | 5 |
| `WOO_URL` · `WOO_KEY` · `WOO_SECRET` | Conexión con la API de WooCommerce | — |
| `WOO_WEBHOOK_SECRET` | Secreto para firmar los avisos entrantes | — |
| `WOO_PUSH_STOCK` | `1`: este sistema manda en el stock y lo envía a WooCommerce | desactivado |
| `EMBED_ORIGINS` | Sitios autorizados a mostrar el chat (separados por coma, o `*`) | ninguno |

**Costo del modo IA.** Cada mensaje se cobra a tu cuenta de Anthropic. Estimación gruesa (no medida) por mensaje: con `claude-haiku-5-5`
**alrededor de 0,1 a 0,3 centavos de dólar**; con `claude-sonnet-5-5`, unas 20 veces más; con `claude-opus-5-5`, unas 40 veces más. Los topes
limitan el gasto máximo diario. El costo real lo ves en la terminal: cada respuesta de IA imprime una línea `[chat]` con los tokens usados.
**El modo IA no se probó contra la API real** (no había clave): su lógica se probó con un cliente simulado.

**Seguridad.** La clave vive solo en el servidor. El modelo de IA no toca la base de datos: pide búsquedas y el servidor valida cada petición
(ids, cantidades, stock). Nunca se entregan costos ni márgenes. El texto del chat se muestra escapado (no ejecuta HTML).

## Dos diseños

Abajo a la izquierda (tienda) o a la derecha (panel) hay un selector **Diseño: Limón / Shop**. Se recuerda entre visitas.

- **Limón**: oscuro tipo brasserie, acento limón, esquinas casi rectas, tipografía ancha en mayúsculas, todo plano.
- **Shop**: claro, tarjetas de 28px, controles en píldora, sombras suaves y un único violeta.

Para que **Shop** sea el diseño por defecto, cambia `'limon'` por `'shop'` en tres sitios: el `<script>` del `<head>` de
`public/index.html` (dos veces en esa línea), el de `public/admin.html`, y `currentTheme` en `public/js/theme.js`.
Quien ya eligió un diseño en su navegador conserva su elección.

## Estructura

```
server.js · app.js     servidor HTTP, sesiones y rutas de la API (sin frameworks)
routes-shop.js         rutas públicas: precio de la bolsa, tarjetas de regalo, «avísame», seguimiento, buscador, cuentas, fotos y pagos
routes-ops.js          rutas del panel: caja, devoluciones, reportes, promociones, tarjetas, sets, avisos, facturas y ajustes
db.js                  esquema SQLite (v4, con migración desde versiones anteriores), triggers (la automatización) y bandejas de salida
auth.js                usuarios, roles y permisos, claves (scrypt), sesiones firmadas y bitácora
accounts.js            cuentas de clientes y favoritos
catalog.js             catálogo a escala: filtros, búsqueda con relevancia, conteos, paginación y recomendados (todo en SQL)
service.js             reglas de negocio (inventario, pedidos con descuentos y tarjetas, compras, productos)
pricing.js · giftcards.js · bundles.js   ofertas y cupones, tarjetas de regalo, sets de regalo
shifts.js · returns.js · reports.js · tracking.js   caja, devoluciones, reportes y seguimiento del pedido
notify.js · payments.js · invoicing.js   avisos (WhatsApp/correo), pagos con pasarela y facturación electrónica (con proveedores de demostración)
finder.js · media.js   buscador guiado y fotos de producto
reviews.js · brand.js · brand.json   reseñas e identidad configurable de la tienda
woo-import.js · woo-sync.js          CSV/REST de WooCommerce, bandeja de stock y webhook firmado
seed.js · photos.js    productos de ejemplo (con ofertas, sets y tarjeta de ejemplo), el generador de 8.500 y el reparto de fotos
netlify/ · scripts/    función de Netlify (API + estado compartido) y armado del sitio estático
public/                tienda (index.html, js/store.js, store-ext.js, product-page.js, account.js), panel (admin.html, js/admin*.js), chat embebible, css/ y js/
public/js/barcode.js   EAN-13 y Code 128 para las etiquetas
chatbot.js · chatbot-local.js · chat-env.js  el asistente (modo IA y modo local)
test/                  pruebas (ver «npm test»); test/fixtures/v3.db es una base real de la versión anterior para probar la migración
data/aurelia.db        base de datos (se crea sola; las bases anteriores se migran sin perder datos)
```

## Datos de ejemplo y fotos

Las marcas, fragancias y precios son **ficticios** (no se copió ningún producto, foto ni logo de otra tienda). Hay **24 fotos** reales y
de uso libre (Pexels / Unsplash); autores y licencias en `public/img/CREDITS.md`. Ningún producto de ejemplo se queda sin foto: se reparten
por color y tipo (`photos.js`), así que con miles de productos las fotos se repiten. `npm run photos` completa las que falten en la base
de datos y **nunca** toca productos importados de WooCommerce (la foto de otro frasco no es la de ese producto). Esas licencias cubren la foto, **no** el diseño de los
frascos que aparecen: antes de lanzar una tienda real, sustituye las fotos por las de tus propios productos.

## Demo en Netlify (para mostrarla en una página)

Netlify no ejecuta un servidor Node con una base SQLite como el de `npm start`, así que la demo se despliega de otra forma, con el mismo código:

- **La tienda y el panel** (HTML, CSS, JS, fotos) salen como archivos estáticos desde la red de Netlify (`dist/`, lo arma `scripts/build-netlify.mjs`).
- **La API** (`/api/*`) es una función serverless (`netlify/functions/api.mjs`) que ejecuta la misma app.
- **Los datos** (productos, stock, pedidos) viven en una base SQLite de ejemplo en cada instancia de la función. Para que la demo sea coherente (la compra que haces
  en la tienda aparece en el panel aunque la atienda otra instancia), cada instancia la sincroniza con una copia compartida en **Netlify Blobs** (`netlify/lib/demo-state.mjs`).
  Las sesiones del panel son tokens firmados, no dependen de la memoria de una instancia.

**Qué esperar:** es una demostración, no un sistema en producción.
- Si dos personas compran en el mismo instante, gana la última copia guardada.
- El botón **Reiniciar demo** vuelve a los productos de ejemplo (con sus ofertas, sets y tarjeta de ejemplo) y conserva los usuarios y las cuentas de clientes; **Catálogo masivo** carga los 8.500 (tarda unos segundos).
- Una demostración publicada con una versión anterior recibe lo nuevo (ofertas, sets, tarjeta de ejemplo, códigos de barras y usuarios) la primera vez que abre con esta versión, sin perder lo que ya tenía.
- Las fotos que se suban desde el panel viven en la base compartida: cada una la agranda (tope total de 40 MB).
- Límites de Netlify: cada petición tiene 60 s, y subir un CSV de WooCommerce no puede pasar de ~6 MB (con el CSV de ejemplo sobra).
- Para datos permanentes y reales hace falta una base en la nube (Postgres, Turso…) y un servidor de verdad; ver «Qué falta para una tienda real».

**Pasos** (una sola vez; necesitas una cuenta gratuita de Netlify):

```powershell
npx netlify-cli login                         # abre el navegador para autorizar (no se pega ninguna clave en ningún sitio)
npx netlify-cli sites:create --name mi-demo   # crea el sitio (el nombre da la dirección mi-demo.netlify.app)
npx netlify-cli env:set ADMIN_PASSWORD "una-clave-para-el-panel"
npx netlify-cli env:set FRAME_ORIGINS "https://tu-sitio.com"   # quién puede mostrar la tienda dentro de su página (iframe)
npm run deploy                                # arma (con las variables de Netlify), empaqueta la función y publica
```

| Variable de Netlify | Para qué |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel (`/admin`). Sin ella se usa `admin123`, que se muestra en pantalla: solo para pruebas. |
| `FRAME_ORIGINS` | Sitios que pueden mostrar la tienda en un iframe (varios, separados por coma). Admite `https://*.sitio.com` para todos los subdominios de un dominio propio. Ojo: las vistas previas de Netlify (`deploy-preview-N--tu-sitio.netlify.app`) no son subdominios de `tu-sitio.netlify.app` y ningún comodín razonable las cubre; para probar una, agrega su dirección exacta y quítala después. Por defecto, ninguno. El panel nunca se puede incrustar. |
| `EMBED_ORIGINS` | Sitios que pueden mostrar el chat (`/embed.js`) en otro sitio. |
| `DEMO_SHOW_ADMIN_PASSWORD=1` | Muestra la contraseña del panel y los usuarios de ejemplo en su pantalla de acceso, para que quien pruebe la demo pueda entrar. Solo para demostraciones públicas. |
| `DEMO_USERS=0` | No crear los usuarios de ejemplo (gerente, cajero, bodega). |
| `ANTHROPIC_API_KEY`, `STORE_WHATSAPP`, `BRAND_NAME`… | Igual que en local (ver más arriba). |

**Dentro de otra página** (la demo de la tienda a pantalla completa):

```html
<iframe src="https://mi-demo.netlify.app/" title="Demostración de la tienda" loading="lazy"
        style="width:100%;height:85vh;border:0;border-radius:12px"></iframe>
<p><a href="https://mi-demo.netlify.app/" target="_blank" rel="noopener">Abrir la demo en pantalla completa</a></p>
```

Para elegir el diseño de la tienda dentro del iframe, agrega `?tema=shop` o `?tema=limon` a la dirección. Dentro de un iframe el enlace «Panel» se abre en una pestaña nueva (el panel no se puede incrustar).

Si esa página define una política de seguridad (CSP), debe permitir `frame-src https://mi-demo.netlify.app`. El chat solo, como botón flotante: `<script src="https://mi-demo.netlify.app/embed.js" async></script>`.

Nota: `npm run deploy` arma el sitio *antes* de publicar a propósito; la CLI de Netlify lee las cabeceras (`_headers`) antes de compilar y, con `deploy --build`, publicaría las de la compilación anterior.

Probar el despliegue sin publicar (emulador de Netlify en tu equipo): `npx netlify-cli dev` (arma antes con `npm run build:netlify`).

## Qué falta para una tienda real

Lo que **ya funciona de verdad** y está probado: usuarios y roles, bitácora, caja, devoluciones, reportes, ofertas y cupones, sets y tarjetas de regalo, seguimiento,
buscador guiado, cuentas y favoritos, códigos de barras y etiquetas, fotos y descripciones, la mecánica de pagos con pasarela y la de avisos y facturas hacia servicios externos.
Lo que **falta o no se pudo probar**:

- **Cobrar de verdad**: falta el paso «crear el cobro» de la pasarela elegida (Yappy, Banco General, tarjeta…); hace falta su cuenta y credenciales. Hoy el pago con tarjeta es simulado.
- **Factura electrónica válida**: falta un PAC autorizado por la DGI y la traducción del documento a su formato. Los documentos `FE-DEMO` no tienen validez fiscal.
- **WhatsApp y correo reales**: falta conectar el flujo de n8n (o similar) a WhatsApp Business (número verificado, plantillas aprobadas por Meta) y a un servidor de correo. Los avisos
  salen firmados del sistema, pero esa conexión no se ha probado contra WhatsApp real. Un chatbot que converse por WhatsApp con un modelo de lenguaje es un proyecto aparte
  (hace falta, entre otras cosas, un endpoint servidor-a-servidor del asistente con límites por número y entrega a una persona).
- **Verificar el correo o el WhatsApp** al crear una cuenta de cliente (hoy no se verifica).
- **Lectores y cámaras**: los códigos de barras se probaron por sus propiedades matemáticas y con la entrada de teclado del lector; no con un lector físico ni con la cámara de un celular.
- Envíos con transportista y correos reales al proveedor.
- **Un servidor de verdad**: base de datos en la nube (por ejemplo Postgres), copias de seguridad y HTTPS. SQLite con un solo servidor sirve para una tienda pequeña; la demostración de Netlify guarda su base completa en cada cambio.
- Almacenamiento de archivos para las fotos (hoy van dentro de la base) y varias sucursales con stock por sucursal.
- La integración con WooCommerce se probó contra un servidor simulado y con un CSV de ejemplo; antes de conectarla a la tienda real conviene
  ensayarla en una copia (staging) y confirmar con ellos cómo clasifican categorías, marcas y tamaños.
