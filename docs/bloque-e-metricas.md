# Bloque E · Métricas de anuncios y Conversions API

**Requisitos previos: bloques A y B.** Sin pagos confirmados no hay conversión
que reportar.

## Qué vas a construir

1. **Conversions API** — cada venta cerrada en WhatsApp vuelve a Meta, para que
   el algoritmo aprenda quién compra de verdad
2. **Métricas por anuncio** — gasto real de Meta cruzado con tus ventas

**Tiempo estimado:** 5–6 horas.

### Por qué importa

El píxel ve el clic, no la venta que cerraste conversando. Sin Conversions API,
Meta optimiza hacia gente que abre conversación y desaparece. Con ella, aprende
del comprador.

---

## Paso 1 · Migración

`server/src/db/migrations/006_metricas.sql`

```sql
-- Atribución: de qué anuncio vino cada contacto.
-- ctwa_clid es el identificador que Meta manda en el campo referral cuando
-- alguien llega por un anuncio "click to WhatsApp".
ALTER TABLE contacts
    ADD COLUMN ctwa_clid    text,
    ADD COLUMN campaign_id  text,
    ADD COLUMN adset_id     text;

CREATE INDEX contacts_ad_idx ON contacts (account_id, ad_id)
    WHERE ad_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Eventos enviados a Conversions API
--
-- Se registran para no duplicar y para poder auditar qué se reportó.
-- --------------------------------------------------------------------------
CREATE TABLE capi_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  event_name     text NOT NULL DEFAULT 'Purchase',
  event_id       text NOT NULL,          -- deduplicación en el lado de Meta
  value          numeric(12,2),
  currency       text,

  status         text NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts       integer NOT NULL DEFAULT 0,
  response       jsonb,
  error          text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE UNIQUE INDEX capi_event_id_uniq ON capi_events (account_id, event_id);
CREATE INDEX capi_pending_idx ON capi_events (created_at) WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- Métricas de anuncios traídas de Meta
--
-- Se guardan por día para poder filtrar por rango sin volver a pedirlas.
-- --------------------------------------------------------------------------
CREATE TABLE ad_metrics (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date           date NOT NULL,
  ad_id          text NOT NULL,
  ad_name        text NOT NULL DEFAULT '',
  campaign_id    text,
  campaign_name  text NOT NULL DEFAULT '',
  adset_name     text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT '',

  spend          numeric(12,2) NOT NULL DEFAULT 0,
  impressions    bigint NOT NULL DEFAULT 0,
  clicks         bigint NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'USD',

  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, date, ad_id)
);
```

```bash
cd server && npm run migrate
```

---

## Paso 2 · Capturar la atribución

En `server/src/services/engine.js`, dentro de `upsertContact`, añade los campos
nuevos. El `referral` de Meta trae:

```json
{
  "source_url": "https://fb.me/...",
  "source_id": "23851234567890123",
  "source_type": "ad",
  "headline": "Curso de IA",
  "ctwa_clid": "ARBxxxxx"
}
```

```js
async function upsertContact({ accountId, phone, profileName, referral }) {
  return one(
    `INSERT INTO contacts (account_id, phone, name, profile_name, source, ad_name, ad_id,
                           ctwa_clid, first_seen_at, last_message_at, last_inbound_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, now(), now(), now())
     ON CONFLICT (account_id, phone) DO UPDATE SET
       profile_name    = COALESCE(NULLIF(EXCLUDED.profile_name, ''), contacts.profile_name),
       name            = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END,
       -- La atribución es la del PRIMER anuncio: si vuelve por otro, el mérito
       -- sigue siendo del que lo trajo
       ad_name         = COALESCE(contacts.ad_name, EXCLUDED.ad_name),
       ad_id           = COALESCE(contacts.ad_id, EXCLUDED.ad_id),
       ctwa_clid       = COALESCE(contacts.ctwa_clid, EXCLUDED.ctwa_clid),
       last_message_at = now(),
       last_inbound_at = now()
     RETURNING *, (xmax = 0) AS is_new`,
    [accountId, phone, profileName || '',
     referral?.source_id ? 'Anuncio Meta' : 'Orgánico',
     referral?.headline || null, referral?.source_id || null, referral?.ctwa_clid || null]
  );
}
```

Y en la llamada: `referral: message.referral`

---

## Paso 3 · Servicio de Conversions API

`server/src/services/capi.js` (nuevo)

