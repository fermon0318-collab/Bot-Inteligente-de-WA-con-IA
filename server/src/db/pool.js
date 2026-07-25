/**
 * Pool de PostgreSQL y helpers de consulta.
 */

import pg from 'pg';
import { config } from '../config.js';

// Los numeric vuelven como string por defecto para no perder precisión.
// En este esquema son importes acotados, así que convertirlos a número es seguro
// y evita sorpresas al sumarlos en JavaScript.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// bigint: los ids de mensaje caben de sobra en Number.MAX_SAFE_INTEGER
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.db.connectionString,
  ssl: config.db.ssl,
  max: config.db.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] error en cliente inactivo:', err.message);
});

/** Ejecuta una consulta y devuelve el resultado completo. */
export const query = (text, params) => pool.query(text, params);

/** Devuelve la primera fila o null. */
export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

/** Devuelve todas las filas. */
export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Ejecuta `fn` dentro de una transacción, con rollback automático si falla. */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
