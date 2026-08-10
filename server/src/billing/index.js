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

import * as none from './none.js';

const KNOWN = ['none', 'stripe', 'wompi'];

const PROVIDER = process.env.BILLING_PROVIDER || 'none';

if (!KNOWN.includes(PROVIDER)) {
  console.error(`✗ BILLING_PROVIDER="${PROVIDER}" no está implementado. Opciones: ${KNOWN.join(', ')}`);
  process.exit(1);
}

// Se importa el adaptador de forma perezosa: stripe.js/wompi.js validan sus
// propias variables de entorno en cuanto se cargan, así que cargarlos siempre
// rompería el arranque aunque no se vayan a usar.
export const billing =
  PROVIDER === 'stripe' ? await import('./stripe.js') :
  PROVIDER === 'wompi' ? await import('./wompi.js') :
  none;

export const providerName = PROVIDER;
