/**
 * Cobro del trial de Wompi.
 *
 * Wompi no tiene "suscripción con trial" como Stripe — no hay nada que dispare
 * el cobro solo. Este worker es lo que hace ese trabajo: cada cierto tiempo
 * busca cuentas en `subscriptions.status = 'trialing'` cuyo `trial_ends_at` ya
 * pasó y les cobra con la tarjeta guardada (`billing.chargeTrialsDue()`).
 *
 * Solo hace algo cuando el proveedor activo es Wompi; con Stripe el cobro lo
 * dispara Stripe mismo vía `trial_period_days`, y con 'none' no hay nada que
 * cobrar.
 */

import { billing, providerName } from '../billing/index.js';

export function startWorker({ intervalMs = 60 * 60 * 1000 } = {}) {
  if (providerName !== 'wompi') return () => {};

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await billing.chargeTrialsDue();
      if (results.length) {
        const ok = results.filter((r) => r.status === 'APPROVED').length;
        const fail = results.length - ok;
        console.log(`[trialBilling] ${results.length} trial(s) procesado(s) · ${ok} aprobado(s) · ${fail} con problema`);
      }
    } catch (err) {
      console.error('[trialBilling] fallo:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick(); // no se espera arranque en frío para cobrar trials ya vencidos

  return () => clearInterval(timer);
}
