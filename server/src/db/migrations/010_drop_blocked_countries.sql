-- ============================================================================
-- Retira "Bloqueo por País" por completo: sin negocios activos usándolo,
-- se elimina en vez de dejarlo huérfano en el backend. Sustituido por Agenda.
-- ============================================================================

DROP TABLE IF EXISTS blocked_countries;
