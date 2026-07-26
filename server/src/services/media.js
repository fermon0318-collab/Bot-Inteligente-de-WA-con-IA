/**
 * Alta de archivos: disco + subida a Meta.
 *
 * Se sube a Meta en el momento del alta y no al enviar, porque subir tarda
 * segundos y hacerlo dentro de un flujo retrasaría toda la conversación.
 */

import { one, query } from '../db/pool.js';
import * as storage from './storage.js';
import * as wa from './whatsapp.js';

/** Los media_id de Meta caducan a los 30 días. Se renuevan a los 25. */
const RENEW_AFTER_DAYS = 25;

export async function addFile({ accountId, buffer, mimeType, originalName }) {
  const stored = await storage.save({ accountId, buffer, mimeType, originalName });

  const row = await one(
    `INSERT INTO media_files (account_id, name, file_type, mime_type, size_bytes,
                              storage_path, checksum)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account_id, name) DO UPDATE SET
       file_type = EXCLUDED.file_type, mime_type = EXCLUDED.mime_type,
       size_bytes = EXCLUDED.size_bytes, storage_path = EXCLUDED.storage_path,
       checksum = EXCLUDED.checksum, wa_media_id = NULL, wa_uploaded_at = NULL
     RETURNING id, name, file_type, size_bytes, created_at`,
    [accountId, originalName, stored.type, mimeType, stored.size,
     stored.storagePath, stored.checksum]
  );

  // La subida a Meta no debe tumbar el alta: si falla, se reintenta al enviar
  ensureUploaded(accountId, row.id).catch((err) =>
    console.warn(`[media] no se pudo subir "${originalName}" a Meta: ${err.message}`));

  return row;
}

/** Garantiza que el archivo tiene un media_id vigente en Meta. */
export async function ensureUploaded(accountId, mediaFileId) {
  const file = await one(
    `SELECT id, name, mime_type, storage_path, wa_media_id, wa_uploaded_at
       FROM media_files WHERE id = $1 AND account_id = $2`,
    [mediaFileId, accountId]
  );
  if (!file) throw new Error('El archivo no existe');

  const fresh = file.wa_media_id && file.wa_uploaded_at
    && Date.now() - new Date(file.wa_uploaded_at).getTime() < RENEW_AFTER_DAYS * 86400_000;
  if (fresh) return file.wa_media_id;

  const cfg = await wa.accountConfig(accountId);
  if (!cfg?.token || !cfg.phoneNumberId) throw new Error('Cloud API sin configurar');

  const buffer = await storage.read(file.storage_path);
  const mediaId = await wa.uploadMedia({
    token: cfg.token, phoneNumberId: cfg.phoneNumberId,
    buffer, mimeType: file.mime_type, filename: file.name,
  });

  await query(
    'UPDATE media_files SET wa_media_id = $2, wa_uploaded_at = now() WHERE id = $1',
    [file.id, mediaId]
  );
  return mediaId;
}

export async function removeFile({ accountId, mediaFileId }) {
  const file = await one(
    'DELETE FROM media_files WHERE id = $1 AND account_id = $2 RETURNING storage_path',
    [mediaFileId, accountId]
  );
  if (file?.storage_path) await storage.remove(file.storage_path);
  return Boolean(file);
}
