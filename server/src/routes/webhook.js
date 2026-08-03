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
import { one, query } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';
import { rateLimit } from '../middleware/auth.js';
import * as engine from '../services/engine.js';

const router = Router();

// Defensa en profundidad detrás de la firma: un límite generoso, calibrado
// para no afectar el tráfico real de Meta (todas las cuentas comparten este
// único endpoint y las entregas pueden venir en ráfaga), pero que acota el
// costo de una avalancha de peticiones sin firma válida o mal configuradas.
const webhookRateLimit = rateLimit({ windowMs: 60_000, max: 600 });

/**
 * Verifica que el POST vino de verdad de Meta.
 *
 * Meta firma cada entrega con HMAC-SHA256 del cuerpo EXACTO (los bytes tal
 * cual, antes de parsear JSON) usando el App Secret de LA APP DEL CLIENTE
 * (cada cuenta conecta su propio número pegando su propio Access Token desde
 * su propia app de Meta for Developers — no hay una app central de Elorai),
 * y lo manda en `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Por eso la verificación es por cuenta: primero hay que saber a qué cuenta
 * pertenece el evento (vía `phone_number_id`, que no es secreto y viaja sin
 * verificar) para poder buscar SU App Secret y validar con ese. Sin esto,
 * cualquiera podría inyectar mensajes falsos con solo conocer el
 * phone_number_id. Devuelve `true`/`false`; nunca lanza.
 */
function firmaValida(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) return false;

  const esperada = createHmac('sha256', appSecret).update(rawBody).digest('hex');
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
  // req.body es el Buffer crudo (ver index.js: express.raw para esta ruta,
  // montado antes que express.json). Hace falta así, sin parsear, para que la
  // firma se calcule sobre los mismos bytes exactos que firmó Meta.
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) return res.status(400).end();

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).end();
  }

  if (body?.object !== 'whatsapp_business_account') return res.status(400).end();

  // El phone_number_id identifica la cuenta pero no es secreto, así que solo
  // sirve para saber DE QUIÉN es este evento — no para confiar en él todavía.
  // Con eso se busca el App Secret propio de esa cuenta y recién ahí se
  // verifica la firma.
  const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
  const cuenta = phoneNumberId
    ? await one('SELECT account_id, wa_app_secret_enc FROM bot_settings WHERE wa_phone_number_id = $1', [String(phoneNumberId)])
    : null;
  const appSecret = cuenta && decrypt(cuenta.wa_app_secret_enc);

  if (!appSecret) {
    console.warn(`[webhook] cuenta sin App Secret configurado (phone_number_id ${phoneNumberId || 'desconocido'}) — evento rechazado`);
    return res.status(503).end();
  }

  if (!firmaValida(raw, req.headers['x-hub-signature-256'], appSecret)) {
    console.warn('[webhook] firma inválida — evento rechazado');
    return res.status(401).end();
  }

  // Confirmar de inmediato: cualquier trabajo aquí retrasa la respuesta a Meta
  res.sendStatus(200);

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
