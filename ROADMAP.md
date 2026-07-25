# ApolAI · qué está hecho y qué falta

Estado a fecha del último commit. Dos partes: **conectar** (credenciales y
servicios externos, no requiere código) y **construir** (lo que falta por
programar).

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

VPS con **Ubuntu 24.04**. Recomendado: Hetzner CX22 (~4 €/mes) o DigitalOcean 6 $/mes.

```bash
ssh root@IP
git clone <repo> /var/www/apolai && cd /var/www/apolai
sudo bash deploy/deploy.sh tudominio.com
```

Instala nginx, PostgreSQL, Node y certbot; genera `SESSION_SECRET` y
`ENCRYPTION_KEY`; y se detiene pidiendo credenciales.

> **Guarda `ENCRYPTION_KEY` en un gestor de contraseñas.** Cifra los tokens de
> Meta y las API Key de IA de tus clientes. Si lo pierdes, son irrecuperables.

## 3. Google — botón «Ingresar»

<https://console.cloud.google.com> → nuevo proyecto.

| Paso | Valor |
|---|---|
| Pantalla de consentimiento | Externo · dominios autorizados: `tudominio.com` |
| Enlaces legales | `https://tudominio.com/privacidad.html` y `/terminos.html` |
| Permisos | Solo `openid`, `email`, `profile` — así **no** necesitas verificación de Google |
| Credenciales → ID de cliente OAuth | Aplicación web |
| Origen autorizado | `https://tudominio.com` |
| URI de redirección | `https://tudominio.com/auth/google/callback` |

Copia **Client ID** y **Client Secret** → `/etc/apolai/apolai.env`:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

> La URI de redirección debe coincidir carácter por carácter, sin barra final.
> Es la causa del 90 % de los `redirect_uri_mismatch`.

## 4. Stripe — cobrar a tus clientes

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

⚠️ **Esto todavía no funciona: falta el código del webhook (bloque A).**
Cuando exista, la conexión será:

| Paso | Dónde |
|---|---|
| Crear app de tipo «Empresa» | developers.facebook.com |
| Añadir producto WhatsApp | Panel de la app |
| Dar de alta el número | WhatsApp → Configuración de la API |
| Generar token permanente | Business Settings → Usuarios del sistema |
| Configurar webhook | URL `https://tudominio.com/webhook/whatsapp` + token de verificación |
| Suscribir campos | `messages`, `message_status` |

El token y los identificadores **los introduce cada cliente en el panel**
(sección Cloud API), no van en el `.env`. El panel ya los guarda cifrados y
tiene el botón «Obtener Data de Meta» que los recupera solo.

## 6. Proveedor de IA

Cada cliente pone su propia API Key en el panel (Configurar IA). No hay
credencial global. El backend ya la guarda cifrada; **falta el código que la
usa** (bloque A).

## 7. Meta Ads y Conversions API

Igual que el anterior: Ad Account ID, Access Token y Pixel ID los introduce el
cliente en el panel. Ya se guardan; **falta el envío de eventos** (bloque E).

---

# Parte 2 · Qué falta por construir

## Estado actual

| Capa | Estado |
|---|---|
| Landing, panel y páginas legales | ✅ completo |
| Autenticación con Google | ✅ funcionando |
| Suscripciones con Stripe | ✅ funcionando |
| Protección del panel (nginx `auth_request`) | ✅ funcionando |
| Base de datos y migraciones | ✅ 18 tablas |
| API del panel | ✅ 40 endpoints |
| Despliegue (nginx, systemd, TLS) | ✅ probado |
| **Motor del bot** | ❌ no existe |
| **Panel conectado a la API** | ⚠️ solo sesión y cobros; los datos siguen siendo de ejemplo |

---

## Bloque A · Motor del bot ← **el más importante**

Sin esto ApolAI no es un bot: es un panel bonito. Todo lo demás depende de aquí.

- [ ] `GET /webhook/whatsapp` — verificación del webhook (Meta manda `hub.challenge`)
- [ ] `POST /webhook/whatsapp` — recepción de mensajes
  - [ ] Resolver a qué cuenta pertenece el `phone_number_id`
  - [ ] Descartar duplicados por `wa_message_id` (Meta reintenta)
  - [ ] Aplicar bloqueo por país antes de gastar créditos
  - [ ] Crear o actualizar el contacto y guardar el mensaje
- [ ] Envío de mensajes vía Graph API (texto, archivo, plantilla)
- [ ] Motor de disparadores: coincidencia de palabra clave → flujo, con
      predeterminado si nada coincide
