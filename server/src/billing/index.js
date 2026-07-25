/**
 * Capa de cobros.
 *
 * El resto de la aplicación solo conoce esta interfaz, nunca a Stripe
 * directamente. Cambiar de proveedor —a Paddle o Lemon Squeezy, por ejemplo, si
 * algún día conviene que un merchant of record asuma los impuestos de LatAm—
 * significa escribir otro adaptador con estos cuatro métodos, sin tocar rutas
 * ni middlewares.
 *
 *   createCheckout({ account, user, plan, returnUrl }) → { url }
 *   createPortal({ account, returnUrl })               → { url }
 *   verifyWebhook(rawBody, signature)                  → evento normalizado
 *   handleEvent(event)                                 → persiste el cambio
 */

import * as stripe from './stripe.js';

const providers = { stripe };

const PROVIDER = process.env.BILLING_PROVIDER || 'stripe';

export const billing = providers[PROVIDER];

if (!billing) {
  console.error(`✗ BILLING_PROVIDER="${PROVIDER}" no está implementado. Opciones: ${Object.keys(providers).join(', ')}`);
  process.exit(1);
}

export const providerName = PROVIDER;
