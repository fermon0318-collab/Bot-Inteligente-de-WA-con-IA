/**
 * Adaptador de Stripe.
 *
 * Se usa Checkout alojado y el Customer Portal: los datos de tarjeta nunca
 * pasan por este servidor, así que el alcance de PCI se reduce a SAQ A.
 */

import Stripe from 'stripe';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';

const client = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-12-18.acacia',
  appInfo: { name: 'Elorai', version: '1.0.0' },
  maxNetworkRetries: 2,
});

const PRICES = {
  monthly: config.stripe.priceMonthly,
  yearly: config.stripe.priceYearly,
};

/** Devuelve el customer de Stripe de la cuenta, creándolo si hace falta. */
async function ensureCustomer({ accountId, email, name }) {
  const row = await one('SELECT customer_id FROM subscriptions WHERE account_id = $1', [accountId]);
  if (row?.customer_id) return row.customer_id;

  const customer = await client.customers.create({
    email,
    name,
    // Permite recuperar la cuenta desde el webhook aunque cambie el correo
    metadata: { account_id: accountId },
  });

  await query(
    `INSERT INTO subscriptions (account_id, provider, customer_id)
     VALUES ($1, 'stripe', $2)
     ON CONFLICT (account_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, updated_at = now()`,
    [accountId, customer.id]
  );
  return customer.id;
}

/* --- Alta de suscripción ------------------------------------------------- */
export async function createCheckout({ accountId, email, name, plan, returnUrl }) {
  const price = PRICES[plan];
  if (!price) throw Object.assign(new Error('Plan no válido'), { status: 400, code: 'invalid_plan' });

  const customer = await ensureCustomer({ accountId, email, name });
  const base = returnUrl || config.publicUrl;

  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/dashboard.html?suscripcion=ok&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#precios?suscripcion=cancelada`,
    locale: 'es',
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    // Necesario para declarar el IVA de servicios digitales en LatAm:
    // requiere activar Stripe Tax en el panel de Stripe.
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto', name: 'auto' },
    subscription_data: {
      metadata: { account_id: accountId, plan },
      ...(config.stripe.trialDays > 0 ? { trial_period_days: config.stripe.trialDays } : {}),
    },
    metadata: { account_id: accountId, plan },
  });

  return { url: session.url, id: session.id };
}

/* --- Autogestión del cliente --------------------------------------------- */
export async function createPortal({ accountId, returnUrl }) {
  const row = await one('SELECT customer_id FROM subscriptions WHERE account_id = $1', [accountId]);
  if (!row?.customer_id) {
    throw Object.assign(new Error('Todavía no hay una suscripción que gestionar'), {
      status: 409, code: 'no_customer',
    });
  }
  const session = await client.billingPortal.sessions.create({
    customer: row.customer_id,
    return_url: returnUrl || `${config.publicUrl}/dashboard.html`,
    locale: 'es',
  });
  return { url: session.url };
}

/* --- Webhook -------------------------------------------------------------- */
export function verifyWebhook(rawBody, signature) {
  return client.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

const RELEVANT = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
]);

/**
 * Aplica el evento. Es idempotente: los eventos ya vistos se ignoran, porque
 * Stripe reintenta la entrega y puede repetirlos.
 */
export async function handleEvent(event) {
  if (!RELEVANT.has(event.type)) return { ignored: true };

  const seen = await one('SELECT id FROM billing_events WHERE id = $1', [event.id]);
  if (seen) return { duplicate: true };

  await query(
    'INSERT INTO billing_events (id, type, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [event.id, event.type, event.data.object]
  );

  const object = event.data.object;
  let subscriptionId = null;

  if (event.type === 'checkout.session.completed') {
    subscriptionId = object.subscription;
  } else if (event.type.startsWith('customer.subscription.')) {
    subscriptionId = object.id;
  } else if (event.type.startsWith('invoice.')) {
    subscriptionId = object.subscription;
  }

  if (!subscriptionId) return { ignored: true };

  // Se relee la suscripción en lugar de fiarse del payload: los eventos pueden
  // llegar desordenados y esto garantiza guardar el estado actual.
  const sub = await client.subscriptions.retrieve(subscriptionId);
  const accountId = sub.metadata?.account_id || (await accountIdFromCustomer(sub.customer));
  if (!accountId) {
    console.warn(`[billing] evento ${event.id} sin cuenta asociada (customer ${sub.customer})`);
    return { orphan: true };
  }

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id || null;
  const plan = priceId === PRICES.yearly ? 'yearly' : priceId === PRICES.monthly ? 'monthly' : null;

  await query(
    `INSERT INTO subscriptions
       (account_id, provider, customer_id, subscription_id, price_id, plan,
        status, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, 'stripe', $2, $3, $4, $5, $6, to_timestamp($7), $8, now())
     ON CONFLICT (account_id) DO UPDATE SET
       customer_id = EXCLUDED.customer_id,
       subscription_id = EXCLUDED.subscription_id,
       price_id = EXCLUDED.price_id,
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = now()`,
    [
      accountId, sub.customer, sub.id, priceId, plan,
      sub.status, sub.current_period_end, sub.cancel_at_period_end,
    ]
  );

  console.log(`[billing] cuenta ${accountId} → ${sub.status}${plan ? ` (${plan})` : ''}`);
  return { applied: true, status: sub.status };
}

