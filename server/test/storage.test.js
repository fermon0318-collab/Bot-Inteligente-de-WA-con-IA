import './setup.js';

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// storage.js lee UPLOADS_DIR al cargarse: hay que fijarlo ANTES del import.
const dir = join(tmpdir(), `elorai-storage-test-${randomBytes(4).toString('hex')}`);
process.env.UPLOADS_DIR = dir;

const storage = await import('../src/services/storage.js');

const ACCOUNT = 'aaaaaaaa-0000-0000-0000-000000000000';

test.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));

/* --------------------------------------------------------------------------
   Bytes mágicos: el Content-Type de un multipart lo declara quien sube el
   archivo. Sin comprobar el contenido real, cualquier cosa podía guardarse
   etiquetada como una imagen con solo decirlo.
   -------------------------------------------------------------------------- */

test('save() acepta un JPEG cuya firma coincide con lo declarado', async () => {
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
  const r = await storage.save({ accountId: ACCOUNT, buffer: jpeg, mimeType: 'image/jpeg', originalName: 'foto.jpg' });
  assert.equal(r.type, 'image');
});

test('save() rechaza contenido que no coincide con el tipo declarado', async () => {
  const noEsImagen = Buffer.from('esto es texto plano, no una imagen');
  await assert.rejects(
    storage.save({ accountId: ACCOUNT, buffer: noEsImagen, mimeType: 'image/jpeg', originalName: 'falso.jpg' }),
    /no coincide/
  );
});

test('save() rechaza un ejecutable disfrazado de PDF', async () => {
  const cabeceraExe = Buffer.from([0x4D, 0x5A, 0x90, 0x00]); // "MZ": cabecera real de un .exe
  await assert.rejects(
    storage.save({ accountId: ACCOUNT, buffer: cabeceraExe, mimeType: 'application/pdf', originalName: 'factura.pdf' }),
    /no coincide/
  );
});

test('save() acepta PNG, WEBP, PDF, OGG y MP4 con su firma real', async () => {
  const casos = [
    { mimeType: 'image/png', tipo: 'image', firma: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
    { mimeType: 'application/pdf', tipo: 'pdf', firma: Buffer.from('%PDF-1.4') },
    { mimeType: 'audio/ogg', tipo: 'audio', firma: Buffer.from('OggS') },
  ];
  for (const { mimeType, tipo, firma } of casos) {
    const buffer = Buffer.concat([Buffer.from(firma), Buffer.alloc(16)]);
    const r = await storage.save({ accountId: ACCOUNT, buffer, mimeType, originalName: 'x' });
    assert.equal(r.type, tipo, `${mimeType} debería reconocerse como ${tipo}`);
  }

  // WEBP: RIFF....WEBP
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  const rWebp = await storage.save({ accountId: ACCOUNT, buffer: webp, mimeType: 'image/webp', originalName: 'x.webp' });
  assert.equal(rWebp.type, 'image');

  // MP4/M4A: caja "ftyp" a partir del byte 4
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(16)]);
  const rMp4 = await storage.save({ accountId: ACCOUNT, buffer: mp4, mimeType: 'video/mp4', originalName: 'x.mp4' });
  assert.equal(rMp4.type, 'video');
});

test('save() rechaza un tipo MIME que no está en la lista permitida', async () => {
  await assert.rejects(
    storage.save({ accountId: ACCOUNT, buffer: Buffer.from('x'), mimeType: 'application/x-msdownload', originalName: 'x.exe' }),
    /no permitido/
  );
});

/* --------------------------------------------------------------------------
   Límites de tamaño por tipo: antes un único MAX_BYTES de 16 MB se aplicaba
   a todo por igual, rechazando en silencio documentos y videos legítimos.
   -------------------------------------------------------------------------- */

test('save() aplica el límite real de Meta por tipo, no un tope único', async () => {
  const video15MB = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(15 * 1024 * 1024)]);
  const r = await storage.save({ accountId: ACCOUNT, buffer: video15MB, mimeType: 'video/mp4', originalName: 'clip.mp4' });
  assert.equal(r.type, 'video');

  const imagen8MB = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(8 * 1024 * 1024)]);
  await assert.rejects(
    storage.save({ accountId: ACCOUNT, buffer: imagen8MB, mimeType: 'image/jpeg', originalName: 'grande.jpg' }),
    /5 MB/
  );

  const documento50MB = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(50 * 1024 * 1024)]);
  const rPdf = await storage.save({ accountId: ACCOUNT, buffer: documento50MB, mimeType: 'application/pdf', originalName: 'catalogo.pdf' });
  assert.equal(rPdf.type, 'pdf');
});

/* --------------------------------------------------------------------------
   Servido por rangos: lo necesita cualquier <audio>/<video> para reproducir
   sin cortes. read()/readRange()/size() son las piezas que usa la ruta HTTP.
   -------------------------------------------------------------------------- */

test('readRange() devuelve exactamente el tramo pedido', async () => {
  const contenido = Buffer.from('0123456789ABCDEF');
  const { storagePath } = await storage.save({
    accountId: ACCOUNT,
    buffer: Buffer.concat([Buffer.from('OggS'), contenido]),
    mimeType: 'audio/ogg', originalName: 'x.ogg',
  });

  const total = await storage.size(storagePath);
  assert.equal(total, 4 + contenido.length);

  const chunks = [];
  for await (const chunk of storage.readRange(storagePath, { start: 4, end: 4 + contenido.length - 1 })) {
    chunks.push(chunk);
  }
  assert.equal(Buffer.concat(chunks).toString(), contenido.toString());
});
