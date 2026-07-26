# Bloque B · Verificación automática de pagos

**Requisito previo: [bloque F](bloque-f-archivos.md) terminado.** Sin él no se
pueden entregar los archivos del producto.

## Qué vas a construir

El cliente final manda una foto del comprobante. Elorai la lee, comprueba que
el monto coincide con una de tus reglas, entrega el producto y marca la venta.
Todo sin que nadie mire el chat.

**Tiempo estimado:** 6–8 horas. Es el bloque con más matices.

### El recorrido completo

```
Llega imagen/PDF
   ↓ descargar de la Graph API
   ↓ leer con un modelo multimodal → monto, moneda, fecha, referencia, banco
   ↓ ¿es un comprobante de verdad?           no → mensaje de "no válido"
   ↓ ¿la referencia ya se usó?               sí → aviso de duplicado
   ↓ ¿coincide con alguna regla de acceso?   no → mensaje de "no válido"
   ↓ marcar contacto como pagado
   ↓ enviar mensaje de acceso + archivos del producto
   ↓ ejecutar el flujo post-pago
```

---

## Paso 1 · Migración

`server/src/db/migrations/004_pagos.sql`

```sql
-- --------------------------------------------------------------------------
-- Comprobantes recibidos
--
-- Se guarda cada intento, válido o no. Sin esta tabla no hay forma de resolver
-- una disputa ni de detectar a quien reenvía el mismo comprobante dos veces.
-- --------------------------------------------------------------------------
CREATE TABLE payment_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id      bigint REFERENCES messages(id) ON DELETE SET NULL,

  wa_media_id     text,
  storage_path    text,
  mime_type       text NOT NULL DEFAULT '',

  -- Lo que se extrajo del comprobante
  amount          numeric(12,2),
  currency        text,
  reference       text,
  paid_at         timestamptz,
  bank            text,
  raw_extraction  jsonb,
  confidence      real,

  -- pending | valid | invalid | duplicate | manual_review
  status          text NOT NULL DEFAULT 'pending',
  rule_id         uuid REFERENCES access_rules(id) ON DELETE SET NULL,
  reason          text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);

CREATE INDEX receipts_account_idx ON payment_receipts (account_id, created_at DESC);
CREATE INDEX receipts_contact_idx ON payment_receipts (contact_id);

-- La misma referencia bancaria no puede valer dos veces en la misma cuenta.
-- Es la defensa contra el reenvío del comprobante de otra persona.
CREATE UNIQUE INDEX receipts_reference_uniq
    ON payment_receipts (account_id, lower(reference))
    WHERE reference IS NOT NULL AND status = 'valid';

-- Tolerancia por regla: un pago de 89.00 y otro de 89.50 pueden ser el mismo
-- producto si el banco cobró comisión.
ALTER TABLE access_rules
    ADD COLUMN currency   text NOT NULL DEFAULT 'MXN',
    ADD COLUMN tolerance  numeric(12,2) NOT NULL DEFAULT 0;

-- Cuándo se entregó el producto, para no entregarlo dos veces
ALTER TABLE contacts
    ADD COLUMN delivered_at   timestamptz,
    ADD COLUMN delivered_rule uuid REFERENCES access_rules(id) ON DELETE SET NULL;
```

```bash
cd server && npm run migrate
```

---

## Paso 2 · Lectura del comprobante

`server/src/services/receipts.js` (nuevo)

```js
/**
 * Lectura de comprobantes de pago con un modelo multimodal.
 *
 * Se usa el mismo proveedor de IA que ya configuró el cliente: así no hay una
 * credencial más que pedirle ni un servicio más que pagar.
 */

import { one } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

const INSTRUCCIONES = `Analiza esta imagen de un comprobante de pago o transferencia bancaria.

