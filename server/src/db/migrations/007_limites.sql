-- Tope diario de respuestas de IA por cuenta: un cliente con un bucle mal
-- configurado (o un contacto que le hace preguntas a un bot en bucle) puede
-- quemar su presupuesto de IA en horas si nadie lo frena.
ALTER TABLE bot_settings
    ADD COLUMN ai_daily_limit integer NOT NULL DEFAULT 500;

CREATE TABLE ai_usage (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date        date NOT NULL DEFAULT current_date,
  calls       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, date)
);
