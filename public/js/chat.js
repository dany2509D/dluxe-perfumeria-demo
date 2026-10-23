// Widget del asistente de compras ("Aura"). Habla con POST /api/chat (flujo SSE) y se integra con la
// tienda solo mediante eventos: aurelia:add-to-cart y aurelia:open-cart (los escucha store.js).
import { esc, icon, productArt, tileColor, money } from './ui.js';

const KEY = 'aurelia-chat-v1';
const EMBED = document.documentElement.hasAttribute('data-embed'); // dentro de un iframe en otro sitio
const $ = (sel, root = document) => root.querySelector(sel);

const SUGGESTIONS = [
  'Quiero un perfume para regalar',
  'Algo fresco para el día a día',
  '¿Qué tienen con vainilla?',
  'Un perfume para caballero de menos de $80',
  '¿Qué ofertas tienen?',
];
// Textos según el modo: "ia" (Claude) o "local" (reglas, sin IA).
const MODES = {
  ia: {
    sub: 'Asesora virtual con IA',
    foot: 'Asistente con IA: puede equivocarse. Confirma precios y existencias en la ficha del producto.',
    welcome: 'Hola, soy <strong>Aura</strong>, tu asesora de perfumes. Cuéntame qué buscas: para quién es, la ocasión o las notas que te gustan.',
  },
  local: {
    sub: 'Asistente de compras',
    foot: 'Asistente básico: entiende palabras clave y consulta el catálogo real. Confirma precios y existencias en la ficha del producto.',
    welcome: 'Hola, soy <strong>Aura</strong>, tu asistente de compras. Puedo recomendarte perfumes, mostrarte precios y existencias, y agregar a tu bolsa lo que elijas. Prueba con una de las sugerencias o cuéntame qué buscas.',
  },
};
const TOOL_LABELS = {
  search_products: 'Buscando en el catálogo…',
  show_products: 'Preparando las tarjetas…',
  add_to_bag: 'Agregando a tu bolsa…',
};
const OFF_MESSAGES = {
  sin_clave: 'El asistente de IA todavía no está activo. Para activarlo, quien administra la tienda debe configurar la clave de Claude (variable ANTHROPIC_API_KEY) y reiniciar el servidor. Mientras tanto, puedes explorar la colección con los filtros.',
  sin_sdk: 'Falta instalar las dependencias del asistente. Quien administra la tienda debe ejecutar «npm install» y reiniciar el servidor.',
  apagado: 'El asistente está desactivado en este momento.',
  sin_servidor: 'No pude conectar con el asistente. Si acabas de actualizar la tienda, reinicia el servidor (Ctrl+C y luego «npm start»).',
};

const state = {
  open: false,
  busy: false,
  status: null, // { enabled, reason }
  messages: [], // { role, content, cards?, notes?, error?, ui? }
  ac: null,
  tool: '',
};

// ─── Persistencia (solo en esta pestaña) ──────────────────────────────────
function load() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) || '[]');
    if (Array.isArray(raw)) state.messages = raw.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  } catch { /* sin almacenamiento */ }
}
function save() {
  try { sessionStorage.setItem(KEY, JSON.stringify(state.messages.slice(-30))); } catch { /* ignorar */ }
}