Devuelve SOLO un objeto JSON, sin explicaciones ni markdown, con esta forma:
{
  "es_comprobante": true,
  "monto": 89.00,
  "moneda": "MXN",
  "referencia": "0123456789",
  "fecha": "2026-07-25",
  "banco": "BBVA",
  "beneficiario": "Nombre del receptor",
  "confianza": 0.95
}

Reglas:
- "es_comprobante" es false si la imagen no es un comprobante de pago.
- "monto" es número, sin símbolos ni separadores de miles.
- "referencia" es el folio, clave de rastreo o número de operación. null si no aparece.
- "fecha" en formato AAAA-MM-DD. null si no aparece.
- "confianza" entre 0 y 1: cuán legible y fiable te parece.
- Si un dato no se ve, usa null. NO lo inventes.`;

/** Config de IA de la cuenta, con la clave descifrada. */
async function aiCredentials(accountId) {
  const row = await one(
    'SELECT ai_model, ai_key_enc FROM bot_settings WHERE account_id = $1',
    [accountId]
  );
  const apiKey = decrypt(row?.ai_key_enc);
  return apiKey ? { model: row.ai_model, apiKey } : null;
}

/**
 * Extrae los datos de un comprobante.
 * Devuelve null si no hay credenciales o el proveedor falla: en ese caso el
 * comprobante queda en revisión manual, que es mejor que descartarlo.
 */
export async function extract({ accountId, buffer, mimeType }) {
  const cred = await aiCredentials(accountId);
  if (!cred) return null;

  const base64 = buffer.toString('base64');
  const esAnthropic = cred.model.startsWith('claude');

  // Los PDF solo los acepta Anthropic como documento; para el resto, imagen
  const bloque = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }
    : esAnthropic
      ? { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }
      : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };

  const peticion = esAnthropic
    ? {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: {
          model: cred.model, max_tokens: 400,
          messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
        },
        extraer: (d) => d?.content?.[0]?.text,
      }
    : {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: `Bearer ${cred.apiKey}`, 'content-type': 'application/json' },
        body: {
          model: cred.model, max_completion_tokens: 400,
          messages: [{ role: 'user', content: [bloque, { type: 'text', text: INSTRUCCIONES }] }],
        },
        extraer: (d) => d?.choices?.[0]?.message?.content,
      };

  try {
    const res = await fetch(peticion.url, {
      method: 'POST',
      headers: peticion.headers,
      body: JSON.stringify(peticion.body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      console.error(`[comprobante] el proveedor devolvió ${res.status}`);
      return null;
    }

    const texto = peticion.extraer(await res.json()) || '';
    // El modelo a veces envuelve el JSON en ```json … ``` pese a pedírselo
    const json = texto.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;

    const datos = JSON.parse(json);
    return {
      esComprobante: Boolean(datos.es_comprobante),
      monto: datos.monto === null ? null : Number(datos.monto),
      moneda: datos.moneda || null,
      referencia: datos.referencia ? String(datos.referencia).trim() : null,
      fecha: datos.fecha || null,
      banco: datos.banco || null,
      beneficiario: datos.beneficiario || null,
      confianza: Number(datos.confianza) || 0,
      crudo: datos,
    };
  } catch (err) {
    console.error(`[comprobante] fallo al leer: ${err.message}`);
    return null;
  }
}
```

---

## Paso 3 · Comparación con las reglas

En el mismo archivo, debajo:

