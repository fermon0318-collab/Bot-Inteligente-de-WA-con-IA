/**
 * Autenticación con Google (OpenID Connect, Authorization Code + PKCE).
 *
 * Se implementa a mano contra los endpoints públicos de Google en lugar de usar
 * una librería: son tres llamadas, y así no hay una dependencia más que auditar
 * en el camino crítico del login.
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, query, transaction } from '../db/pool.js';
import { randomId } from '../lib/crypto.js';
import { clientIp, createSession, destroySession } from '../lib/session.js';
import { rateLimit } from '../middleware/auth.js';

const router = Router();

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const STATE_TTL_MS = 10 * 60 * 1000;

const base64url = (buf) => buf.toString('base64url');
const challengeFor = (verifier) => base64url(createHash('sha256').update(verifier).digest());

/** Solo se permiten destinos internos: evita open redirect. */
function safeRedirect(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) {
    return '/dashboard.html';
  }
  return target;
}

/* --- Inicio del flujo ---------------------------------------------------- */
router.get('/google', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
  if (!config.google.configured) {
    return res.redirect('/?login=error&reason=google_no_configurado');
  }
  try {
    const state = randomId(24);
    const verifier = base64url(randomBytes(48));

    await query(
      `INSERT INTO oauth_states (state, code_verifier, redirect_to, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [state, verifier, safeRedirect(req.query.next), new Date(Date.now() + STATE_TTL_MS)]
    );

    const url = new URL(GOOGLE_AUTH);
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', config.google.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Fuerza el selector de cuenta: mucha gente tiene varias sesiones de Google
    url.searchParams.set('prompt', 'select_account');

    res.redirect(url.toString());
  } catch (err) {
    next(err);
  }
});

/* --- Vuelta de Google ---------------------------------------------------- */
router.get('/google/callback', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
  const fail = (reason) => res.redirect(`/?login=error&reason=${encodeURIComponent(reason)}`);
  if (!config.google.configured) return fail('google_no_configurado');

  try {
    if (req.query.error) return fail(String(req.query.error));

    const { code, state } = req.query;
    if (!code || !state) return fail('parametros_incompletos');

    // El state se consume: un segundo intento con el mismo código no vale
    const saved = await one(
      `DELETE FROM oauth_states
        WHERE state = $1 AND expires_at > now()
        RETURNING code_verifier, redirect_to`,
      [String(state)]
    );
    if (!saved) return fail('state_invalido');

    /* Intercambio de código por tokens */
    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: saved.code_verifier,
      }),
    });

    if (!tokenRes.ok) {
      console.error('[auth] Google rechazó el intercambio:', await tokenRes.text());
      return fail('token_rechazado');
    }
    const tokens = await tokenRes.json();

    /* Perfil del usuario */
    const profileRes = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileRes.ok) return fail('perfil_no_disponible');

    const profile = await profileRes.json();
    if (!profile.email) return fail('sin_correo');
    if (profile.email_verified === false) return fail('correo_no_verificado');

    const email = String(profile.email).toLowerCase();
    const user = await upsertUser({
      googleSub: profile.sub,
      email,
      name: profile.name || email.split('@')[0],
      avatarUrl: profile.picture || '',
    });

    await createSession(res, user.id, req);
    console.log(`[auth] sesión iniciada · ${email} · ${clientIp(req)}`);

    const dest = saved.redirect_to || '/dashboard.html';
    const hasProfile = await one('SELECT 1 FROM business_profile WHERE account_id = $1', [user.account_id]);
    if (!hasProfile && dest !== '/onboarding.html') {
      return res.redirect(`/onboarding.html?next=${encodeURIComponent(dest)}`);
    }
    res.redirect(dest);
  } catch (err) {
    next(err);
  }
});

/**
 * Crea o actualiza el usuario. La primera vez se crea también su cuenta, la
 * fila de suscripción y la configuración por defecto del bot, todo en una
 * transacción para que no queden cuentas a medio construir.
 */
async function upsertUser({ googleSub, email, name, avatarUrl }) {
  return transaction(async (client) => {
    const existing = await client.query(
      'SELECT id, account_id FROM users WHERE google_sub = $1 OR email = $2 LIMIT 1',
      [googleSub, email]
    );

    if (existing.rows[0]) {
      const { rows } = await client.query(
        `UPDATE users
            SET google_sub = COALESCE(google_sub, $2),
                name = $3, avatar_url = $4, last_login_at = now()
          WHERE id = $1
      RETURNING id, account_id`,
        [existing.rows[0].id, googleSub, name, avatarUrl]
      );
      return rows[0];
    }

    const account = await client.query(
      'INSERT INTO accounts (name) VALUES ($1) RETURNING id',
      [name]
    );
    const accountId = account.rows[0].id;

    const created = await client.query(
      `INSERT INTO users (account_id, email, name, avatar_url, google_sub, role, last_login_at)
       VALUES ($1, $2, $3, $4, $5, 'owner', now())
       RETURNING id, account_id`,
      [accountId, email, name, avatarUrl, googleSub]
    );

    await client.query('INSERT INTO subscriptions (account_id) VALUES ($1)', [accountId]);
    await client.query(
      `INSERT INTO bot_settings (account_id, wa_verify_token, pay_message_ok, pay_message_invalid)
       VALUES ($1, $2, $3, $4)`,
      [
        accountId,
        `elorai_vf_${randomBytes(8).toString('hex')}`,
        '¡Pago confirmado! 🎉 En un momento recibes tus accesos.',
        'No pudimos validar el comprobante. Revisa que se vea el monto, la fecha y la referencia completa, y vuelve a enviarlo.',
      ]
    );
    // Fila de Modo App con los límites por defecto. Se crea siempre aunque el
    // canal activo sea Cloud API: así el panel puede leer el estado sin tener
    // que distinguir entre "nunca vinculado" y "fila inexistente".
    await client.query('INSERT INTO wa_app_sessions (account_id) VALUES ($1)', [accountId]);

    console.log(`[auth] cuenta creada para ${email}`);
    return created.rows[0];
  });
}

/* --- Cierre de sesión ---------------------------------------------------- */
router.post('/logout', async (req, res, next) => {
  try {
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Enlace directo para cerrar sesión desde el navegador
router.get('/logout', async (req, res, next) => {
  try {
    await destroySession(req, res);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

export default router;
