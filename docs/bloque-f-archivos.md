# Bloque F · Archivos

**Empieza por aquí.** Sin esto, el bloque B no puede entregar productos.

## Qué vas a construir

Hoy `GET /api/media` y `DELETE /api/media/:id` existen, pero **nada sube
archivos**. Al terminar:

- El cliente arrastra un PDF al panel y se guarda en el servidor
- Ese archivo se sube a Meta y se guarda su `wa_media_id`
- Los flujos pueden enviarlo (`outbox.js` ya lo soporta, le falta el id)

**Tiempo estimado:** 3–4 horas.

---

## Paso 1 · Migración

`server/src/db/migrations/003_media.sql`

```sql
-- Datos que faltan para gestionar archivos de verdad
ALTER TABLE media_files
    ADD COLUMN mime_type       text NOT NULL DEFAULT '',
    ADD COLUMN wa_uploaded_at  timestamptz,
    ADD COLUMN checksum        text;

-- Meta caduca los media_id a los 30 días: hay que saber cuáles renovar
CREATE INDEX media_wa_expiry_idx ON media_files (wa_uploaded_at)
    WHERE wa_media_id IS NOT NULL;

-- Un mismo nombre dos veces en la misma cuenta rompe el envío por nombre
CREATE UNIQUE INDEX media_name_uniq ON media_files (account_id, name);
```

Aplícala:

```bash
cd server && npm run migrate
```

> Si falla por nombres duplicados, límpialos antes:
> `DELETE FROM media_files a USING media_files b WHERE a.id > b.id AND a.account_id = b.account_id AND a.name = b.name;`

---

## Paso 2 · Dependencia para subir archivos

Express no procesa `multipart/form-data` por sí solo.

```bash
cd server && npm install multer@^1.4.5-lts.1
```

---

## Paso 3 · Servicio de almacenamiento

`server/src/services/storage.js` (nuevo)

```js
/**
 * Almacenamiento de archivos en disco.
 *
 * Cada cuenta tiene su carpeta. El nombre en disco es aleatorio: si se usara
 * el nombre original, un cliente podría subir "../../etc/passwd" o pisar el
 * archivo de otro.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { SERVER_ROOT } from '../config.js';

const UPLOADS = process.env.UPLOADS_DIR || join(SERVER_ROOT, '..', 'uploads');

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
```

Necesitas exportar `SERVER_ROOT` desde `config.js` — ya está exportado, comprueba
que la línea existe:

```js
export const SERVER_ROOT = join(here, '..');
```

---

## Paso 4 · Servicio de medios

`server/src/services/media.js` (nuevo)

```js
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
```

---

## Paso 5 · Endpoint de subida

En `server/src/routes/api.js`, arriba con los demás imports:

```js
import multer from 'multer';
import * as media from '../services/media.js';
import { ALLOWED, MAX_BYTES } from '../services/storage.js';

// En memoria: los archivos son pequeños y así no hay temporales que limpiar
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype])),
});
```

Sustituye el `DELETE /media/:id` que ya existe y añade el POST:

