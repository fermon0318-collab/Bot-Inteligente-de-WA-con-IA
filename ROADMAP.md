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
| Base de datos y migraciones | ✅ 20 tablas |
| API del panel | ✅ 44 endpoints |
| Despliegue | ✅ Railway (sin nginx, ver [docs/deploy-railway.md](docs/deploy-railway.md)) y Hetzner+nginx probados |
| **Motor del bot** | ✅ webhook, flujos, IA y cola de envíos — probado |
| **Archivos (Bloque F)** | ✅ subida real, guardado en disco y a Meta |
| **Verificación de pagos (Bloque B)** | ✅ lectura de comprobantes, reglas, entrega y revisión manual |
| **Panel conectado a la API (Bloque C)** | ✅ todo excepto Métricas de Anuncios, que espera al Bloque E |

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

## Bloque D · Automatizaciones programadas

📘 **Guía completa: [docs/bloque-d-remarketing.md](docs/bloque-d-remarketing.md)**

- [ ] Trabajo periódico que detecta contactos sin conversión
- [ ] Respeto de la franja horaria y la zona horaria del cliente
- [ ] Ejecución de la secuencia de remarketing
- [ ] Registro para no reenviar al mismo contacto

**Depende de:** bloque A.

## Bloque E · Métricas de anuncios

📘 **Guía completa: [docs/bloque-e-metricas.md](docs/bloque-e-metricas.md)**

- [ ] Lectura de gasto y campañas desde la Marketing API de Meta
- [ ] `GET /api/ads` con el detalle por anuncio (no existe todavía)
- [ ] Envío del evento de compra por Conversions API al confirmar un pago
- [ ] Atribución del contacto al anuncio de origen (`ctwa_clid`)

**Depende de:** bloques A y B.

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

## Bloque G · Endurecer para producción

📘 **Guía completa: [docs/bloque-g-produccion.md](docs/bloque-g-produccion.md)**

- [ ] Compilar Tailwind y quitar `'unsafe-eval'` de la CSP (ver `deploy/README.md`)
- [ ] Copias de seguridad automáticas de PostgreSQL en cron
- [ ] Monitorización de caídas (Uptime Kuma, Better Stack…)
- [ ] Registro de errores agregado (Sentry o similar)
- [ ] Límite de peticiones compartido si algún día hay más de una instancia
- [ ] Pruebas automatizadas del motor del bot

---

## Orden recomendado

1. ~~Bloque A~~ ✅
2. ~~Bloque F~~ ✅
3. ~~Bloque B~~ ✅
4. ~~Bloque C~~ ✅
5. **Publicar en Railway** ([docs/deploy-railway.md](docs/deploy-railway.md)) **y
   conectar un número real de WhatsApp.** El motor no se puede dar por bueno
   hasta que haya hablado con Meta de verdad — y hasta entonces, ni la lectura
   de comprobantes ni el panel se han visto en producción.
6. **Bloques D y E** por valor comercial.
7. **Bloque G** antes de tener volumen real.

## Antes de abrir al público

- [ ] Sustituir los marcadores de `index.html` (`grep -n "\[[A-Z_]\+\]" index.html`)
- [ ] Completar `privacidad.html` y `terminos.html` y hacerlos revisar por un abogado
- [ ] Alinear `[PLAZO_REEMBOLSO]` en `terminos.html` y `assets/js/catalogs.js`
- [ ] Publicar la pantalla de consentimiento de Google
- [ ] Pasar Stripe de claves de prueba a producción
- [ ] Retirar `BILLING_BYPASS_EMAILS` de cuentas que no sean tuyas
