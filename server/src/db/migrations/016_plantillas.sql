-- ============================================================================
-- Plantillas de WhatsApp y recordatorios de la Agenda.
--
-- Pasadas 24 h desde el último mensaje del cliente, Meta RECHAZA cualquier
-- texto libre: el mensaje no llega y el cliente nunca se entera. La única
-- forma de escribir primero es una plantilla que Meta aprobó antes.
--
-- Meta identifica la plantilla por su NOMBRE exacto dentro de la WABA de cada
-- cuenta, así que aquí no se guarda "la plantilla" (esa vive en Meta) sino la
-- referencia a ella: cómo se llama, en qué idioma y cuántas variables espera,
-- para poder pedirle esos datos al operador y mandarlas en el orden correcto.
-- ============================================================================

CREATE TABLE wa_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nombre EXACTO tal como quedó aprobado en Meta (minúsculas y guiones bajos)
  name          text NOT NULL,
  language      text NOT NULL DEFAULT 'es',
  category      text NOT NULL DEFAULT 'UTILITY',
  -- Copia del texto aprobado, solo para previsualizar en el panel. Lo que
  -- Meta envía de verdad es lo que tiene registrado, no esto.
  body          text NOT NULL DEFAULT '',
  -- Cuántos {{n}} tiene el cuerpo, y cómo se le pide cada uno al operador
  -- (["Nombre del cliente", "Fecha"]) para no mostrar "Variable 1".
  variables     int NOT NULL DEFAULT 0,
  var_labels    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Una plantilla es única por nombre+idioma dentro de la cuenta, igual que
  -- en Meta: el mismo nombre puede existir en español y en inglés.
  UNIQUE (account_id, name, language)
);

CREATE INDEX wa_templates_account_idx ON wa_templates(account_id);

-- --------------------------------------------------------------------------
-- Recordatorios automáticos de citas
-- --------------------------------------------------------------------------
ALTER TABLE bot_settings
  ADD COLUMN reminder_enabled     boolean NOT NULL DEFAULT false,
  -- Cuántas horas antes de la cita se avisa
  ADD COLUMN reminder_hours       int NOT NULL DEFAULT 24,
  -- Plantilla a usar. ON DELETE SET NULL: si se borra la plantilla, los
  -- recordatorios se apagan solos en vez de fallar en cada intento.
  ADD COLUMN reminder_template_id uuid REFERENCES wa_templates(id) ON DELETE SET NULL;

ALTER TABLE appointments
  -- Marca de "ya se avisó": sin esto, el trabajador reenviaría el mismo
  -- recordatorio en cada pasada hasta que llegara la hora de la cita.
  ADD COLUMN reminder_sent_at timestamptz;

-- Índice pensado para la consulta del trabajador: citas próximas sin avisar.
CREATE INDEX appointments_reminder_idx ON appointments(account_id, starts_at)
  WHERE reminder_sent_at IS NULL;
