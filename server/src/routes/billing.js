/**
 * Rutas de cobros: alta de suscripción, portal de cliente y webhook.
 */

import { Router } from 'express';
import { billing } from '../billing/index.js';
import { requireAuth, rateLimit } from '../middleware/auth.js';

const router = Router();

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
    res.json(await billing.getStatus(req.user.accountId));
  } catch (err) {
    next(err);
  }
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
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = billing.verifyWebhook(req.body, signature);
  } catch (err) {
    console.warn('[billing] firma de webhook inválida:', err.message);
    return res.status(400).send('firma inválida');
  }

  res.json({ received: true });

  try {
    await billing.handleEvent(event);
  } catch (err) {
    console.error(`[billing] fallo al procesar ${event.type} (${event.id}):`, err.message);
  }
});

export default router;
