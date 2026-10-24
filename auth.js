// Acceso: usuarios del panel con roles, claves guardadas con scrypt, sesiones firmadas y bitácora.
//
// Las sesiones no guardan nada en el servidor: son un token firmado (HMAC) con el usuario y su vencimiento. Así valen aunque
// la petición la atienda otra instancia (funciones serverless) o se reinicie el servidor. La firma incluye una huella de la
// clave del usuario, de modo que cambiarla cierra todas sus sesiones abiertas.
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { HttpError, tx } from './db.js';

// ─── Roles y permisos ──────────────────────────────────────────────────────
export const ROLES = {
  admin: 'Administrador',
  gerente: 'Gerente',
  cajero: 'Cajero',
  inventario: 'Inventario',
};

// Cada permiso es una pantalla o una acción del panel. El rol «admin» tiene todos.
const GERENTE = [
  'resumen', 'costos', 'pos', 'caja', 'caja_todas', 'pedidos', 'pedidos_cancelar', 'devoluciones', 'inventario', 'inventario_editar',
  'productos', 'sets', 'compras', 'movimientos', 'resenas', 'promociones', 'regalos', 'reportes', 'notificaciones', 'facturas',
  'descuento_libre', 'bitacora', 'configuracion',
];
const PERMS_BY_ROLE = {
  admin: null,
  gerente: new Set(GERENTE),
  cajero: new Set(['pos', 'caja', 'pedidos', 'inventario', 'regalos', 'descuento_manual']),
  inventario: new Set(['inventario', 'inventario_editar', 'productos', 'sets', 'compras', 'movimientos', 'costos', 'resenas']),
};
export const ALL_PERMS = [...new Set([...GERENTE, 'usuarios', 'woocommerce', 'ajustes', 'descuento_manual'])];

export const permsOf = (role) => (role === 'admin' ? ALL_PERMS : [...(PERMS_BY_ROLE[role] || [])]);
export const can = (user, perm) => !!user && (user.role === 'admin' || !!PERMS_BY_ROLE[user.role]?.has(perm));
// perm puede ser un texto o una lista (basta con uno de ellos).
export const canAny = (user, perm) => (Array.isArray(perm) ? perm.some((p) => can(user, p)) : can(user, perm));

// ─── Claves ────────────────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  try {
    const want = Buffer.from(hashHex, 'hex');
    const got = scryptSync(String(password), Buffer.from(saltHex, 'hex'), want.length, { N: Number(N), r: Number(r), p: Number(p) });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// Una clave aceptable: 8 caracteres o más, sin ser una de las más repetidas.
const COMMON = new Set(['12345678', '123456789', 'password', 'contraseña', 'qwertyui', '11111111', '00000000', 'abcd1234']);
export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return 'La contraseña debe tener al menos 8 caracteres';
  if (s.length > 100) return 'La contraseña es demasiado larga';
  if (COMMON.has(s.toLowerCase())) return 'Esa contraseña es demasiado común: elige otra';
  return null;
}

// Huella corta de la clave guardada: va dentro de la firma de la sesión.
const fingerprint = (stored) => createHash('sha256').update(String(stored)).digest('hex').slice(0, 16);

// ─── Sesiones ──────────────────────────────────────────────────────────────
export function createSessions(secret) {
  const key = createHash('sha256').update(`dluxe-session:${secret}`).digest();
  const mac = (s) => createHmac('sha256', key).update(s).digest('hex');
  return {
    // kind: 's' = personal del panel, 'c' = cliente de la tienda.
    issue(kind, id, passHash, ttlMs) {
      const body = `${kind}.${id}.${(Date.now() + ttlMs).toString(36)}`;
      return `${body}.${mac(`${body}.${fingerprint(passHash)}`)}`;
    },
    parse(header) {
      const m = /^Bearer ([sc])\.(\d{1,9})\.([a-z0-9]{1,12})\.([a-f0-9]{64})$/.exec(header || '');
      return m ? { kind: m[1], id: Number(m[2]), exp: parseInt(m[3], 36), sig: m[4], body: `${m[1]}.${m[2]}.${m[3]}` } : null;
    },
    valid(parsed, passHash) {
      if (!parsed || parsed.exp <= Date.now()) return false;
      const want = Buffer.from(mac(`${parsed.body}.${fingerprint(passHash)}`));
      const got = Buffer.from(parsed.sig);
      return want.length === got.length && timingSafeEqual(want, got);
    },
  };
}

