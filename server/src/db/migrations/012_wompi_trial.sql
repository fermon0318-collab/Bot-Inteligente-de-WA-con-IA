-- ============================================================================
-- Soporte para el ciclo real de prueba gratuita + cobro con Wompi.
--
-- Wompi no tiene "suscripción con trial" como Stripe: nosotros llevamos la
-- cuenta de los 7 días y disparamos el cobro nosotros mismos (ver
-- services/trialBilling.js). Las columnas genéricas ya existentes se
-- reutilizan así:
--   customer_id     → id del payment source de Wompi (tarjeta tokenizada)
--   subscription_id → id de la última transacción de Wompi
-- ============================================================================

ALTER TABLE subscriptions
  ADD COLUMN trial_ends_at    timestamptz,
  ADD COLUMN charge_attempts  int NOT NULL DEFAULT 0,
  ADD COLUMN last_charge_at   timestamptz,
  ADD COLUMN last_charge_error text,
  -- Se guarda aparte (en vez de un JOIN a users) porque el correo de cobro
  -- de Wompi debe quedar fijo aunque el usuario dueño de la cuenta cambie.
  ADD COLUMN customer_email   text;

CREATE INDEX subscriptions_trial_due_idx ON subscriptions(trial_ends_at)
  WHERE status = 'trialing';
