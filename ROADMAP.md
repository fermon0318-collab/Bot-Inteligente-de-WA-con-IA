# Elorai · qué está hecho y qué falta

Estado a fecha del último commit. Dos partes: **conectar** (credenciales y
servicios externos, no requiere código) y **construir** (lo que falta por
programar).

> **Para implementarlo tú misma:** cada bloque pendiente tiene su guía paso a
> paso con el código completo en **[docs/](docs/)**. Empieza por
> [docs/README.md](docs/README.md), que explica el orden y el método de trabajo.

---

# Parte 1 · Cómo conectar todo

Siete servicios externos. El orden importa: cada uno depende del anterior.

## 1. Dominio y DNS

| Qué | Dónde | Va a parar a |
|---|---|---|
| Dominio | Namecheap / Cloudflare / GoDaddy | — |
| Registro `A @` → IP del VPS | Panel DNS del dominio | — |
| Registro `A www` → IP del VPS | Panel DNS del dominio | — |

Verifica con `dig +short tudominio.com` antes de seguir. Si usas Cloudflare,
deja el proxy en **DNS only** hasta emitir el certificado.

## 2. Servidor

Dos rutas, la misma base de código:

- **Mientras dure el plan gratuito de Railway (30 días):** sin VPS ni nginx —
  Railway aloja el proceso de Node y le da HTTPS. Guía completa:
  **[docs/deploy-railway.md](docs/deploy-railway.md)**.
- **Al escalar, VPS propio** con **Ubuntu 24.04**. Recomendado: Hetzner CX22
  (~4 €/mes) o DigitalOcean 6 $/mes.

  ```bash
  ssh root@IP
  git clone <repo> /var/www/elorai && cd /var/www/elorai
  sudo bash deploy/deploy.sh tudominio.com
  ```

  Instala nginx, PostgreSQL, Node y certbot; genera `SESSION_SECRET` y
  `ENCRYPTION_KEY`; y se detiene pidiendo credenciales.

> **Guarda `ENCRYPTION_KEY` en un gestor de contraseñas.** Cifra los tokens de
> Meta y las API Key de IA de tus clientes. Si lo pierdes, son irrecuperables.

## 3. Google — botón «Ingresar»

> `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` son opcionales al arrancar: sin
> ellas el servidor funciona igual y el botón "Acceder con Google" solo
> redirige con un aviso. Puedes completar el paso de Credenciales (última
> fila de la tabla) más tarde, cuando ya tengas la URL pública real —
> justo como en el paso 6 de [docs/deploy-railway.md](docs/deploy-railway.md).

<https://console.cloud.google.com> → nuevo proyecto.

| Paso | Valor |
|---|---|
| Pantalla de consentimiento | Externo · dominios autorizados: `tudominio.com` |
| Enlaces legales | `https://tudominio.com/privacidad.html` y `/terminos.html` |
| Permisos | Solo `openid`, `email`, `profile` — así **no** necesitas verificación de Google |
| Credenciales → ID de cliente OAuth | Aplicación web |
| Origen autorizado | `https://tudominio.com` |
| URI de redirección | `https://tudominio.com/auth/google/callback` |

Copia **Client ID** y **Client Secret** → `/etc/elorai/elorai.env`:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

> La URI de redirección debe coincidir carácter por carácter, sin barra final.
> Es la causa del 90 % de los `redirect_uri_mismatch`.

## 4. Pasarela de pago — cobrar a tus clientes

> Mientras no configures ninguna, `BILLING_PROVIDER=none` deja que cualquier
> cuenta con sesión use el panel sin pagar — así puedes publicar y probar todo
> antes de tener cobros listos. El adaptador de Stripe (abajo) ya está
> terminado; el de **Wompi** (elegido para LatAm) está en proceso y se añade
> con el mismo patrón — ver el paso 9 de [docs/deploy-railway.md](docs/deploy-railway.md).

### Stripe

<https://dashboard.stripe.com>

