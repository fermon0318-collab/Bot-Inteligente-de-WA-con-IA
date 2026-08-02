/**
 * Motor del bot: qué pasa cuando entra un mensaje.
 *
 * El orden importa y está pensado para gastar lo mínimo antes de descartar:
 *
 *   1. ¿La cuenta existe y el bot está encendido?
 *   2. Se registra el contacto y el mensaje (esto siempre, aunque no se responda)
 *   3. ¿Automatización detenida para este contacto?  → solo se guarda
 *   4. ¿Había un flujo esperando respuesta?          → continúa por su rama
 *   5. ¿Coincide algún disparador?                   → ejecuta su flujo
 *   6. Si no, y la IA está activa                    → responde la IA
 */

import { many, one, query } from '../db/pool.js';
import * as ai from './ai.js';
import * as flows from './flows.js';
import { drain, enqueue } from './outbox.js';
import * as providers from './providers/index.js';
import * as receipts from './receipts.js';
import * as storage from './storage.js';

/** Escribe en la terminal de actividad del panel. */
async function log(accountId, message, level = 'info') {
  await query(
    'INSERT INTO activity_log (account_id, level, message) VALUES ($1, $2, $3)',
    [accountId, level, message]
  );
}

/** Resuelve la cuenta a partir del número que recibió el mensaje. */
export async function accountForPhoneNumberId(phoneNumberId) {
  return one(
    `SELECT account_id, bot_running, wa_connected, wa_channel
       FROM bot_settings WHERE wa_phone_number_id = $1`,
    [String(phoneNumberId)]
  );
}

/**
 * Resuelve la cuenta de un mensaje entrante.
 *
 * Cloud API identifica la cuenta por el `phone_number_id` que Meta manda en el
 * evento; Modo App ya sabe de qué cuenta es su propio socket. Un único punto
 * de entrada para los dos canales.
 */
async function resolveAccount({ accountId, phoneNumberId }) {
  if (accountId) {
    return one(
      `SELECT account_id, bot_running, wa_connected, wa_channel
         FROM bot_settings WHERE account_id = $1`,
      [accountId]
    );
  }
  return accountForPhoneNumberId(phoneNumberId);
}

