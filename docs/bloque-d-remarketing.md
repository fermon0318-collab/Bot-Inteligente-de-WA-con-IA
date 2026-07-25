# Bloque D · Remarketing automático

**Requisito previo: bloque A** (ya terminado).

## Qué vas a construir

Un contacto escribe, no compra, y a las 24 horas recibe un recordatorio — pero
solo dentro del horario que definió el cliente, y una sola vez.

**Tiempo estimado:** 3–4 horas.

### La lógica

```
Cada 5 minutos:
  buscar contactos que…
    · escribieron hace más de N horas
    · no han comprado
    · no tienen la automatización detenida
    · no han recibido ya remarketing
  para cada uno:
    ¿estamos dentro de la franja horaria de su cuenta?
      sí → encolar la secuencia
      no → esperar a la siguiente ventana
```

---

## Paso 1 · Migración

`server/src/db/migrations/005_remarketing.sql`

```sql
-- Registro de envíos: sin esto, cada pasada volvería a escribirle al mismo
-- contacto y acabarías con el número bloqueado por Meta.
CREATE TABLE remarketing_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  steps_queued  integer NOT NULL DEFAULT 0,
  sent_at       timestamptz NOT NULL DEFAULT now()
);

-- Un contacto, un remarketing. Si algún día quieres varias secuencias, esto
-- pasa a ser (account_id, contact_id, sequence_id).
CREATE UNIQUE INDEX remarketing_once_idx ON remarketing_sends (account_id, contact_id);

-- Interruptor por cuenta: hoy no hay forma de apagarlo sin borrar los pasos
ALTER TABLE bot_settings
    ADD COLUMN rm_enabled boolean NOT NULL DEFAULT false;
```

```bash
cd server && npm run migrate
```

---

## Paso 2 · Servicio

`server/src/services/remarketing.js` (nuevo)

```js
/**
 * Remarketing programado.
 *
 * Se ejecuta cada pocos minutos y busca contactos que se enfriaron. La franja
 * horaria se respeta en la zona horaria de cada cuenta: escribirle a alguien a
 * las 3 de la mañana es la mejor forma de que te reporte, y unos cuantos
 * reportes bajan la calidad del número ante Meta.
 */

import { many, one, query } from '../db/pool.js';
import { enqueue } from './outbox.js';

/**
 * ¿Es hora permitida en la zona de la cuenta?
 * Se compara en minutos desde medianoche para que funcione igual con franjas
 * normales (09:00–21:00) y nocturnas (22:00–02:00).
 */
export function dentroDeFranja({ inicio, fin, timezone, ahora = new Date() }) {
  const hhmm = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ahora);

  const aMinutos = (s) => {
    const [h, m] = String(s).slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };

  const actual = aMinutos(hhmm);
  const desde = aMinutos(inicio);
  const hasta = aMinutos(fin);

  return desde <= hasta
    ? actual >= desde && actual < hasta
    : actual >= desde || actual < hasta;   // franja que cruza medianoche
}

/** Cuentas con remarketing activo y al menos un paso configurado. */
async function cuentasActivas() {
  return many(
    `SELECT s.account_id, s.rm_hours, s.rm_minutes, s.rm_window_start,
            s.rm_window_end, s.rm_timezone
       FROM bot_settings s
      WHERE s.rm_enabled = true
        AND s.bot_running = true
        AND EXISTS (SELECT 1 FROM remarketing_steps r WHERE r.account_id = s.account_id)`
  );
}

/** Contactos que cumplen todas las condiciones para recibir remarketing. */
async function candidatos({ accountId, minutosEspera }) {
  return many(
    `SELECT c.id, c.phone, c.name
       FROM contacts c
      WHERE c.account_id = $1
        AND c.status IN ('new', 'pending')
        AND c.automation_off = false
        AND c.last_inbound_at IS NOT NULL
        AND c.last_inbound_at <= now() - make_interval(mins => $2)
        -- Nada de perseguir contactos de hace un mes
        AND c.last_inbound_at > now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM remarketing_sends s
           WHERE s.account_id = c.account_id AND s.contact_id = c.id
        )
        -- Si tiene algo pendiente de enviarse, aún está en conversación
        AND NOT EXISTS (
          SELECT 1 FROM outbox o
           WHERE o.contact_id = c.id AND o.status = 'pending'
        )
      LIMIT 100`,
    [accountId, minutosEspera]
  );
}

/** Encola la secuencia para un contacto. */
async function enviarSecuencia({ accountId, contactId, pasos }) {
  let retraso = 0;
  let encolados = 0;

  for (const paso of pasos) {
    if (paso.step_type === 'delay') {
      retraso += Math.max(0, Number(paso.value) || 0);
      continue;
    }
    if (!String(paso.value || '').trim()) continue;

    await enqueue({
      accountId, contactId,
      kind: paso.step_type === 'file' ? 'media' : 'text',
      body: paso.step_type === 'file' ? '' : paso.value,
      mediaName: paso.step_type === 'file' ? paso.value : null,
      origin: 'remarketing',
      delaySeconds: retraso,
    });
    encolados++;
    retraso += 3;
  }

  await query(
    `INSERT INTO remarketing_sends (account_id, contact_id, steps_queued)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [accountId, contactId, encolados]
  );

  return encolados;
}

