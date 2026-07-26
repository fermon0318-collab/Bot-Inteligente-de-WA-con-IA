/**
 * Verificación automática de comprobantes de pago.
 *
 * El cliente final manda una foto o PDF del comprobante; se lee con el mismo
 * proveedor de IA que ya configuró el dueño de la cuenta (no hay una
 * credencial ni un servicio más que pagar), se compara con sus reglas de
 * acceso y, si coincide, se entrega el producto solo.
 */

import { many, one, query, transaction } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';
import * as capi from './capi.js';
import { normalize, runFlow } from './flows.js';
import { enqueue } from './outbox.js';
import * as wa from './whatsapp.js';

const INSTRUCCIONES = `Analiza esta imagen de un comprobante de pago o transferencia bancaria.

Devuelve SOLO un objeto JSON, sin explicaciones ni markdown, con esta forma:
{
  "es_comprobante": true,
  "monto": 89.00,
  "moneda": "MXN",
  "referencia": "0123456789",
  "fecha": "2026-07-25",
  "banco": "BBVA",
  "beneficiario": "Nombre del receptor",
  "confianza": 0.95
}

Reglas:
- "es_comprobante" es false si la imagen no es un comprobante de pago.
- "monto" es número, sin símbolos ni separadores de miles.
- "referencia" es el folio, clave de rastreo o número de operación. null si no aparece.
- "fecha" en formato AAAA-MM-DD. null si no aparece.
- "confianza" entre 0 y 1: cuán legible y fiable te parece.
- Si un dato no se ve, usa null. NO lo inventes.`;

/** Un comprobante con menos confianza que esto va a revisión manual. */
const CONFIANZA_MINIMA = 0.6;

/** Config de IA de la cuenta, con la clave descifrada. */
async function aiCredentials(accountId) {
  const row = await one(
    'SELECT ai_model, ai_key_enc FROM bot_settings WHERE account_id = $1',
    [accountId]
  );
  const apiKey = decrypt(row?.ai_key_enc);
  return apiKey ? { model: row.ai_model, apiKey } : null;
}

/**
 * Extrae los datos de un comprobante.
 * Devuelve null si no hay credenciales o el proveedor falla: en ese caso el
 * comprobante queda en revisión manual, que es mejor que descartarlo.
 */