```js
import { many } from '../db/pool.js';
import { normalize } from './flows.js';

/**
 * Busca la regla de acceso que corresponde a un comprobante.
 *
 * Dos condiciones: el monto encaja (con la tolerancia de la regla) y alguna
 * palabra de contexto aparece en la conversación reciente. El contexto evita
 * que dos productos del mismo precio se confundan.
 */
export async function matchRule({ accountId, contactId, monto }) {
  if (monto === null || Number.isNaN(monto)) return null;

  const reglas = await many(
    'SELECT id, amount, context, message, files, currency, tolerance FROM access_rules WHERE account_id = $1',
    [accountId]
  );
  if (!reglas.length) return null;

  // Últimos mensajes del contacto: de ahí sale el contexto
  const historial = await many(
    `SELECT body FROM messages WHERE contact_id = $1 AND direction = 'in'
      ORDER BY created_at DESC LIMIT 15`,
    [contactId]
  );
  const conversacion = normalize(historial.map((m) => m.body).join(' '));

  const candidatas = reglas
    .map((r) => {
      const esperado = Number(String(r.amount).replace(/[^\d.]/g, ''));
      if (!esperado) return null;

      const tolerancia = Number(r.tolerance) || 0;
      if (Math.abs(monto - esperado) > tolerancia) return null;

      const palabras = String(r.context).split(',').map((c) => normalize(c)).filter(Boolean);
      const aciertos = palabras.filter((p) => conversacion.includes(p)).length;

      // Sin contexto definido, la regla vale solo por monto
      if (palabras.length && !aciertos) return null;

      return { regla: r, aciertos, desvio: Math.abs(monto - esperado) };
    })
    .filter(Boolean)
    // Más contexto acertado primero; a igualdad, el monto más exacto
    .sort((a, b) => b.aciertos - a.aciertos || a.desvio - b.desvio);

  return candidatas[0]?.regla || null;
}
```

---

## Paso 4 · Procesamiento completo

Sigue en `receipts.js`:

