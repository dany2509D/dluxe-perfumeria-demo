// Sesión del cliente de la tienda y sus favoritos. Los favoritos viven en este navegador y, si el cliente tiene cuenta, también se
// guardan en ella para que lo acompañen a otros aparatos. Comprar no exige cuenta.
import { api, ApiError } from './ui.js';

const TOKEN_KEY = 'aurelia-customer-token';
const FAV_KEY = 'aurelia-favs-v1';

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

let token = read(TOKEN_KEY) || null;
let customer = null;
let favs = (() => { try { const v = JSON.parse(read(FAV_KEY) || '[]'); return Array.isArray(v) ? v.filter(Number.isInteger) : []; } catch { return []; } })();

const emit = () => window.dispatchEvent(new CustomEvent('aurelia:account'));
export const getToken = () => token;
export const getCustomer = () => customer;
export const loggedIn = () => !!token && !!customer;

const apiAs = (path, opts = {}) => api(path, { ...opts, token });

function setSession(r) {
  token = r.token;
  customer = r.customer;
  write(TOKEN_KEY, token);
}

// Al cargar la tienda: si había una sesión guardada, se comprueba y se unen los favoritos.
export async function restore() {
  if (!token) return emit();
  try {
    customer = (await apiAs('/api/account/me')).customer;
    await syncFavs();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { token = null; customer = null; write(TOKEN_KEY, null); }
  }
  emit();
}

export async function login(email, password) {
  setSession(await api('/api/account/login', { method: 'POST', body: { email, password } }));
  await syncFavs().catch(() => {});
  emit();
}

export async function register(data) {
  setSession(await api('/api/account/register', { method: 'POST', body: data }));
  await syncFavs().catch(() => {});
  emit();
}

export function logout() {
  token = null;
  customer = null;
  write(TOKEN_KEY, null);
  emit();
}

export async function updateProfile(body) {
  customer = (await apiAs('/api/account/me', { method: 'PATCH', body })).customer;
  emit();
  return customer;
}

export async function changePassword(current, next) {
  const r = await apiAs('/api/account/password', { method: 'POST', body: { current, next } });
  setSession(r);
  emit();
}

export const myOrders = async () => (await apiAs('/api/account/orders')).orders;

// ─── Favoritos ─────────────────────────────────────────────────────────────
export const favIds = () => [...favs];
export const isFav = (id) => favs.includes(Number(id));

function saveFavs() {
  write(FAV_KEY, JSON.stringify(favs));
  emit();
}

// Une lo guardado en el navegador con lo de la cuenta (sin perder nada de ninguno de los dos).
async function syncFavs() {
  if (!token) return;
  const remote = (await apiAs('/api/account/favorites')).ids || [];
  favs = [...new Set([...favs, ...remote])];
  const saved = await apiAs('/api/account/favorites', { method: 'PUT', body: { ids: favs } });
  favs = saved.ids;
  write(FAV_KEY, JSON.stringify(favs));
}

export async function toggleFav(id) {
  id = Number(id);
  favs = favs.includes(id) ? favs.filter((x) => x !== id) : [id, ...favs];
  saveFavs();
  if (token) apiAs('/api/account/favorites', { method: 'PUT', body: { ids: favs } }).catch(() => {});
  return favs.includes(id);
}
