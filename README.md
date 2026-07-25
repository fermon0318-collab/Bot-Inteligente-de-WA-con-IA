# ApolAI · Panel de Control

Dashboard de administración para un bot de WhatsApp con IA. SPA de una sola página,
sin build step: se abre `index.html` y funciona.

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

**Logo**: robot recreado en SVG — contorno `#6D28D9`, panel facial `#8B5CF6`,
relleno de cabeza `#EEF2FF`. Los PNG (favicons y apple-touch-icon) se regeneran con:

```bash
python3 tools/render_logo.py      # requiere Pillow
```

## Estructura

```
index.html              Markup de las 16 secciones
assets/css/apolai.css   Tokens y componentes (glass, botones, switches, modales…)
assets/js/
  mock.js               Datos de ejemplo — el punto a sustituir por la API real
  core.js               Helpers, navegación SPA, modales, toasts, loader, CSV, paginador
  dashboard.js          Estadísticas, resumen de ventas y 5 gráficos de Chart.js
  connect.js            Cloud API (webhook, alta semi-automática, logs) y bloqueo por país
  chat.js               Motor de chat compartido por Chat en Vivo e Histórico
  reports.js            Reportes de contactos y métricas de anuncios
  automation.js         Archivos, flujos simples y avanzados, remarketing, disparadores
  settings.js           Pagos y acceso, configuración de IA, tutoriales, FAQ
  app.js                Arranque
tools/render_logo.py    Rasterizador del logo a PNG
```

## Secciones

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
