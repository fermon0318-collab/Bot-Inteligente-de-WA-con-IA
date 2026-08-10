-- ============================================================================
-- 1. Limpieza de cuentas de prueba: solo sobrevive eloraibot@gmail.com.
-- 2. Historial de facturas real, para el módulo de Facturación del panel.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Borrado de cuentas
--
-- Todas las tablas del esquema cuelgan de accounts con ON DELETE CASCADE, así
-- que borrar la cuenta se lleva conversaciones, agenda, flujos y credenciales.
--
-- El guardarraíl importa: si la cuenta que hay que conservar todavía no existe
-- (nadie entró con ese correo), NO se borra nada. Sin esta condición, un
-- despliegue sobre una base donde ese correo aún no ha iniciado sesión
-- vaciaría el sistema entero.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  keeper uuid;
  borradas int;
BEGIN
  SELECT account_id INTO keeper
    FROM users
   WHERE lower(email) = 'eloraibot@gmail.com'
   LIMIT 1;

  IF keeper IS NULL THEN
    RAISE NOTICE '[013] eloraibot@gmail.com no existe todavía: no se borra ninguna cuenta.';
  ELSE
    DELETE FROM accounts WHERE id <> keeper;
    GET DIAGNOSTICS borradas = ROW_COUNT;
    RAISE NOTICE '[013] cuentas eliminadas: % (conservada: %)', borradas, keeper;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Facturas
--
-- Wompi no guarda "facturas": cada cobro es una transacción suelta. Esta tabla
-- es nuestro propio historial, lo que el usuario ve en Configuración →
-- Facturación y lo que sustenta cualquier reclamo de cobro.
--
-- Se escribe una fila por INTENTO de cobro (aprobado o no), porque un cobro
-- rechazado también es información que el cliente necesita ver.
-- --------------------------------------------------------------------------
CREATE TABLE billing_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'wompi',
  -- id de la transacción en la pasarela; único para que un webhook reenviado
  -- no duplique la factura
  transaction_id  text UNIQUE,
  amount_cents    bigint NOT NULL,
  currency        text NOT NULL DEFAULT 'COP',
  plan            text,
  status          text NOT NULL,          -- APPROVED | DECLINED | ERROR | VOIDED | PENDING
  period_start    timestamptz,
  period_end      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX billing_invoices_account_idx ON billing_invoices(account_id, created_at DESC);