| Paso | Qué copiar | Variable |
|---|---|---|
| Productos → precio mensual recurrente | `price_…` | `STRIPE_PRICE_MONTHLY` |
| Productos → precio anual recurrente | `price_…` | `STRIPE_PRICE_YEARLY` |
| Desarrolladores → Claves de API | `sk_live_…` | `STRIPE_SECRET_KEY` |
| Desarrolladores → Webhooks → `https://tudominio.com/api/billing/webhook` | `whsec_…` | `STRIPE_WEBHOOK_SECRET` |

Eventos del webhook: `checkout.session.completed`,
`customer.subscription.created/updated/deleted`, `invoice.paid`,
`invoice.payment_failed`.

Activa además **Stripe Tax** (el checkout ya envía `automatic_tax`, pero sin
activarlo no calcula nada) y el **Portal de clientes** (es lo que abre el botón
«Gestionar suscripción»).

Añade tu correo en `BILLING_BYPASS_EMAILS` para entrar sin pagarte a ti mismo.

## 5. Meta — WhatsApp Cloud API

| Paso | Dónde |
|---|---|
| Crear app de tipo «Empresa» | developers.facebook.com |
| Añadir producto WhatsApp | Panel de la app |
| Dar de alta el número | WhatsApp → Configuración de la API |
| Generar token permanente | Business Settings → Usuarios del sistema |
| Configurar webhook | URL `https://tudominio.com/webhook/whatsapp` + token de verificación |
| Suscribir campos | `messages`, `message_status` |

El **token de verificación** lo genera Elorai al crear cada cuenta y aparece en
la sección Cloud API del panel: hay que copiarlo tal cual en Meta. El endpoint
responde al `hub.challenge` y lo valida contra la cuenta correspondiente.

El token de acceso y los identificadores **los introduce cada cliente en el
panel**, no van en el `.env`. Se guardan cifrados, y el botón «Obtener Data de
Meta» los recupera solo a partir del token.

## 6. Proveedor de IA

Cada cliente pone su propia API Key en el panel (Configurar IA). No hay
credencial global: se guarda cifrada y el motor la usa para responder cuando
ningún disparador coincide. Se reconocen modelos de Anthropic y de OpenAI por
el nombre del modelo.

## 7. Meta Ads y Conversions API

Igual que el anterior: Ad Account ID, Access Token y Pixel ID los introduce el
cliente en el panel. Ya se guardan; **falta el envío de eventos** (bloque E).

---

# Parte 2 · Qué falta por construir

## Estado actual

| Capa | Estado |
|---|---|
| Landing, panel y páginas legales | ✅ completo |
| Autenticación con Google | ✅ funcionando (opcional al arrancar si aún no hay credenciales) |
| Cobros | ✅ adaptador de Stripe listo · `none` por defecto mientras Wompi no esté · Wompi pendiente |
| Protección del panel | ✅ nginx `auth_request` (Hetzner) y su equivalente en Express (Railway) |
| Base de datos y migraciones | ✅ 24 tablas |
| API del panel | ✅ 46 endpoints |
| **Métricas de anuncios y Conversions API (Bloque E)** | ✅ gasto real cruzado con ventas, conversiones reportadas a Meta |
| **Remarketing (Bloque D)** | ✅ trabajador periódico, franja horaria, interruptor por cuenta |
| Despliegue | ✅ Railway (sin nginx, ver [docs/deploy-railway.md](docs/deploy-railway.md)) y Hetzner+nginx probados |
| **Motor del bot** | ✅ webhook, flujos, IA y cola de envíos — probado |
| **Archivos (Bloque F)** | ✅ subida real, guardado en disco y a Meta |
| **Verificación de pagos (Bloque B)** | ✅ lectura de comprobantes, reglas, entrega y revisión manual |
| **Panel conectado a la API (Bloque C)** | ✅ completo, incluida Métricas de Anuncios (Bloque E) |
| **Producción (Bloque G)** | ✅ CSP estricta, copias de seguridad, avisos de error, límites de abuso, pruebas automatizadas |

---

## Bloque A · Motor del bot ✅ terminado

- [x] `GET /webhook/whatsapp` — verificación con el token de cada cuenta
- [x] `POST /webhook/whatsapp` — recepción, con respuesta a Meta en ~13 ms
  - [x] Cuenta resuelta por `phone_number_id`
  - [x] Duplicados descartados por `wa_message_id` (Meta reintenta)
  - [x] Bloqueo por país antes de gastar IA, con prefijo más largo primero
  - [x] Contacto y mensaje registrados siempre, se responda o no
  - [x] Origen del anuncio capturado del campo `referral`
