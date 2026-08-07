/**
 * Compresión de video para caber en el límite de Meta.
 *
 * La app oficial de WhatsApp no tiene un límite mayor que la Cloud API: lo
 * que hace es comprimir el video antes de enviarlo para que quepa bajo esos
 * mismos ~16 MB, sin que el usuario lo note. Esto reproduce lo mismo aquí,
 * calculando el bitrate de video necesario para llegar al tamaño objetivo
 * según la duración real del archivo (más simple y confiable que probar CRF
 * a ciegas hasta acertar el tamaño).
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const AUDIO_KBPS = 96;
/** Margen bajo el límite: el cálculo de bitrate nunca es exacto al byte. */
const MARGEN = 0.9;
/** Por debajo de esto el video queda inservible — mejor rechazarlo que entregar basura. */
const MIN_VIDEO_KBPS = 150;

function ejecutar(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} salió con código ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function duracionSegundos(path) {
  const stdout = await new Promise((resolve, reject) => {
    const proc = spawn(ffprobeStatic.path, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
  });
  const seg = parseFloat(stdout);
  return Number.isFinite(seg) && seg > 0 ? seg : null;
}

/**
 * Comprime `buffer` (video/mp4) para que quede bajo `maxBytes`.
 * Devuelve el buffer comprimido, o el original si ya estaba bajo el límite.
 * Lanza si no logra comprimirlo lo suficiente (video demasiado largo para el
 * límite incluso a calidad mínima aceptable).
 */
export async function compressVideo(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer;

  const dir = await mkdtemp(join(tmpdir(), 'elorai-video-'));
  const entrada = join(dir, `${randomBytes(8).toString('hex')}.mp4`);
  const salida = join(dir, `${randomBytes(8).toString('hex')}.mp4`);

  try {
    await writeFile(entrada, buffer);

    const duracion = await duracionSegundos(entrada);
    if (!duracion) {
      throw Object.assign(new Error('No se pudo leer la duración del video'), { code: 'video_ilegible' });
    }

    // Bits disponibles para todo el archivo, repartidos entre video y audio.
    const bitrateTotalKbps = (maxBytes * 8 * MARGEN) / duracion / 1000;
    const bitrateVideoKbps = Math.floor(bitrateTotalKbps - AUDIO_KBPS);

    if (bitrateVideoKbps < MIN_VIDEO_KBPS) {
      throw Object.assign(
        new Error('El video es demasiado largo para comprimirlo y que quede en buena calidad bajo el límite de Meta'),
        { code: 'video_muy_largo' }
      );
    }

    await ejecutar(ffmpegPath, [
      '-y', '-i', entrada,
      // 720p como techo: más resolución no ayuda en WhatsApp y solo gasta bitrate.
      '-vf', "scale='min(1280,iw)':'-2'",
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${bitrateVideoKbps}k`, '-maxrate', `${bitrateVideoKbps}k`,
      '-bufsize', `${bitrateVideoKbps * 2}k`,
      '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
      '-movflags', '+faststart',
      salida,
    ]);

    const comprimido = await readFile(salida);
    if (comprimido.length > maxBytes) {
      // El cálculo por bitrate no es exacto al byte; un solo reintento más
      // agresivo cubre el margen de error sin complicar esto con más pasadas.
      const ajuste = Math.floor(bitrateVideoKbps * (maxBytes / comprimido.length) * 0.95);
      await ejecutar(ffmpegPath, [
        '-y', '-i', entrada,
        '-vf', "scale='min(1280,iw)':'-2'",
        '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', `${ajuste}k`, '-maxrate', `${ajuste}k`, '-bufsize', `${ajuste * 2}k`,
        '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`,
        '-movflags', '+faststart',
        salida,
      ]);
      const segundoIntento = await readFile(salida);
      if (segundoIntento.length > maxBytes) {
        throw Object.assign(
          new Error('No se logró comprimir el video lo suficiente para el límite de Meta'),
          { code: 'compresion_insuficiente' }
        );
      }
      return segundoIntento;
    }

    return comprimido;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