/** Crea o actualiza el contacto y devuelve su fila. */
async function upsertContact({ accountId, phone, profileName, adName, adId, ctwaClid }) {
  return one(
    `INSERT INTO contacts (account_id, phone, name, profile_name, source, ad_name, ad_id,
                           ctwa_clid, first_seen_at, last_message_at, last_inbound_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now(), now(), now())
     ON CONFLICT (account_id, phone) DO UPDATE SET
       profile_name    = COALESCE(NULLIF(EXCLUDED.profile_name, ''), contacts.profile_name),
       name            = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END,
       -- La atribución es la del PRIMER anuncio: si vuelve por otro, el mérito
       -- sigue siendo del que lo trajo
       ad_name         = COALESCE(contacts.ad_name, EXCLUDED.ad_name),
       ad_id           = COALESCE(contacts.ad_id, EXCLUDED.ad_id),
       ctwa_clid       = COALESCE(contacts.ctwa_clid, EXCLUDED.ctwa_clid),
       last_message_at = now(),
       last_inbound_at = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [accountId, phone, profileName || '', adName ? 'Anuncio Meta' : 'Orgánico', adName || null, adId || null, ctwaClid || null]
  );
}

/** Extrae el texto legible de cualquier tipo de mensaje de WhatsApp. */
function textOf(message) {
  switch (message.type) {
    case 'text': return message.text?.body || '';
    case 'button': return message.button?.text || '';
    case 'interactive':
      return message.interactive?.button_reply?.title
          || message.interactive?.list_reply?.title || '';
    case 'image': return message.image?.caption || '📷 Imagen';
    case 'document': return message.document?.caption || `📎 ${message.document?.filename || 'Documento'}`;
    case 'audio': return '🎤 Audio';
    case 'video': return message.video?.caption || '🎥 Video';
    case 'location': return '📍 Ubicación';
    case 'sticker': return '🙂 Sticker';
    default: return `[${message.type}]`;
  }
}

/** El adjunto, si lo hay: para el bloque de verificación de pagos. */
function attachmentOf(message) {
  // 'sticker' va al final porque no es un adjunto "de negocio" (nunca es un
  // comprobante), pero sí hay que guardarlo para poder pintarlo en el chat.
  for (const kind of ['image', 'document', 'audio', 'video', 'sticker']) {
    if (message[kind]?.id) {
      return { kind, mediaId: message[kind].id, mimeType: message[kind].mime_type, filename: message[kind].filename };
    }
  }
  return null;
}

/**
 * Descarga el adjunto de un mensaje entrante y lo deja guardado, para que el
 * panel pueda mostrarlo.
 *
 * Las URLs que devuelve Meta caducan y requieren el token de la cuenta, así
 * que no sirve de nada guardarlas: hay que traerse el archivo. Nunca lanza —
 * el mensaje ya está registrado con su texto, y quedarse sin la imagen es
 * mucho mejor que perder el mensaje entero o romper el webhook.
 */
async function guardarAdjunto({ accountId, messageId, attachment, provider, rawMessage }) {
  try {
    // Cada canal descarga a su manera: Cloud API pide el archivo a Meta con el
    // id y el token; Modo App lo descifra a partir del mensaje original. El
    // proveedor absorbe la diferencia.
    const archivo = await provider.downloadMedia({ mediaId: attachment.mediaId, raw: rawMessage });

    // Meta manda el mime con parámetros ("audio/ogg; codecs=opus"), y las
    // notas de voz siempre vienen así. Sin recortarlos, el tipo no coincide
    // con la lista de permitidos y se rechazaría cada nota de voz.
    const mime = String(archivo.mimeType || attachment.mimeType || '').split(';')[0].trim();

    const guardado = await storage.save({
      accountId,
      buffer: archivo.buffer,
      mimeType: mime,
      originalName: attachment.filename || '',
    });

    await query(
      `UPDATE messages
          SET media_url = $2, media_type = $3, media_mime = $4, media_name = $5
        WHERE id = $1`,
      [messageId, guardado.storagePath, guardado.type, mime, attachment.filename || null]
    );
    return { saved: true, type: guardado.type };
  } catch (err) {
    console.warn(`[engine] no se pudo guardar el adjunto del mensaje ${messageId}: ${err.message}`);
    return { saved: false, error: err.message };
  }
}

/* ==========================================================================
   Entrada principal
   ========================================================================== */

/**
 * Procesa un mensaje entrante ya extraído del webhook.
 * Devuelve un resumen de lo que decidió hacer — útil para las pruebas y el log.
 */
export async function handleIncomingMessage({
  phoneNumberId, accountId: fromAccountId, message, contactProfile,
  rawKey = null, rawMessage = null,
}) {
  const account = await resolveAccount({ accountId: fromAccountId, phoneNumberId });
  if (!account) return { skipped: 'cuenta_desconocida' };

  const accountId = account.account_id;
  const phone = `+${String(message.from).replace(/\D/g, '')}`;
  const text = textOf(message);

  /* 3 · Contacto y mensaje se registran siempre */
  const referral = message.referral || {};
  const contact = await upsertContact({
    accountId,
    phone,
    profileName: contactProfile?.name,
    adName: referral.headline || referral.source_id ? (referral.headline || 'Anuncio') : null,
    adId: referral.source_id || null,
    ctwaClid: referral.ctwa_clid || null,
  });

  const inserted = await one(
    `INSERT INTO messages (account_id, contact_id, direction, body, wa_message_id, status)
     VALUES ($1, $2, 'in', $3, $4, 'received')
     ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [accountId, contact.id, text, message.id]
  );

  // Meta reintenta la entrega: si ya lo teníamos, no se vuelve a responder
  if (!inserted) return { skipped: 'duplicado', contactId: contact.id };

  if (contact.is_new) {
    await log(accountId, `Nuevo contacto ${phone}${contact.ad_name ? ` · desde "${contact.ad_name}"` : ''}`, 'ok');
  }

  const attachment = attachmentOf(message);
  const result = {
    contactId: contact.id, accountId, text, attachment,
    isNew: contact.is_new, actions: [],
  };

  /* 3.5 · El adjunto se guarda SIEMPRE, antes de cualquier salida temprana.
     Que el bot esté detenido o la automatización pausada solo significa que
     no se responde solo — el operador tiene que poder ver igualmente la foto
     o escuchar el audio que le mandaron desde Chat en Vivo. */
  if (attachment) {
    const proveedorMedia = await providers.forAccount(accountId);
    if (proveedorMedia.ready) {
      const r = await guardarAdjunto({
        accountId, messageId: inserted.id, attachment,
        provider: proveedorMedia, rawMessage,
      });
      result.actions.push(r.saved ? `adjunto_guardado:${r.type}` : 'adjunto_no_guardado');
    }
  }

  /* 1 · El bot puede estar apagado: se guarda el mensaje pero no se responde */
  if (!account.bot_running) {
    result.actions.push('bot_detenido');
    return result;
  }

  /* 4 · El operador tomó el control de esta conversación */
  if (contact.automation_off || !contact.ai_enabled) {
    // ai_enabled apagado significa "yo respondo": los flujos sí siguen valiendo
    if (contact.automation_off) {
      result.actions.push('automatizacion_detenida');
      return result;
    }
  }

  /* Acuse de recibo: el contacto ve que su mensaje llegó.
     Cada canal lo marca a su manera — Cloud API por id de mensaje, Modo App
     por la clave del socket — y el proveedor se encarga de la diferencia. */
  providers.forAccount(accountId)
    .then((provider) => (provider.ready
      ? provider.markAsRead({ messageId: message.id, key: rawKey })
      : null))
    .catch(() => {});

  /* 4.5 · ¿Adjuntó un comprobante de pago? */
  if (attachment && ['image', 'document'].includes(attachment.kind)) {
    if (contact.status === 'paid') {
      result.actions.push('ya_estaba_pagado');
    } else {
      const veredicto = await receipts.processReceipt({
        accountId, contactId: contact.id,
        messageId: inserted.id, attachment, rawMessage,
      });
      result.actions.push(`comprobante:${veredicto.status}`);
      // Un comprobante no sigue al resto del pipeline: ya se respondió
      return result;
    }
  }

  /* 5 · ¿Había un flujo esperando respuesta? */
  const resumed = await flows.resumeFlow({ accountId, contactId: contact.id, text });
  if (resumed?.queued) {
    result.actions.push(`flujo_continuado:${resumed.queued}`);
    return result;
  }

  /* 5.5 · Respuestas rápidas: "transferencia", "tarjeta"… */
  const rapidas = await many(
    'SELECT keyword, reply FROM quick_replies WHERE account_id = $1', [accountId]);

  const textoNorm = flows.normalize(text);
  const rapida = rapidas.find((q) => q.keyword && textoNorm.includes(flows.normalize(q.keyword)));

  if (rapida?.reply) {
    await enqueue({ accountId, contactId: contact.id, body: rapida.reply, origin: 'flow' });
    await query(
      `UPDATE contacts SET status = 'pending' WHERE id = $1 AND status = 'new'`,
      [contact.id]);
    result.actions.push(`respuesta_rapida:${rapida.keyword}`);
    return result;
  }

  /* 6 · Disparadores */
  const trigger = await flows.matchTrigger(accountId, text);
  if (trigger?.flow_id) {
    const run = await flows.runFlow({ accountId, contactId: contact.id, flowId: trigger.flow_id });
    if (run.queued) {
      await log(accountId, `Disparador "${trigger.keyword}" → flujo "${run.flowName}" para ${phone}`);
      result.actions.push(`flujo:${run.flowName}`);
      return result;
    }
  }

  /* 7 · Respuesta de la IA */
  if (!contact.ai_enabled) {
    result.actions.push('ia_desactivada_para_el_contacto');
    return result;
  }

  const aiCfg = await ai.aiConfig(accountId);
  if (!aiCfg?.enabled) {
    result.actions.push('ia_desactivada');
    return result;
  }

  const answer = await ai.reply({ accountId, contactId: contact.id, config: aiCfg });
  if (!answer) {
    result.actions.push('ia_sin_respuesta');
    return result;
  }

  // El retraso configurado hace que la conversación no se sienta robótica
  await enqueue({
    accountId, contactId: contact.id,
    kind: 'text', body: answer, origin: 'ai',
    delaySeconds: aiCfg.delaySeconds,
  });
  result.actions.push('ia_respondio');

  return result;
}

