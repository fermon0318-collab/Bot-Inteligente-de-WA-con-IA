/**
 * Elorai — arranque del servidor.
 *
 * Escucha solo en 127.0.0.1: quien expone el servicio a internet es nginx, que
 * además termina TLS y sirve los archivos estáticos.
 */

import express from 'express';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { purgeExpired } from './lib/session.js';
import { attachSession, requireAuth, subscriptionAccess } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import billingRoutes from './routes/billing.js';
import apiRoutes from './routes/api.js';
import webhookRoutes, { reprocessPending } from './routes/webhook.js';
import { startWorker } from './services/outbox.js';

const app = express();

// nginx es el único que habla con este proceso: se confía en su X-Forwarded-*
app.set('trust proxy', 1);
app.disable('x-powered-by');

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

/* --- 404 y errores -------------------------------------------------------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message);
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
});
