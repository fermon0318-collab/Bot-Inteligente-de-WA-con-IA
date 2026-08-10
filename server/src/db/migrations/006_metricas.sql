-- Atribución: de qué anuncio vino cada contacto.
-- ctwa_clid es el identificador que Meta manda en el campo referral cuando
-- alguien llega por un anuncio "click to WhatsApp".
ALTER TABLE contacts
    ADD COLUMN ctwa_clid    text,
    ADD COLUMN campaign_id  text,
    ADD COLUMN adset_id     text;

CREATE INDEX contacts_ad_idx ON contacts (account_id, ad_id)
    WHERE ad_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Eventos enviados a Conversions API
--
-- Se registran para no duplicar y para poder auditar qué se reportó.
-- --------------------------------------------------------------------------
CREATE TABLE capi_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  event_name     text NOT NULL DEFAULT 'Purchase',
  event_id       text NOT NULL,          -- deduplicación en el lado de Meta
  value          numeric(12,2),
  currency       text,

  status         text NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts       integer NOT NULL DEFAULT 0,
  response       jsonb,
  error          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE UNIQUE INDEX capi_event_id_uniq ON capi_events (account_id, event_id);
CREATE INDEX capi_pending_idx ON capi_events (created_at) WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- Métricas de anuncios traídas de Meta
--
-- Se guardan por día para poder filtrar por rango sin volver a pedirlas.
-- --------------------------------------------------------------------------
CREATE TABLE ad_metrics (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date           date NOT NULL,
  ad_id          text NOT NULL,
  ad_name        text NOT NULL DEFAULT '',
  campaign_id    text,
  campaign_name  text NOT NULL DEFAULT '',
  adset_name     text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT '',

  spend          numeric(12,2) NOT NULL DEFAULT 0,
  impressions    bigint NOT NULL DEFAULT 0,
  clicks         bigint NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'USD',

  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, date, ad_id)
);
