/**
 * Elorai — arranque del servidor.
 *
 * Puede vivir detrás de nginx (Hetzner: nginx termina TLS, sirve los estáticos
 * y solo reenvía /auth, /api y /webhook) o solo, publicado directamente por
 * Railway (sin nginx: aquí mismo se sirven los archivos estáticos, la cabecera
 * de seguridad y la compresión). Ambos casos conviven sin configuración
 * adicional porque en el primero nginx nunca llega a reenviar a Node las
 * rutas de estáticos ni "/", así que el código de abajo simplemente no se
 * ejecuta ahí.
 */

import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { one, pool } from './db/pool.js';
import { avisarError } from './lib/alert.js';
import { purgeExpired } from './lib/session.js';
import { attachSession, requireAuth, subscriptionAccess } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import apiRoutes from './routes/api.js';
import webhookRoutes, { reprocessPending } from './routes/webhook.js';
import * as adsync from './services/adsync.js';
import * as capi from './services/capi.js';
import { startWorker } from './services/outbox.js';
import * as remarketing from './services/remarketing.js';
import * as trialBilling from './services/trialBilling.js';

const app = express();

// Detrás de nginx o del proxy de borde de Railway: ambos anexan X-Forwarded-*
app.set('trust proxy', 1);
app.disable('x-powered-by');

// La misma CSP que llevaba deploy/elorai-headers.conf para nginx — ver ese
// archivo para el porqué de cada origen permitido.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Tailwind se compila localmente y no hay <script> inline en ningún
      // HTML: script-src no necesita 'unsafe-inline' ni 'unsafe-eval'.
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com', 'https://i.ytimg.com'],
      frameSrc: ['https://www.youtube-nocookie.com'],
      // sandbox./production.wompi.co: el navegador tokeniza la tarjeta
      // directo con Wompi (onboarding.js) — así el número nunca toca este
      // servidor. Ambos hosts se permiten siempre: cuál se use depende de
      // qué llave (pub_test_/pub_prod_) esté configurada, no del entorno.
      connectSrc: ["'self'", 'https://sandbox.wompi.co', 'https://production.wompi.co'],
      formAction: ["'self'", 'https://checkout.stripe.com', 'https://billing.stripe.com'],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

/* --- Webhook de cobros: cuerpo en crudo ----------------------------------
   Debe ir ANTES del parser de JSON. La firma de Stripe se calcula sobre los
   bytes exactos del cuerpo; si express lo parsea primero, la verificación
   falla siempre y de forma desconcertante.
   ------------------------------------------------------------------------ */
app.use('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(attachSession);

/* --- Salud ---------------------------------------------------------------- */
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, env: config.env, time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
});

/* --- Rutas ---------------------------------------------------------------- */

// Público a propósito: la landing (sin sesión) necesita el WhatsApp de soporte
// para sus enlaces "Contactar por WhatsApp" — una sola variable de entorno
// (SUPPORT_WHATSAPP) lo cambia en todo el sitio, en vez de un número quemado
// en cada archivo.
app.get('/api/public/support', (_req, res) => {
  res.json({ whatsapp: config.support.whatsapp, email: config.support.email });
});

app.use('/auth', authRoutes);
app.use('/api/billing', billingRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

/**
 * Punto de apoyo para `auth_request` de nginx.
 *
 * nginx consulta esta ruta antes de servir dashboard.html. Así el panel queda
 * protegido en el propio servidor web, sin depender de que el JavaScript del
 * navegador redirija — que es una defensa que se salta desactivando JS.
 *
 * 200 → deja pasar · 401 → sin sesión · 402 → sin suscripción
 */
app.get('/internal/auth', requireAuth, async (req, res, next) => {
  // auth_request de nginx solo interpreta 401 y 403: cualquier otro código lo
  // convierte en un 500. Por eso la falta de suscripción se traduce aquí a 403,
  // mientras que la API sigue devolviendo el 402 que le corresponde.
  try {
    const { allowed } = await subscriptionAccess(req.user);
    if (!allowed) return res.status(403).end();
    res.setHeader('X-Elorai-User', req.user.email);
    res.status(200).end();
  } catch (err) {
    next(err);
  }
});

/* --- Panel protegido -------------------------------------------------------
   Equivalente en Express de lo que hacía `auth_request` en nginx (ver
   deploy/nginx.conf): sin esto, publicar directamente en Railway serviría
   dashboard.html a cualquiera que conociera la URL, sesión o no.
   ------------------------------------------------------------------------ */
app.get('/dashboard.html', requireAuth, async (req, res, next) => {
  try {
    const hasProfile = await one('SELECT 1 FROM business_profile WHERE account_id = $1', [req.user.accountId]);
    if (!hasProfile) return res.redirect('/onboarding.html');
    const { allowed } = await subscriptionAccess(req.user);
    if (!allowed) return res.redirect('/#precios?suscripcion=requerida');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(ROOT, 'dashboard.html'));
  } catch (err) {
    next(err);
  }
});