// ─── Texto: Markdown mínimo y seguro (siempre se escapa primero) ───────────
const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
function md(text) {
  let html = '';
  let list = false;
  for (const raw of esc(text).split('\n')) {
    const li = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (li) {
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (list) { html += '</ul>'; list = false; }
    if (raw.trim()) html += `<p>${inline(raw)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

// ─── Piezas de la interfaz ────────────────────────────────────────────────
function cardHTML(p) {
  const out = p.total_stock === 0;
  const cheapest = p.variants?.find((v) => v.price === p.min_price);
  const was = cheapest?.compare_at ? ` <s class="was">${money(cheapest.compare_at)}</s>` : '';
  const pct = cheapest?.compare_at ? Math.round((1 - cheapest.price / cheapest.compare_at) * 100) : 0;
  const tag = p.on_sale ? (pct ? `-${pct}%` : 'Oferta') : p.kind && p.kind !== 'Perfume' ? p.kind : '';
  return `<article class="chat-card ${out ? 'is-out' : ''}">
    <button type="button" class="chat-card-img" data-open="${p.id}" style="--tile:${tileColor(p.id)}" aria-label="Ver ${esc(p.name)}">${productArt(p, { title: p.name })}</button>
    <div class="chat-card-body">
      <p class="cc-name">${esc(p.name)}${tag ? ` <span class="cc-tag">${esc(tag)}</span>` : ''}</p>
      <p class="cc-meta">${esc(p.brand || p.family)} · ${out ? 'agotado' : `desde ${money(p.min_price)}${was}`}</p>
      <button type="button" class="cc-btn" data-open="${p.id}">Ver detalle</button>
    </div>
  </article>`;
}

function msgHTML(m, i) {
  if (m.role === 'user') return `<div class="msg msg-user" data-i="${i}"><div class="bubble">${md(m.content)}</div></div>`;
  const typing = !m.content && !m.cards?.length && !m.notes?.length && !m.error;
  const tool = state.busy && i === state.messages.length - 1 && state.tool ? `<p class="chat-status">${esc(state.tool)}</p>` : '';
  return `<div class="msg msg-bot" data-i="${i}">
    ${m.content || typing ? `<div class="bubble">${m.content ? md(m.content) : '<span class="dots" aria-label="Escribiendo"><i></i><i></i><i></i></span>'}</div>` : ''}
    ${m.cards?.length ? `<div class="chat-cards">${m.cards.map(cardHTML).join('')}</div>` : ''}
    ${(m.notes || []).map((n) => `<p class="chat-note">${icon('checkCircle', 16)}<span>Agregado: ${esc(n)}</span><button type="button" data-chat-cart>Ver bolsa</button></p>`).join('')}
    ${(m.links || []).map((l) => `<a class="chat-link" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join('')}
    ${m.error ? `<p class="chat-error" role="alert">${esc(m.error)}</p>` : ''}
    ${tool}
  </div>`;
}

function render({ keepScroll = false } = {}) {
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const mode = MODES[state.status?.mode] || MODES.ia;
  $('#chat-sub').textContent = mode.sub;
  $('#chat-foot').textContent = mode.foot;
  const welcome = state.status?.enabled
    ? `<div class="msg msg-bot"><div class="bubble"><p>${mode.welcome}</p></div></div>`
    : `<div class="msg msg-bot"><div class="bubble"><p>${esc(OFF_MESSAGES[state.status?.reason] || 'Conectando con el asistente…')}</p></div></div>`;
  log.innerHTML = welcome + state.messages.map(msgHTML).join('');
  $('#chat-suggest').hidden = !(state.status?.enabled && state.messages.length === 0);
  const off = !state.status?.enabled;
  $('#chat-input').disabled = off || state.busy;
  $('#chat-send').disabled = off;
  $('#chat-send').innerHTML = state.busy ? icon('x', 18) : icon('send', 18);
  $('#chat-send').setAttribute('aria-label', state.busy ? 'Detener' : 'Enviar');
  $('#chat-form').dataset.busy = String(state.busy);
  if (nearBottom || !keepScroll) log.scrollTop = log.scrollHeight;
}

// Actualiza solo el mensaje que se está escribiendo (evita parpadeos y mantiene el scroll).
function renderLast() {
  const i = state.messages.length - 1;
  const node = $(`#chat-log [data-i="${i}"]`);
  if (!node) return render();
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  node.outerHTML = msgHTML(state.messages[i], i);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// ─── Envío y lectura del flujo ────────────────────────────────────────────
async function send(text) {
  text = text.trim();
  if (!text || state.busy || !state.status?.enabled) return;
  state.messages.push({ role: 'user', content: text });
  const bot = { role: 'assistant', content: '', cards: [], notes: [] };
  state.messages.push(bot);
  state.busy = true;
  state.tool = '';
  render();

  // Al modelo solo viaja texto: nunca tarjetas ni avisos de la interfaz.
  const history = state.messages.slice(0, -1).filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content }));
  // Qué tarjetas vio el cliente por última vez (permite entender "agrégalo" o "el segundo").
  const lastCards = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.cards?.length)?.cards || [];
  state.ac = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, embed: EMBED || undefined, context: { last_product_ids: lastCards.map((c) => c.id).slice(0, 4) } }),
      signal: state.ac.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No pude contactar con el asistente.');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) handle(bot, JSON.parse(chunk.slice(6)));
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') bot.error = e.message || 'No pude responder. Inténtalo de nuevo.';
  } finally {
    state.busy = false;
    state.tool = '';
    state.ac = null;
    if (!bot.content && !bot.cards.length && !bot.notes.length && !bot.error) bot.error = 'Detuve la respuesta.';
    save();
    render({ keepScroll: true });
    announce(bot.content || bot.error || '');
    if (state.open) $('#chat-input').focus();
  }
}

