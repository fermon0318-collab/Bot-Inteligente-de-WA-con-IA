/**
 * Migrador mínimo: aplica en orden los .sql de ./migrations que no estén
 * registrados todavía, cada uno dentro de su propia transacción.
 *
 *   npm run migrate
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    // Los RAISE NOTICE de una migración se pierden si nadie los escucha, y son
    // justo lo que hace falta para auditar en los logs qué tocó una migración
    // destructiva (cuántas filas borró, sobre qué cuenta).
    const onNotice = (msg) => console.log(`  ${msg.message}`);
    client.on('notice', onNotice);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`✗ ${file}: ${err.message}`);
      process.exitCode = 1;
      return;
    } finally {
      client.off('notice', onNotice);
      client.release();
    }
  }

  console.log(count ? `\n${count} migración(es) aplicada(s).` : 'Base de datos al día.');
}

run()
  .catch((err) => {
    console.error('Error al migrar:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
