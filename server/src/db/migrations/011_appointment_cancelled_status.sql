-- ============================================================================
-- Agrega el estado "cancelada": hasta ahora la única forma de quitar una cita
-- era borrarla, perdiendo el historial de cancelaciones/ausencias.
-- ============================================================================

ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('reservado','confirmado','asiste','no_asistio','pendiente','en_espera','cancelada'));