```js
router.post('/media', requireSubscription, upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'validation', message: 'No llegó ningún archivo.' });
    }

    const saved = [];
    const rejected = [];

    for (const file of files) {
      try {
        saved.push(await media.addFile({
          accountId: account(req),
          buffer: file.buffer,
          mimeType: file.mimetype,
          originalName: file.originalname,
        }));
      } catch (err) {
        rejected.push({ name: file.originalname, reason: err.message });
      }
    }

    await log(account(req), `${saved.length} archivo(s) subidos`, 'ok');
    res.status(201).json({ saved, rejected });
  } catch (err) {
    next(err);
  }
});

router.delete('/media/:id', requireSubscription, async (req, res, next) => {
  try {
    const ok = await media.removeFile({ accountId: account(req), mediaFileId: req.params.id });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

---

## Paso 6 · Que el envío se autorrepare

En `server/src/services/outbox.js`, dentro de `dispatch()`, sustituye el bloque
`if (item.kind === 'media')`:

```js
if (item.kind === 'media') {
  const file = await one(
    'SELECT id, name, file_type, wa_media_id FROM media_files WHERE account_id = $1 AND name = $2',
    [item.account_id, item.media_name]
  );
  if (!file) {
    await fail(item, `El archivo "${item.media_name}" ya no existe`, true);
    return 'failed';
  }

  // Si no tiene media_id o caducó, se sube ahora en vez de fallar
  const mediaId = await media.ensureUploaded(item.account_id, file.id);

  messageId = await wa.sendMedia({
    token: cfg.token, phoneNumberId: cfg.phoneNumberId, to,
    mediaId,
    kind: file.file_type === 'pdf' ? 'document' : file.file_type,
    filename: file.name,
    caption: item.body || undefined,
  });
}
```

Y arriba: `import * as media from './media.js';`

---

## Paso 7 · Conectar el panel

En `assets/js/automation.js`, la función `uploadFiles` guarda en `App.MEDIA`.
Sustitúyela por:

```js
async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const form = new FormData();
  files.forEach((f) => form.append('files', f));

  App.toast(`Subiendo ${files.length} archivo(s)…`, 'info');

  try {
    const res = await fetch('/api/media', {
      method: 'POST', credentials: 'same-origin', body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'No se pudo subir');

    data.rejected?.forEach((r) => App.toast(`${r.name}: ${r.reason}`, 'err', 6000));
    if (data.saved?.length) App.toast(`${data.saved.length} archivo(s) subidos`, 'ok');

    await loadMedia();
  } catch (err) {
    App.toast(err.message, 'err');
  }
}

async function loadMedia() {
  const files = await App.session.api('/media');
  App.MEDIA.length = 0;
  App.MEDIA.push(...files.map((f) => ({
    id: f.id, name: f.name, type: f.type, size: f.size, at: f.at.slice(0, 10),
  })));
  renderMedia();
}
```

Y en `initMedia()`, sustituye `renderMedia();` por `loadMedia().catch(() => renderMedia());`

> `FormData` no lleva `Content-Type` a mano: el navegador debe poner el
> `boundary`. Si lo fuerzas, multer no encuentra nada y responde "no llegó
> ningún archivo".

---

## Cómo probarlo

```bash
# 1. Sube un PDF por API
curl -X POST http://localhost:3000/api/media \
  -H "Cookie: elorai_session=TU_COOKIE" \
  -F "files=@/ruta/a/catalogo.pdf"

# 2. ¿Está en disco?
ls -la uploads/*/

# 3. ¿Y en base, con su media_id?
psql $DATABASE_URL -c \
  "SELECT name, file_type, size_bytes, wa_media_id IS NOT NULL AS en_meta FROM media_files;"

# 4. Rechazo de tipo no permitido (espera 400 o lista en 'rejected')
curl -X POST http://localhost:3000/api/media -H "Cookie: ..." -F "files=@algo.exe"
```

**Prueba de extremo a extremo:** crea un flujo simple con un paso de tipo
archivo apuntando a `catalogo.pdf`, añade un disparador, y escríbele a tu número
desde otro teléfono. Debe llegarte el PDF.

## Lista de verificación

- [ ] Migración `003_media.sql` aplicada
- [ ] `POST /api/media` sube y devuelve la fila creada
- [ ] El archivo aparece en `uploads/<account_id>/`
- [ ] `wa_media_id` se rellena en segundos
- [ ] Un `.exe` se rechaza
- [ ] Un archivo de 20 MB se rechaza
- [ ] El panel muestra los archivos reales tras recargar
- [ ] Un flujo con paso de archivo entrega el archivo en WhatsApp

## Errores frecuentes

| Síntoma | Causa |
|---|---|
| "No llegó ningún archivo" | Pusiste `Content-Type` a mano en el `fetch` |
| `EACCES` al escribir | La carpeta `uploads/` no pertenece al usuario `elorai`. En el servidor: `chown -R elorai:elorai /var/www/elorai/uploads` |
| `wa_media_id` siempre nulo | Cloud API sin configurar, o el token no tiene permiso `whatsapp_business_messaging` |
| El archivo llega sin nombre | Falta `filename` en `sendMedia`, solo aplica a documentos |
