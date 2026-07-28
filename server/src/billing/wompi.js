/**
 * Adaptador de Wompi.
 *
 * A diferencia de Stripe, Wompi no tiene "checkout alojado" ni "suscripción
 * con trial": es puramente transaccional. El flujo real es:
 *
 *   1. El navegador tokeniza la tarjeta con Wompi.js (usando `publicKey`,
 *      nunca toca este servidor — alcance PCI reducido a SAQ A).
 *   2. El navegador manda ese token a `attachCard()`, que lo cambia por una
 *      "fuente de pago" (payment source) reutilizable vía la API privada.
 *   3. Aquí guardamos `trial_ends_at` y el estado queda en 'trialing'.
 *   4. Una tarea programada diaria (`services/trialBilling.js`) llama a
 *      `chargeTrialsDue()`, que cobra con la fuente de pago guardada a cada
 *      cuenta cuyo trial ya venció.
 *   5. Wompi confirma (o no) la transacción por webhook; `handleEvent()`
 *      actualiza el estado real de la cuenta a partir de esa confirmación,
 *      no del resultado síncrono del cobro, porque las tarjetas pueden
 *      quedar en PENDING un rato.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';

const PRICES_COP = {
  monthly: config.wompi.priceMonthlyCop,
  yearly: config.wompi.priceYearlyCop,
};

async function wompiFetch(path, { method = 'GET', body, auth = 'private' } = {}) {
  const key = auth === 'private' ? config.wompi.privateKey : config.wompi.publicKey;
  const res = await fetch(`${config.wompi.apiBase}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json?.error?.messages ? JSON.stringify(json.error.messages) : (json?.error?.reason || res.statusText);
    throw Object.assign(new Error(`Wompi ${method} ${path} → ${res.status}: ${detail}`), {
      status: 502, code: 'wompi_error', wompi: json,
    });
  }
  return json.data ?? json;
}

/** Datos públicos que necesita el widget de tarjeta en el navegador. */
export async function getWidgetConfig() {
  const merchant = await wompiFetch(`/merchants/${config.wompi.publicKey}`, { auth: 'public' });
  return {
    publicKey: config.wompi.publicKey,
    apiBase: config.wompi.apiBase,
    sandbox: config.wompi.sandbox,
    acceptanceToken: merchant?.presigned_acceptance?.acceptance_token || null,
    acceptanceLink: merchant?.presigned_acceptance?.permalink || null,
    personalDataAuthToken: merchant?.presigned_personal_data_auth?.acceptance_token || null,
    prices: { monthly: config.wompi.priceMonthlyCop, yearly: config.wompi.priceYearlyCop },
    trialDays: config.wompi.trialDays,
  };
}

/* --- Wompi no tiene checkout alojado ni portal de autogestión ------------ */
export async function createCheckout() {
  throw Object.assign(new Error('Wompi no usa checkout alojado; usa POST /api/billing/wompi/attach-card'), {
    status: 400, code: 'wrong_provider_flow',
  });
}

export async function createPortal() {
  throw Object.assign(new Error('Wompi no tiene portal de autogestión'), {
    status: 400, code: 'wrong_provider_flow',
  });
}

/**
 * Guarda la tarjeta tokenizada como fuente de pago reutilizable y arranca
 * el trial de `config.wompi.trialDays` días. No cobra nada todavía.
 */
export async function attachCard({ accountId, email, plan, cardToken, acceptanceToken, personalDataAuthToken }) {
  const price = PRICES_COP[plan];
  if (!price) throw Object.assign(new Error('Plan no válido'), { status: 400, code: 'invalid_plan' });
  if (!cardToken || !acceptanceToken) {
    throw Object.assign(new Error('Falta el token de tarjeta o de aceptación'), { status: 400, code: 'missing_token' });
  }

  const source = await wompiFetch('/payment_sources', {
    method: 'POST',
    body: {
      type: 'CARD',
      token: cardToken,
      customer_email: email,
      acceptance_token: acceptanceToken,
      ...(personalDataAuthToken ? { accept_personal_auth: personalDataAuthToken } : {}),
    },
  });

  const trialEndsAt = new Date(Date.now() + config.wompi.trialDays * 86_400_000);

  await query(
    `INSERT INTO subscriptions
       (account_id, provider, customer_id, price_id, plan, status,
        trial_ends_at, charge_attempts, last_charge_error, customer_email, updated_at)
     VALUES ($1, 'wompi', $2, $3, $4, 'trialing', $5, 0, NULL, $6, now())
     ON CONFLICT (account_id) DO UPDATE SET
       provider = 'wompi',
       customer_id = EXCLUDED.customer_id,
       price_id = EXCLUDED.price_id,
       plan = EXCLUDED.plan,
       status = 'trialing',
       trial_ends_at = EXCLUDED.trial_ends_at,
       charge_attempts = 0,
       last_charge_error = NULL,
       customer_email = EXCLUDED.customer_email,
       updated_at = now()`,
    [accountId, source.id, String(price), plan, trialEndsAt, email]
  );

  return { paymentSourceId: source.id, trialEndsAt, sourceStatus: source.status };
}

/* --- Cobro ------------------------------------------------------------- */
const MAX_CHARGE_ATTEMPTS = 3;