// ─── Tope de intentos (en memoria) ─────────────────────────────────────────
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  const recent = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    // Cuenta un intento. Devuelve false si ya se pasó del tope.
    take(key, now = Date.now()) {
      const list = recent(key, now);
      if (list.length >= max) return false;
      list.push(now);
      hits.set(key, list);
      return true;
    },
    // ¿Ya se agotó el tope? (sin contar un intento más)
    blocked: (key, now = Date.now()) => recent(key, now).length >= max,
    count: (key, now = Date.now()) => recent(key, now).length,
    reset: (key) => hits.delete(key),
    retrySeconds(key, now = Date.now()) {
      const list = recent(key, now);
      return list.length ? Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000)) : 0;
    },
  };
}

// ─── Usuarios ──────────────────────────────────────────────────────────────
const USER_COLS = 'id, username, name, role, active, created_at, last_login';
const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role, role_label: ROLES[u.role], active: !!u.active, created_at: u.created_at, last_login: u.last_login };

export const userById = (db, id) => db.prepare('SELECT id, username, name, role, active, pass_hash FROM users WHERE id = ?').get(id);
export const userByName = (db, username) => db.prepare('SELECT id, username, name, role, active, pass_hash FROM users WHERE username = ?').get(String(username ?? '').trim());

const cleanUsername = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) throw new HttpError(400, 'El usuario debe tener de 3 a 30 letras minúsculas, números, punto, guion o guion bajo');
  return s;
};
const cleanName = (v) => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw new HttpError(400, 'El nombre es obligatorio');
  return s.slice(0, 60);
};
const cleanRole = (v) => {
  if (!ROLES[v]) throw new HttpError(400, 'El rol no es válido');
  return v;
};