/* ==========================================================================
   Estados de entrega
   ========================================================================== */

/** Actualiza el estado de un mensaje saliente (enviado, entregado, leído, fallido). */
export async function handleStatus({ phoneNumberId, status }) {
  const account = await accountForPhoneNumberId(phoneNumberId);
  if (!account) return { skipped: 'cuenta_desconocida' };

  const column = {
    delivered: 'delivered_at',
    read: 'read_at',
    failed: 'failed_at',
  }[status.status];

  if (!column) return { skipped: 'estado_ignorado' };

  await query(
    `UPDATE messages SET ${column} = now(), status = $2,
            error = COALESCE($3, error)
      WHERE wa_message_id = $1`,
    [status.id, status.status, status.errors?.[0]?.title || null]
  );

  if (status.status === 'failed') {
    const detail = status.errors?.[0];
    await log(
      account.account_id,
      `Entrega fallida (${detail?.code || 's/c'}): ${detail?.title || 'sin detalle'}`,
      'err'
    );
  }

  return { updated: status.status };
}

/**
 * Detiene toda la automatización de un contacto: cancela lo encolado, marca
 * los flujos en curso y apaga la IA. Lo usa el botón del panel.
 */
export async function stopAutomation({ accountId, contactId }) {
  // Las tres consultas filtran por account_id, no solo por contact_id: sin
  // esto, una cuenta que conociera (o adivinara) el UUID de un contacto ajeno
  // podía cancelar en silencio mensajes en cola y flujos en curso de OTRO
  // negocio. `contacts` ya se protegía así; `outbox` y `flow_runs` no.
  const contact = await one(
    'SELECT id FROM contacts WHERE id = $1 AND account_id = $2',
    [contactId, accountId]
  );
  if (!contact) return;

  await query(
    `UPDATE outbox SET status = 'canceled', last_error = 'automatización detenida'
      WHERE contact_id = $1 AND account_id = $2 AND status = 'pending'`,
    [contactId, accountId]
  );
  await query(
    `UPDATE flow_runs SET status = 'canceled', updated_at = now()
      WHERE contact_id = $1 AND account_id = $2 AND status IN ('running', 'waiting')`,
    [contactId, accountId]
  );
  await query(
    'UPDATE contacts SET automation_off = true, ai_enabled = false WHERE id = $1 AND account_id = $2',
    [contactId, accountId]
  );
  await log(accountId, 'Automatización detenida para un contacto', 'warn');
}

