-- ============================================================================
-- Elorai · esquema inicial
--
-- Cada cliente es una "cuenta" (account). Un usuario pertenece a una cuenta.
-- Todo lo que genera el bot cuelga de account_id, para que añadir equipos más
-- adelante no obligue a rehacer las tablas.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Cuentas y usuarios
-- --------------------------------------------------------------------------

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email           text NOT NULL UNIQUE,
  name            text NOT NULL DEFAULT '',
  avatar_url      text NOT NULL DEFAULT '',
  google_sub      text UNIQUE,             -- identificador estable de Google
  role            text NOT NULL DEFAULT 'owner',
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_account_idx ON users(account_id);

-- Sesiones en base de datos: permite cerrar sesión de verdad y revocar accesos.
CREATE TABLE sessions (
  id              text PRIMARY KEY,        -- id aleatorio, va firmado en la cookie
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent      text NOT NULL DEFAULT '',
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Estado transitorio del flujo OAuth (state + PKCE verifier).
CREATE TABLE oauth_states (
  state           text PRIMARY KEY,
  code_verifier   text NOT NULL,
  redirect_to     text NOT NULL DEFAULT '/dashboard.html',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

-- --------------------------------------------------------------------------
-- Suscripciones
-- --------------------------------------------------------------------------

CREATE TABLE subscriptions (
  account_id             uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider               text NOT NULL DEFAULT 'stripe',
  customer_id            text,
  subscription_id        text,
  price_id               text,
  plan                   text,             -- 'monthly' | 'yearly'
  -- trialing | active | past_due | canceled | incomplete | unpaid | none
  status                 text NOT NULL DEFAULT 'none',
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX subscriptions_subscription_idx ON subscriptions(subscription_id);

-- Eventos de Stripe ya procesados: hace el webhook idempotente ante reintentos.
CREATE TABLE billing_events (
  id              text PRIMARY KEY,        -- id del evento en el proveedor
  type            text NOT NULL,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Configuración del bot
--
-- Un único registro por cuenta. Las credenciales se guardan cifradas con
-- AES-256-GCM desde la aplicación: la base nunca ve el texto claro.
-- --------------------------------------------------------------------------

CREATE TABLE bot_settings (
  account_id            uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,

  -- WhatsApp Cloud API
  wa_phone_number_id    text NOT NULL DEFAULT '',
  wa_business_id        text NOT NULL DEFAULT '',
  wa_display_phone      text NOT NULL DEFAULT '',
  wa_token_enc          text,                       -- cifrado
  wa_verify_token       text NOT NULL DEFAULT '',
  wa_connected          boolean NOT NULL DEFAULT false,
  bot_running           boolean NOT NULL DEFAULT false,

  -- Inteligencia artificial
  ai_enabled            boolean NOT NULL DEFAULT true,
  ai_model              text NOT NULL DEFAULT 'claude-sonnet-5',
  ai_key_enc            text,                       -- cifrado
  ai_delay_seconds      integer NOT NULL DEFAULT 15,
  ai_prompt             text NOT NULL DEFAULT '',

  -- Meta Ads y Conversions API
  ads_account_id        text NOT NULL DEFAULT '',
  ads_token_enc         text,                       -- cifrado
  capi_pixel_id         text NOT NULL DEFAULT '',
  capi_currency         text NOT NULL DEFAULT 'USD',
  capi_enabled          boolean NOT NULL DEFAULT false,

  -- Pagos y acceso
  pay_message_ok        text NOT NULL DEFAULT '',
  pay_message_invalid   text NOT NULL DEFAULT '',
  pay_post_flow_id      text,

  -- Remarketing
  rm_hours              integer NOT NULL DEFAULT 24,
  rm_minutes            integer NOT NULL DEFAULT 0,
  rm_window_start       time NOT NULL DEFAULT '09:00',
  rm_window_end         time NOT NULL DEFAULT '21:00',
  rm_timezone           text NOT NULL DEFAULT 'America/Mexico_City',

  currency              text NOT NULL DEFAULT 'USD',
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocked_countries (
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  country_code    text NOT NULL,
  dial_prefix     text NOT NULL,
  PRIMARY KEY (account_id, country_code)
);

-- --------------------------------------------------------------------------
-- Automatización
-- --------------------------------------------------------------------------

CREATE TABLE flows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL,            -- 'simple' | 'advanced'
  name            text NOT NULL,
  steps           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- flujos simples
  tree            jsonb,                                -- flujos avanzados
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX flows_account_idx ON flows(account_id, kind);

CREATE TABLE triggers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind            text NOT NULL DEFAULT 'simple',
  keyword         text NOT NULL,
  flow_id         uuid REFERENCES flows(id) ON DELETE SET NULL,
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX triggers_account_idx ON triggers(account_id, kind);
CREATE UNIQUE INDEX triggers_keyword_uniq ON triggers(account_id, kind, lower(keyword));

CREATE TABLE remarketing_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  step_type       text NOT NULL,            -- 'text' | 'file' | 'delay'
  value           text NOT NULL DEFAULT ''
);

CREATE INDEX remarketing_account_idx ON remarketing_steps(account_id, position);

CREATE TABLE access_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount          text NOT NULL DEFAULT '',
  context         text NOT NULL DEFAULT '',
  message         text NOT NULL DEFAULT '',
  files           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quick_replies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  keyword         text NOT NULL,
  reply           text NOT NULL DEFAULT ''
);

CREATE TABLE media_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  file_type       text NOT NULL DEFAULT 'other',
  size_bytes      bigint NOT NULL DEFAULT 0,
  storage_path    text NOT NULL DEFAULT '',
  wa_media_id     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_account_idx ON media_files(account_id);

-- --------------------------------------------------------------------------
-- Contactos y conversaciones
-- --------------------------------------------------------------------------

CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone           text NOT NULL,
  name            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'new',    -- new | pending | paid | rejected
  source          text NOT NULL DEFAULT '',
  ad_name         text,
  ad_id           text,
  amount          numeric(12,2) NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  ai_enabled      boolean NOT NULL DEFAULT true,
  paid_at         timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, phone)
);

CREATE INDEX contacts_account_status_idx ON contacts(account_id, status);
CREATE INDEX contacts_last_message_idx ON contacts(account_id, last_message_at DESC);

CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction       text NOT NULL,            -- 'in' | 'out' | 'bot'
  body            text NOT NULL DEFAULT '',
  media_url       text,
  wa_message_id   text,
  status          text NOT NULL DEFAULT 'sent',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_contact_idx ON messages(contact_id, created_at);
CREATE INDEX messages_account_idx ON messages(account_id, created_at DESC);
CREATE UNIQUE INDEX messages_wa_id_uniq ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL;

-- Búsqueda de texto en el histórico
CREATE INDEX messages_body_search_idx ON messages USING gin (to_tsvector('spanish', body));

-- --------------------------------------------------------------------------
-- Registro de actividad (terminal de Cloud API)
-- --------------------------------------------------------------------------

CREATE TABLE activity_log (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  level           text NOT NULL DEFAULT 'info',   -- info | ok | warn | err
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_account_idx ON activity_log(account_id, created_at DESC);
