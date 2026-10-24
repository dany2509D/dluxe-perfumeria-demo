// Página de pago de demostración (PAYMENTS_PROVIDER=demo-hosted): imita el paso por una pasarela externa.
const q = new URLSearchParams(location.search);
const ref = q.get('ref') || '';
const amount = Number(q.get('amount'));
// Solo se vuelve a esta misma tienda (nunca a una dirección de otro sitio).
const back = (() => {
  try {
    const u = new URL(q.get('back') || '/', location.origin);
    return u.origin === location.origin ? u.href : '/';
  } catch { return '/'; }
})();

document.getElementById('ref').textContent = ref || '(sin referencia)';
document.getElementById('amount').textContent = Number.isFinite(amount) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount) : '—';
document.getElementById('back').href = back;
if (!ref) document.querySelectorAll('button').forEach((b) => { b.disabled = true; });

async function finish(result) {
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    const res = await fetch('/api/payments/demo/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference: ref, result }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo registrar el pago');
    location.assign(back);
  } catch (e) {
    const err = document.getElementById('err');
    err.textContent = e.message;
    err.hidden = false;
    document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}
document.getElementById('ok').addEventListener('click', () => finish('pagado'));
document.getElementById('bad').addEventListener('click', () => finish('fallido'));