/** Cobra una única cuenta cuyo trial ya venció. No lanza: devuelve el resultado. */
async function chargeOne(sub) {
  const amount = sub.plan === 'yearly' ? config.wompi.priceYearlyCop : config.wompi.priceMonthlyCop;
  const reference = `elorai-${sub.account_id}-${Date.now()}`;

  try {
    const tx = await wompiFetch('/transactions', {
      method: 'POST',
      body: {
        amount_in_cents: amount,
        currency: 'COP',
        customer_email: sub.customer_email,
        payment_method: { installments: 1 },
        payment_source_id: Number(sub.customer_id) || sub.customer_id,
        reference,
      },
    });

    // APPROVED/DECLINED llegan también por webhook; aquí solo se registra el
    // intento — el estado definitivo de la cuenta lo fija handleEvent().
    await query(
      `UPDATE subscriptions
         SET subscription_id = $2, charge_attempts = charge_attempts + 1,
             last_charge_at = now(), last_charge_error = NULL, updated_at = now()
       WHERE account_id = $1`,
      [sub.account_id, tx.id]
    );

    if (tx.status === 'APPROVED') {
      await activateAfterCharge(sub.account_id, sub.plan);
    } else if (tx.status === 'DECLINED' || tx.status === 'ERROR') {
      await markChargeFailed(sub.account_id, `transacción ${tx.status.toLowerCase()}`);
    }
    // PENDING se resuelve por webhook.

    return { accountId: sub.account_id, transactionId: tx.id, status: tx.status };
  } catch (err) {
    await markChargeFailed(sub.account_id, err.message);
    return { accountId: sub.account_id, error: err.message };
  }
}

async function activateAfterCharge(accountId, plan) {
  const periodDays = plan === 'yearly' ? 365 : 30;
  await query(
    `UPDATE subscriptions
       SET status = 'active', current_period_end = now() + interval '${periodDays} days',
           updated_at = now()
     WHERE account_id = $1`,
    [accountId]
  );
}

async function markChargeFailed(accountId, reason) {
  const row = await one(
    `UPDATE subscriptions
        SET charge_attempts = charge_attempts + 1, last_charge_at = now(),
            last_charge_error = $2, updated_at = now()
      WHERE account_id = $1
      RETURNING charge_attempts`,
    [accountId, reason]
  );
  if (row && row.charge_attempts >= MAX_CHARGE_ATTEMPTS) {
    await query(`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE account_id = $1`, [accountId]);
  }
}

/** Llamada por la tarea programada diaria. Cobra todos los trials vencidos. */
export async function chargeTrialsDue() {
  const { rows } = await query(
    `SELECT account_id, plan, customer_id, customer_email
       FROM subscriptions
      WHERE status = 'trialing' AND trial_ends_at <= now()`
  );
  const results = [];
  for (const sub of rows) {
    results.push(await chargeOne(sub));
  }
  return results;
}

/* --- Webhook -------------------------------------------------------------
 * Wompi no firma con un header como Stripe: el checksum va dentro del propio
 * JSON, en `event.signature.checksum`, calculado como
 *   sha256( valores de event.data en el orden de event.signature.properties
 *           + event.timestamp + eventsSecret )
 */
export function verifyWebhook(rawBody) {
  const event = typeof rawBody === 'string' || Buffer.isBuffer(rawBody) ? JSON.parse(rawBody) : rawBody;
  const sig = event?.signature;
  if (!sig?.checksum || !Array.isArray(sig?.properties)) {
    throw Object.assign(new Error('Webhook de Wompi sin firma'), { status: 400 });
  }

  const parts = sig.properties.map((path) => getByPath(event.data, path));
  const toHash = parts.join('') + String(event.timestamp) + config.wompi.eventsSecret;
  const expected = crypto.createHash('sha256').update(toHash).digest('hex').toUpperCase();

  if (expected !== String(sig.checksum).toUpperCase()) {
    throw Object.assign(new Error('Firma de webhook de Wompi inválida'), { status: 400 });
  }
  return event;
}

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

export async function handleEvent(event) {
  if (event?.event !== 'transaction.updated') return { ignored: true };

  const tx = event.data?.transaction;
  if (!tx?.id) return { ignored: true };

  const seen = await one('SELECT id FROM billing_events WHERE id = $1', [String(tx.id)]);
  if (seen) return { duplicate: true };
  await query(
    'INSERT INTO billing_events (id, type, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [String(tx.id), event.event, tx]
  );

  const sub = await one('SELECT account_id, plan FROM subscriptions WHERE subscription_id = $1', [String(tx.id)]);
  if (!sub) {
    console.warn(`[billing] webhook de Wompi para transacción ${tx.id} sin cuenta asociada`);
    return { orphan: true };
  }

  if (tx.status === 'APPROVED') {
    await activateAfterCharge(sub.account_id, sub.plan);
  } else if (tx.status === 'DECLINED' || tx.status === 'ERROR' || tx.status === 'VOIDED') {
    await markChargeFailed(sub.account_id, `transacción ${tx.status.toLowerCase()}`);
  }

  console.log(`[billing] wompi: cuenta ${sub.account_id} → transacción ${tx.id} ${tx.status}`);
  return { applied: true, status: tx.status };
}

export async function getStatus(accountId) {
  const row = await one(
    `SELECT status, plan, current_period_end, cancel_at_period_end, trial_ends_at, last_charge_error
       FROM subscriptions WHERE account_id = $1`,
    [accountId]
  );
  return row || { status: 'none', plan: null };
}