- [x] Envío vía Graph API: texto, archivo y plantilla
- [x] Disparadores con normalización de acentos y prioridad al más específico
- [x] Flujos simples (texto / archivo / pausa)
- [x] Flujos avanzados: árbol que se detiene en cada condición y retoma con la
      respuesta del contacto, con estado en base para sobrevivir reinicios
- [x] IA con el prompt del cliente, historial de 12 mensajes y retraso configurable
- [x] Ventana de 24 h: se avisa antes de que Meta rechace el envío
- [x] Cola de salida con reintentos y espera creciente (30 s → 32 min)
- [x] Estados de entrega: enviado, entregado, leído, fallido
- [x] Detener automatización: cancela cola, flujos e IA de un contacto

**Archivos:** `server/src/services/{whatsapp,outbox,flows,ai,engine}.js` ·
`server/src/routes/webhook.js` · migración `002_bot_engine.sql`

**Pendiente menor:** plantillas aprobadas para escribir fuera de la ventana de
24 h (hoy se detecta y se avisa, pero no se envían).

## Bloque B · Cobros de los clientes finales ✅ terminado

📘 **Guía original: [docs/bloque-b-pagos.md](docs/bloque-b-pagos.md)**

- [x] Descarga del adjunto desde la Graph API
- [x] Lectura del comprobante con el modelo multimodal que ya configuró el
      cliente (Anthropic u OpenAI) → monto, moneda, referencia, fecha, banco
- [x] Comparación con las reglas de acceso (monto con tolerancia + contexto
      de la conversación reciente)
- [x] Entrega automática del mensaje y los archivos del producto
- [x] Marcado del contacto como pagado y disparo del flujo post-pago
- [x] Respuestas rápidas de medios de pago por palabra clave
- [x] Detección de referencia duplicada (mismo comprobante reenviado)
- [x] Cola de revisión manual (`manual_review`) para comprobantes ilegibles o
      sin proveedor de IA configurado, con aprobación desde `POST /api/receipts/:id/approve`

**Archivos:** `server/src/services/receipts.js` ·
`server/src/services/engine.js` (pasos 4.5 y 5.5 del pipeline) ·
`server/src/routes/api.js` (`/receipts`) · migración `004_pagos.sql`

**Probado de extremo a extremo** contra una base real: coincidencia de regla
por monto+tolerancia+contexto, aprobación manual con entrega real (mensaje +
archivo encolados, contacto marcado `paid`), doble aprobación rechazada
(409), y fallo real de descarga contra la Graph API de Meta manejado sin
degradar un contacto ya pagado.

**Pendiente:** la lectura automática en sí (llamada al modelo multimodal) no
se ha probado con una API Key real — sin ella, todo comprobante cae en
`manual_review`, que es el comportamiento esperado y seguro por defecto.

**Advertencia que ya aplica:** esto no sustituye la conciliación bancaria.
Revisa `payment_receipts` contra tu estado de cuenta real, sobre todo con
importes altos, y considera un umbral de monto por encima del cual todo vaya
a revisión manual.

**Depende de:** bloque A y bloque F (ya terminados).

## Bloque C · Panel con datos reales ✅ terminado

📘 **Guía original: [docs/bloque-c-panel.md](docs/bloque-c-panel.md)**

- [x] `dashboard.js` → `GET /api/stats` (tarjetas y 4 gráficos; se quitaron
      "Recurrencia" y "Rendimiento por distribuidor", que no tienen endpoint
      ni datos reales detrás — mejor sin la tarjeta que con una cifra inventada)
- [x] `chat.js` → `GET /api/conversations` y `/messages` + envío real, con
      subida de adjuntos real (Bloque F) y refresco cada 10 s solo en Chat en Vivo
- [x] `reports.js` → `GET /api/contacts` con filtros y paginación en servidor
- [x] `automation.js` → flujos, disparadores y remarketing desde la API
      (los archivos ya hablaban con la API real desde el Bloque F)
