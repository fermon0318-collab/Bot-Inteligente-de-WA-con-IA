/**
 * Estado de autenticación de Modo App, guardado en PostgreSQL y cifrado.
 *
 * Baileys trae `useMultiFileAuthState`, que escribe un directorio de ficheros
 * JSON. No sirve para lo nuestro por dos motivos:
 *
 *   · el disco del contenedor es efímero (en Railway se borra en cada
 *     despliegue), y perder este estado significa pedirle otro QR al cliente
 *     — justo la fricción que Modo App existe para evitar;
 *   · son claves privadas de Signal en texto plano dentro del contenedor.
 *
 * Aquí cada clave va como una fila cifrada con AES-256-GCM (la misma
 * `ENCRYPTION_KEY` que protege los tokens de Meta). Se trocea por clave en vez
 * de guardar un único blob porque Baileys escribe claves sueltas
 * constantemente: reescribir el estado entero en cada mensaje sería un UPDATE
 * de megabytes por mensaje.
 *
 * ⚠️  Si se pierde ENCRYPTION_KEY, estas sesiones son irrecuperables y todos
 *     los clientes de Modo App tendrán que volver a escanear el QR.
 */

import { many, one, query, transaction } from '../../db/pool.js';
import { decrypt, encrypt } from '../../lib/crypto.js';

/**
 * Devuelve `{ state, saveCreds }` con la forma exacta que espera
 * `makeWASocket({ auth })`.
 *
 * `baileys` se recibe por parámetro en lugar de importarse: este módulo tiene
 * que poder cargarse (y probarse) en un despliegue donde la dependencia no
 * esté instalada.
 */
export async function loadAuthState({ accountId, baileys }) {
  const { BufferJSON, initAuthCreds, proto } = baileys;

  async function readItem(category, itemId = '') {
    const row = await one(
      'SELECT value_enc FROM wa_app_auth WHERE account_id = $1 AND category = $2 AND item_id = $3',
      [accountId, category, itemId]
    );
    if (!row) return null;
    const plain = decrypt(row.value_enc);
    if (!plain) return null; // clave rotada o dato corrupto: como si no estuviera
    try {
      return JSON.parse(plain, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function writeItem(category, itemId, value) {
    await query(
      `INSERT INTO wa_app_auth (account_id, category, item_id, value_enc, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (account_id, category, item_id)
         DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
      [accountId, category, itemId, encrypt(JSON.stringify(value, BufferJSON.replacer))]
    );
  }

  // Sin credenciales guardadas, `initAuthCreds()` crea una identidad de
  // dispositivo nueva: es lo que hace que aparezca un QR en vez de reconectar.
  const creds = (await readItem('creds')) || initAuthCreds();

  const state = {
    creds,
    keys: {
      /** Devuelve un objeto id → valor para los ids pedidos de ese tipo. */
      async get(type, ids) {
        const result = {};
        if (!ids?.length) return result;

        const rows = await many(
          `SELECT item_id, value_enc FROM wa_app_auth
            WHERE account_id = $1 AND category = $2 AND item_id = ANY($3::text[])`,
          [accountId, type, ids.map(String)]
        );

        for (const row of rows) {
          const plain = decrypt(row.value_enc);
          if (!plain) continue;
          let value;
          try {
            value = JSON.parse(plain, BufferJSON.reviver);
          } catch {
            continue;
          }
          // Las claves de sincronización vienen envueltas en un protobuf que
          // hay que rehidratar; el resto se usa tal cual.
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[row.item_id] = value;
        }
        return result;
      },

      /**
       * Guarda un árbol tipo → id → valor. Un valor nulo significa "borra".
       * Va en una sola transacción porque Baileys llama aquí con decenas de
       * claves de golpe mientras levanta la sesión.
       */
      async set(data) {
        await transaction(async (client) => {
          for (const [type, items] of Object.entries(data || {})) {
            for (const [id, value] of Object.entries(items || {})) {
              if (value === null || value === undefined) {
                await client.query(
                  'DELETE FROM wa_app_auth WHERE account_id = $1 AND category = $2 AND item_id = $3',
                  [accountId, type, String(id)]
                );
                continue;
              }
              await client.query(
                `INSERT INTO wa_app_auth (account_id, category, item_id, value_enc, updated_at)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (account_id, category, item_id)
                   DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`,
                [accountId, type, String(id), encrypt(JSON.stringify(value, BufferJSON.replacer))]
              );
            }
          }
        });
      },
    },
  };

  return { state, saveCreds: () => writeItem('creds', '', state.creds) };
}

/**
 * Borra todo el estado de una cuenta.
 *
 * Se llama cuando WhatsApp cierra la sesión (`loggedOut`): esas credenciales
 * ya no valen y reintentar con ellas solo genera reconexiones fallidas en
 * bucle. También al desvincular desde el panel.
 */
export async function clearAuthState(accountId) {
  const { rowCount } = await query('DELETE FROM wa_app_auth WHERE account_id = $1', [accountId]);
  return rowCount;
}

/** ¿Hay credenciales guardadas? Decide entre "reconectar" y "pedir QR". */
export async function hasAuthState(accountId) {
  const row = await one(
    `SELECT 1 FROM wa_app_auth WHERE account_id = $1 AND category = 'creds'`,
    [accountId]
  );
  return Boolean(row);
}