- [ ] Ejecución de flujos simples (texto / archivo / pausa)
- [ ] Ejecución de flujos avanzados (árbol con condiciones)
- [ ] Llamada al proveedor de IA con el prompt base del cliente
- [ ] Respeto de la ventana de 24 h de Meta (fuera de ella, solo plantillas)
- [ ] Cola de reintentos para fallos de la Graph API

**Depende de:** nada. **Bloquea:** todo lo demás.

## Bloque B · Cobros de los clientes finales

- [ ] Descarga del adjunto desde la Graph API
- [ ] Lectura del comprobante (OCR o modelo multimodal) → monto, fecha, referencia
- [ ] Comparación con las reglas de acceso (monto + contexto)
- [ ] Entrega automática del mensaje y los archivos del producto
- [ ] Marcado del contacto como pagado y disparo del flujo post-pago
- [ ] Respuestas rápidas de medios de pago por palabra clave

**Depende de:** bloque A.

## Bloque C · Panel con datos reales

La API ya existe; falta que el frontend la use en lugar de `mock.js`.

- [ ] `dashboard.js` → `GET /api/stats` (tarjetas y 5 gráficos)
- [ ] `chat.js` → `GET /api/conversations` y `/messages` + envío real
- [ ] `reports.js` → `GET /api/contacts` con filtros y paginación en servidor
- [ ] `automation.js` → flujos, disparadores y archivos desde la API
- [ ] `settings.js` → pagos, IA y remarketing desde la API
- [ ] `connect.js` → Cloud API y países desde la API
- [ ] Exportación CSV desde el servidor (hoy se genera con datos de ejemplo)
- [ ] Retirar `mock.js`

**Depende de:** nada (la API responde). Se puede hacer en paralelo al bloque A.

## Bloque D · Automatizaciones programadas

- [ ] Trabajo periódico que detecta contactos sin conversión
- [ ] Respeto de la franja horaria y la zona horaria del cliente
- [ ] Ejecución de la secuencia de remarketing
- [ ] Registro para no reenviar al mismo contacto

**Depende de:** bloque A.

## Bloque E · Métricas de anuncios

- [ ] Lectura de gasto y campañas desde la Marketing API de Meta
- [ ] `GET /api/ads` con el detalle por anuncio (no existe todavía)
- [ ] Envío del evento de compra por Conversions API al confirmar un pago
- [ ] Atribución del contacto al anuncio de origen (`ctwa_clid`)

**Depende de:** bloques A y B.

## Bloque F · Archivos

- [ ] `POST /api/media` — subida real (hoy solo hay listar y borrar)
- [ ] Almacenamiento en disco o S3 con límite de tamaño y tipo
- [ ] Subida a la Graph API para obtener el `media_id` reutilizable

**Depende de:** nada.

## Bloque G · Endurecer para producción

- [ ] Compilar Tailwind y quitar `'unsafe-eval'` de la CSP (ver `deploy/README.md`)
- [ ] Copias de seguridad automáticas de PostgreSQL en cron
- [ ] Monitorización de caídas (Uptime Kuma, Better Stack…)
- [ ] Registro de errores agregado (Sentry o similar)
- [ ] Límite de peticiones compartido si algún día hay más de una instancia
- [ ] Pruebas automatizadas del motor del bot

---

## Orden recomendado

1. **Publicar lo que ya funciona** (partes 1.1 a 1.4). Tienes landing con
   registro y cobro real: puedes empezar a vender antes de terminar el bot.
2. **Bloque A** — sin él no hay producto.
3. **Bloque C en paralelo** — es independiente y hace el panel creíble.
4. **Bloque B** — la verificación de pagos es tu diferenciador frente a la
   competencia.
5. **Bloques D, E y F** por valor comercial.
6. **Bloque G** antes de tener volumen real.

## Antes de abrir al público

- [ ] Sustituir los marcadores de `index.html` (`grep -n "\[[A-Z_]\+\]" index.html`)
- [ ] Completar `privacidad.html` y `terminos.html` y hacerlos revisar por un abogado
- [ ] Alinear `[PLAZO_REEMBOLSO]` en `terminos.html` y `assets/js/mock.js`
- [ ] Publicar la pantalla de consentimiento de Google
- [ ] Pasar Stripe de claves de prueba a producción
- [ ] Retirar `BILLING_BYPASS_EMAILS` de cuentas que no sean tuyas