- [x] `settings.js` → pagos e IA desde la API (tutoriales y FAQ siguen en
      `catalogs.js`: son contenido tuyo, no datos de usuario)
- [x] `connect.js` → Cloud API y países desde la API
- [x] Exportación CSV generada en el servidor (`GET /api/contacts/export.csv`)
- [x] `mock.js` retirado; renombrado a `catalogs.js` con solo catálogos
      estáticos (monedas, países, zonas horarias, modelos de IA, emojis,
      tutoriales, FAQ, prompt de referencia, plantillas de flujo)

**Se queda como mock, a propósito:** Métricas de Anuncios (`reports.js`,
sección Ads) — no tiene endpoint todavía (Bloque E). En vez de datos
inventados, `App.ADS` arranca vacío y la tabla muestra un estado vacío real.

**Probado con Playwright contra un servidor y una base real:** cada sección
carga datos reales desde la cuenta de prueba (incluida una cuenta nueva, que
muestra ceros sin errores), y dos escrituras completas por la UI (crear un
disparador, guardar un mensaje de pagos) sobrevivieron a una recarga completa
de la página — confirma que persisten en el servidor y no solo en memoria.

**Depende de:** nada (la API respondía desde antes). Bloque F ya estaba
terminado, así que Archivos no necesitó cambios en este bloque.

## Bloque D · Automatizaciones programadas ✅ terminado

📘 **Guía original: [docs/bloque-d-remarketing.md](docs/bloque-d-remarketing.md)**

- [x] Trabajo periódico (cada 5 min) que detecta contactos sin conversión
- [x] Respeto de la franja horaria y la zona horaria de cada cuenta, incluidas
      franjas nocturnas que cruzan medianoche (22:00–02:00)
- [x] Ejecución de la secuencia de remarketing por la cola de salida
- [x] Registro en `remarketing_sends` para no reenviar al mismo contacto
- [x] Interruptor por cuenta (`rm_enabled`), **apagado por defecto**
- [x] Excluye contactos ya pagados, con automatización detenida o con algo
      pendiente de enviarse todavía

**Archivos:** `server/src/services/remarketing.js` ·
`server/src/index.js` (trabajador) · `server/src/routes/api.js`
(`enabled` en `/settings/remarketing`) · migración `005_remarketing.sql`

**Probado de extremo a extremo** contra una base real: franja normal y franja
que cruza medianoche calculadas bien, un contacto candidato recibe la
secuencia y una segunda pasada no la duplica, un contacto pagado y uno con
automatización detenida quedan excluidos, y apagar el interruptor detiene los
envíos de inmediato. El interruptor también se probó por la UI real: se
activa, se guarda y persiste tras recargar la página completa.

**Depende de:** bloque A (ya terminado).

## Bloque E · Métricas de anuncios ✅ terminado

📘 **Guía original: [docs/bloque-e-metricas.md](docs/bloque-e-metricas.md)**

- [x] Atribución del contacto al anuncio de origen (`ad_id`, `ad_name`, `ctwa_clid`)
- [x] Sincronización horaria del gasto real con la Marketing API de Meta,
      guardado por día y por anuncio en `ad_metrics`
- [x] `GET /api/ads` cruza ese gasto con las ventas reales de `contacts` y
      calcula costo/conversación, costo/venta y ROI en el servidor
- [x] Botón de sincronización manual (`POST /api/ads/sync`) sin esperar a la
      pasada horaria
- [x] Conversions API: cada venta (automática o marcada a mano) encola un
      evento `Purchase` con teléfono y nombre siempre con hash SHA-256, nunca
      en claro, y `ctwa_clid` cuando existe

**Archivos:** `server/src/services/{capi,adsync}.js` ·
`server/src/services/engine.js` (captura `ctwa_clid`) ·
`server/src/services/receipts.js` (`entregar()` encola la conversión) ·
migración `006_metricas.sql`

**Se quitó la columna "Estado" de la tabla de anuncios** del panel: la
Marketing API de insights no expone el estado activo/pausado del anuncio (eso
vive en el nodo `ad`, no en `insights`, y añadir esa llamada extra quedaba
fuera de lo que pedía este bloque), así que mostrar un badge inventado sería
peor que no mostrarlo.

