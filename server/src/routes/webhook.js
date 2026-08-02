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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { many, one, query } from '../db/pool.js';
import { rateLimit } from '../middleware/auth.js';
import * as engine from '../services/engine.js';

const router = Router();

// Defensa en profundidad detrás de la firma: un límite generoso, calibrado
// para no afectar el tráfico real de Meta (todas las cuentas comparten este
// único endpoint y las entregas pueden venir en ráfaga), pero que acota el
// costo de una avalancha de peticiones sin firma válida o mal configuradas.
const webhookRateLimit = rateLimit({ windowMs: 60_000, max: 600 });

/** Para no llenar los logs: un aviso de "sin App Secret" cada 5 min como mucho. */
let lastMisconfigWarning = 0;

/**
 * Verifica que el POST vino de verdad de Meta.
 *
 * Meta firma cada entrega con HMAC-SHA256 del cuerpo EXACTO (los bytes tal
 * cual, antes de parsear JSON) usando el App Secret de la app registrada en
 * Meta for Developers, y lo manda en `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Sin esto, el único dato que identifica la cuenta destino es
 * `phone_number_id`, que NO es secreto — aparece en el propio panel del
 * cliente — así que cualquiera podría inyectar mensajes falsos con solo
 * conocerlo. Devuelve `true`/`false`; nunca lanza.
 */
function firmaValida(rawBody, header) {
  if (!header || !header.startsWith('sha256=')) return false;

  const esperada = createHmac('sha256', config.meta.appSecret).update(rawBody).digest('hex');
  const recibida = header.slice('sha256='.length);

  const a = Buffer.from(esperada, 'hex');
  const b = Buffer.from(recibida, 'hex');
  // Firmas de longitud distinta: timingSafeEqual exige buffers del mismo
  // tamaño o lanza, así que se descarta antes en vez de dejar que reviente.
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ==========================================================================
   Verificación (Meta llama una vez al configurar el webhook)
   ========================================================================== */

router.get('/whatsapp', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe' || !token) return res.sendStatus(400);

  // El token de verificación lo genera Elorai por cuenta al crearla, así que
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

router.post('/whatsapp', webhookRateLimit, async (req, res) => {
  // Sin App Secret configurado, la única alternativa a procesar sin verificar
  // es no procesar en absoluto: un webhook "abierto" es peor que uno que
  // tarda en activarse. Meta reintenta las entregas fallidas durante horas,
  // así que nada se pierde mientras se configura META_APP_SECRET.
  if (!config.meta.configured) {
    if (Date.now() - lastMisconfigWarning > 5 * 60_000) {
      console.error('[webhook] META_APP_SECRET no está configurado: se rechazan todos los eventos entrantes de WhatsApp.');
      lastMisconfigWarning = Date.now();
    }
    return res.status(503).end();
  }

  // req.body es el Buffer crudo (ver index.js: express.raw para esta ruta,
  // montado antes que express.json). Hace falta así, sin parsear, para que la
  // firma se calcule sobre los mismos bytes exactos que firmó Meta.
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !firmaValida(raw, req.headers['x-hub-signature-256'])) {
    console.warn('[webhook] firma inválida o ausente — evento rechazado');
    return res.status(401).end();
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).end();
  }

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