```js
/**
 * Conversions API de Meta.
 *
 * Los datos personales viajan siempre con hash SHA-256, como exige Meta. El
 * event_id permite que Meta descarte duplicados si el píxel también reportó.
 */

import { createHash, randomUUID } from 'node:crypto';
import { many, one, query } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta exige minúsculas, sin espacios y con hash. */
const hash = (valor) => valor
  ? createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex')
  : undefined;

/** El teléfono va solo con dígitos, con código de país y sin el +. */
const hashTelefono = (telefono) => {
  const digitos = String(telefono).replace(/\D/g, '');
  return digitos ? createHash('sha256').update(digitos).digest('hex') : undefined;
};

async function config(accountId) {
  const row = await one(
    `SELECT capi_pixel_id, capi_currency, capi_enabled, ads_token_enc
       FROM bot_settings WHERE account_id = $1`,
    [accountId]
  );
  if (!row?.capi_enabled || !row.capi_pixel_id) return null;
  const token = decrypt(row.ads_token_enc);
  return token ? { pixelId: row.capi_pixel_id, currency: row.capi_currency, token } : null;
}

/**
 * Registra una conversión. No la envía: la encola.
 * Llamar desde el bloque B justo después de marcar un pago como válido.
 */
export async function recordPurchase({ accountId, contactId, value, currency }) {
  const cfg = await config(accountId);
  if (!cfg) return { skipped: 'capi_desactivada' };

  const evento = await one(
    `INSERT INTO capi_events (account_id, contact_id, event_name, event_id, value, currency)
     VALUES ($1, $2, 'Purchase', $3, $4, $5)
     ON CONFLICT (account_id, event_id) DO NOTHING
     RETURNING id`,
    [accountId, contactId, `purchase_${contactId}_${Date.now()}`,
     value, currency || cfg.currency]
  );

  return evento ? { queued: evento.id } : { skipped: 'duplicado' };
}

/** Despacha los eventos pendientes. */
export async function flush({ limit = 20 } = {}) {
  const pendientes = await many(
    `SELECT e.*, c.phone, c.name, c.ctwa_clid
       FROM capi_events e JOIN contacts c ON c.id = e.contact_id
      WHERE e.status = 'pending' AND e.attempts < 5
      ORDER BY e.created_at LIMIT $1`,
    [limit]
  );

  let enviados = 0;

  for (const evento of pendientes) {
    const cfg = await config(evento.account_id);
    if (!cfg) {
      await query(
        `UPDATE capi_events SET status = 'failed', error = 'Conversions API desactivada' WHERE id = $1`,
        [evento.id]);
      continue;
    }

    const [nombre, ...apellidos] = String(evento.name || '').split(' ');

    const payload = {
      data: [{
        event_name: evento.event_name,
        event_time: Math.floor(new Date(evento.created_at).getTime() / 1000),
        event_id: evento.event_id,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: {
          ph: [hashTelefono(evento.phone)].filter(Boolean),
          fn: [hash(nombre)].filter(Boolean),
          ln: [hash(apellidos.join(' '))].filter(Boolean),
          // Cierra el círculo con el anuncio que trajo al contacto
          ...(evento.ctwa_clid ? { ctwa_clid: evento.ctwa_clid } : {}),
        },
        custom_data: {
          value: Number(evento.value) || 0,
          currency: evento.currency || cfg.currency,
        },
      }],
    };

    try {
      const res = await fetch(`${GRAPH}/${cfg.pixelId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, access_token: cfg.token }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        await query(
          `UPDATE capi_events SET status = 'sent', sent_at = now(), response = $2,
                  attempts = attempts + 1 WHERE id = $1`,
          [evento.id, JSON.stringify(data)]);
        enviados++;
      } else {
        const permanente = res.status < 500 && res.status !== 429;
        await query(
          `UPDATE capi_events SET status = $2, attempts = attempts + 1, error = $3, response = $4
            WHERE id = $1`,
          [evento.id, permanente ? 'failed' : 'pending',
           data?.error?.message || `HTTP ${res.status}`, JSON.stringify(data)]);
      }
    } catch (err) {
      await query(
        `UPDATE capi_events SET attempts = attempts + 1, error = $2 WHERE id = $1`,
        [evento.id, err.message]);
    }
  }

  return enviados;
}

