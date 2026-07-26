/**
 * Adaptador "sin pasarela".
 *
 * Se usa mientras no hay un proveedor de cobros configurado (por ejemplo,
 * durante la puesta en marcha en Railway antes de terminar Wompi). Con este
 * adaptador todas las cuentas cuentan como utilizables — ver
 * `subscriptionAccess()` en middleware/auth.js, que corta camino cuando el
 * proveedor activo es 'none' — y las rutas de checkout/portal devuelven un
 * error claro en lugar de intentar hablar con un proveedor que no existe.
 */

function notConfigured() {
  return Object.assign(
    new Error('Los pagos todavía no están configurados en este servidor.'),
    { status: 503, code: 'billing_not_configured' }
  );
}

export async function createCheckout() {
  throw notConfigured();
}

export async function createPortal() {
  throw notConfigured();
}

export function verifyWebhook() {
  throw notConfigured();
}

export async function handleEvent() {
  return { ignored: true };
}

export async function getStatus() {
  return { status: 'bypass', plan: null };
}
