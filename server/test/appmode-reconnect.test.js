/**
 * Integración: reconexión de Modo App tras escanear el QR.
 *
 * Necesita Postgres con las migraciones aplicadas (DATABASE_URL) y el flag
 * de mocks de módulos de Node 22:
 *
 *   node --experimental-test-module-mocks --test test/appmode-reconnect.test.js
 *
 * Sin el flag o sin base de datos se salta sola, para que `npm test` siga
 * funcionando en cualquier máquina.
 */
import './setup.js';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

/* Baileys falso: cada makeWASocket() es un "dispositivo" que se puede manejar
   a mano desde la prueba, igual que lo haría WhatsApp. */
const sockets = [];
const RESTART_REQUIRED = 515;

const fakeBaileys = {
  makeWASocket() {
    const ev = new EventEmitter();
    const socket = { ev, user: null, end() {}, logout: async () => {} };
    sockets.push(socket);
    return socket;
  },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  makeCacheableSignalKeyStore: (keys) => keys,
  Browsers: { appropriate: () => ['Elorai', 'Desktop', '1.0'] },
  DisconnectReason: {
    loggedOut: 401, badSession: 500, forbidden: 403,
    connectionReplaced: 440, restartRequired: RESTART_REQUIRED,
  },
  initAuthCreds: () => ({ me: null }),
  BufferJSON: { replacer: (_k, v) => v, reviver: (_k, v) => v },
  proto: { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } },
};
const puedeMockear = typeof mock.module === 'function';
if (puedeMockear) mock.module('baileys', { defaultExport: fakeBaileys, namedExports: fakeBaileys });

const { pool, one } = await import('../src/db/pool.js');
const session = await import('../src/wa/app/session.js');

const hayBase = puedeMockear && await pool.query('SELECT 1 FROM wa_app_sessions LIMIT 1').then(() => true, () => false);
const motivoSalto = !puedeMockear
  ? 'requiere node --experimental-test-module-mocks'
  : !hayBase ? 'requiere Postgres con las migraciones aplicadas (DATABASE_URL)' : false;

test.after(() => pool.end());

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function hasta(cond, ms = 6000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return true;
    await esperar(50);
  }
  return false;
}

test('tras escanear el QR (cierre 515) la sesión reconecta y queda vinculada', { skip: motivoSalto }, async () => {
  const { id: accountId } = await one(`INSERT INTO accounts (name) VALUES ('qr-reconnect') RETURNING id`);
  await one('INSERT INTO wa_app_sessions (account_id) VALUES ($1) RETURNING account_id', [accountId]); // lo hace el alta

  await session.connect(accountId);
  assert.equal(sockets.length, 1);
  const primero = sockets[0];

  // WhatsApp muestra un QR…
  primero.ev.emit('connection.update', { qr: '2@fake-qr-payload' });
  assert.ok(await hasta(async () => (await session.getSessionRow(accountId))?.qr_png));

  // …el teléfono lo escanea y WhatsApp cierra con 515: "reconecta ya".
  const err = Object.assign(new Error('Stream Errored (restart required)'), {
    output: { statusCode: RESTART_REQUIRED },
  });
  primero.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: err } });

  // La reconexión espera 2 s (primer intento): debe abrir un socket NUEVO.
  assert.ok(await hasta(() => sockets.length === 2), 'la reconexión nunca abrió un socket nuevo');

  const segundo = sockets[1];
  segundo.user = { id: '573001112233:7@s.whatsapp.net', name: 'Prueba' };
  segundo.ev.emit('connection.update', { connection: 'open' });

  assert.ok(await hasta(async () => (await session.getSessionRow(accountId))?.status === 'connected'));
  const fila = await session.getSessionRow(accountId);
  assert.equal(fila.display_phone, '+573001112233');

  await session.disconnect(accountId);
});
