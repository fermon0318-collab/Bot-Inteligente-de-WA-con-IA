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
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat as fsStat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ROOT } from '../config.js';
import { compressVideo } from './videoCompress.js';

const UPLOADS = process.env.UPLOADS_DIR || join(ROOT, 'uploads');

/** Tipos permitidos. Todo lo demás se rechaza. */
export const ALLOWED = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'application/pdf': 'pdf',
  'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio',
  'video/mp4': 'video',
};

/**
 * Límite de tamaño POR TIPO — calcado de los límites reales que Meta impone a
 * cada uno, no un único número igual para todos.
 *
 * Antes había un solo `MAX_BYTES` de 16 MB para cualquier archivo, incluidos
 * los documentos. Eso rechazaba en silencio documentos legítimos de más de
 * 16 MB (Meta permite hasta 100) y, más grave, videos recibidos por WhatsApp
 * de poco más de medio minuto: un archivo así de común supera los 16 MB con
 * facilidad. `guardarAdjunto` (engine.js) atrapa el error y solo dice
 * "no se pudo guardar el adjunto" en el log — el mensaje queda en el chat sin
 * ninguna foto ni video que mostrar, y sin ningún aviso visible para quien
 * atiende. Es la causa más probable de "no me deja ver las imágenes/videos
 * que envían": el archivo sí se descargaba, pero se descartaba al guardarlo.
 */
export const MAX_BYTES_BY_TYPE = {
  image: 5 * 1024 * 1024,    // límite real de Meta para imágenes
  audio: 16 * 1024 * 1024,   // límite real de Meta para audio
  video: 16 * 1024 * 1024,   // límite real de Meta para video
  pdf: 100 * 1024 * 1024,    // límite real de Meta para documentos
};

/** El mayor de los límites por tipo: techo en bruto antes de saber cuál es. */
export const MAX_BYTES = Math.max(...Object.values(MAX_BYTES_BY_TYPE));

/**
 * Comprueba los primeros bytes del archivo contra la firma real de cada
 * formato ("magic bytes"). El `Content-Type` de un `multipart/form-data` lo
 * declara quien sube el archivo — nada impide que mienta. Antes `save()`
 * confiaba en esa declaración a ciegas: un archivo con cualquier contenido
 * podía guardarse etiquetado como "image/jpeg" con solo decir que lo era.
 *
 * No hace falta una librería para esto: el conjunto de formatos permitidos
 * es pequeño y sus firmas son públicas y estables.
 */
function firmaCoincide(buffer, mimeType) {
  const b = buffer;
  switch (mimeType) {
    case 'image/jpeg':
      return b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case 'image/png':
      return b.length >= 8 && b.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    case 'image/webp':
      return b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF'
        && b.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'application/pdf':
      return b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'audio/ogg':
      return b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'OggS';
    case 'audio/mpeg':
      // Con etiqueta ID3, o un frame MPEG crudo (sync de 11 bits: 0xFF seguido
      // de un byte cuyos 3 bits altos también están encendidos).
      return b.length >= 3 && (
        b.subarray(0, 3).toString('ascii') === 'ID3'
        || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)
      );
    case 'audio/mp4':
    case 'video/mp4':
      // Contenedor ISO base media (MP4/M4A comparten el mismo envoltorio):
      // 4 bytes de tamaño de caja y luego el literal "ftyp".
      return b.length >= 8 && b.subarray(4, 8).toString('ascii') === 'ftyp';
    default:
      return false;
  }
}

export async function save({ accountId, buffer, mimeType, originalName }) {
  const type = ALLOWED[mimeType];
  if (!type) {
    throw Object.assign(new Error(`Tipo de archivo no permitido: ${mimeType}`),
      { status: 400, code: 'unsupported_type' });
  }
  if (!firmaCoincide(buffer, mimeType)) {
    throw Object.assign(
      new Error('El contenido del archivo no coincide con el tipo declarado'),
      { status: 400, code: 'content_mismatch' }
    );
  }
  const limite = MAX_BYTES_BY_TYPE[type] || MAX_BYTES;

  let contenido = buffer;
  if (type === 'video' && contenido.length > limite) {
    // La app oficial de WhatsApp no tiene un límite más alto: comprime el
    // video antes de enviarlo para que quepa bajo el mismo límite de Meta.
    // Esto hace lo mismo, en vez de rechazar de una un archivo que un
    // cliente cualquiera podría enviar sin pensarlo dos veces.
    try {
      contenido = await compressVideo(contenido, limite);
    } catch (err) {
      throw Object.assign(
        new Error(`El video supera los ${Math.round(limite / 1024 / 1024)} MB permitidos y no se pudo comprimir lo suficiente: ${err.message}`),
        { status: 400, code: 'too_large' }
      );
    }
  }

  if (contenido.length > limite) {
    throw Object.assign(
      new Error(`El archivo supera los ${Math.round(limite / 1024 / 1024)} MB permitidos para este tipo`),
      { status: 400, code: 'too_large' }
    );
  }

  const dir = join(UPLOADS, accountId);
  await mkdir(dir, { recursive: true });

  const safeName = `${randomBytes(16).toString('hex')}${extname(originalName).slice(0, 10)}`;
  const path = join(dir, safeName);
  await writeFile(path, contenido);

  return {
    storagePath: join(accountId, safeName),
    checksum: createHash('sha256').update(contenido).digest('hex'),
    type,
    size: contenido.length,
  };
}

export const read = (storagePath) => readFile(join(UPLOADS, storagePath));

/** Tamaño en disco, sin leer el contenido — lo necesita el servido por rangos. */
export const size = async (storagePath) => (await fsStat(join(UPLOADS, storagePath))).size;

/**
 * Stream de una porción del archivo (o de todo, si no se pide rango).
 * Es lo que permite responder 206 Partial Content: sin esto, un <audio> o
 * <video> que pide "dame los últimos bytes para seguir donde iba" siempre
 * recibe el archivo entero desde el principio, y navegadores como Safari
 * directamente cortan la reproducción en vez de tolerarlo.
 */
export const readRange = (storagePath, { start, end } = {}) =>
  createReadStream(join(UPLOADS, storagePath), start === undefined ? undefined : { start, end });

export async function remove(storagePath) {
  try { await unlink(join(UPLOADS, storagePath)); } catch { /* ya no estaba */ }
}
