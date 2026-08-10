-- ============================================================================
-- Onboarding: datos de negocio recogidos después del primer login con Google.
-- Una fila por cuenta (no por usuario): si más adelante hay varios usuarios
-- en la misma cuenta, el onboarding no se repite para el segundo.
-- ============================================================================

CREATE TABLE business_profile (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  business_type   text NOT NULL,
  team_size       text NOT NULL,
  full_name       text NOT NULL,
  phone_country   text NOT NULL,
  phone_number    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
