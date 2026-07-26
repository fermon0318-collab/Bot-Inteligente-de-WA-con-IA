/**
 * Almacenamiento de archivos en disco.
 *
 * Cada cuenta tiene su carpeta. El nombre en disco es aleatorio: si se usara
 * el nombre original, un cliente podría subir "../../etc/passwd" o pisar el
 * archivo de otro.
 *
 * En Railway este directorio vive en el filesystem efímero del contenedor a
 * menos que se monte un Volume en UPLOADS_DIR — sin eso, los archivos
 * desaparecen en el siguiente despliegue (ver docs/deploy-railway.md).
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ROOT } from '../config.js';

const UPLOADS = process.env.UPLOADS_DIR || join(ROOT, 'uploads');

/** Tipos permitidos. Todo lo demás se rechaza. */
export const ALLOWED = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'application/pdf': 'pdf',
  'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio',
  'video/mp4': 'video',
};

/** Límite de Meta para documentos. */
export const MAX_BYTES = 16 * 1024 * 1024;

export async function save({ accountId, buffer, mimeType, originalName }) {
  if (!ALLOWED[mimeType]) {
    throw Object.assign(new Error(`Tipo de archivo no permitido: ${mimeType}`),
      { status: 400, code: 'unsupported_type' });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('El archivo supera los 16 MB'),
      { status: 400, code: 'too_large' });
  }

  const dir = join(UPLOADS, accountId);
  await mkdir(dir, { recursive: true });

  const safeName = `${randomBytes(16).toString('hex')}${extname(originalName).slice(0, 10)}`;
  const path = join(dir, safeName);
  await writeFile(path, buffer);

  return {
    storagePath: join(accountId, safeName),
    checksum: createHash('sha256').update(buffer).digest('hex'),
    type: ALLOWED[mimeType],
    size: buffer.length,
  };
}

export const read = (storagePath) => readFile(join(UPLOADS, storagePath));

export async function remove(storagePath) {
  try { await unlink(join(UPLOADS, storagePath)); } catch { /* ya no estaba */ }
}
