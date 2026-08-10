-- ============================================================================
-- Elorai · motor del bot
--
-- Tres piezas nuevas:
--   · outbox     cola de envíos con reintentos — nada se envía en caliente
--   · flow_runs  posición de cada contacto dentro de un flujo con ramas
--   · wa_events  eventos crudos de Meta, para depurar y para no perder nada
-- ============================================================================

-- El webhook llega con phone_number_id y hay que resolver la cuenta al vuelo.
CREATE UNIQUE INDEX bot_settings_phone_number_idx
    ON bot_settings (wa_phone_number_id)
    WHERE wa_phone_number_id <> '';

-- El token de verificación identifica la cuenta durante el alta del webhook.
CREATE INDEX bot_settings_verify_token_idx ON bot_settings (wa_verify_token);

-- --------------------------------------------------------------------------
-- Ventana de 24 horas
--
-- Meta solo permite mensajes libres dentro de las 24 h siguientes al último
-- mensaje del contacto. Fuera de esa ventana hace falta plantilla aprobada.
-- --------------------------------------------------------------------------
ALTER TABLE contacts
    ADD COLUMN last_inbound_at  timestamptz,
    ADD COLUMN profile_name     text NOT NULL DEFAULT '',
    ADD COLUMN automation_off   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN contacts.automation_off IS
  'El operador detuvo flujos y remarketing para este contacto desde el panel';

-- --------------------------------------------------------------------------
-- Cola de envíos
--
-- Todo lo que sale hacia WhatsApp pasa por aquí: las pausas de un flujo son
-- una fecha futura en scheduled_at, y un fallo de la Graph API es un reintento
-- con espera creciente en vez de un mensaje perdido.
-- --------------------------------------------------------------------------
CREATE TABLE outbox (
  id             bigserial PRIMARY KEY,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  kind           text NOT NULL DEFAULT 'text',   -- text | media | template
  body           text NOT NULL DEFAULT '',
  media_name     text,                            -- nombre en media_files
  payload        jsonb,                           -- cuerpo ya listo para Meta

  origin         text NOT NULL DEFAULT 'flow',    -- flow | ai | manual | remarketing
  status         text NOT NULL DEFAULT 'pending', -- pending | sent | failed | canceled
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,

  scheduled_at   timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  wa_message_id  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- El trabajador busca exactamente por esto: pendientes cuya hora ya llegó.
CREATE INDEX outbox_due_idx ON outbox (scheduled_at)
    WHERE status = 'pending';
CREATE INDEX outbox_contact_idx ON outbox (contact_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Ejecución de flujos con ramas
--
-- Un flujo avanzado se detiene en cada nodo de condición a esperar la
-- respuesta del contacto. Aquí se guarda dónde se quedó.
-- --------------------------------------------------------------------------
CREATE TABLE flow_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  flow_id        uuid REFERENCES flows(id) ON DELETE CASCADE,

  -- Ruta de índices dentro del árbol: [0,2,1] = hijo 0 → hijo 2 → hijo 1
  node_path      integer[] NOT NULL DEFAULT '{}',
  -- waiting: detenido en una condición · running · done | canceled
  status         text NOT NULL DEFAULT 'running',

  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flow_runs_waiting_idx ON flow_runs (contact_id)
    WHERE status = 'waiting';

-- --------------------------------------------------------------------------
-- Eventos crudos de Meta
--
-- Se guardan antes de procesarlos: si el motor falla, el evento no se pierde y
-- se puede reprocesar. También sirve para entender qué mandó Meta de verdad
-- cuando algo no cuadra.
-- --------------------------------------------------------------------------
CREATE TABLE wa_events (
  id             bigserial PRIMARY KEY,
  account_id     uuid REFERENCES accounts(id) ON DELETE CASCADE,
  wa_message_id  text,
  event_type     text NOT NULL DEFAULT 'message',
  payload        jsonb NOT NULL,
  processed_at   timestamptz,
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wa_events_unprocessed_idx ON wa_events (received_at)
    WHERE processed_at IS NULL;
CREATE UNIQUE INDEX wa_events_message_uniq ON wa_events (wa_message_id)
    WHERE wa_message_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Estado de entrega de los mensajes salientes
-- --------------------------------------------------------------------------
ALTER TABLE messages
    ADD COLUMN delivered_at timestamptz,
    ADD COLUMN read_at      timestamptz,
    ADD COLUMN failed_at    timestamptz,
    ADD COLUMN error        text;