/* --- Onboarding -------------------------------------------------------------
   Paso obligatorio tras el primer login con Google: sin esto, la cuenta existe
   pero no sabemos qué tipo de negocio es ni cómo contactarlo. No exige
   suscripción — el negocio completa esto antes de elegir plan. */
app.get('/onboarding.html', requireAuth, async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(ROOT, 'onboarding.html'));
  } catch (err) {
    next(err);
  }
});

/* --- Archivos estáticos -----------------------------------------------------
   Solo lo que de verdad es público: assets/ y las páginas sueltas. Nunca se
   monta ROOT entero, así server/, deploy/, docs/ y tools/ quedan fuera de
   alcance sin necesidad de una lista de bloqueo.
   ------------------------------------------------------------------------ */
app.use('/assets', express.static(join(ROOT, 'assets'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

for (const page of ['index.html', 'privacidad.html', 'terminos.html']) {
  const filePath = join(ROOT, page);
  if (!existsSync(filePath)) continue;
  app.get(`/${page}`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filePath);
  });
}
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(ROOT, 'index.html'));
});

/* --- 404 y errores -------------------------------------------------------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
    avisarError(`${req.method} ${req.originalUrl}`, err).catch(() => {});
  } else {
    console.warn(`[aviso] ${req.method} ${req.originalUrl}: ${err.message}`);
  }

  // Nunca se filtra el stack ni el mensaje interno al cliente en un 500
  res.status(status).json({
    error: err.code || (status >= 500 ? 'internal_error' : 'request_error'),
    message: status >= 500
      ? 'Algo falló de nuestro lado. Ya estamos avisados.'
      : err.message,
  });
});

/* --- Ciclo de vida -------------------------------------------------------- */
const server = app.listen(config.port, config.host, () => {
  console.log(`Elorai escuchando en http://${config.host}:${config.port} · entorno ${config.env}`);
  console.log(`URL pública: ${config.publicUrl}`);
});

// Trabajador de la cola de salida: despacha lo que ya venció
const stopOutbox = startWorker({ intervalMs: 3000 });

// Remarketing: busca contactos enfriados cada pocos minutos
const stopRemarketing = remarketing.startWorker();

// Conversions API: despacha eventos de compra encolados
const stopCapi = capi.startWorker();

// Sincronización con Meta Ads: trae gasto y métricas una vez por hora
const stopAdsync = adsync.startWorker();

// Cobro de trials vencidos (Wompi): revisa cada hora si hay cuentas que ya
// cumplieron los 7 días. No hace nada si el proveedor activo no es Wompi.
const stopTrialBilling = trialBilling.startWorker();

// Si el proceso murió a mitad de un evento, aquí se recupera
reprocessPending().catch((err) => console.error('[webhook] reproceso inicial:', err.message));

// Limpieza de sesiones y estados OAuth caducados
setInterval(() => {
  purgeExpired().catch((err) => console.error('[limpieza]', err.message));
}, 60 * 60 * 1000).unref();

purgeExpired().catch(() => {});

function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando…`);
  stopOutbox();
  stopRemarketing();
  stopCapi();
  stopAdsync();
  stopTrialBilling();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  // Si alguna conexión se queda colgada, no se bloquea el despliegue
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[promesa sin manejar]', reason);
  avisarError('promesa sin manejar', reason instanceof Error ? reason : new Error(String(reason))).catch(() => {});
});
