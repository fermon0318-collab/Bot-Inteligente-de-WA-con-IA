/**
 * Ritmo de envío de Modo App.
 *
 * En Cloud API es Meta quien pone el techo y quien cobra. Aquí no hay techo
 * externo: si el software quisiera, mandaría trescientos mensajes en un minuto
 * desde el número personal del cliente — y WhatsApp lo cerraría ese mismo día.
 * Así que el techo lo pone el producto, y no es negociable a la baja.
 *
 * Reglas, todas por número:
 *
 *   1. entre mensaje y mensaje, una pausa aleatoria de 5-15 s (configurable
 *      hacia arriba, nunca por debajo de 5)
 *   2. como mucho 20-30 mensajes por minuto
 *   3. un tope diario
 *   4. nada de duplicados: el mismo texto al mismo contacto no se repite
 *      dentro de la ventana de rebote
 *
 * Ninguna de estas cuentas vive en memoria: van contra `wa_app_sends`. Un
 * reinicio del proceso no debe regalar una ráfaga, y con varios trabajadores
 * el límite tiene que ser del número, no de la instancia.
 */

import { createHash } from 'node:crypto';
import { many, one } from '../../db/pool.js';

/** Suelo del producto: por debajo de esto no se puede configurar. */
export const MIN_GAP_SECONDS = 5;
export const MAX_GAP_SECONDS = 120;
export const MAX_PER_MINUTE = 30;

/** Ventana en la que un texto idéntico al mismo contacto se considera repetido. */
const DEDUPE_WINDOW_MINUTES = 60;