**Un bug que corregí de paso:** `PUT /settings/ads` guarda las credenciales de
Meta Ads y las de Conversions API en el mismo registro. El panel tiene dos
formularios separados ("Guardar credenciales" y "Guardar" de Conversions
API) que pegan al mismo endpoint — si cada uno mandara solo sus propios
campos, guardar uno borraría los valores del otro. Ahora los dos envían
siempre el conjunto completo.

**Probado de extremo a extremo** contra una base y credenciales reales
(fake token/pixel, llamada real a Meta): `recordPurchase` encola y `flush`
hace la llamada real a Conversions API, que Meta rechaza con 403 y el evento
queda marcado `failed` con el motivo — nunca se pierde ni rompe el flujo de
pago. `GET /api/ads` cruza gasto y ventas reales correctamente. Por la UI
real: guardar credenciales de Ads y luego Conversions API no borra lo que se
guardó antes (justo el bug que corregí), y ambos persisten tras recargar la
página completa.

**Depende de:** bloques A y B (ya terminados).

## Bloque F · Archivos ✅ terminado

📘 **Guía original: [docs/bloque-f-archivos.md](docs/bloque-f-archivos.md)**

- [x] `POST /api/media` — subida real, en memoria y validada por tipo/tamaño
- [x] Almacenamiento en disco (`UPLOADS_DIR`, con nombre aleatorio por archivo)
- [x] Subida a la Graph API para obtener el `media_id`, renovado automáticamente
      a los 25 días desde `outbox.js` si ya caducó
- [x] `DELETE /api/media/:id` borra también el archivo en disco
- [x] Panel conectado: subir, listar y borrar hablan con la API real

**Archivos:** `server/src/services/{storage,media}.js` ·
`server/src/routes/api.js` · migración `003_media.sql` ·
`assets/js/automation.js`

**Pendiente:** en Railway hace falta montar un Volume en `UPLOADS_DIR` o los
archivos no sobreviven a un redeploy (ver paso 5 de
[docs/deploy-railway.md](docs/deploy-railway.md)).

## Bloque G · Endurecer para producción ✅ terminado (lo que se podía hacer sin servidor real)

📘 **Guía completa: [docs/bloque-g-produccion.md](docs/bloque-g-produccion.md)**

- [x] Compilar Tailwind y quitar `'unsafe-eval'` **y** `'unsafe-inline'` de la CSP
- [x] Copias de seguridad automáticas de PostgreSQL en cron (con salida opcional
      fuera del servidor vía `rclone`)
- [x] Registro de errores agregado: aviso deduplicado (10 min por error) a un
      webhook (Slack/Discord/lo que sea) para los fallos graves del servidor y
      de cada trabajador en segundo plano
- [x] Límite diario de respuestas de IA por cuenta, para que un uso
      descontrolado no vacíe la tarjeta de nadie
- [x] Límite de comprobantes de pago por contacto (1 cada 2 minutos), para que
      no se pueda forzar a pagar por lecturas de IA mandando fotos en bucle
- [x] Pruebas automatizadas del motor del bot (`node --test`, sin dependencias
      externas)
- [ ] Monitorización de caídas (Uptime Kuma, Better Stack…) — **manual**, hace
      falta una cuenta real; ver `deploy/README.md`
- [ ] Límite de peticiones compartido entre instancias — los límites nuevos
      (IA, comprobantes) ya viven en PostgreSQL y por tanto son correctos con
      varias instancias; el `rateLimit()` que ya existía para
      `/auth/google` y `/billing/*` sigue en memoria (un solo proceso), tal
      como su propio comentario en el código ya advertía — moverlo a Redis o
      a `limit_req` de nginx solo hace falta si algún día hay más de una
      instancia corriendo a la vez

