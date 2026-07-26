# Guía de implementación de Elorai

Cómo terminar tú misma los bloques que faltan. Cada documento es autocontenido:
qué vas a construir, el código exacto, cómo probarlo y qué suele salir mal.

## Orden recomendado

| # | Bloque | Documento | Por qué en este orden |
|---|---|---|---|
| — | **F · Archivos** | [bloque-f-archivos.md](bloque-f-archivos.md) | ✅ Ya implementado — queda como referencia de cómo se construyó |
| — | **B · Verificación de pagos** | [bloque-b-pagos.md](bloque-b-pagos.md) | ✅ Ya implementado — queda como referencia de cómo se construyó |
| — | **C · Panel con datos reales** | [bloque-c-panel.md](bloque-c-panel.md) | ✅ Ya implementado — queda como referencia de cómo se construyó |
| — | **D · Remarketing** | [bloque-d-remarketing.md](bloque-d-remarketing.md) | ✅ Ya implementado — queda como referencia de cómo se construyó |
| — | **E · Métricas y Conversions API** | [bloque-e-metricas.md](bloque-e-metricas.md) | ✅ Ya implementado — queda como referencia de cómo se construyó |
| 1 | **G · Producción** | [bloque-g-produccion.md](bloque-g-produccion.md) | Antes de tener volumen real |

> **Despliegue en Railway:** [deploy-railway.md](deploy-railway.md) — la ruta
> activa mientras dure el plan gratuito, sin nginx.

---

## Cómo trabajar

### Entorno local

```bash
# 1. PostgreSQL (una vez)
sudo -u postgres createuser elorai --pwprompt
sudo -u postgres createdb -O elorai elorai_dev

# 2. Configuración
cp .env.example server/.env
# edita server/.env:
#   DATABASE_URL=postgres://elorai:TUCLAVE@127.0.0.1:5432/elorai_dev
#   PUBLIC_URL=http://localhost:3000
#   SESSION_SECRET y ENCRYPTION_KEY  →  openssl rand -hex 32
#   El resto puede quedar con valores falsos mientras no pruebes login o cobros

# 3. Arrancar
cd server
npm install
npm run migrate
npm run dev        # se reinicia solo al guardar
```

### Ciclo de cada cambio

```bash
node --check src/services/loquesea.js   # ¿compila?
npm run migrate                          # ¿esquema al día?
# prueba lo que acabas de hacer (cada guía trae su script)
git add -A && git commit -m "..."        # commits pequeños
```

### Convenciones del proyecto

Respétalas y el código seguirá pareciendo escrito por una sola persona.

**Migraciones.** Numeradas y nunca se editan una vez aplicadas. Si te
equivocaste, escribe otra que corrija:

```
server/src/db/migrations/003_lo_que_sea.sql
```

**Consultas.** Siempre parametrizadas. Nunca interpolar valores en el SQL:

```js
// ✅
await query('SELECT * FROM contacts WHERE account_id = $1', [accountId]);
// ❌ inyección SQL
await query(`SELECT * FROM contacts WHERE account_id = '${accountId}'`);
```

**Alias en SQL.** Entre comillas o PostgreSQL los devuelve en minúsculas:

```sql
SELECT count(*) AS "totalHoy"   -- ✅ llega como totalHoy
SELECT count(*) AS totalHoy     -- ❌ llega como totalhoy
```

**Aislamiento por cuenta.** Toda consulta filtra por `account_id`. Es lo que
impide que un cliente vea datos de otro:

```js
'... WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]
```

**Credenciales.** Se guardan con `encrypt()` y salen al panel con `mask()`.
Nunca devuelvas un token en claro por la API.

**Envíos.** Nunca llames a la Graph API directamente desde una ruta. Usa
`enqueue()`: te da reintentos, orden y persistencia gratis.

**Errores.** Lanza con `status` y deja que el manejador central responda:

```js
throw Object.assign(new Error('Mensaje para el usuario'), { status: 400, code: 'validation' });
```

---

## Mapa del código

```
server/src/
  index.js              Arranque, montaje de rutas, trabajadores periódicos
  config.js             Variables de entorno validadas al arrancar
  db/pool.js            query · one · many · transaction
  db/migrations/        Esquema, en orden
  lib/crypto.js         encrypt · decrypt · mask · sign · unsign
  lib/session.js        Sesiones en base de datos
  middleware/auth.js    requireAuth · requireSubscription · rateLimit
  routes/
    auth.js             Google OAuth
    billing.js          Stripe
    webhook.js          Entrada de WhatsApp
    api.js              Todo lo que consume el panel
  services/
    whatsapp.js         Graph API: enviar, descargar, subir
    outbox.js           Cola de salida con reintentos
    flows.js            Disparadores y ejecución de flujos
    ai.js               Respuestas con IA
    engine.js           Orquestación del mensaje entrante
    storage.js          Archivos en disco (Bloque F)
    media.js            Alta de archivos + subida a Meta (Bloque F)
    receipts.js         Lectura de comprobantes, reglas y entrega (Bloque B)
    remarketing.js      Trabajador periódico, franja horaria y envío (Bloque D)
    capi.js             Conversions API: cola y envío de eventos de compra (Bloque E)
    adsync.js           Sincronización de gasto con la Marketing API de Meta (Bloque E)
  billing/
    index.js            Interfaz de pasarela (perezosa: solo carga el adaptador activo)
    none.js             Adaptador por defecto — sin cobrar, mientras Wompi no esté
    stripe.js           Adaptador

assets/js/              Frontend del panel (conectado a la API; catalogs.js son los únicos datos estáticos que quedan)
```

## Funciones que vas a reutilizar

```js
import { query, one, many, transaction } from '../db/pool.js';
import { encrypt, decrypt, mask } from '../lib/crypto.js';
import { enqueue, cancelPending } from './outbox.js';
import { runFlow, matchTrigger, normalize } from './flows.js';
import * as wa from './whatsapp.js';   // sendText, sendMedia, downloadMedia, uploadMedia
import * as ai from './ai.js';         // aiConfig, reply
```

## Si algo falla

```bash
journalctl -u elorai -f              # en el servidor
tail -f /tmp/elorai.log              # en local
psql $DATABASE_URL                   # inspeccionar datos
```

Consultas útiles mientras desarrollas:

```sql
-- ¿Qué está esperando salir?
SELECT id, kind, origin, status, attempts, last_error, scheduled_at FROM outbox
 ORDER BY id DESC LIMIT 20;

-- ¿Qué llegó de Meta y se procesó?
SELECT wa_message_id, processed_at, error FROM wa_events ORDER BY id DESC LIMIT 20;

-- ¿Dónde se quedó un flujo?
SELECT contact_id, node_path, status FROM flow_runs WHERE status = 'waiting';

-- Lo que ve el cliente en la terminal del panel
SELECT created_at, level, message FROM activity_log ORDER BY id DESC LIMIT 30;

-- Comprobantes que necesitan revisión manual
SELECT id, contact_id, amount, currency, reason, created_at FROM payment_receipts
 WHERE status = 'manual_review' ORDER BY created_at DESC;
```
