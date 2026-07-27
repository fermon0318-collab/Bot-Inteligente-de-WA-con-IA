-- ============================================================================
-- Agenda de citas: profesionales, clientes, servicios, bloqueos y reservas.
-- Todo cuelga de account_id, igual que el resto del esquema — así el bot y el
-- panel comparten la misma fuente de verdad para saber qué horas están libres.
-- ============================================================================

CREATE TABLE professionals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX professionals_account_idx ON professionals(account_id);

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clients_account_idx ON clients(account_id);
CREATE INDEX clients_account_name_idx ON clients(account_id, lower(name));
-- Un mismo teléfono no debería crear dos clientes distintos en la misma cuenta
-- (el bot identifica al cliente por su número de WhatsApp).
CREATE UNIQUE INDEX clients_account_phone_uidx ON clients(account_id, phone) WHERE phone <> '';

CREATE TABLE services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  duration_min    int NOT NULL DEFAULT 30,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_account_idx ON services(account_id);

CREATE TABLE schedule_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  label           text NOT NULL DEFAULT '',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX blocks_account_prof_range_idx ON schedule_blocks(account_id, professional_id, starts_at, ends_at);

CREATE TABLE appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'reservado'
                  CHECK (status IN ('reservado','confirmado','asiste','no_asistio','pendiente','en_espera')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  -- 'dashboard' = creada a mano por el negocio · 'bot' = agendada por la IA de WhatsApp
  source          text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard','bot')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX appointments_account_prof_range_idx ON appointments(account_id, professional_id, starts_at, ends_at);
CREATE INDEX appointments_client_idx ON appointments(client_id);
