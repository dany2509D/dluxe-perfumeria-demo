/*
 * Chat de compras para pegar en otro sitio (WordPress/WooCommerce u otro). Una sola línea, antes de </body>:
 *
 *   <script src="https://TU-SERVIDOR/embed.js" async></script>
 *
 * Opciones (atributos data- en la misma etiqueta):
 *   data-label="Pregúntale a Aura"   texto del botón
 *   data-theme="limon" | "shop"      diseño del chat
 *   data-position="right" | "left"   esquina del botón
 *
 * El chat vive en un iframe de este servidor: no toca el CSS ni el JavaScript de tu sitio, y tu sitio no ve
 * lo que escribe el cliente. Para que el navegador lo permita, el servidor debe tener
 * EMBED_ORIGINS=https://tu-sitio.com (separados por coma, o * solo para pruebas).
 */
(function () {
  if (window.__dluxeChat) return;
  var tag = document.currentScript;
  if (!tag || !tag.src) return;
  window.__dluxeChat = true;

  var base = new URL(tag.src).origin;
  var label = tag.getAttribute('data-label') || 'Pregúntale a Aura';
  var theme = tag.getAttribute('data-theme') === 'shop' ? 'shop' : 'limon';
  var side = tag.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var z = '2147483000';

  var button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', 'Abrir el asistente de compras');
  button.setAttribute('aria-expanded', 'false');
  button.textContent = label;
  var dark = theme !== 'shop';
  button.style.cssText =
    'position:fixed;bottom:20px;' + side + ':20px;z-index:' + z + ';min-height:48px;padding:0 20px;cursor:pointer;' +
    'font:600 15px/1 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.02em;' +
    (dark
      ? 'background:#1d0b0d;color:#f7ea48;border:1px solid #f7ea48;border-radius:2px;text-transform:uppercase;'
      : 'background:#fff;color:#000;border:0;border-radius:9999px;box-shadow:0 8px 28px rgba(0,0,0,.18);');

  var frame = document.createElement('iframe');
  frame.title = 'Asistente de compras';
  frame.hidden = true;
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;z-index:' + z + ';border:0;background:transparent;';

  function layout() {
    var small = window.innerWidth < 600;
    frame.style.width = small ? '100vw' : '400px';
    frame.style.height = small ? '100dvh' : 'min(640px, calc(100vh - 40px))';
    if (small) { frame.style.bottom = '0'; frame.style[side] = '0'; } else { frame.style.bottom = '20px'; frame.style[side] = '20px'; }
    frame.style.borderRadius = small ? '0' : dark ? '2px' : '28px';
    frame.style.boxShadow = small ? 'none' : '0 18px 60px rgba(0,0,0,.35)';
  }

  function setOpen(open) {
    if (open && !frame.src) frame.src = base + '/embed?theme=' + theme; // se carga la primera vez que se abre
    frame.hidden = !open;
    button.hidden = open;
    button.setAttribute('aria-expanded', String(open));
    if (open) layout();
    else button.focus();
  }

  button.addEventListener('click', function () { setOpen(true); });
  window.addEventListener('resize', function () { if (!frame.hidden) layout(); });
  window.addEventListener('message', function (e) {
    if (e.origin !== base || !e.data || e.data.type !== 'dluxe-chat') return;
    if (e.data.action === 'close') setOpen(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !frame.hidden) setOpen(false); });

  function mount() { document.body.appendChild(button); document.body.appendChild(frame); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