```js
import { query, transaction } from '../db/pool.js';
import { enqueue } from './outbox.js';
import { runFlow } from './flows.js';
import * as wa from './whatsapp.js';

/** Un comprobante con menos confianza que esto va a revisión manual. */
const CONFIANZA_MINIMA = 0.6;

export async function processReceipt({ accountId, contactId, messageId, attachment }) {
  const cfg = await wa.accountConfig(accountId);
  if (!cfg?.token) return { status: 'error', reason: 'Cloud API sin configurar' };

  const ajustes = await one(
    'SELECT pay_message_ok, pay_message_invalid, pay_post_flow_id FROM bot_settings WHERE account_id = $1',
    [accountId]
  );

  const rechazar = async (recibo, motivo, avisar = true) => {
    await query(
      `UPDATE payment_receipts SET status = $2, reason = $3, processed_at = now() WHERE id = $1`,
      [recibo, 'invalid', motivo]
    );
    if (avisar && ajustes?.pay_message_invalid) {
      await enqueue({ accountId, contactId, body: ajustes.pay_message_invalid, origin: 'flow' });
    }
    await query(
      `UPDATE contacts SET status = 'rejected' WHERE id = $1 AND status <> 'paid'`,
      [contactId]
    );
    return { status: 'invalid', reason: motivo };
  };

  // 1 · Registrar el intento antes de nada
  const recibo = await one(
    `INSERT INTO payment_receipts (account_id, contact_id, message_id, wa_media_id, mime_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [accountId, contactId, messageId, attachment.mediaId, attachment.mimeType || '']
  );

  // 2 · Descargar
  let archivo;
  try {
    archivo = await wa.downloadMedia({ token: cfg.token, mediaId: attachment.mediaId });
  } catch (err) {
    return rechazar(recibo.id, `No se pudo descargar: ${err.message}`);
  }

  // 3 · Leer
  const datos = await extract({ accountId, buffer: archivo.buffer, mimeType: archivo.mimeType });

  if (!datos) {
    await query(
      `UPDATE payment_receipts SET status = 'manual_review',
              reason = 'No se pudo leer automáticamente', processed_at = now()
        WHERE id = $1`, [recibo.id]);
    await query(
      `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'warn', $2)`,
      [accountId, 'Comprobante recibido que no se pudo leer: revísalo en Chat en Vivo']);
    return { status: 'manual_review' };
  }

  await query(
    `UPDATE payment_receipts
        SET amount = $2, currency = $3, reference = $4, paid_at = $5, bank = $6,
            raw_extraction = $7, confidence = $8
      WHERE id = $1`,
    [recibo.id, datos.monto, datos.moneda, datos.referencia,
     datos.fecha || null, datos.banco, JSON.stringify(datos.crudo), datos.confianza]
  );

  if (!datos.esComprobante) return rechazar(recibo.id, 'La imagen no es un comprobante');
  if (datos.confianza < CONFIANZA_MINIMA) {
    await query(
      `UPDATE payment_receipts SET status = 'manual_review',
              reason = 'Comprobante poco legible', processed_at = now() WHERE id = $1`,
      [recibo.id]);
    return { status: 'manual_review' };
  }

  // 4 · ¿Referencia ya usada?
  if (datos.referencia) {
    const previo = await one(
      `SELECT contact_id FROM payment_receipts
        WHERE account_id = $1 AND lower(reference) = lower($2)
          AND status = 'valid' AND id <> $3 LIMIT 1`,
      [accountId, datos.referencia, recibo.id]
    );
    if (previo) {
      await query(
        `UPDATE payment_receipts SET status = 'duplicate',
                reason = 'Referencia ya utilizada', processed_at = now() WHERE id = $1`,
        [recibo.id]);
      await enqueue({ accountId, contactId, origin: 'flow',
        body: 'Ese comprobante ya lo recibimos antes. Si crees que es un error, escríbenos.' });
      return { status: 'duplicate' };
    }
  }

  // 5 · Buscar regla
  const regla = await matchRule({ accountId, contactId, monto: datos.monto });
  if (!regla) {
    return rechazar(recibo.id,
      `Monto ${datos.monto} ${datos.moneda || ''} sin regla de acceso que coincida`);
  }

  // 6 · Marcar pagado y entregar, todo o nada
  await transaction(async (client) => {
    await client.query(
      `UPDATE payment_receipts SET status = 'valid', rule_id = $2, processed_at = now()
        WHERE id = $1`, [recibo.id, regla.id]);
    await client.query(
      `UPDATE contacts SET status = 'paid', paid_at = now(), amount = $2, currency = $3,
              delivered_at = now(), delivered_rule = $4
        WHERE id = $1`,
      [contactId, datos.monto, datos.moneda || regla.currency, regla.id]);
  });

  let retraso = 0;
  if (ajustes?.pay_message_ok) {
    await enqueue({ accountId, contactId, body: ajustes.pay_message_ok, origin: 'flow' });
    retraso += 2;
  }
  await enqueue({ accountId, contactId, body: regla.message, origin: 'flow', delaySeconds: retraso });
  retraso += 2;

  for (const nombre of regla.files || []) {
    await enqueue({ accountId, contactId, kind: 'media', mediaName: nombre, origin: 'flow', delaySeconds: retraso });
    retraso += 2;
  }

  // 7 · Flujo post-pago, solo la primera vez
  if (ajustes?.pay_post_flow_id) {
    await runFlow({ accountId, contactId, flowId: ajustes.pay_post_flow_id });
  }

  await query(
    `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'ok', $2)`,
    [accountId, `Pago validado: ${datos.monto} ${datos.moneda || ''} · ref ${datos.referencia || 's/r'}`]);

  return { status: 'valid', amount: datos.monto, rule: regla.id };
}
```

---

## Paso 5 · Enganchar al motor

En `server/src/services/engine.js`, dentro de `handleIncomingMessage`, **justo
después del acuse de recibo** (`markAsRead`) y **antes** del paso 5 (reanudar
flujo):

```js
/* 4.5 · ¿Adjuntó un comprobante? */
if (attachment && ['image', 'document'].includes(attachment.kind)) {
  const yaPago = await one(
    `SELECT status FROM contacts WHERE id = $1`, [contact.id]);

  if (yaPago?.status === 'paid') {
    result.actions.push('ya_estaba_pagado');
  } else {
    const veredicto = await receipts.processReceipt({
      accountId, contactId: contact.id,
      messageId: inserted.id, attachment,
    });
    result.actions.push(`comprobante:${veredicto.status}`);
    // Un comprobante no sigue al resto del pipeline: ya se respondió
    return result;
  }
}
```

Y arriba: `import * as receipts from './receipts.js';`

---

## Paso 6 · Respuestas rápidas de medios de pago

En `engine.js`, **antes** de los disparadores (paso 6):

```js
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
```

---

## Paso 7 · Endpoint para revisión manual

En `api.js`:

```js
router.get('/receipts', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT r.id, r.amount, r.currency, r.reference, r.bank, r.status, r.reason,
              r.confidence, r.created_at AS "at",
              c.id AS "contactId", c.name, c.phone
         FROM payment_receipts r JOIN contacts c ON c.id = r.contact_id
        WHERE r.account_id = $1
          AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC LIMIT 100`,
      [account(req), req.query.status || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** Aprobación manual: entrega el producto de la regla indicada. */
router.post('/receipts/:id/approve', requireSubscription, async (req, res, next) => {
  try {
    const result = await receipts.approveManually({
      accountId: account(req),
      receiptId: req.params.id,
      ruleId: req.body?.ruleId || null,
    });
    res.json(result);
  } catch (err) { next(err); }
});
```

Y en `receipts.js` añade `approveManually`, que reutiliza los pasos 6 y 7 del
procesamiento. Extrae ese bloque a una función `entregar({ accountId, contactId, regla, ajustes })`
y llámala desde ambos sitios — así la entrega manual y la automática nunca se
desincronizan.

---

## Cómo probarlo

**Sin gastar en IA**, simula la extracción:

```js
// scripts/prueba-pago.mjs
import * as receipts from '../server/src/services/receipts.js';

// Sustituye temporalmente extract() por un valor fijo y ejecuta processReceipt
// con un attachment falso, comprobando qué queda en payment_receipts.
```

**Casos que debes cubrir:**

| Caso | Resultado esperado |
|---|---|
| Comprobante correcto de $89 con regla de $89 | `valid` · entrega archivos · contacto `paid` |
| Foto de un gato | `invalid` · mensaje de "no válido" |
| Comprobante de $50 sin regla de $50 | `invalid` |
| Mismo comprobante dos veces | `duplicate` · mensaje distinto |
| Comprobante borroso (confianza 0.3) | `manual_review` · sin mensaje automático |
| Contacto que ya pagó | `ya_estaba_pagado` · no entrega dos veces |
| Sin API Key de IA | `manual_review` · aviso en la terminal |

**Prueba real:** configura una regla de acceso con un monto pequeño, hazte una
transferencia de ese importe y mándate el comprobante desde otro teléfono.

## Lista de verificación

- [ ] Migración `004_pagos.sql` aplicada
- [ ] Un comprobante válido entrega mensaje + archivos y marca `paid`
- [ ] Una imagen que no es comprobante responde el mensaje de "no válido"
- [ ] La misma referencia dos veces se detecta como duplicada
- [ ] Un comprobante ilegible queda en `manual_review` sin responder nada raro
- [ ] "transferencia" dispara la respuesta rápida con tus datos bancarios
- [ ] El flujo post-pago se ejecuta una sola vez
- [ ] Todo queda registrado en `payment_receipts`

## Advertencias

**Esto no sustituye la conciliación bancaria.** Un modelo puede leer mal un
monto, y un comprobante se puede falsificar. Revisa periódicamente
`payment_receipts` contra tu estado de cuenta real, sobre todo con importes
altos. Considera poner un umbral por encima del cual todo vaya a revisión
manual.

**Los comprobantes son datos financieros de terceros.** Tu política de
privacidad ya lo declara: trátalos en consecuencia y no los uses para otra cosa.

**Coste.** Cada lectura es una llamada a un modelo multimodal. Con precios
típicos, unos céntimos por comprobante — pero si alguien te manda cien fotos
seguidas, lo pagas tú. Limita a un comprobante por contacto cada pocos minutos.
