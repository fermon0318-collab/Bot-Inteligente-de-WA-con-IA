/**
 * Middlewares de sesión, acceso y límite de peticiones.
 */

import { config } from '../config.js';
import { one } from '../db/pool.js';
import { readSession } from '../lib/session.js';

/** Adjunta req.user y req.sessionId si hay sesión. Nunca bloquea. */
export async function attachSession(req, _res, next) {
  try {
    const session = await readSession(req);
    if (session) {
      req.user = session.user;
      req.sessionId = session.sessionId;
    }
  } catch (err) {
    console.error('[auth] error al leer la sesión:', err.message);
  }
  next();
}

/** Exige sesión. Responde 401 en JSON o redirige si la petición es de página. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.accepts(['json', 'html']) === 'html') {
    return res.redirect(`/?login=required&next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: 'unauthenticated', message: 'Inicia sesión para continuar.' });
}

const ACTIVE = new Set(['active', 'trialing']);

/**
 * ¿Puede esta cuenta usar el producto?
 *
 * `past_due` cuenta como utilizable: al cliente se le avisa en el panel, pero
 * cortarle el bot en el primer cobro fallido haría más daño que bien — sus
 * conversaciones se quedarían sin responder por una tarjeta caducada.
 *
 * Se expone aparte de requireSubscription porque /internal/auth necesita la
 * misma decisión pero traducida a los códigos que entiende nginx.
 */
export async function subscriptionAccess(user) {
  if (config.bypassEmails.includes(user.email.toLowerCase())) {
    return { allowed: true, subscription: { status: 'bypass', plan: null } };
  }

  const sub = await one(
    `SELECT status, plan, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE account_id = $1`,
    [user.accountId]
  );

  const status = sub?.status || 'none';
  return {
    allowed: ACTIVE.has(status) || status === 'past_due',
    subscription: sub || { status: 'none' },
  };
}

/** Exige suscripción utilizable. Responde 402 en JSON o redirige a precios. */
export async function requireSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });

  const { allowed, subscription } = await subscriptionAccess(req.user);
  req.subscription = subscription;
  const status = subscription.status;

  if (allowed) return next();

  if (req.accepts(['json', 'html']) === 'html') {
    return res.redirect('/#precios?suscripcion=requerida');
  }
  return res.status(402).json({
    error: 'subscription_required',
    status,
    message: 'Necesitas una suscripción activa para usar esta sección.',
  });
}

/**
 * Límite de peticiones en memoria (ventana deslizante simple).
 * Suficiente para una sola instancia detrás de nginx; si algún día hay varias,
 * habrá que moverlo a Redis o a limit_req de nginx.
 */
export function rateLimit({ windowMs = 60_000, max = 60, key = (req) => req.ip } = {}) {
  const hits = new Map();

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, list] of hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
    list.push(now);
    hits.set(k, list);
    if (list.length > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'rate_limited', message: 'Demasiadas peticiones. Inténtalo en un minuto.' });
    }
    next();
  };
}
