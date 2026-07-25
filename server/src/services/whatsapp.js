/**
 * Cliente de WhatsApp Cloud API.
 *
 * Cada cuenta usa su propio token, así que ninguna función guarda estado: se
 * les pasa la configuración ya descifrada.
 */

import { one } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Errores de Meta que no tiene sentido reintentar. */
const PERMANENT = new Set([
  131_026, // el destinatario no puede recibir mensajes
  131_047, // fuera de la ventana de 24 h: hace falta plantilla
  131_051, // tipo de mensaje no soportado
  132_000, // plantilla inexistente o no aprobada
  100,     // parámetro inválido
  190,     // token caducado o revocado
]);

export class WhatsAppError extends Error {
  constructor(message, { code, permanent, status } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
    this.status = status;
    // Un error permanente no se reintenta: solo gastaría cuota y ensuciaría el log
    this.permanent = permanent ?? PERMANENT.has(code);
  }
}

/** Configuración de WhatsApp de una cuenta, con el token ya descifrado. */
export async function accountConfig(accountId) {
  const row = await one(
    `SELECT wa_phone_number_id, wa_business_id, wa_token_enc, wa_connected, bot_running
       FROM bot_settings WHERE account_id = $1`,
    [accountId]
  );
  if (!row) return null;
  return {
    phoneNumberId: row.wa_phone_number_id,
    businessId: row.wa_business_id,
    token: decrypt(row.wa_token_enc),
    connected: row.wa_connected,
    botRunning: row.bot_running,
  };
}

async function call(path, { token, method = 'POST', body } = {}) {
  let response;
  try {
    response = await fetch(`${GRAPH}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Fallo de red o tiempo agotado: merece reintento
    throw new WhatsAppError(`No se pudo contactar con Meta: ${err.message}`, { permanent: false });
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const meta = data?.error || {};
    throw new WhatsAppError(meta.message || `Meta devolvió ${response.status}`, {
      code: meta.code,
      status: response.status,
      // 5xx y 429 son transitorios; el resto depende del código de Meta
      permanent: response.status < 500 && response.status !== 429
        ? PERMANENT.has(meta.code)
        : false,
    });
  }

  return data;
}

/** Envía un mensaje de texto. Devuelve el id que asigna WhatsApp. */
export async function sendText({ token, phoneNumberId, to, body, previewUrl = true }) {
  const data = await call(`${phoneNumberId}/messages`, {
    token,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: previewUrl, body },
    },
  });
  return data?.messages?.[0]?.id || null;
}

/**
 * Envía un archivo ya subido a Meta.
 * `kind` es el tipo que espera la API: image, document, audio o video.
 */
export async function sendMedia({ token, phoneNumberId, to, mediaId, kind = 'document', filename, caption }) {
  const media = { id: mediaId };
  if (caption && kind !== 'audio') media.caption = caption;
  if (filename && kind === 'document') media.filename = filename;

  const data = await call(`${phoneNumberId}/messages`, {
    token,
    body: { messaging_product: 'whatsapp', to, type: kind, [kind]: media },
  });
  return data?.messages?.[0]?.id || null;
}

/** Envía una plantilla aprobada — la única vía fuera de la ventana de 24 h. */
export async function sendTemplate({ token, phoneNumberId, to, name, language = 'es', components = [] }) {
  const data = await call(`${phoneNumberId}/messages`, {
    token,
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: language }, components },
    },
  });
  return data?.messages?.[0]?.id || null;
}

/** Marca como leído: el contacto ve la doble palomita azul. */
export async function markAsRead({ token, phoneNumberId, messageId }) {
  try {
    await call(`${phoneNumberId}/messages`, {
      token,
      body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
    });
  } catch {
    // Cosmético: si falla, no vale la pena interrumpir el procesamiento
  }
}

/** Descarga un adjunto. Devuelve { buffer, mimeType, sha256 }. */
export async function downloadMedia({ token, mediaId }) {
  const meta = await call(mediaId, { token, method: 'GET' });
  if (!meta?.url) throw new WhatsAppError('Meta no devolvió la URL del archivo');

  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new WhatsAppError(`No se pudo descargar el archivo (${res.status})`);

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.mime_type,
    sha256: meta.sha256,
    size: Number(meta.file_size) || 0,
  };
}

/** Sube un archivo y devuelve su media_id, reutilizable durante 30 días. */
export async function uploadMedia({ token, phoneNumberId, buffer, mimeType, filename }) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new WhatsAppError(data?.error?.message || 'No se pudo subir el archivo');
  return data.id;
}

/** Estado del número: sirve para avisar cuando Meta degrada la calidad. */
export async function phoneStatus({ token, phoneNumberId }) {
  return call(`${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,throughput`, {
    token,
    method: 'GET',
  });
}

/** Tipo de mensaje de Meta → tipo de archivo de ApolAI. */
export function mediaKindFor(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}
