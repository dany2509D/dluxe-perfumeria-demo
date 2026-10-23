// Selector de diseño compartido por la tienda y el panel.
// El tema vive en <html data-theme="…"> y se recuerda en localStorage.
// (Un script mínimo en el <head> lo aplica antes de pintar para evitar el parpadeo.)
const KEY = 'aurelia-theme';
const THEMES = [
  ['limon', 'Limón'],
  ['shop', 'Shop'],
];

export const currentTheme = () => document.documentElement.dataset.theme || 'limon';

export function applyTheme(theme) {
  if (!THEMES.some(([id]) => id === theme)) theme = 'limon';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(KEY, theme); } catch { /* sin almacenamiento */ }
  document.querySelectorAll('.theme-switch button').forEach((b) => {
    const on = b.dataset.theme === theme;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

export function mountThemeSwitch() {
  const box = document.createElement('div');
  box.className = 'theme-switch';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Diseño de la página');
  box.innerHTML =
    '<span class="ts-label">Diseño</span>' +
    THEMES.map(([id, label]) => `<button type="button" data-theme="${id}" aria-pressed="false">${label}</button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme]');
    if (b) applyTheme(b.dataset.theme);
  });
  document.body.append(box);
  applyTheme(currentTheme());
}
