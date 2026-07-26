# Elorai

Producto completo de Elorai: landing pública, panel de administración, backend con
autenticación de Google y suscripciones de Stripe, y despliegue con nginx.

| Página | Archivo | Qué es |
|---|---|---|
| Landing | `index.html` | Sitio de marketing: hero, características, cómo funciona, ROI, precios |
| Panel | `dashboard.html` | SPA de administración con 16 secciones (requiere sesión y suscripción) |
| Privacidad | `privacidad.html` | Política de privacidad (borrador) |
| Términos | `terminos.html` | Términos y condiciones (borrador) |
| Backend | `server/` | Node + PostgreSQL: login con Google, cobros con Stripe y API del panel |
| Despliegue | `deploy/` | nginx, systemd y script de instalación — ver [deploy/README.md](deploy/README.md) |

Todas comparten `assets/css/elorai.css`, el logo y la tipografía: son literalmente
los mismos componentes, no dos interpretaciones de la misma marca.

![Elorai](assets/img/elorai-logo.svg)

**Estado del proyecto: [ROADMAP.md](ROADMAP.md)** · **Guías de implementación: [docs/](docs/README.md)**

## Publicar

La guía completa —dominio, VPS, DNS, credenciales de Google y Stripe, TLS— está
en **[deploy/README.md](deploy/README.md)**. Resumen:

```bash
git clone <repo> /var/www/elorai && cd /var/www/elorai
sudo bash deploy/deploy.sh tu-dominio.com
```

## Desarrollo local

Solo el frontend (con datos de ejemplo, sin backend):

```bash
npx http-server -p 8080     # o: python3 -m http.server 8080
```

Con backend completo:

```bash
cp .env.example server/.env     # y completa los valores
cd server && npm install && npm run migrate && npm run dev
```

Requiere PostgreSQL 14+ y conexión a internet para las CDNs (Tailwind,
Chart.js, Font Awesome, Google Fonts).

## Arquitectura

```
navegador → nginx ─┬─ archivos estáticos (landing, panel, assets)
                   └─ /api · /auth · /webhook → Node (127.0.0.1:3000) → PostgreSQL
```

nginx protege `dashboard.html` con `auth_request`: consulta a Node antes de
entregar el HTML, así el panel no depende de que el JavaScript del navegador
redirija. Sin sesión no se sirve el archivo.

**Autenticación**: Google OAuth 2.0 con PKCE. La sesión vive en la base de
datos y la cookie solo lleva su identificador firmado, de modo que cerrar
sesión la invalida de verdad.

**Cobros**: Stripe Checkout y Customer Portal alojados — los datos de tarjeta
nunca tocan este servidor. El adaptador está aislado en `server/src/billing/`
detrás de una interfaz de cuatro métodos: cambiar a Paddle o Lemon Squeezy es
escribir otro archivo, no tocar el backend.

**Credenciales de terceros** (token de Meta, API Key de IA) se guardan cifradas
con AES-256-GCM y vuelven al panel siempre enmascaradas.

## Sistema de diseño

**Marca (índigo → violeta → púrpura)**

| Rol | Tailwind | Hex |
|---|---|---|
| Marca 1 · inicio de gradiente | `brand-600` | `#4F46E5` |
| Marca 2 · medio | `accent-600` | `#7C3AED` |
| Marca 3 · fin de gradiente | `plum-600` | `#9333EA` |
| Botón primario · hover | `brand-700` | `#4338CA` |
| Badge de ícono | `brand-500` → `plum-600` | `#6366F1` → `#9333EA` |

**Superficies** — glass claro sobre fondo lavanda: `linear-gradient(#F5F3FF → #FDF4FF)`,
tarjetas `rgba(255,255,255,.75)` con `backdrop-blur`, borde `rgba(196,181,253,.7)`,
tinta `#1E1B4B`.

**Estados** (universales, no se tiñen de morado): `#10B981` en línea/pagado,
`#F59E0B` pendiente, `#EF4444` destructivo.

