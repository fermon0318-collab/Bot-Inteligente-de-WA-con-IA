-- --------------------------------------------------------------------------
-- Comprobantes recibidos
--
-- Se guarda cada intento, válido o no. Sin esta tabla no hay forma de resolver
-- una disputa ni de detectar a quien reenvía el mismo comprobante dos veces.
-- --------------------------------------------------------------------------
CREATE TABLE payment_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id      bigint REFERENCES messages(id) ON DELETE SET NULL,

  wa_media_id     text,
  storage_path    text,
  mime_type       text NOT NULL DEFAULT '',

  -- Lo que se extrajo del comprobante
  amount          numeric(12,2),
  currency        text,
  reference       text,
  paid_at         timestamptz,
  bank            text,
  raw_extraction  jsonb,
  confidence      real,

  -- pending | valid | invalid | duplicate | manual_review
  status          text NOT NULL DEFAULT 'pending',
  rule_id         uuid REFERENCES access_rules(id) ON DELETE SET NULL,
  reason          text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX receipts_account_idx ON payment_receipts (account_id, created_at DESC);
CREATE INDEX receipts_contact_idx ON payment_receipts (contact_id);

-- La misma referencia bancaria no puede valer dos veces en la misma cuenta.
-- Es la defensa contra el reenvío del comprobante de otra persona.
CREATE UNIQUE INDEX receipts_reference_uniq
    ON payment_receipts (account_id, lower(reference))
    WHERE reference IS NOT NULL AND status = 'valid';

-- Tolerancia por regla: un pago de 89.00 y otro de 89.50 pueden ser el mismo
-- producto si el banco cobró comisión.
ALTER TABLE access_rules
    ADD COLUMN currency   text NOT NULL DEFAULT 'MXN',
    ADD COLUMN tolerance  numeric(12,2) NOT NULL DEFAULT 0;

-- Cuándo se entregó el producto, para no entregarlo dos veces
ALTER TABLE contacts
    ADD COLUMN delivered_at   timestamptz,
    ADD COLUMN delivered_rule uuid REFERENCES access_rules(id) ON DELETE SET NULL;