export async function extract({ accountId, buffer, mimeType }) {
  const cred = await aiCredentials(accountId);
  if (!cred) return null;

  const base64 = buffer.toString('base64');
  const esAnthropic = cred.model.startsWith('claude');

  // Los PDF solo los acepta Anthropic como documento; para el resto, imagen
  const bloque = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : esAnthropic
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
      : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };

  const peticion = esAnthropic
    ? {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: {
          model: cred.model, max_tokens: 400,
          messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
        },
        extraer: (d) => d?.content?.[0]?.text,
      }
    : {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: `Bearer ${cred.apiKey}`, 'content-type': 'application/json' },
        body: {
          model: cred.model, max_completion_tokens: 400,
          messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
        },
        extraer: (d) => d?.choices?.[0]?.message?.content,
      };

  try {
    const res = await fetch(peticion.url, {
      method: 'POST',
      headers: peticion.headers,
      body: JSON.stringify(peticion.body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.error(`[comprobante] el proveedor devolvió ${res.status}`);
      return null;
    }

    const texto = peticion.extraer(await res.json()) || '';
    // El modelo a veces envuelve el JSON en ```json … ``` pese a pedírselo
    const json = texto.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;

    const datos = JSON.parse(json);
    return {
      esComprobante: Boolean(datos.es_comprobante),
      monto: datos.monto === null ? null : Number(datos.monto),
      moneda: datos.moneda || null,
      referencia: datos.referencia ? String(datos.referencia).trim() : null,
      fecha: datos.fecha || null,
      banco: datos.banco || null,
      beneficiario: datos.beneficiario || null,
      confianza: Number(datos.confianza) || 0,
      crudo: datos,
    };
  } catch (err) {
    console.error(`[comprobante] fallo al leer: ${err.message}`);
    return null;
  }
}

/**
 * Busca la regla de acceso que corresponde a un comprobante.
 *
 * Dos condiciones: el monto encaja (con la tolerancia de la regla) y alguna
 * palabra de contexto aparece en la conversación reciente. El contexto evita
 * que dos productos del mismo precio se confundan.
 */
export async function matchRule({ accountId, contactId, monto }) {
  if (monto === null || Number.isNaN(monto)) return null;

  const reglas = await many(
    'SELECT id, amount, context, message, files, currency, tolerance FROM access_rules WHERE account_id = $1',
    [accountId]
  );
  if (!reglas.length) return null;

  // Últimos mensajes del contacto: de ahí sale el contexto
  const historial = await many(
    `SELECT body FROM messages WHERE contact_id = $1 AND direction = 'in'
      ORDER BY created_at DESC LIMIT 15`,
    [contactId]
  );
  const conversacion = normalize(historial.map((m) => m.body).join(' '));

  const candidatas = reglas
    .map((r) => {
      const esperado = Number(String(r.amount).replace(/[^\d.]/g, ''));
      if (!esperado) return null;

      const tolerancia = Number(r.tolerance) || 0;
      if (Math.abs(monto - esperado) > tolerancia) return null;

      const palabras = String(r.context).split(',').map((c) => normalize(c)).filter(Boolean);
      const aciertos = palabras.filter((p) => conversacion.includes(p)).length;

      // Sin contexto definido, la regla vale solo por monto
      if (palabras.length && !aciertos) return null;

      return { regla: r, aciertos, desvio: Math.abs(monto - esperado) };
    })
    .filter(Boolean)
    // Más contexto acertado primero; a igualdad, el monto más exacto
    .sort((a, b) => b.aciertos - a.aciertos || a.desvio - b.desvio);

  return candidatas[0]?.regla || null;
}

/**
 * Marca el comprobante como válido, al contacto como pagado (todo o nada en
 * la misma transacción) y encola la entrega: mensaje de confirmación,
 * mensaje de la regla, sus archivos y el flujo post-pago.
 *
 * Compartida entre la aprobación automática y la manual para que nunca se
 * desincronicen — un cambio aquí afecta a las dos por igual.
 */
async function entregar({ accountId, contactId, reciboId, motivoAprobacion, regla, ajustes, monto, moneda }) {
  await transaction(async (client) => {
    await client.query(
      `UPDATE payment_receipts SET status = 'valid', rule_id = $2, reason = $3, processed_at = now()
        WHERE id = $1`,
      [reciboId, regla.id, motivoAprobacion]
    );
    await client.query(
      `UPDATE contacts SET status = 'paid', paid_at = now(), amount = $2, currency = $3,
              delivered_at = now(), delivered_rule = $4
        WHERE id = $1`,
      [contactId, monto ?? 0, moneda || regla.currency, regla.id]
    );
  });

  // Conversions API: si está configurada, esta venta vuelve a Meta para que
  // el algoritmo aprenda del comprador real, no solo de quien abrió el chat.
  // Solo se encola aquí (una fila en capi_events); el envío real a Meta lo
  // hace el trabajador de capi.js, así que esto no puede retrasar la entrega.
  await capi.recordPurchase({ accountId, contactId, value: monto ?? 0, currency: moneda || regla.currency });

  let retraso = 0;
  if (ajustes?.pay_message_ok) {
    await enqueue({ accountId, contactId, body: ajustes.pay_message_ok, origin: 'flow' });
    retraso += 2;
  }
  await enqueue({ accountId, contactId, body: regla.message, origin: 'flow', delaySeconds: retraso });
  retraso += 2;

  for (const nombre of regla.files || []) {
    await enqueue({ accountId, contactId, kind: 'media', mediaName: nombre, origin: 'flow', delaySeconds: retraso });
    retraso += 2;
  }

  // Flujo post-pago: solo la primera vez, porque delivered_at ya quedó fijado
  if (ajustes?.pay_post_flow_id) {
    await runFlow({ accountId, contactId, flowId: ajustes.pay_post_flow_id });
  }
}

export async function processReceipt({ accountId, contactId, messageId, attachment }) {
  const cfg = await wa.accountConfig(accountId);
  if (!cfg?.token) return { status: 'error', reason: 'Cloud API sin configurar' };

  const ajustes = await one(
    'SELECT pay_message_ok, pay_message_invalid, pay_post_flow_id FROM bot_settings WHERE account_id = $1',
    [accountId]
  );

  const rechazar = async (reciboId, motivo, avisar = true) => {
    await query(
      `UPDATE payment_receipts SET status = $2, reason = $3, processed_at = now() WHERE id = $1`,
      [reciboId, 'invalid', motivo]
    );
    if (avisar && ajustes?.pay_message_invalid) {
      await enqueue({ accountId, contactId, body: ajustes.pay_message_invalid, origin: 'flow' });
    }
    await query(
      `UPDATE contacts SET status = 'rejected' WHERE id = $1 AND status <> 'paid'`,
      [contactId]
    );
    return { status: 'invalid', reason: motivo };
  };

  // 1 · Registrar el intento antes de nada
  const recibo = await one(
    `INSERT INTO payment_receipts (account_id, contact_id, message_id, wa_media_id, mime_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [accountId, contactId, messageId, attachment.mediaId, attachment.mimeType || '']
  );

  // 2 · Descargar
  let archivo;
  try {
    archivo = await wa.downloadMedia({ token: cfg.token, mediaId: attachment.mediaId });
  } catch (err) {
    return rechazar(recibo.id, `No se pudo descargar: ${err.message}`);
  }

  // 3 · Leer
  const datos = await extract({ accountId, buffer: archivo.buffer, mimeType: archivo.mimeType });

  if (!datos) {
    await query(
      `UPDATE payment_receipts SET status = 'manual_review',
              reason = 'No se pudo leer automáticamente', processed_at = now()
        WHERE id = $1`, [recibo.id]);
    await query(
      `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'warn', $2)`,
      [accountId, 'Comprobante recibido que no se pudo leer: revísalo en Chat en Vivo']);
    return { status: 'manual_review' };
  }

  await query(
    `UPDATE payment_receipts
        SET amount = $2, currency = $3, reference = $4, paid_at = $5, bank = $6,
            raw_extraction = $7, confidence = $8
      WHERE id = $1`,
    [recibo.id, datos.monto, datos.moneda, datos.referencia,
     datos.fecha || null, datos.banco, JSON.stringify(datos.crudo), datos.confianza]
  );

  if (!datos.esComprobante) return rechazar(recibo.id, 'La imagen no es un comprobante');
  if (datos.confianza < CONFIANZA_MINIMA) {
    await query(
      `UPDATE payment_receipts SET status = 'manual_review',
              reason = 'Comprobante poco legible', processed_at = now() WHERE id = $1`,
      [recibo.id]);
    return { status: 'manual_review' };
  }

  // 4 · ¿Referencia ya usada?
  if (datos.referencia) {
    const previo = await one(
      `SELECT contact_id FROM payment_receipts
        WHERE account_id = $1 AND lower(reference) = lower($2)
          AND status = 'valid' AND id <> $3 LIMIT 1`,
      [accountId, datos.referencia, recibo.id]
    );
    if (previo) {
      await query(
        `UPDATE payment_receipts SET status = 'duplicate',
                reason = 'Referencia ya utilizada', processed_at = now() WHERE id = $1`,
        [recibo.id]);
      await enqueue({ accountId, contactId, origin: 'flow',
        body: 'Ese comprobante ya lo recibimos antes. Si crees que es un error, escríbenos.' });
      return { status: 'duplicate' };
    }
  }

  // 5 · Buscar regla
  const regla = await matchRule({ accountId, contactId, monto: datos.monto });
  if (!regla) {
    return rechazar(recibo.id,
      `Monto ${datos.monto} ${datos.moneda || ''} sin regla de acceso que coincida`);
  }

  // 6 · Marcar pagado y entregar
  await entregar({
    accountId, contactId, reciboId: recibo.id, motivoAprobacion: null,
    regla, ajustes, monto: datos.monto, moneda: datos.moneda,
  });

  await query(
    `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'ok', $2)`,
    [accountId, `Pago validado: ${datos.monto} ${datos.moneda || ''} · ref ${datos.referencia || 's/r'}`]);

  return { status: 'valid', amount: datos.monto, rule: regla.id };
}

/**
 * Aprobación manual desde el panel: para comprobantes en `manual_review` o
 * rechazados por error. Reutiliza `entregar()`, así que nunca se desvía del
 * comportamiento automático.
 */
export async function approveManually({ accountId, receiptId, ruleId }) {
  const recibo = await one(
    `SELECT id, contact_id, amount, currency, status FROM payment_receipts
      WHERE id = $1 AND account_id = $2`,
    [receiptId, accountId]
  );
  if (!recibo) {
    throw Object.assign(new Error('El comprobante no existe'), { status: 404, code: 'not_found' });
  }
  if (recibo.status === 'valid') {
    throw Object.assign(new Error('Ese comprobante ya estaba aprobado'), { status: 409, code: 'already_valid' });
  }

  const regla = ruleId
    ? await one('SELECT id, message, files, currency FROM access_rules WHERE id = $1 AND account_id = $2', [ruleId, accountId])
    : null;
  if (!regla) {
    throw Object.assign(new Error('Selecciona una regla de acceso válida'), { status: 400, code: 'invalid_rule' });
  }

  const ajustes = await one(
    'SELECT pay_message_ok, pay_post_flow_id FROM bot_settings WHERE account_id = $1',
    [accountId]
  );

  await entregar({
    accountId, contactId: recibo.contact_id, reciboId: recibo.id, motivoAprobacion: 'Aprobado manualmente',
    regla, ajustes, monto: recibo.amount, moneda: recibo.currency,
  });

  await query(
    `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'ok', $2)`,
    [accountId, `Comprobante aprobado manualmente · regla "${regla.message.slice(0, 40)}"`]);

  return { status: 'valid', rule: regla.id };
}
