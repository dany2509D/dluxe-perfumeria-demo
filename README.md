# D'Luxe Perfumería — demo de tienda con inventario automático

Tienda online + punto de venta + inventario, todo conectado, pensada para un catálogo de **miles de productos**. Cuando se vende
algo (por la web o en mostrador) el stock baja solo, queda registrado el movimiento y, si llega al mínimo, se genera una orden de
compra automática.

Sirve de dos maneras, con el mismo código:

- **A. Tienda nueva**: reemplaza la web actual (catálogo con filtros, búsqueda, ofertas, marcas, bolsa, pago simulado, POS, panel).
- **B. Capa de inventario para la tienda que ya existe** (WordPress/WooCommerce): importa el catálogo con un informe de calidad de
  datos, mantiene el stock al día en los dos sentidos y pone el asistente de compras dentro de la web actual con una sola línea.

Necesita **Node.js 22.13 o superior** (probado con Node 24). Una sola dependencia: el SDK oficial de Anthropic, que usa el asistente
de IA opcional. Sin ninguna clave ni cuenta externa, todo funciona igual.

## Cómo arrancar

```bash
npm install   # solo la primera vez
npm start
```

| Qué | Dónde |
|---|---|
| Tienda | http://localhost:3000 |
| Panel de administración | http://localhost:3000/admin — contraseña **`admin123`** |

En VS Code también puedes usar **Terminal → Ejecutar tarea → Iniciar demo**, o la tecla **F5** (depura el servidor).

```bash
npm test                      # 211 pruebas: backend, catálogo, migración, escala, WooCommerce, chat embebido y asistente
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

**Panel** (`/admin`)
- **Resumen**: ventas, margen, valor del inventario, alertas, gráfico de 14 días, más vendidos, canales.
- **Punto de venta**: busca en el servidor; acepta un SKU escrito o escaneado + Enter.
- **Inventario**: paginado, con búsqueda, filtros (bajo, agotado, en camino, oculto), ajustes, historial e importación CSV de entradas.
- **Productos**: lista paginada con filtros (incluida la cola «Sin clasificar»), crear, editar, ocultar.
- **Compras**: órdenes a proveedores; al recibirlas el stock sube solo.
- **Pedidos** y **Movimientos**: libro de entradas, salidas y ajustes.
- **WooCommerce**: importación del CSV con informe de calidad, conexión por API, avisos y envío de stock (ver abajo).

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

La lógica vive en **triggers de la base de datos** (`db.js`), así que da igual por dónde entre la venta.

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
server.js · app.js     servidor HTTP y rutas de la API (sin frameworks)
db.js                  esquema SQLite (v3, con migración), triggers (la automatización) y bandeja de salida
catalog.js             catálogo a escala: filtros, búsqueda con relevancia, conteos, paginación y recomendados (todo en SQL)
reviews.js             reseñas de productos: validación, antispam, resumen y moderación
service.js             reglas de negocio (inventario, pedidos, compras, productos)
brand.js · brand.json  identidad configurable de la tienda
woo-import.js          CSV/REST de WooCommerce → plan, informe de calidad e importación
woo-sync.js            cliente REST, bandeja de salida de stock, webhook firmado
seed.js · photos.js    27 productos de ejemplo, el generador de 8.500 y el reparto de fotos
netlify/ · scripts/    función de Netlify (API + estado compartido) y armado del sitio estático
netlify.toml           configuración del despliegue en Netlify
public/                tienda (index.html; la página de producto es js/product-page.js), panel (admin.html), chat embebible (embed.html, embed.js), css/ y js/
public/img/            fotos libres de derechos (ver CREDITS.md)
public/samples/        CSV de ejemplo en formato WooCommerce
chatbot.js · chatbot-local.js · chat-env.js  el asistente (modo IA y modo local)
test/                  pruebas (backend, catálogo, escala, WooCommerce con un servidor falso, chat embebido, asistente)
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
- El botón **Reiniciar demo** vuelve a los 27 productos de ejemplo; **Catálogo masivo** carga los 8.500 (tarda unos segundos).
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
| `DEMO_SHOW_ADMIN_PASSWORD=1` | Muestra la contraseña del panel en su pantalla de acceso, para que quien pruebe la demo pueda entrar. Solo para demostraciones públicas. |
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

- Pagos reales (Stripe, Yappy, Banco General, etc.): hoy el pago es simulado.
- Facturación electrónica (el ITBMS se muestra, pero no se factura).
- Envíos con transportista, correos reales al cliente y al proveedor.
- Usuarios y roles (hoy hay una sola contraseña de administrador).
- Pasar a una base de datos en la nube (por ejemplo Postgres) y publicar en internet con HTTPS.
- Subida de fotos desde el panel (hoy se ponen en `public/img/` o se traen como enlace desde WooCommerce).
- La integración con WooCommerce se probó contra un servidor simulado y con un CSV de ejemplo; antes de conectarla a la tienda real conviene
  ensayarla en una copia (staging) y confirmar con ellos cómo clasifican categorías, marcas y tamaños.