/** Una pasada completa. Devuelve cuántos contactos recibieron secuencia. */
export async function run() {
  const cuentas = await cuentasActivas();
  let total = 0;

  for (const cuenta of cuentas) {
    const enHora = dentroDeFranja({
      inicio: cuenta.rm_window_start,
      fin: cuenta.rm_window_end,
      timezone: cuenta.rm_timezone,
    });
    // Fuera de la franja no se hace nada: en la siguiente pasada seguirán ahí
    if (!enHora) continue;

    const pasos = await many(
      `SELECT step_type, value FROM remarketing_steps
        WHERE account_id = $1 ORDER BY position`,
      [cuenta.account_id]
    );
    if (!pasos.length) continue;

    const espera = (Number(cuenta.rm_hours) || 0) * 60 + (Number(cuenta.rm_minutes) || 0);
    if (espera <= 0) continue;

    const lista = await candidatos({ accountId: cuenta.account_id, minutosEspera: espera });

    for (const contacto of lista) {
      const n = await enviarSecuencia({
        accountId: cuenta.account_id, contactId: contacto.id, pasos,
      });
      if (n) total++;
    }

    if (lista.length) {
      await query(
        `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'info', $2)`,
        [cuenta.account_id, `Remarketing enviado a ${lista.length} contacto(s)`]
      );
    }
  }

  return total;
}

/** Arranca el trabajador. Devuelve una función para detenerlo. */
export function startWorker({ intervalMs = 5 * 60 * 1000 } = {}) {
  let corriendo = false;

  const timer = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const n = await run();
      if (n) console.log(`[remarketing] secuencia enviada a ${n} contacto(s)`);
    } catch (err) {
      console.error('[remarketing] fallo:', err.message);
    } finally {
      corriendo = false;
    }
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
```

---

## Paso 3 · Arrancar el trabajador

En `server/src/index.js`:

```js
import * as remarketing from './services/remarketing.js';

// …junto al trabajador de la cola
const stopRemarketing = remarketing.startWorker();
```

Y en `shutdown()`: `stopRemarketing();`

---

## Paso 4 · Interruptor en la API

En `api.js`, dentro de `PUT /settings/remarketing`, añade `enabled` al cuerpo:

```js
const { enabled = false, hours = 24, minutes = 0, ... } = req.body || {};