/** Envío manual desde el panel: entra por la misma cola que todo lo demás. */
/**
 * Rellena el cuerpo de una plantilla con los valores del operador, solo para
 * guardarlo legible en el historial. Lo que Meta envía es la plantilla que
 * tiene registrada; esto es lo que se ve en Chat en Vivo.
 */
export function renderTemplate(body, values) {
  return String(body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? `{{${n}}}`);
}

/**
 * Envía una plantilla aprobada. Es la única vía para escribirle a alguien
 * cuando ya pasaron 24 h desde su último mensaje: fuera de esa ventana Meta
 * rechaza el texto libre y el cliente nunca llega a verlo.
 */
export async function sendTemplateTo({ accountId, contactId, template, values = [] }) {
  const contact = await one(
    'SELECT id FROM contacts WHERE id = $1 AND account_id = $2',
    [contactId, accountId]
  );
  if (!contact) return { error: 'contacto_inexistente' };

  // Meta espera los valores en el orden de {{1}}, {{2}}… dentro de "body".
  const components = values.length
    ? [{ type: 'body', parameters: values.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];

  const item = await enqueue({
    accountId, contactId,
    kind: 'template',
    // El texto ya resuelto es lo que verá el operador en el historial
    body: renderTemplate(template.body, values),
    payload: { name: template.name, language: template.language, components },
    origin: 'manual',
  });

  drain({ limit: 5 }).catch((err) => console.error('[engine] drain inmediato tras plantilla:', err.message));
  return { queued: item.id };
}

export async function sendManual({ accountId, contactId, body, mediaName }) {
  const contact = await one(
    'SELECT last_inbound_at FROM contacts WHERE id = $1 AND account_id = $2',
    [contactId, accountId]
  );
  if (!contact) return { error: 'contacto_inexistente' };

  // Cloud API solo permite texto libre dentro de las 24 h del último mensaje
  // del contacto: fuera de ahí hace falta plantilla y Meta la cobra. Se avisa
  // en vez de dejar que el envío falle sin explicación.
  //
  // En Modo App esa ventana no existe —es el teléfono del cliente escribiendo
  // a sus propios contactos— así que el aviso sobraría y se omite.
  const provider = await providers.forAccount(accountId);
  const outsideWindow = provider.capabilities.window24h && (
    !contact.last_inbound_at
    || Date.now() - new Date(contact.last_inbound_at).getTime() > 24 * 3600 * 1000
  );

  const item = await enqueue({
    accountId, contactId,
    kind: mediaName ? 'media' : 'text',
    body: body || '',
    mediaName: mediaName || null,
    origin: 'manual',
  });

  // Un mensaje manual es una acción del operador, en vivo: no tiene sentido
  // hacerlo esperar hasta 3 s por el siguiente tick del trabajador periódico.
  // Se dispara un intento inmediato sin bloquear la respuesta — si falla
  // (Graph API caída, etc.), el trabajador normal lo retoma igual.
  drain({ limit: 5 }).catch((err) => console.error('[engine] drain inmediato tras envío manual:', err.message));

  return { queued: item.id, outsideWindow };
}
