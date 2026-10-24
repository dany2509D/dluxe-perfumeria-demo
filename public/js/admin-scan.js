// Lectura de códigos de barras con la cámara (Chrome y Edge en Android o computadora traen BarcodeDetector). Los lectores USB
// no necesitan esto: escriben el código como un teclado y terminan con Enter, que el punto de venta ya entiende.
import { esc, icon, toast } from './ui.js';
import { openModal, closeModal } from './admin-kit.js';

export const cameraScanSupported = () => typeof window.BarcodeDetector === 'function' && !!navigator.mediaDevices?.getUserMedia;

// Pitido corto al leer un código (WebAudio, sin archivos). Falla en silencio si el navegador no deja sonar.
let audio = null;
export function beep(ok = true) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1040 : 220;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.09 : 0.25));
  } catch { /* sin sonido */ }
}

// Abre la cámara en un diálogo y llama onCode(código) por cada lectura nueva (el mismo código no se repite en 2 segundos).
export async function scanWithCamera(onCode) {
  if (!cameraScanSupported()) return toast('Este navegador no puede leer códigos con la cámara. Usa un lector USB o escribe el SKU.', 'error');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch {
    return toast('No se pudo abrir la cámara. Revisa el permiso del navegador.', 'error');
  }
  const detector = new window.BarcodeDetector({ formats: ['ean_13', 'code_128', 'ean_8', 'upc_a'] });
  let alive = true;
  let last = { code: '', at: 0 };
  openModal({
    title: 'Escanear con la cámara',
    body: `<div class="scan-box"><video id="scan-video" playsinline muted></video><div class="scan-aim" aria-hidden="true"></div></div>
           <p class="muted caption" id="scan-msg">Apunta al código de barras. Cada lectura se agrega al ticket; cierra cuando termines.</p>`,
    closeLabel: 'Terminar',
    onOpen: (dlg) => {
      const video = dlg.querySelector('#scan-video');
      video.srcObject = stream;
      video.play().catch(() => {});
      const stop = () => {
        alive = false;
        stream.getTracks().forEach((t) => t.stop());
        dlg.removeEventListener('close', stop);
      };
      dlg.addEventListener('close', stop);
      const loop = async () => {
        if (!alive) return;
        try {
          const found = await detector.detect(video);
          const code = found[0]?.rawValue;
          if (code && (code !== last.code || Date.now() - last.at > 2000)) {
            last = { code, at: Date.now() };
            const ok = await onCode(code);
            beep(ok !== false);
            const msg = dlg.querySelector('#scan-msg');
            if (msg) msg.innerHTML = ok === false ? `<span class="err-text">No hay ningún producto con el código ${esc(code)}</span>` : `${icon('check', 14)} Leído ${esc(code)}`;
          }
        } catch { /* un cuadro sin código: seguir */ }
        setTimeout(loop, 220);
      };
      loop();
    },
  });
  return { close: closeModal };
}
