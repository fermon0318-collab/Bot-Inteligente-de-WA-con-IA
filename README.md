# ApolAI

Sitio de ApolAI: landing pública + panel de administración del bot de WhatsApp con IA.
Sin build step — se abren los HTML y funcionan.

| Página | Archivo | Qué es |
|---|---|---|
| Landing | `index.html` | Sitio de marketing: hero, características, cómo funciona, ROI, precios |
| Panel | `dashboard.html` | SPA de administración con 16 secciones |

Ambas comparten `assets/css/apolai.css`, el logo y la tipografía: son literalmente
los mismos componentes, no dos interpretaciones de la misma marca.

![ApolAI](assets/img/apolai-logo.svg)

## Cómo ejecutarlo

```bash
npx http-server -p 8080     # o: python3 -m http.server 8080
```

Y abrir <http://localhost:8080>. Requiere conexión a internet para las CDNs
(Tailwind, Chart.js, Font Awesome, Google Fonts).

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

`assets/img/apolai-logo.svg` es la fuente de verdad. Si cambia la paleta, se edita
ese archivo y se regeneran los PNG (favicons y apple-touch-icon):

```bash
npm i -D playwright && node tools/render_logo.mjs
```

## Estructura

```
index.html              Landing pública
dashboard.html          Panel de administración (16 secciones)
assets/css/
  apolai.css            Sistema de diseño compartido por ambas páginas
  landing.css           Solo landing: blobs, timeline, precios, reveal
assets/js/
  landing.js            Navbar, menú móvil, modal de login, scroll y reveal
  mock.js               Datos de ejemplo — el punto a sustituir por la API real
  core.js               Helpers, navegación SPA, modales, toasts, loader, CSV, paginador
  dashboard.js          Estadísticas, resumen de ventas y 5 gráficos de Chart.js
  connect.js            Cloud API (webhook, alta semi-automática, logs) y bloqueo por país
  chat.js               Motor de chat compartido por Chat en Vivo e Histórico
  reports.js            Reportes de contactos y métricas de anuncios
  automation.js         Archivos, flujos simples y avanzados, remarketing, disparadores
  settings.js           Pagos y acceso, configuración de IA, tutoriales, FAQ
  app.js                Arranque
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
| `[LOGIN_URL]` | URL real de autenticación |
| `[PRECIO_MENSUAL]` / `[PRECIO_ANUAL]` | Precios de cada plan |
| `[DESCUENTO_ANUAL]` | Ahorro del plan anual |
| `[MEJORA_1..3]` | Métricas de resultados |

Las tres métricas del bloque "Resultados esperables" son marcadores a propósito:
publicar cifras inventadas como si fueran datos medidos de ApolAI sería publicidad
engañosa. Sustitúyelas por resultados propios indicando periodo y muestra, o borra
el bloque.

También faltan por crear `privacidad.html` y `terminos.html`, enlazadas desde el footer.

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

Utilidades disponibles en `window.ApolAI`: `toast`, `modal`, `confirmModal`,
`promptModal`, `validate`, `downloadCsv`, `renderPager`, `money`, `navigate`,
`setConnection`, `setBotState`, `onView`.