function handle(bot, ev) {
  if (ev.type === 'text') bot.content += ev.text;
  else if (ev.type === 'tool') state.tool = TOOL_LABELS[ev.name] || 'Un momento…';
  else if (ev.type === 'cards') {
    bot.cards.push(...ev.products);
    window.dispatchEvent(new CustomEvent('aurelia:remember', { detail: { products: ev.products } })); // la tienda los conoce para abrirlos y agregarlos
  }
  else if (ev.type === 'link' && typeof ev.url === 'string' && /^https?:\/\//.test(ev.url)) (bot.links ??= []).push({ label: ev.label, url: ev.url });
  else if (ev.type === 'action' && ev.action === 'add_to_cart') {
    window.dispatchEvent(new CustomEvent('aurelia:add-to-cart', { detail: { variantId: ev.variant_id, qty: ev.qty } }));
    bot.notes.push(ev.label);
  } else if (ev.type === 'refusal') bot.content += (bot.content ? '\n\n' : '') + 'Con eso no puedo ayudarte, pero con gusto te ayudo a elegir una fragancia.';
  else if (ev.type === 'error') bot.error = ev.message;
  renderLast();
}

// Aviso para lectores de pantalla: una sola vez al terminar, no en cada fragmento.
function announce(text) {
  $('#chat-live').textContent = '';
  setTimeout(() => { $('#chat-live').textContent = text.slice(0, 300); }, 50);
}

// ─── Abrir, cerrar y reiniciar ────────────────────────────────────────────
async function open() {
  state.open = true;
  $('#chat-panel').hidden = false;
  $('#chat-launcher')?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('chat-open');
  if (!state.status) {
    render();
    try {
      const r = await fetch('/api/chat/status');
      state.status = r.ok ? await r.json() : { enabled: false, reason: 'sin_servidor' };
    } catch {
      state.status = { enabled: false, reason: 'sin_servidor' };
    }
  }
  render();
  if (state.status.enabled) $('#chat-input').focus();
}
function close() {
  if (EMBED) return void parent.postMessage({ type: 'dluxe-chat', action: 'close' }, '*'); // el sitio que lo muestra lo esconde
  state.open = false;
  $('#chat-panel').hidden = true;
  $('#chat-launcher').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('chat-open');
  $('#chat-launcher').focus();
}
function reset() {
  state.ac?.abort();
  state.messages = [];
  state.busy = false;
  save();
  render();
}

// ─── Montaje ──────────────────────────────────────────────────────────────
function mount() {
  const root = document.createElement('div');
  root.innerHTML = `
    <button type="button" class="chat-launcher" id="chat-launcher" aria-label="Abrir el asistente de compras" aria-expanded="false" aria-controls="chat-panel">
      ${icon('message', 22)}<span class="chat-launcher-label">Pregúntale a Aura</span>
    </button>
    <section class="chat-panel dark" id="chat-panel" role="dialog" aria-label="Asistente de compras" hidden>
      <header class="chat-head">
        <div><p class="chat-title">Aura</p><p class="chat-sub" id="chat-sub">Asistente de compras</p></div>
        <div class="chat-tools">
          <button type="button" class="icon-btn sm" id="chat-reset" aria-label="Nueva conversación" title="Nueva conversación">${icon('refresh', 18)}</button>
          <button type="button" class="icon-btn sm" id="chat-close" aria-label="Cerrar el asistente" title="Cerrar">${icon('x', 20)}</button>
        </div>
      </header>
      <div class="chat-log" id="chat-log" role="log" aria-live="off" tabindex="0" aria-label="Conversación"></div>
      <div class="chat-suggest" id="chat-suggest" hidden>${SUGGESTIONS.map((s) => `<button type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <form class="chat-form" id="chat-form" autocomplete="off">
        <label class="sr-only" for="chat-input">Escribe tu mensaje</label>
        <textarea id="chat-input" rows="1" maxlength="600" placeholder="Cuéntame qué buscas…"></textarea>
        <button type="submit" class="chat-send" id="chat-send"></button>
      </form>
      <p class="chat-foot" id="chat-foot"></p>
      <div class="sr-only" id="chat-live" role="status" aria-live="polite"></div>
    </section>`;
  document.body.append(...root.children);
  if (EMBED) {
    $('#chat-launcher').remove();
    $('#chat-panel').classList.add('chat-embed');
  }

  $('#chat-launcher')?.addEventListener('click', () => (state.open ? close() : open()));
  $('#chat-close').addEventListener('click', close);
  $('#chat-reset').addEventListener('click', reset);
  $('#chat-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  const input = $('#chat-input');
  const fit = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 112)}px`; };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); }
  });
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) return state.ac?.abort(); // el botón es «Detener» mientras responde
    const text = input.value;
    input.value = '';
    fit();
    send(text);
  });
  $('#chat-suggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-suggest]');
    if (b) send(b.dataset.suggest);
  });
  $('#chat-log').addEventListener('click', (e) => {
    if (e.target.closest('[data-chat-cart]')) window.dispatchEvent(new CustomEvent('aurelia:open-cart'));
    // Dentro de otro sitio no existe el recuadro de la tienda: se abre la página del producto en WooCommerce o, si no la tiene, la de la tienda.
    const open = EMBED && e.target.closest('[data-open]');
    if (open) {
      const card = state.messages.flatMap((m) => m.cards || []).find((c) => String(c.id) === open.dataset.open);
      const url = card?.permalink || (card?.id ? `${location.origin}/#producto/${card.id}` : `${location.origin}/?q=${encodeURIComponent(card?.name || '')}`);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  });
}

load();
mount();
render();
if (EMBED) open();