await client.query(
  `UPDATE bot_settings
      SET rm_enabled = $7, rm_hours = $2, rm_minutes = $3, rm_window_start = $4,
          rm_window_end = $5, rm_timezone = $6, updated_at = now()
    WHERE account_id = $1`,
  [account(req), Number(hours), Number(minutes), windowStart, windowEnd, timezone, Boolean(enabled)]
);
```

Y en `publicSettings()`, dentro de `remarketing`: `enabled: row.rm_enabled,`

---

## Paso 5 · Interruptor en el panel

En `dashboard.html`, sección Remarketing, junto al título:

```html
<label class="flex items-center gap-3 rounded-xl border border-accent-200 bg-white/70 px-3 py-2.5 cursor-pointer">
  <span class="switch"><input type="checkbox" id="rm-enabled" /><span class="track"></span></span>
  <span class="text-sm font-bold text-ink">Activar remarketing</span>
</label>
```

Y en `automation.js`, al guardar, incluye `enabled: qs('#rm-enabled').checked`.

> **Por defecto apagado.** Que un cliente configure la secuencia y empiece a
> escribir a gente sin haberlo decidido es la forma más rápida de que le
> bloqueen el número.

---

## Cómo probarlo

La franja horaria es lo único delicado. Pruébala aislada:

```js
// scripts/prueba-franja.mjs
import { dentroDeFranja } from '../server/src/services/remarketing.js';

const casos = [
  { inicio: '09:00', fin: '21:00', tz: 'America/Mexico_City' },
  { inicio: '22:00', fin: '02:00', tz: 'America/Mexico_City' },  // cruza medianoche
  { inicio: '09:00', fin: '21:00', tz: 'Europe/Madrid' },
];

for (const c of casos) {
  console.log(c.inicio, '-', c.fin, c.tz, '→',
    dentroDeFranja({ inicio: c.inicio, fin: c.fin, timezone: c.tz }));
}
```

Prueba del flujo completo, sin esperar 24 horas:

```sql
-- 1. Activa remarketing con espera de 1 minuto
UPDATE bot_settings SET rm_enabled = true, rm_hours = 0, rm_minutes = 1,
       rm_window_start = '00:00', rm_window_end = '23:59';

-- 2. Asegúrate de tener pasos
INSERT INTO remarketing_steps (account_id, position, step_type, value)
VALUES ('TU_ACCOUNT_ID', 0, 'text', '¿Sigues interesado? Aparté tu lugar 👋');

-- 3. Envejece un contacto
UPDATE contacts SET last_inbound_at = now() - interval '5 minutes',
       status = 'pending' WHERE phone = '+52...';
```

```js
// 4. Fuerza una pasada
import * as rm from './server/src/services/remarketing.js';
console.log('contactos alcanzados:', await rm.run());
```

```sql
-- 5. Comprueba
SELECT * FROM remarketing_sends;
SELECT origin, body, scheduled_at FROM outbox WHERE origin = 'remarketing';

-- 6. Segunda pasada: no debe duplicar
```

## Lista de verificación

- [ ] Migración `005_remarketing.sql` aplicada
- [ ] Franja normal y franja que cruza medianoche se calculan bien
- [ ] Fuera de horario no se envía nada
- [ ] Un contacto no recibe la secuencia dos veces
- [ ] Un contacto que ya pagó queda excluido
- [ ] Un contacto con automatización detenida queda excluido
- [ ] Apagar el interruptor detiene los envíos
- [ ] Aparece registrado en la terminal del panel

## Advertencias

**El remarketing no consentido es la vía rápida al bloqueo.** Meta mide los
reportes de los usuarios. Un mensaje de recuperación a alguien que escribió hace
un día es razonable; una secuencia de cinco mensajes a quien nunca contestó, no.

**Ventana de 24 horas.** Si el contacto escribió hace más de 24 h, Meta rechaza
el texto libre. La cola lo intentará y fallará con código 131047. Para esos
casos hace falta plantilla aprobada — está fuera de este bloque, pero considera
limitar el tiempo de disparo a menos de 24 h mientras tanto.
