/**
 * Proveedor "cloud": WhatsApp Cloud API de Meta.
 *
 * Envuelve `services/whatsapp.js`, que ya existía, en la interfaz común de
 * `providers/`. No cambia ningún comportamiento: la lógica de la Graph API
 * sigue viviendo donde estaba.
 */

import * as media from '../media.js';
import * as wa from '../whatsapp.js';

export const name = 'cloud';

export async function build(accountId) {
  const cfg = await wa.accountConfig(accountId);
  const ready = Boolean(cfg?.token && cfg.phoneNumberId);

  return {
    name,
    accountId,
    ready,
    reason: ready ? null : 'La cuenta no tiene Cloud API configurada',
    // Sin token no hay nada que esperar: esto no se arregla solo, lo arregla
    // el cliente en la pantalla de Cloud API.
    readyRetryable: false,

    capabilities: {
      // Fuera de la ventana de 24 h Meta solo deja plantillas aprobadas, y las
      // cobra. Es exactamente el motivo por el que existe Modo App.
      templates: true,
      window24h: true,
      // Los archivos se suben a Meta y se reutilizan por media_id.
      mediaById: true,
    },

    /** Modo App impone un ritmo; aquí lo impone Meta con sus propios límites. */
    async beforeSend() {
      return { allow: true };
    },
    async afterSend() {},

    async sendText({ to, body }) {
      return wa.sendText({ token: cfg.token, phoneNumberId: cfg.phoneNumberId, to, body });
    },

    async sendMedia({ to, mediaFileId, kind, filename, caption }) {
      const mediaId = await media.ensureUploaded(accountId, mediaFileId);
      return wa.sendMedia({
        token: cfg.token, phoneNumberId: cfg.phoneNumberId, to,
        mediaId, kind, filename, caption,
      });
    },

    async sendTemplate({ to, name: template, language, components }) {
      return wa.sendTemplate({
        token: cfg.token, phoneNumberId: cfg.phoneNumberId, to,
        name: template, language, components,
      });
    },

    async markAsRead({ messageId }) {
      if (!messageId) return;
      await wa.markAsRead({ token: cfg.token, phoneNumberId: cfg.phoneNumberId, messageId });
    },

    /**
     * Descarga un adjunto entrante. Las URLs de Meta caducan y exigen el token
     * de la cuenta, así que hay que traerse el archivo, no guardar el enlace.
     */
    async downloadMedia({ mediaId }) {
      return wa.downloadMedia({ token: cfg.token, mediaId });
    },
  };
}