export function listUsers(db) {
  return db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY active DESC, role, username`).all().map(publicUser);
}

export function createUser(db, { username, name, role, password }) {
  const u = cleanUsername(username);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  if (userByName(db, u)) throw new HttpError(409, 'Ese usuario ya existe');
  const r = db.prepare('INSERT INTO users (username, name, role, pass_hash) VALUES (?, ?, ?, ?)').run(u, cleanName(name), cleanRole(role), hashPassword(password));
  return publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(Number(r.lastInsertRowid)));
}

const activeAdmins = (db, exceptId) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?").get(exceptId).n;

// Cambia nombre, rol, estado o clave de un usuario. Siempre debe quedar al menos un administrador activo.
export function updateUser(db, id, body, { actorId = null } = {}) {
  return tx(db, () => {
    const cur = userById(db, id);
    if (!cur) throw new HttpError(404, 'Usuario no encontrado');
    const sets = [];
    const vals = [];
    const changes = [];
    if ('name' in body) { sets.push('name = ?'); vals.push(cleanName(body.name)); }
    if ('role' in body && body.role !== cur.role) {
      cleanRole(body.role);
      if (cur.role === 'admin' && !activeAdmins(db, id)) throw new HttpError(409, 'Debe quedar al menos un administrador activo');
      sets.push('role = ?'); vals.push(body.role); changes.push(`rol ${cur.role} → ${body.role}`);
    }
    if ('active' in body && !!body.active !== !!cur.active) {
      if (!body.active) {
        if (id === actorId) throw new HttpError(409, 'No puedes desactivar tu propio usuario');
        if (cur.role === 'admin' && !activeAdmins(db, id)) throw new HttpError(409, 'Debe quedar al menos un administrador activo');
      }
      sets.push('active = ?'); vals.push(body.active ? 1 : 0); changes.push(body.active ? 'activado' : 'desactivado');
    }
    if (body.password) {
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      sets.push('pass_hash = ?'); vals.push(hashPassword(body.password)); changes.push('clave cambiada');
    }
    if (!sets.length) throw new HttpError(400, 'No hay cambios que guardar');
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return { user: publicUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)), changes };
  });
}

export function changeOwnPassword(db, id, current, next) {
  const u = userById(db, id);
  if (!u || !verifyPassword(current, u.pass_hash)) throw new HttpError(401, 'La contraseña actual no es correcta');
  const problem = passwordProblem(next);
  if (problem) throw new HttpError(400, problem);
  if (verifyPassword(next, u.pass_hash)) throw new HttpError(400, 'La contraseña nueva debe ser distinta de la actual');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(next), id);
}

export const touchLogin = (db, id) => db.prepare("UPDATE users SET last_login = datetime('now','localtime') WHERE id = ?").run(id);

// El administrador inicial se crea una sola vez con la clave que llegue de ADMIN_PASSWORD; después la clave se cambia en el panel.
export function ensureOwner(db, password) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
  db.prepare("INSERT INTO users (username, name, role, pass_hash) VALUES ('admin', 'Administrador', 'admin', ?)").run(hashPassword(password));
  return true;
}

// Usuarios de ejemplo para la demostración (comparten la clave del administrador). En una tienda real se desactivan.
export const DEMO_USERS = [
  ['gerente', 'Gerente de tienda', 'gerente'],
  ['cajero', 'Cajero de mostrador', 'cajero'],
  ['bodega', 'Encargado de inventario', 'inventario'],
];
export function seedDemoUsers(db, password) {
  let hash = null;
  for (const [username, name, role] of DEMO_USERS) {
    if (userByName(db, username)) continue;
    hash ??= hashPassword(password);
    db.prepare('INSERT INTO users (username, name, role, pass_hash) VALUES (?, ?, ?, ?)').run(username, name, role, hash);
  }
}

// ─── Bitácora ──────────────────────────────────────────────────────────────
// Se registra quién hizo qué. `detail` es un resumen legible; jamás debe llevar claves ni datos de tarjetas.
export function audit(db, user, { action, entity = '', id = '', detail = '', ip = '' }) {
  db.prepare('INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    user?.id ?? null,
    user ? `${user.name} (${user.username})` : '',
    String(action).slice(0, 60),
    String(entity).slice(0, 40),
    String(id ?? '').slice(0, 40),
    String(detail ?? '').slice(0, 500),
    String(ip ?? '').slice(0, 64)
  );
}

export function listAudit(db, { action = '', userId = null, q = '', from = '', to = '', page = 1, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const pg = Math.max(1, Number(page) || 1);
  const w = ['1 = 1'];
  const a = [];
  if (action) { w.push("(action = ? OR action LIKE ? ESCAPE '\\')"); a.push(action, `${action.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`); }
  if (userId) { w.push('user_id = ?'); a.push(Number(userId)); }
  if (q) { w.push("(detail LIKE ? ESCAPE '\\' OR entity_id = ? OR user_name LIKE ? ESCAPE '\\')"); const e = `%${String(q).slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; a.push(e, String(q).trim(), e); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { w.push('date(created_at) >= ?'); a.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { w.push('date(created_at) <= ?'); a.push(to); }
  const cond = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${cond}`).get(...a).n;
  const rows = db.prepare(`SELECT id, user_id, user_name, action, entity, entity_id, detail, ip, created_at FROM audit_log WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...a, lim, (pg - 1) * lim);
  const actions = db.prepare('SELECT DISTINCT substr(action, 1, instr(action || \'.\', \'.\') - 1) AS area FROM audit_log ORDER BY area').all().map((r) => r.area);
  return { rows, total, page: pg, limit: lim, pages: Math.max(1, Math.ceil(total / lim)), areas: actions };
}
