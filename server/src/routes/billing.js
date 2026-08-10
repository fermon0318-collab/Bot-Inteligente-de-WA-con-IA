/**
 * Rutas de cobros: alta de suscripción, portal de cliente y webhook.
 */

import { Router } from 'express';
import { billing, providerName } from '../billing/index.js';
import { config } from '../config.js';
import { requireAuth, rateLimit } from '../middleware/auth.js';

const router = Router();

/** Cuentas gratuitas de por vida (fundadores, soporte): nunca se les cobra. */
const isBypass = (req) => config.bypassEmails.includes(req.user.email.toLowerCase());

/* --- Flujo específico de Wompi: tokenizar tarjeta y guardarla ------------- */
router.get('/wompi/widget-config', requireAuth, async (req, res, next) => {
  try {
    if (providerName !== 'wompi') return res.status(404).json({ error: 'not_applicable' });
    // A una cuenta gratuita de por vida no se le pide tarjeta: devolver 404
    // hace que el onboarding se salte ese paso sin ninguna lógica extra.
    if (isBypass(req)) return res.status(404).json({ error: 'not_applicable' });
    res.json(await billing.getWidgetConfig());
  } catch (err) { next(err); }
});

router.post('/wompi/attach-card', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    if (providerName !== 'wompi') return res.status(404).json({ error: 'not_applicable' });
    const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
    const { cardToken, acceptanceToken, personalDataAuthToken } = req.body || {};
    const result = await billing.attachCard({
      accountId: req.user.accountId, email: req.user.email, plan,
      cardToken, acceptanceToken, personalDataAuthToken,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Cuenta con cobro fallido (past_due/unpaid): cambia la tarjeta y reintenta
// el cobro al instante, sin reiniciar el trial.
router.post('/wompi/update-card', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    if (providerName !== 'wompi') return res.status(404).json({ error: 'not_applicable' });
    const { cardToken, acceptanceToken, personalDataAuthToken } = req.body || {};
    const result = await billing.updateCard({
      accountId: req.user.accountId, email: req.user.email,
      cardToken, acceptanceToken, personalDataAuthToken,
    });
    res.json(result);
  } catch (err) { next(err); }
});

/* --- Iniciar suscripción -------------------------------------------------- */
router.post('/checkout', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
    const { url } = await billing.createCheckout({
      accountId: req.user.accountId,
      email: req.user.email,
      name: req.user.name,
      plan,
    });
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/* --- Gestionar suscripción existente ------------------------------------- */
router.post('/portal', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    const { url } = await billing.createPortal({ accountId: req.user.accountId });
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/* --- Estado para el panel ------------------------------------------------- */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const status = await billing.getStatus(req.user.accountId);
    // Mismo criterio que /api/me y subscriptionAccess(): en una cuenta
    // gratuita de por vida manda el bypass, no lo que diga la tabla.
    if (isBypass(req)) status.status = 'bypass';
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/* --- Módulo de Facturación del panel -------------------------------------- */
router.get('/invoices', requireAuth, async (req, res, next) => {
  try {
    res.json({ invoices: await billing.listInvoices(req.user.accountId) });
  } catch (err) { next(err); }
});

router.post('/cancel', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    if (isBypass(req)) {
      return res.status(409).json({ error: 'bypass_account', message: 'Esta cuenta es gratuita de por vida: no hay nada que cancelar.' });
    }
    res.json(await billing.cancelSubscription(req.user.accountId));
  } catch (err) { next(err); }
});

router.post('/resume', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    res.json(await billing.resumeSubscription(req.user.accountId));
  } catch (err) { next(err); }
});

router.post('/plan', requireAuth, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res, next) => {
  try {
    const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
    res.json(await billing.changePlan(req.user.accountId, plan));
  } catch (err) { next(err); }
});

/**
 * Webhook del proveedor.
 *
 * Monta el body en crudo (ver index.js): la firma se calcula sobre los bytes
 * exactos, así que parsear el JSON antes rompería la verificación.
 *
 * Se responde 200 en cuanto la firma es válida, incluso si el procesamiento
 * falla: si devolviéramos 500, Stripe reintentaría en bucle un evento que
 * quizá nunca podamos aplicar. Los fallos quedan en el log para revisarlos.
 */
router.post('/webhook', async (req, res) => {
  // Stripe firma con un header (`stripe-signature`) sobre el cuerpo crudo;
  // Wompi mete el checksum dentro del propio JSON (ver billing/wompi.js),
  // así que verifyWebhook() recibe distintos argumentos según el proveedor.
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = providerName === 'wompi' ? billing.verifyWebhook(req.body) : billing.verifyWebhook(req.body, signature);
  } catch (err) {
    console.warn('[billing] firma de webhook inválida:', err.message);
    return res.status(400).send('firma inválida');
  }

  res.json({ received: true });

  try {
    await billing.handleEvent(event);
  } catch (err) {
    const label = event?.id || event?.data?.transaction?.id || '?';
    console.error(`[billing] fallo al procesar evento (${label}):`, err.message);
  }
});

export default router;
