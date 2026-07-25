/**
 * Webhook de WhatsApp Cloud API.
 *
 * Un único endpoint para todas las cuentas: Meta identifica a cuál pertenece
 * cada mensaje por el `phone_number_id` que viene en el propio evento.
 *
 * Regla de oro: responder 200 en milisegundos. Meta reintenta si tardas más de
 * unos segundos, y un reintento sobre un mensaje que sí procesaste acaba en
 * respuestas duplicadas. Por eso se persiste el evento, se responde, y solo
 * después se procesa.
 */

import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import * as engine from '../services/engine.js';

const router = Router();

/* ==========================================================================
   Verificación (Meta llama una vez al configurar el webhook)
   ========================================================================== */

router.get('/whatsapp', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) return res.sendStatus(400);

  // El token de verificación lo genera ApolAI por cuenta al crearla, así que
  // sirve además para saber quién está dando de alta el webhook.
  const account = await one(
    'SELECT account_id FROM bot_settings WHERE wa_verify_token = $1',
    [String(token)]
  );

  if (!account) {
    console.warn('[webhook] verificación rechazada: token desconocido');
    return res.sendStatus(403);
  }

  await query(
    `INSERT INTO activity_log (account_id, level, message)
     VALUES ($1, 'ok', 'Webhook verificado por Meta')`,
    [account.account_id]
  );

  console.log(`[webhook] verificado para la cuenta ${account.account_id}`);
  // Meta espera el challenge en texto plano, sin comillas ni JSON
  res.type('text/plain').send(String(challenge));
});

/* ==========================================================================
   Recepción de eventos
   ========================================================================== */

router.post('/whatsapp', async (req, res) => {
  const body = req.body;

  // Confirmar de inmediato: cualquier trabajo aquí retrasa la respuesta a Meta
  res.sendStatus(200);

  if (body?.object !== 'whatsapp_business_account') return;

  try {
    await ingest(body);
  } catch (err) {
    console.error('[webhook] fallo al procesar el evento:', err.message);
  }
});

/** Recorre la estructura anidada de Meta y procesa cada cosa que encuentra. */
async function ingest(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const account = await engine.accountForPhoneNumberId(phoneNumberId);
      const accountId = account?.account_id || null;

      /* --- Mensajes entrantes ------------------------------------------- */
      for (const message of value.messages || []) {
        // El evento se guarda antes de procesarlo: si el motor falla, queda
        // registro de qué llegó exactamente y se puede reprocesar.
        const stored = await one(
          `INSERT INTO wa_events (account_id, wa_message_id, event_type, payload)
           VALUES ($1, $2, 'message', $3)
           ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [accountId, message.id, JSON.stringify({ phoneNumberId, message, contacts: value.contacts })]
        );

        // Sin fila devuelta, este mensaje ya se había recibido
        if (!stored) continue;

        const profile = (value.contacts || []).find((c) => c.wa_id === message.from)?.profile;

        try {
          const result = await engine.handleIncomingMessage({
            phoneNumberId,
            message,
            contactProfile: profile,
          });
          await query('UPDATE wa_events SET processed_at = now() WHERE id = $1', [stored.id]);

          if (result.actions?.length) {
            console.log(`[webhook] ${message.from} → ${result.actions.join(', ')}`);
          }
        } catch (err) {
          await query('UPDATE wa_events SET processed_at = now(), error = $2 WHERE id = $1',
            [stored.id, err.message]);
          console.error(`[webhook] mensaje ${message.id}:`, err.message);
        }
      }

      /* --- Estados de entrega -------------------------------------------- */
      for (const status of value.statuses || []) {
        try {
          await engine.handleStatus({ phoneNumberId, status });
        } catch (err) {
          console.error('[webhook] estado de entrega:', err.message);
        }
      }

      /* --- Avisos de calidad del número ---------------------------------- */
      if (value.event === 'PHONE_NUMBER_QUALITY_UPDATE' && accountId) {
        await query(
          `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'warn', $2)`,
          [accountId, `Meta cambió la calidad del número a ${value.current_limit || 'desconocida'}`]
        );
      }
    }
  }
}

/**
 * Reprocesa eventos que quedaron sin procesar.
 * Se ejecuta al arrancar: si el proceso murió a mitad, nada se pierde.
 */
export async function reprocessPending({ limit = 50 } = {}) {
  const pending = await many(
    `SELECT id, payload FROM wa_events
      WHERE processed_at IS NULL AND received_at > now() - interval '24 hours'
      ORDER BY received_at LIMIT $1`,
    [limit]
  );

  for (const row of pending) {
    try {
      await engine.handleIncomingMessage({
        phoneNumberId: row.payload.phoneNumberId,
        message: row.payload.message,
        contactProfile: (row.payload.contacts || [])
          .find((c) => c.wa_id === row.payload.message?.from)?.profile,
      });
      await query('UPDATE wa_events SET processed_at = now() WHERE id = $1', [row.id]);
    } catch (err) {
      await query('UPDATE wa_events SET processed_at = now(), error = $2 WHERE id = $1',
        [row.id, err.message]);
    }
  }

  if (pending.length) console.log(`[webhook] reprocesados ${pending.length} evento(s) pendientes`);
  return pending.length;
}

export default router;
