/**
 * Sesiones respaldadas en base de datos.
 *
 * La cookie solo lleva el id de sesión firmado; el estado vive en Postgres, así
 * que cerrar sesión la invalida de verdad y se pueden revocar accesos.
 */

import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { randomId, sign, unsign } from './crypto.js';

// El prefijo __Host- ata la cookie al dominio exacto y exige Secure + Path=/.
// En desarrollo (http://localhost) el navegador lo rechazaría, así que se cae
// a un nombre normal.
export const COOKIE = config.isProd ? '__Host-elorai_session' : 'elorai_session';

const MAX_AGE = config.sessionDays * 24 * 60 * 60;

function serializeCookie(name, value, { maxAge }) {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Crea la sesión, la persiste y deja la cookie en la respuesta. */
export async function createSession(res, userId, req) {
  const id = randomId(32);
  const expiresAt = new Date(Date.now() + MAX_AGE * 1000);
  await query(
    `INSERT INTO sessions (id, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, (req.headers['user-agent'] || '').slice(0, 500), clientIp(req), expiresAt]
  );
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, sign(id), { maxAge: MAX_AGE }));
  return id;
}

/** Devuelve { user, session } o null si no hay sesión válida. */
export async function readSession(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const id = unsign(raw);
  if (!id) return null;

  const row = await one(
    `SELECT s.id AS session_id, s.expires_at,
            u.id, u.account_id, u.email, u.name, u.avatar_url, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id]
  );
  if (!row) return null;

  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      role: row.role,
    },
  };
}

export async function destroySession(req, res) {
  const raw = parseCookies(req)[COOKIE];
  const id = raw ? unsign(raw) : null;
  if (id) await query('DELETE FROM sessions WHERE id = $1', [id]);
  res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', { maxAge: 0 }));
}

export function clientIp(req) {
  // nginx envía X-Forwarded-For; se toma la primera entrada, que es el cliente.
  const fwd = req.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress;
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Limpieza periódica de sesiones y estados OAuth caducados. */
export async function purgeExpired() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query('DELETE FROM oauth_states WHERE expires_at < now()');
}