/** Huella del texto, insensible a mayúsculas y espacios sobrantes. */
export function bodyHash(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * Pausa aleatoria en milisegundos dentro del rango de la cuenta.
 *
 * El azar no es decorativo: un intervalo exacto de 10 s repetido cien veces es
 * una firma de automatización mucho más evidente que el propio volumen.
 */
export function randomGapMs(minSeconds, maxSeconds, random = Math.random) {
  const min = Math.max(MIN_GAP_SECONDS, Number(minSeconds) || MIN_GAP_SECONDS);
  const max = Math.min(MAX_GAP_SECONDS, Math.max(min, Number(maxSeconds) || min));
  return Math.round((min + random() * (max - min)) * 1000);
}

/** Normaliza los límites que llegan del panel a algo que no ponga en riesgo el número. */
export function sanitizeLimits({ minGapSeconds, maxGapSeconds, perMinuteLimit, dailyLimit } = {}) {
  const min = Math.min(MAX_GAP_SECONDS, Math.max(MIN_GAP_SECONDS, Number(minGapSeconds) || MIN_GAP_SECONDS));
  const max = Math.min(MAX_GAP_SECONDS, Math.max(min, Number(maxGapSeconds) || MIN_GAP_SECONDS * 3));
  return {
    minGapSeconds: min,
    maxGapSeconds: max,
    perMinuteLimit: Math.min(MAX_PER_MINUTE, Math.max(1, Number(perMinuteLimit) || 20)),
    dailyLimit: Math.min(5000, Math.max(1, Number(dailyLimit) || 500)),
  };
}

/**
 * ¿Se puede enviar ya?
 *
 * Devuelve `{ allow: true }` o `{ allow: false, retryInSeconds, reason }`. Un
 * "no" nunca descarta el mensaje: la cola lo reprograma para más tarde, que es
 * exactamente lo que se quiere — el mensaje sale, solo que despacio.
 */
export async function checkQuota({ accountId, session, contactId, body, now = new Date() }) {
  /* --- Antiduplicados ----------------------------------------------------
     Va lo primero a propósito. Si se comprobara después del ritmo, un mensaje
     repetido se reprogramaría una y otra vez —ocupando cola y despertando al
     trabajador— para acabar descartado igualmente. Un duplicado no se aplaza:
     no se envía.
     --------------------------------------------------------------------- */
  if (contactId && body) {
    const repetido = await one(
      `SELECT 1 FROM wa_app_sends
        WHERE account_id = $1 AND contact_id = $2 AND body_hash = $3
          AND sent_at > now() - make_interval(mins => $4)
        LIMIT 1`,
      [accountId, contactId, bodyHash(body), DEDUPE_WINDOW_MINUTES]
    );
    if (repetido) {
      return { allow: false, drop: true, reason: 'mensaje idéntico ya enviado a este contacto' };
    }
  }

  if (session.paused) {
    return {
      allow: false,
      retryInSeconds: 600,
      reason: session.paused_reason || 'envíos en pausa por riesgo de bloqueo',
    };
  }

  const counts = await one(
    `SELECT
       count(*) FILTER (WHERE sent_at > $2::timestamptz - interval '1 minute') AS last_minute,
       count(*) FILTER (WHERE sent_at > date_trunc('day', $2::timestamptz))    AS today,
       max(sent_at)                                                            AS last_sent_at
     FROM wa_app_sends
     WHERE account_id = $1 AND sent_at > $2::timestamptz - interval '24 hours'`,
    [accountId, now.toISOString()]
  );

  const lastMinute = Number(counts?.last_minute || 0);
  const today = Number(counts?.today || 0);

  if (today >= session.daily_limit) {
    // Hasta mañana. Se reintenta pasada una hora en vez de calcular la
    // medianoche exacta: la zona horaria del negocio no es la del servidor y
    // un reintento de más no cuesta nada.
    return { allow: false, retryInSeconds: 3600, reason: `tope diario alcanzado (${session.daily_limit})` };
  }

  if (lastMinute >= session.per_minute_limit) {
    return { allow: false, retryInSeconds: 60, reason: `tope por minuto alcanzado (${session.per_minute_limit})` };
  }

  // Pausa desde el último envío. Es lo que impide la ráfaga incluso cuando la
  // cola tiene cien mensajes vencidos a la vez.
  if (counts?.last_sent_at) {
    const gapMs = randomGapMs(session.min_gap_seconds, session.max_gap_seconds);
    const elapsedMs = now.getTime() - new Date(counts.last_sent_at).getTime();
    if (elapsedMs < gapMs) {
      return {
        allow: false,
        retryInSeconds: Math.max(1, Math.ceil((gapMs - elapsedMs) / 1000)),
        reason: 'ritmo humano entre mensajes',
      };
    }
  }

  return { allow: true, remainingToday: session.daily_limit - today };
}

/** Anota un envío consumado. Es lo que alimenta los límites y el guardián. */
export async function recordSend({
  accountId, contactId, phone, body, kind = 'text', origin = 'flow', inboundFirst = true,
}) {
  await one(
    `INSERT INTO wa_app_sends (account_id, contact_id, phone, body_hash, kind, origin, inbound_first)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [accountId, contactId || null, phone || '', bodyHash(body), kind, origin, Boolean(inboundFirst)]
  );
}

/** Resumen para el panel: cuánto se ha usado del cupo de hoy. */
export async function usage(accountId) {
  const row = await one(
    `SELECT
       count(*) FILTER (WHERE sent_at > now() - interval '1 minute') AS last_minute,
       count(*) FILTER (WHERE sent_at > now() - interval '1 hour')   AS last_hour,
       count(*) FILTER (WHERE sent_at > date_trunc('day', now()))    AS today,
       max(sent_at) AS last_sent_at
     FROM wa_app_sends
     WHERE account_id = $1 AND sent_at > now() - interval '24 hours'`,
    [accountId]
  );
  return {
    lastMinute: Number(row?.last_minute || 0),
    lastHour: Number(row?.last_hour || 0),
    today: Number(row?.today || 0),
    lastSentAt: row?.last_sent_at || null,
  };
}

/** Limpieza: el registro de envíos solo sirve para ventanas cortas. */
export async function purgeOldSends({ days = 30 } = {}) {
  const rows = await many(
    `DELETE FROM wa_app_sends WHERE sent_at < now() - make_interval(days => $1) RETURNING id`,
    [days]
  );
  return rows.length;
}