async function accountIdFromCustomer(customerId) {
  const row = await one('SELECT account_id FROM subscriptions WHERE customer_id = $1', [customerId]);
  if (row) return row.account_id;
  try {
    const customer = await client.customers.retrieve(customerId);
    return customer?.metadata?.account_id || null;
  } catch {
    return null;
  }
}

/** Estado actual para pintarlo en el panel. */
export async function getStatus(accountId) {
  const row = await one(
    `SELECT status, plan, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE account_id = $1`,
    [accountId]
  );
  return { provider: 'stripe', ...(row || { status: 'none', plan: null }) };
}

/* --- Facturación autogestionada ------------------------------------------
 * Con Stripe esto también está en el Customer Portal, pero el panel de Elorai
 * ofrece las mismas acciones sin salir del sitio.
 */
export async function listInvoices(accountId, { limit = 50 } = {}) {
  const row = await one('SELECT customer_id FROM subscriptions WHERE account_id = $1', [accountId]);
  if (!row?.customer_id) return [];

  const list = await client.invoices.list({ customer: row.customer_id, limit });
  return list.data.map((inv) => ({
    id: inv.id,
    transaction_id: inv.number || inv.id,
    amount_cents: inv.amount_paid ?? inv.amount_due,
    currency: (inv.currency || 'usd').toUpperCase(),
    plan: inv.lines?.data?.[0]?.price?.id === PRICES.yearly ? 'yearly' : 'monthly',
    status: inv.status === 'paid' ? 'APPROVED' : String(inv.status || '').toUpperCase(),
    period_start: inv.period_start ? new Date(inv.period_start * 1000) : null,
    period_end: inv.period_end ? new Date(inv.period_end * 1000) : null,
    created_at: new Date(inv.created * 1000),
    pdf_url: inv.invoice_pdf || null,
  }));
}

async function setCancelAtPeriodEnd(accountId, value) {
  const row = await one('SELECT subscription_id FROM subscriptions WHERE account_id = $1', [accountId]);
  if (!row?.subscription_id) {
    throw Object.assign(new Error('No hay una suscripción que gestionar'), { status: 409, code: 'no_subscription' });
  }
  const sub = await client.subscriptions.update(row.subscription_id, { cancel_at_period_end: value });
  await query(
    'UPDATE subscriptions SET cancel_at_period_end = $2, updated_at = now() WHERE account_id = $1',
    [accountId, sub.cancel_at_period_end]
  );
  return {
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    current_period_end: new Date(sub.current_period_end * 1000),
  };
}

export const cancelSubscription = (accountId) => setCancelAtPeriodEnd(accountId, true);
export const resumeSubscription = (accountId) => setCancelAtPeriodEnd(accountId, false);

/** Cambia de plan mensual ↔ anual. Stripe prorratea el saldo automáticamente. */
export async function changePlan(accountId, plan) {
  const price = PRICES[plan];
  if (!price) throw Object.assign(new Error('Plan no válido'), { status: 400, code: 'invalid_plan' });

  const row = await one('SELECT subscription_id FROM subscriptions WHERE account_id = $1', [accountId]);
  if (!row?.subscription_id) {
    throw Object.assign(new Error('No hay una suscripción que cambiar'), { status: 409, code: 'no_subscription' });
  }

  const current = await client.subscriptions.retrieve(row.subscription_id);
  const item = current.items.data[0];
  const sub = await client.subscriptions.update(row.subscription_id, {
    items: [{ id: item.id, price }],
    proration_behavior: 'create_prorations',
  });

  await query(
    'UPDATE subscriptions SET plan = $2, price_id = $3, updated_at = now() WHERE account_id = $1',
    [accountId, plan, price]
  );
  return { status: sub.status, plan, effective: 'immediate' };
}