**Tipografía**: Plus Jakarta Sans (UI) · JetBrains Mono (terminal y prompt).

**Logo**: robot con placa de moneda, adaptado a la paleta morada conservando el
trazado original. Contorno `#6D28D9`, panel facial `#8B5CF6`, sombreado `#DDD6FE`,
relleno claro `#EEF2FF`.

`assets/img/elorai-logo.svg` es la fuente de verdad. Si cambia la paleta, se edita
ese archivo y se regeneran los PNG (favicons y apple-touch-icon):

```bash
npm i -D playwright && node tools/render_logo.mjs
```

## Estructura

```
index.html              Landing pública
dashboard.html          Panel de administración (16 secciones)
privacidad.html         Política de privacidad
terminos.html           Términos y condiciones
assets/css/
  elorai.css            Sistema de diseño compartido por todas las páginas
  landing.css           Solo landing: blobs, timeline, precios, reveal
  legal.css             Solo legales: índice lateral, prosa, marcadores
assets/js/
  session.js            Cliente de la API: sesión, cobros y portal de cliente
  landing.js            Navbar, menú móvil, modal de login, scroll y reveal
  legal.js              Navbar, índice activo y scroll de las páginas legales
  mock.js               Datos de ejemplo — el punto a sustituir por la API real
  core.js               Helpers, navegación SPA, modales, toasts, loader, CSV, paginador
  dashboard.js          Estadísticas, resumen de ventas y 5 gráficos de Chart.js
  connect.js            Cloud API (webhook, alta semi-automática, logs) y bloqueo por país
  chat.js               Motor de chat compartido por Chat en Vivo e Histórico
  reports.js            Reportes de contactos y métricas de anuncios
  automation.js         Archivos, flujos simples y avanzados, remarketing, disparadores
  settings.js           Pagos y acceso, configuración de IA, tutoriales, FAQ
  app.js                Arranque
server/
  src/config.js         Lectura y validación de las variables de entorno
  src/db/               Pool, migrador y esquema SQL
  src/lib/              Cifrado AES-256-GCM, firma HMAC y sesiones
  src/middleware/       Sesión, control de acceso y límite de peticiones
  src/routes/           OAuth de Google, cobros y API del panel
  src/billing/          Adaptador de la pasarela (hoy Stripe)
deploy/
  nginx.conf            Sitio: TLS, CSP, auth_request, caché y proxy
  elorai-headers.conf   Cabeceras de seguridad compartidas
  elorai-proxy.conf     Cabeceras de proxy hacia Node
  elorai.service        Unidad de systemd endurecida
  deploy.sh             Instalación y despliegue idempotentes
  README.md             Guía de publicación paso a paso
tools/render_logo.mjs   Rasterizador del logo a PNG
```

## Antes de publicar la landing

`index.html` lleva marcadores que hay que sustituir por datos reales. Están
listados en un comentario al inicio del archivo y se localizan con:

```bash
grep -n "\[[A-Z_]\+\]" index.html
```

| Marcador | Qué va ahí |
|---|---|
| `[WHATSAPP_NUMBER]` | Número en formato internacional sin signos |
| `[SOPORTE_EMAIL]` | Correo de soporte |
| `[YOUTUBE_CHANNEL_URL]` | Canal de tutoriales |
| `[PRECIO_MENSUAL]` / `[PRECIO_ANUAL]` | Precios de cada plan |
| `[DESCUENTO_ANUAL]` | Ahorro del plan anual |
| `[MEJORA_1..3]` | Métricas de resultados |

Las tres métricas del bloque "Resultados esperables" son marcadores a propósito:
publicar cifras inventadas como si fueran datos medidos de Elorai sería publicidad
engañosa. Sustitúyelas por resultados propios indicando periodo y muestra, o borra
el bloque.

## Páginas legales

