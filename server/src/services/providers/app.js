/**
 * Proveedor "app": el teléfono del cliente vinculado por QR (Baileys).
 *
 * La diferencia de fondo con Cloud API no es técnica, es de responsabilidad.
 * Allí Meta pone los límites, cobra las conversaciones y devuelve un error
 * cuando algo no se puede hacer. Aquí no hay nadie delante: el número es el
 * del cliente, con años de historial, y si el software se pasa de rosca lo
 * que se pierde es esa cuenta. Por eso este proveedor es el único que tiene
 * `beforeSend` con dientes — el ritmo no es una recomendación, es la puerta
 * por la que pasa cada mensaje.
 */

import { one } from '../../db/pool.js';
import * as pacing from '../../wa/app/pacing.js';
import * as session from '../../wa/app/session.js';
import * as storage from '../storage.js';

export const name = 'app';

export async function build(accountId) {
  const row = await session.getSessionRow(accountId);
  const connected = row?.status === 'connected' && session.isConnected(accountId);

  return {
    name,
    accountId,
    session: row,
    ready: connected && !row?.paused,
    reason: !row ? 'Modo App no está configurado'
      : row.paused ? (row.paused_reason || 'Envíos en pausa por riesgo de bloqueo')
      : !connected ? 'El teléfono no está vinculado. Escanea el código QR en Modo App.'
      : null,
    // Una sesión caída se reconecta sola y una pausa se levanta desde el
    // panel: el mensaje espera en la cola en vez de darse por perdido.
    readyRetryable: true,

    capabilities: {
      // No hay plantillas ni ventana de 24 h: el cliente escribe a sus
      // contactos como lo haría desde el teléfono, sin coste por mensaje.
      templates: false,
      window24h: false,
      // Los archivos se envían desde disco en cada envío; no hay media_id.
      mediaById: false,
    },

    /**
     * Puerta de ritmo. Devuelve `{ allow: false, retryInSeconds }` para que la
     * cola reprograme, o `{ drop: true }` para descartar un duplicado.
     */
    async beforeSend({ contactId, body }) {
      if (!row) return { allow: false, retryInSeconds: 600, reason: 'Modo App sin configurar' };
      return pacing.checkQuota({ accountId, session: row, contactId, body });
    },

    /** Deja constancia del envío: es lo que alimenta límites y guardián. */
    async afterSend({ contactId, phone, body, kind, origin }) {
      // ¿Este contacto había escrito primero alguna vez? Un envío a alguien que
      // nunca inició conversación es lo que Meta considera contacto en frío, y
      // el detector de políticas necesita saberlo en el momento del envío.
      const contacto = contactId
        ? await one('SELECT last_inbound_at FROM contacts WHERE id = $1', [contactId])
        : null;

      await pacing.recordSend({
        accountId, contactId, phone, body, kind, origin,
        inboundFirst: Boolean(contacto?.last_inbound_at),
      });
    },

    async sendText({ to, body }) {
      return session.sendText({ accountId, to, body });
    },

    async sendMedia({ to, mediaFileId, kind, filename, caption }) {
      const file = await one(
        'SELECT storage_path, mime_type, name FROM media_files WHERE id = $1 AND account_id = $2',
        [mediaFileId, accountId]
      );
      if (!file) throw new Error('El archivo ya no existe');

      const buffer = await storage.read(file.storage_path);
      return session.sendMedia({
        accountId, to, buffer,
        mimeType: file.mime_type,
        filename: filename || file.name,
        caption, kind,
      });
    },

    async sendTemplate() {
      // Las plantillas son un artefacto de Cloud API: existen porque Meta
      // exige una aprobación previa para escribir fuera de la ventana de 24 h.
      // Aquí esa restricción no existe, así que un flujo con plantilla se
      // convierte en texto normal antes de llegar hasta aquí (ver outbox.js).
      const err = new Error('Modo App no usa plantillas: envía el texto directamente.');
      err.permanent = true;
      throw err;
    },

    async markAsRead({ key }) {
      await session.markAsRead({ accountId, key });
    },

    /**
     * Descarga un adjunto entrante a partir del mensaje original: aquí el
     * archivo viaja cifrado y no hay un id que pedirle a nadie.
     */
    async downloadMedia({ raw }) {
      if (!raw) throw new Error('Falta el mensaje original para descargar el adjunto');
      return session.downloadMedia({ accountId, raw });
    },
  };
}
