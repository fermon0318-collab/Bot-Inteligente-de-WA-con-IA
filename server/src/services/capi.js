/**
 * Conversions API de Meta.
 *
 * Los datos personales viajan siempre con hash SHA-256, como exige Meta. El
 * event_id permite que Meta descarte duplicados si el píxel también reportó.
 */

import { createHash } from 'node:crypto';
import { many, one, query } from '../db/pool.js';
import { avisarError } from '../lib/alert.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta exige minúsculas, sin espacios y con hash. */
const hash = (valor) => valor
  ? createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex')
  : undefined;

/** El teléfono va solo con dígitos, con código de país y sin el +. */
const hashTelefono = (telefono) => {
  const digitos = String(telefono).replace(/\D/g, '');
  return digitos ? createHash('sha256').update(digitos).digest('hex') : undefined;
};

async function config(accountId) {
  const row = await one(
    `SELECT capi_pixel_id, capi_currency, capi_enabled, ads_token_enc
       FROM bot_settings WHERE account_id = $1`,
    [accountId]
  );
  if (!row?.capi_enabled || !row.capi_pixel_id) return null;
  const token = decrypt(row.ads_token_enc);
  return token ? { pixelId: row.capi_pixel_id, currency: row.capi_currency, token } : null;
}

/**
 * Registra una conversión. No la envía: la encola.
 * Se llama justo después de marcar un pago como válido, sea automático
 * (bloque B) o manual.
 */
export async function recordPurchase({ accountId, contactId, value, currency }) {
  const cfg = await config(accountId);
  if (!cfg) return { skipped: 'capi_desactivada' };

  const evento = await one(
    `INSERT INTO capi_events (account_id, contact_id, event_name, event_id, value, currency)
     VALUES ($1, $2, 'Purchase', $3, $4, $5)
     ON CONFLICT (account_id, event_id) DO NOTHING
     RETURNING id`,
    [accountId, contactId, `purchase_${contactId}_${Date.now()}`,
     value, currency || cfg.currency]
  );

  return evento ? { queued: evento.id } : { skipped: 'duplicado' };
}

/** Despacha los eventos pendientes. */
export async function flush({ limit = 20 } = {}) {
  const pendientes = await many(
    `SELECT e.*, c.phone, c.name, c.ctwa_clid
       FROM capi_events e JOIN contacts c ON c.id = e.contact_id
      WHERE e.status = 'pending' AND e.attempts < 5
      ORDER BY e.created_at LIMIT $1`,
    [limit]
  );

  let enviados = 0;

  for (const evento of pendientes) {
    const cfg = await config(evento.account_id);
    if (!cfg) {
      await query(
        `UPDATE capi_events SET status = 'failed', error = 'Conversions API desactivada' WHERE id = $1`,
        [evento.id]);
      continue;
    }

    const [nombre, ...apellidos] = String(evento.name || '').split(' ');

    const payload = {
      data: [{
        event_name: evento.event_name,
        event_time: Math.floor(new Date(evento.created_at).getTime() / 1000),
        event_id: evento.event_id,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: {
          ph: [hashTelefono(evento.phone)].filter(Boolean),
          fn: [hash(nombre)].filter(Boolean),
          ln: [hash(apellidos.join(' '))].filter(Boolean),
          // Cierra el círculo con el anuncio que trajo al contacto
          ...(evento.ctwa_clid ? { ctwa_clid: evento.ctwa_clid } : {}),
        },
        custom_data: {
          value: Number(evento.value) || 0,
          currency: evento.currency || cfg.currency,
        },
      }],
    };

    try {
      const res = await fetch(`${GRAPH}/${cfg.pixelId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: cfg.token }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        await query(
          `UPDATE capi_events SET status = 'sent', sent_at = now(), response = $2,
                  attempts = attempts + 1 WHERE id = $1`,
          [evento.id, JSON.stringify(data)]);
        enviados++;
      } else {
        const permanente = res.status < 500 && res.status !== 429;
        await query(
          `UPDATE capi_events SET status = $2, attempts = attempts + 1, error = $3, response = $4
            WHERE id = $1`,
          [evento.id, permanente ? 'failed' : 'pending',
           data?.error?.message || `HTTP ${res.status}`, JSON.stringify(data)]);
      }
    } catch (err) {
      await query(
        `UPDATE capi_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
        [evento.id, err.message]);
    }
  }

  return enviados;
}

export function startWorker({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    flush().catch((err) => {
      console.error('[capi]', err.message);
      avisarError('capi.startWorker', err).catch(() => {});
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
