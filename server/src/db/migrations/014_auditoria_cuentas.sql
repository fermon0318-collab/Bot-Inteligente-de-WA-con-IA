-- ============================================================================
-- Auditoría (SOLO LECTURA) del resultado de la migración 013.
--
-- 013 borra cuentas solo si eloraibot@gmail.com ya existe. Desde fuera no hay
-- forma de saber cuál de los dos caminos tomó, así que esta migración deja el
-- estado real escrito en los logs del despliegue: cuántas cuentas quedan, qué
-- correos hay y si la cuenta a conservar llegó a existir.
--
-- No modifica absolutamente nada.
-- ============================================================================

DO $$
DECLARE
  total_cuentas   int;
  total_usuarios  int;
  correos         text;
  keeper_existe   boolean;
BEGIN
  SELECT count(*) INTO total_cuentas  FROM accounts;
  SELECT count(*) INTO total_usuarios FROM users;
  SELECT string_agg(email, ', ' ORDER BY email) INTO correos FROM users;
  SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'eloraibot@gmail.com')
    INTO keeper_existe;

  RAISE NOTICE '[014] cuentas=% usuarios=%', total_cuentas, total_usuarios;
  RAISE NOTICE '[014] correos registrados: %', coalesce(correos, '(ninguno)');
  RAISE NOTICE '[014] eloraibot@gmail.com presente: %', keeper_existe;

  IF NOT keeper_existe AND total_cuentas > 0 THEN
    RAISE NOTICE '[014] ATENCION: la limpieza de 013 no se ejecuto porque eloraibot@gmail.com nunca inicio sesion. Las cuentas siguen intactas.';
  END IF;
END $$;