**Archivos:** `server/src/lib/alert.js` ·
`server/src/db/migrations/007_limites.sql` ·
`server/src/services/ai.js` (límite diario) ·
`server/src/services/receipts.js` (cooldown por contacto) ·
`server/src/index.js` y los cuatro trabajadores en segundo plano
(`outbox`, `remarketing`, `capi`, `adsync`) — todos avisan por `alert.js` ·
`deploy/elorai-backup.sh`, `deploy/elorai-logrotate.conf` ·
`deploy/deploy.sh` (pasos 4 y 9) · `tools/tailwind-input.css` →
`assets/css/tailwind.css` (compilado, committeado) ·
`server/test/*.test.js` · `.env.example` (`ALERT_WEBHOOK`)

**Un bug que corregí de paso:** `normalize()` en `flows.js` devolvía la
cadena literal `"null"` cuando el texto de entrada era `null` (el valor por
defecto de un parámetro solo actúa sobre `undefined`, nunca sobre `null`), lo
que podía romper el matching de disparadores. Ahora usa `String(text ?? '')`.

**Probado de extremo a extremo** contra una base real: se hicieron 5
llamadas a `ai.reply()` con el límite diario puesto en 3, se confirmó que
`ai_usage.calls` llega a 5 (todas cuentan) y que el aviso en `activity_log`
sale exactamente una vez, al cruzar el límite. Para el cooldown de
comprobantes: dos llamadas seguidas a `processReceipt()` para el mismo
contacto, la segunda devuelve `rate_limited` sin intentar descargar el
archivo ni llamar a la IA, y queda registrada como tal. Con Playwright: el
error de consola `tailwind is not defined` que aparecía en todas las
pruebas de los bloques anteriores (por no poder llegar al CDN) ya no
aparece — el panel carga con la hoja compilada — y la CSP más estricta no
bloquea nada que debiera cargar (Chart.js sigue permitido desde jsdelivr; lo
único que falla son los propios CDNs externos por no tener salida de red en
este entorno de pruebas, no por la CSP). 20/20 pruebas automatizadas en
verde (`npm test` en `server/`).

**Pendiente, y no se puede automatizar desde aquí** (todo documentado en
`deploy/README.md` §§ 8-9 y en `docs/bloque-g-produccion.md`):
- Dar de alta una cuenta de monitorización externa (Uptime Kuma propio o
  Better Stack) y apuntarla a `/`.
- Configurar `rclone` en el servidor real para que las copias salgan del
  disco.
- Endurecer el propio servidor (SSH sin contraseña, `unattended-upgrades`,
  revisar puertos abiertos) — la sección 9 de `deploy/README.md` trae los
  comandos, pero solo tienen sentido contra una máquina real.
- Rotar los secretos según la tabla nueva de `deploy/README.md` § 9 cuando
  toque (especialmente `ENCRYPTION_KEY`, que necesita una migración de
  datos, no solo cambiar la variable).

**Depende de:** todos los bloques anteriores (ya terminados).

---

## Orden recomendado

1. ~~Bloque A~~ ✅
2. ~~Bloque F~~ ✅
3. ~~Bloque B~~ ✅
4. ~~Bloque C~~ ✅
5. ~~Bloque D~~ ✅
6. ~~Bloque E~~ ✅
7. ~~Bloque G~~ ✅ (la parte que no requiere un servidor real ya está)
8. **Publicar en Railway** ([docs/deploy-railway.md](docs/deploy-railway.md)) **y
   conectar un número real de WhatsApp.** El motor no se puede dar por bueno
   hasta que haya hablado con Meta de verdad — y hasta entonces, nada de lo
   construido en los bloques B a G se ha visto en producción.
9. Completar el resto de Bloque G contra el servidor real: monitorización,
   `rclone`, endurecer SSH — ver checklist en `deploy/README.md` §§ 8-9.

## Antes de abrir al público

- [ ] Sustituir los marcadores de `index.html` (`grep -n "\[[A-Z_]\+\]" index.html`)
- [ ] Completar `privacidad.html` y `terminos.html` y hacerlos revisar por un abogado
- [ ] Alinear `[PLAZO_REEMBOLSO]` en `terminos.html` y `assets/js/catalogs.js`
- [ ] Publicar la pantalla de consentimiento de Google
- [ ] Pasar Stripe de claves de prueba a producción
- [ ] Retirar `BILLING_BYPASS_EMAILS` de cuentas que no sean tuyas