export function startWorker({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    flush().catch((err) => console.error('[capi]', err.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

---

## Paso 4 · Enganchar al bloque B

En `receipts.js`, dentro de `processReceipt`, tras marcar el pago como válido:

```js
import * as capi from './capi.js';

// …después de la transacción que marca 'paid'
await capi.recordPurchase({
  accountId, contactId,
  value: datos.monto,
  currency: datos.moneda || regla.currency,
});
```

Y también en el endpoint de marcar pagado manualmente (`POST /contacts/:id/paid`),
para que las ventas cerradas a mano también cuenten.

---

## Paso 5 · Traer el gasto de Meta

`server/src/services/adsync.js` (nuevo)

```js
/**
 * Sincronización con la Marketing API de Meta.
 *
 * Se piden métricas por día y por anuncio. Meta limita las peticiones, así que
 * se sincroniza una vez por hora, no cada vez que alguien abre el panel.
 */

import { many, one, query } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export async function syncAccount({ accountId, days = 30 }) {
  const cfg = await one(
    'SELECT ads_account_id, ads_token_enc FROM bot_settings WHERE account_id = $1',
    [accountId]
  );
  const token = decrypt(cfg?.ads_token_enc);
  if (!cfg?.ads_account_id || !token) return { skipped: 'sin_credenciales' };

  const desde = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);

  const url = new URL(`${GRAPH}/${cfg.ads_account_id}/insights`);
  url.searchParams.set('level', 'ad');
  url.searchParams.set('fields',
    'ad_id,ad_name,campaign_id,campaign_name,adset_name,spend,impressions,clicks,account_currency');
  url.searchParams.set('time_range', JSON.stringify({ since: desde, until: hasta }));
  url.searchParams.set('time_increment', '1');   // desglose diario
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token);

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const data = await res.json();

  if (!res.ok) {
    await query(
      `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'err', $2)`,
      [accountId, `No se pudieron traer métricas de Meta: ${data?.error?.message || res.status}`]);
    return { error: data?.error?.message };
  }

  let filas = 0;
  for (const fila of data.data || []) {
    await query(
      `INSERT INTO ad_metrics (account_id, date, ad_id, ad_name, campaign_id, campaign_name,
                               adset_name, spend, impressions, clicks, currency, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (account_id, date, ad_id) DO UPDATE SET
         ad_name = EXCLUDED.ad_name, campaign_name = EXCLUDED.campaign_name,
         adset_name = EXCLUDED.adset_name, spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
         synced_at = now()`,
      [accountId, fila.date_start, fila.ad_id, fila.ad_name || '', fila.campaign_id || null,
       fila.campaign_name || '', fila.adset_name || '', Number(fila.spend) || 0,
       Number(fila.impressions) || 0, Number(fila.clicks) || 0, fila.account_currency || 'USD']
    );
    filas++;
  }

  return { synced: filas };
}

/** Sincroniza todas las cuentas que tengan credenciales. */
export async function syncAll() {
  const cuentas = await many(
    `SELECT account_id FROM bot_settings
      WHERE ads_account_id <> '' AND ads_token_enc IS NOT NULL`
  );
  for (const c of cuentas) {
    try { await syncAccount({ accountId: c.account_id }); }
    catch (err) { console.error(`[ads] cuenta ${c.account_id}:`, err.message); }
  }
  return cuentas.length;
}

export function startWorker({ intervalMs = 3600_000 } = {}) {
  const timer = setInterval(() => {
    syncAll().catch((err) => console.error('[ads]', err.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

---

## Paso 6 · Endpoint de métricas

En `api.js`:

```js
router.get('/ads', async (req, res, next) => {
  try {
    const desde = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const hasta = req.query.to || new Date().toISOString().slice(0, 10);

    // El gasto viene de Meta; las ventas, de nuestros contactos. Se cruzan por ad_id.
    const rows = await many(
      `WITH gasto AS (
         SELECT ad_id, max(ad_name) AS ad_name, max(campaign_name) AS campaign_name,
                sum(spend) AS spend, max(currency) AS currency
           FROM ad_metrics
          WHERE account_id = $1 AND date BETWEEN $2::date AND $3::date
          GROUP BY ad_id
       ),
       ventas AS (
         SELECT ad_id,
                count(*)                                        AS convos,
                count(*) FILTER (WHERE status = 'paid')         AS sales,
                COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0) AS revenue
           FROM contacts
          WHERE account_id = $1 AND ad_id IS NOT NULL
            AND first_seen_at BETWEEN $2::date AND ($3::date + interval '1 day')
          GROUP BY ad_id
       )
       SELECT COALESCE(g.ad_id, v.ad_id)              AS "adId",
              COALESCE(g.ad_name, 'Anuncio')          AS name,
              COALESCE(g.campaign_name, '')           AS campaign,
              COALESCE(g.spend, 0)                    AS spend,
              COALESCE(v.convos, 0)                   AS convos,
              COALESCE(v.sales, 0)                    AS sales,
              COALESCE(v.revenue, 0)                  AS revenue,
              COALESCE(g.currency, 'USD')             AS currency
         FROM gasto g FULL OUTER JOIN ventas v ON v.ad_id = g.ad_id
        ORDER BY 4 DESC`,
      [account(req), desde, hasta]
    );

    // Los derivados se calculan aquí y no en SQL: es más legible y son baratos
    const detalle = rows.map((r) => ({
      ...r,
      costPerConvo: r.convos ? r.spend / r.convos : 0,
      costPerSale: r.sales ? r.spend / r.sales : 0,
      roi: r.spend ? ((r.revenue - r.spend) / r.spend) * 100 : 0,
    }));

    const totales = detalle.reduce((acc, r) => ({
      spend: acc.spend + Number(r.spend),
      convos: acc.convos + Number(r.convos),
      sales: acc.sales + Number(r.sales),
      revenue: acc.revenue + Number(r.revenue),
    }), { spend: 0, convos: 0, sales: 0, revenue: 0 });

    res.json({
      rows: detalle,
      totals: {
        ...totales,
        roi: totales.spend ? ((totales.revenue - totales.spend) / totales.spend) * 100 : 0,
      },
    });
  } catch (err) { next(err); }
});

/** Fuerza una sincronización desde el botón del panel. */
router.post('/ads/sync', requireSubscription, async (req, res, next) => {
  try {
    res.json(await adsync.syncAccount({ accountId: account(req) }));
  } catch (err) { next(err); }
});
```

---

## Paso 7 · Panel

En `reports.js`, sustituye `renderAds()`:

```js
async function cargarAnuncios() {
  const params = new URLSearchParams({
    from: qs('#ads-from').value, to: qs('#ads-to').value,
  });
  const { rows, totals } = await App.session.api(`/ads?${params}`);

  qs('#ads-spend').textContent = App.money(totals.spend);
  qs('#ads-convos').textContent = App.num(totals.convos);
  qs('#ads-sales').textContent = App.num(totals.sales);
  qs('#ads-roi').textContent = totals.spend ? `${totals.roi.toFixed(0)}%` : '—';

  const tbody = qs('#ads-tbody');
  tbody.innerHTML = '';

  if (!rows.length) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: '10' },
      el('div', { class: 'empty-state', html:
        '<i class="fa-solid fa-bullhorn"></i>Sin datos. Conecta Meta Ads y espera a la primera sincronización.' }))));
    return;
  }
  // …pinta rows igual que ahora…
}
```

---

## Paso 8 · Arrancar los trabajadores

En `index.js`:

```js
import * as capi from './services/capi.js';
import * as adsync from './services/adsync.js';