`privacidad.html` y `terminos.html` están redactadas a partir de cómo funciona Elorai
de verdad: qué datos toca el bot, qué se envía a Meta y al proveedor de IA, qué pasa
con los comprobantes de pago, y quién responde de qué frente a los contactos finales.

**Son borradores, no asesoría legal.** Ambas llevan un aviso visible (`.legal-draft`)
que hay que eliminar antes de publicar, y marcadores en amarillo (`.ph`) con los datos
de tu empresa:

| Marcador | Dónde |
|---|---|
| `[RAZON_SOCIAL]`, `[DOMICILIO_FISCAL]` | Ambas |
| `[PAIS_JURISDICCION]`, `[CIUDAD_TRIBUNALES]` | Ambas / Términos |
| `[PROVEEDOR_IA]`, `[PROVEEDOR_HOSTING]`, `[REGION_SERVIDORES]` | Privacidad |
| `[DIAS_RETENCION]`, `[PLAZO_RESPUESTA_DERECHOS]` | Privacidad |
| `[PLAZO_REEMBOLSO]`, `[LIMITE_CONVERSACIONES_REEMBOLSO]` | Términos |
| `[DIAS_PREAVISO_PRECIO]`, `[SLA_DISPONIBILIDAD]` | Términos |

Antes de publicar hay que revisarlas con un abogado de tu jurisdicción: las cláusulas
de limitación de responsabilidad y de fuero tienen límites distintos en cada país y
varias no son oponibles frente a consumidores.

### El FAQ del panel usa los mismos marcadores

El FAQ de `dashboard.html` (definido en `assets/js/mock.js`) no repite cifras: usa
`[PLAZO_REEMBOLSO]`, `[LIMITE_CONVERSACIONES_REEMBOLSO]` y `[DIAS_RETENCION]`, los
mismos de las páginas legales, y enlaza a la cláusula correspondiente. Al decidir un
plazo hay que sustituirlo en los tres sitios:

```bash
grep -rn "\[PLAZO_REEMBOLSO\]" terminos.html assets/js/mock.js
```

Cualquier marcador `[ASI]` dentro de una respuesta del FAQ se renderiza como chip
ámbar, igual que en las legales, para que un plazo sin decidir se vea en pantalla.

Queda una coherencia que el código no puede garantizar: el rol de encargado del
tratamiento descrito en `privacidad.html` debe reflejarse en el contrato que firmes
con tus clientes.

## Secciones del panel

**Principal** — Dashboard · Cloud API · Bloqueo por País · Chat en Vivo ·
Histórico Chats · Reportes · Métricas de Anuncios
**Automatización** — Archivos · Flujos Simples · Flujos Avanzados · Remarketing · Disparadores
**Configuración** — Pagos y Acceso · Configurar IA · Tutoriales · Preguntas Frecuentes

Cada sección es funcional con datos simulados: navegación sin recarga, formularios
con validación, modales de confirmación, gráficos, tablas paginadas, acordeón,
drag & drop de archivos, editor de árbol con zoom y sidebar colapsable en móvil.

## Conectar un backend

Todo el estado vive en `assets/js/mock.js`; los módulos solo lo leen y lo mutan.
Para conectar la API real:

1. Reemplaza cada colección de `mock.js` por un `fetch` al endpoint equivalente.
2. Sustituye `App.fakeRequest(ms)` (en `core.js`) por la llamada HTTP real —
   es el único punto donde se simula latencia, y ya está envuelto en `App.withBusy`,
   que se encarga del estado de carga de cada botón.
3. Los inputs y botones tienen IDs estables y descriptivos (`#api-token`,
   `#capi-pixel`, `#rep-tbody`, `#trig-form`…) para engancharlos sin tocar el markup.

Utilidades disponibles en `window.Elorai`: `toast`, `modal`, `confirmModal`,
`promptModal`, `validate`, `downloadCsv`, `renderPager`, `money`, `navigate`,
`setConnection`, `setBotState`, `onView`.
