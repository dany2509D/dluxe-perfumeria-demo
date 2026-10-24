// Fotos de producto: elegir un archivo, reducirlo en el navegador (para que suba rápido y pese poco) y subirlo al servidor.
import { api, esc, toast } from './ui.js';

const MAX_SIDE = 1000;

// Reduce la imagen a un máximo de MAX_SIDE píxeles por lado y la guarda como JPEG sobre fondo blanco.
export async function resizeImage(file, maxSide = MAX_SIDE, quality = 0.86) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Elige una imagen JPG, PNG o WebP');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('No se pudo preparar la imagen');
  return blob;
}

export async function uploadPhoto(file) {
  const blob = await resizeImage(file);
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60) + '.jpg';
  return api(`/api/admin/media?name=${encodeURIComponent(name)}`, { method: 'POST', raw: blob, contentType: 'image/jpeg' });
}

// El campo de foto de un formulario: vista previa, «Subir foto» y «Quitar». El valor viaja en <input name="image">.
export function photoField(current = '', { name = 'image' } = {}) {
  return `<div class="photo-field" data-photo>
    <div class="photo-prev">${current ? `<img src="${esc(current)}" alt="Foto actual del producto">` : '<span class="muted caption">Sin foto: se muestra el frasco ilustrado</span>'}</div>
    <div class="photo-acts">
      <input type="file" accept="image/jpeg,image/png,image/webp" class="photo-file" hidden>
      <button type="button" class="btn btn-sm btn-outline" data-photo-pick>Subir foto</button>
      <button type="button" class="btn btn-sm btn-text" data-photo-clear ${current ? '' : 'hidden'}>Quitar</button>
    </div>
    <input type="hidden" name="${name}" value="${esc(current)}">
    <small class="muted">JPG, PNG o WebP. Se reduce sola para que la tienda cargue rápido.</small>
  </div>`;
}

export function bindPhotoField(root) {
  const box = root.querySelector('[data-photo]');
  if (!box) return;
  const input = box.querySelector('input[type=hidden]');
  const file = box.querySelector('.photo-file');
  const prev = box.querySelector('.photo-prev');
  const clear = box.querySelector('[data-photo-clear]');
  const show = (url) => {
    input.value = url;
    prev.innerHTML = url ? `<img src="${esc(url)}" alt="Foto del producto">` : '<span class="muted caption">Sin foto: se muestra el frasco ilustrado</span>';
    clear.hidden = !url;
  };
  box.querySelector('[data-photo-pick]').addEventListener('click', () => file.click());
  clear.addEventListener('click', () => show(''));
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    prev.innerHTML = '<span class="muted caption">Subiendo…</span>';
    try {
      const up = await uploadPhoto(f);
      show(up.url);
      toast('Foto subida. Se guarda en el producto al presionar «Guardar».');
    } catch (e) {
      show(input.value);
      toast(e.message || 'No se pudo subir la foto', 'error');
    } finally {
      file.value = '';
    }
  });
}