const stopCapi = capi.startWorker();
const stopAds = adsync.startWorker();
```

Y en `shutdown()`: `stopCapi(); stopAds();`

---

## Cómo probarlo

### Conversions API

Meta tiene una herramienta pensada para esto: **Administrador de eventos →
tu píxel → Probar eventos**. Te da un `test_event_code`. Añádelo temporalmente
al payload:

```js
body: JSON.stringify({ ...payload, access_token: cfg.token, test_event_code: 'TEST12345' })
```

Marca un pago y el evento debe aparecer en esa pantalla en segundos.

```sql
SELECT event_name, value, currency, status, error FROM capi_events ORDER BY created_at DESC;
```

### Métricas

```js
import * as adsync from './server/src/services/adsync.js';
console.log(await adsync.syncAccount({ accountId: 'TU_ID' }));
```

```sql
SELECT date, ad_name, spend, impressions FROM ad_metrics ORDER BY date DESC LIMIT 10;
```

## Lista de verificación

- [ ] Migración `006_metricas.sql` aplicada
- [ ] Un contacto que llega por anuncio guarda `ad_id` y `ctwa_clid`
- [ ] Un pago válido crea una fila en `capi_events`
- [ ] El evento aparece en Probar eventos de Meta
- [ ] Teléfono y nombre viajan con hash, nunca en claro
- [ ] La sincronización trae gasto real
- [ ] La tabla del panel cruza gasto con ventas
- [ ] Sin credenciales, el panel muestra estado vacío y no un error

## Advertencias

**Nunca envíes datos personales sin hash.** Es incumplimiento de las condiciones
de Meta y de tu propia política de privacidad. Revisa que `ph` y `fn` sean
siempre resultado de `sha256`.

**La atribución no es perfecta.** Un contacto puede llegar por un anuncio y
comprar dos meses después. Aquí se le atribuye al primero que lo trajo, que es
una convención razonable pero una convención al fin.

**Límites de la API.** Meta limita las peticiones de insights. Una vez por hora
va sobrado; si sincronizas en cada carga del panel, te bloqueará.
