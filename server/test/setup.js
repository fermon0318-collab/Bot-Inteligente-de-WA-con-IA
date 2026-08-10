/**
 * Se importa primero en cada archivo de prueba.
 *
 * config.js exige variables de entorno reales y mata el proceso si faltan —
 * correcto en producción, incómodo en pruebas que solo tocan funciones puras.
 * Estos valores nunca se usan de verdad: ninguna prueba abre una conexión.
 */
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.PUBLIC_URL ||= 'http://localhost:3000';
process.env.SESSION_SECRET ||= '0'.repeat(64);
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.BILLING_PROVIDER ||= 'none';
