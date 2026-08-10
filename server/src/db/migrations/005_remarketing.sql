-- Registro de envíos: sin esto, cada pasada volvería a escribirle al mismo
-- contacto y acabarías con el número bloqueado por Meta.
CREATE TABLE remarketing_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  steps_queued  integer NOT NULL DEFAULT 0,
  sent_at       timestamptz NOT NULL DEFAULT now()
);

-- Un contacto, un remarketing. Si algún día quieres varias secuencias, esto
-- pasa a ser (account_id, contact_id, sequence_id).
CREATE UNIQUE INDEX remarketing_once_idx ON remarketing_sends (account_id, contact_id);

-- Interruptor por cuenta: hoy no hay forma de apagarlo sin borrar los pasos
ALTER TABLE bot_settings
    ADD COLUMN rm_enabled boolean NOT NULL DEFAULT false;
