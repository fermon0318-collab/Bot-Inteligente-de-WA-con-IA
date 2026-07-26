/**
 * Cola de salida.
 *
 * Ningún mensaje se envía dentro de la petición del webhook. Todo se encola y
 * un trabajador lo despacha. Eso da tres cosas gratis:
 *
 *   · el webhook responde a Meta en milisegundos, que es lo que exige
 *   · las pausas de un flujo son una fecha futura, no un setTimeout perdido
 *     en memoria que muere al reiniciar el proceso
 *   · un fallo de la Graph API se reintenta con espera creciente en lugar de
 *     perder el mensaje
 */

import { many, one, query, transaction } from '../db/pool.js';
import * as media from './media.js';
import * as wa from './whatsapp.js';

const MAX_ATTEMPTS = 5;
/** Espera antes del reintento n: 30 s, 2 min, 8 min, 32 min. */
const backoffSeconds = (attempt) => Math.min(30 * 4 ** (attempt - 1), 3600);

/** Encola un mensaje. `delaySeconds` retrasa el envío sin bloquear nada. */
export async function enqueue({
  accountId, contactId, kind = 'text', body = '',
  mediaName = null, payload = null, origin = 'flow', delaySeconds = 0,
}) {
  const row = await one(
    `INSERT INTO outbox (account_id, contact_id, kind, body, media_name, payload, origin, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     RETURNING id, scheduled_at`,
    [accountId, contactId, kind, body, mediaName, payload ? JSON.stringify(payload) : null,
     origin, Number(delaySeconds) || 0]
  );
  return row;
}

/** Cancela lo pendiente de un contacto: lo usa "Detener automatización". */
export async function cancelPending(contactId, reason = 'cancelado por el operador') {
  const { rowCount } = await query(
    `UPDATE outbox SET status = 'canceled', last_error = $2
      WHERE contact_id = $1 AND status = 'pending'`,
    [contactId, reason]
  );
  return rowCount;
}

/**
 * Toma hasta `limit` mensajes vencidos y los marca como en curso.
 *
 * SKIP LOCKED permite que varios trabajadores convivan sin enviar dos veces lo
 * mismo — hoy hay uno solo, pero el día que haya dos instancias esto ya está
 * resuelto.
 */
async function claimDue(limit) {
  return many(
    `UPDATE outbox o
        SET attempts = o.attempts + 1
       FROM (
         SELECT id FROM outbox
          WHERE status = 'pending' AND scheduled_at <= now()
          ORDER BY scheduled_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) due
      WHERE o.id = due.id
  RETURNING o.*`,
    [limit]
  );
}

/** Despacha un mensaje concreto. Devuelve 'sent' | 'retry' | 'failed'. */
async function dispatch(item) {
  const cfg = await wa.accountConfig(item.account_id);

  if (!cfg?.token || !cfg.phoneNumberId) {
    await fail(item, 'La cuenta no tiene Cloud API configurada', true);
    return 'failed';
  }
  if (!cfg.botRunning) {
    // El bot está detenido: se deja pendiente para cuando lo reactiven, en vez
    // de descartar un mensaje que el operador sí quería enviar.
    await query(
      `UPDATE outbox SET attempts = attempts - 1, scheduled_at = now() + interval '5 minutes',
              last_error = 'bot detenido'
        WHERE id = $1`,
      [item.id]
    );
    return 'retry';
  }

  const contact = await one('SELECT phone, name FROM contacts WHERE id = $1', [item.contact_id]);
  if (!contact) {
    await fail(item, 'El contacto ya no existe', true);
    return 'failed';
  }

  const to = contact.phone.replace(/\D/g, '');

  try {
    let messageId = null;

    if (item.kind === 'media') {
      const file = await one(
        'SELECT id, name, file_type, wa_media_id FROM media_files WHERE account_id = $1 AND name = $2',
        [item.account_id, item.media_name]
      );
      if (!file) {
        await fail(item, `El archivo "${item.media_name}" ya no existe`, true);
        return 'failed';
      }

      // Si no tiene media_id o caducó, se sube ahora en vez de fallar
      const mediaId = await media.ensureUploaded(item.account_id, file.id);

      messageId = await wa.sendMedia({
        token: cfg.token, phoneNumberId: cfg.phoneNumberId, to,
        mediaId,
        kind: file.file_type === 'pdf' ? 'document' : file.file_type,
        filename: file.name,
        caption: item.body || undefined,
      });
    } else if (item.kind === 'template') {
      const tpl = item.payload || {};
      messageId = await wa.sendTemplate({
        token: cfg.token, phoneNumberId: cfg.phoneNumberId, to,
        name: tpl.name, language: tpl.language, components: tpl.components,
      });
    } else {
      messageId = await wa.sendText({
        token: cfg.token, phoneNumberId: cfg.phoneNumberId, to, body: item.body,
      });
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE outbox SET status = 'sent', sent_at = now(), wa_message_id = $2, last_error = NULL
          WHERE id = $1`,
        [item.id, messageId]
      );
      await client.query(
        `INSERT INTO messages (account_id, contact_id, direction, body, wa_message_id, status)
         VALUES ($1, $2, $3, $4, $5, 'sent')
         ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
        [item.account_id, item.contact_id,
         item.origin === 'manual' ? 'out' : 'bot',
         item.kind === 'media' ? `📎 ${item.media_name}` : item.body,
         messageId]
      );
      await client.query(
        'UPDATE contacts SET last_message_at = now() WHERE id = $1',
        [item.contact_id]
      );
    });

    return 'sent';
  } catch (err) {
    const permanent = err.permanent || item.attempts >= MAX_ATTEMPTS;
    await fail(item, err.message, permanent);
    return permanent ? 'failed' : 'retry';
  }
}

async function fail(item, message, permanent) {
  if (permanent) {
    await query(
      `UPDATE outbox SET status = 'failed', last_error = $2 WHERE id = $1`,
      [item.id, message]
    );
    await query(
      `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'err', $2)`,
      [item.account_id, `Envío fallido: ${message}`]
    );
  } else {
    await query(
      `UPDATE outbox SET scheduled_at = now() + make_interval(secs => $3), last_error = $2
        WHERE id = $1`,
      [item.id, message, backoffSeconds(item.attempts)]
    );
  }
}

/** Procesa una tanda. Devuelve el recuento por resultado. */
export async function drain({ limit = 20 } = {}) {
  const due = await claimDue(limit);
  const result = { sent: 0, retry: 0, failed: 0 };

  for (const item of due) {
    try {
      result[await dispatch(item)]++;
    } catch (err) {
      console.error(`[outbox] error inesperado en el mensaje ${item.id}:`, err.message);
      await fail(item, err.message, false).catch(() => {});
      result.retry++;
    }
  }
  return result;
}

/** Arranca el trabajador periódico. Devuelve una función para detenerlo. */
export function startWorker({ intervalMs = 3000 } = {}) {
  let running = false;

  const timer = setInterval(async () => {
    if (running) return; // una tanda lenta no debe solaparse con la siguiente
    running = true;
    try {
      const r = await drain();
      if (r.sent || r.failed) {
        console.log(`[outbox] enviados ${r.sent} · reintentos ${r.retry} · fallidos ${r.failed}`);
      }
    } catch (err) {
      console.error('[outbox] fallo del trabajador:', err.message);
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
