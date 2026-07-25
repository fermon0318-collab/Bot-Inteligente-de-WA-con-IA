# Bloque C · Panel con datos reales

## Qué vas a construir

Hoy el panel muestra datos inventados de `assets/js/mock.js` aunque haya
conversaciones reales en la base. La API ya responde: falta que el frontend la
use.

**Tiempo estimado:** 6–8 horas. Es repetitivo pero sin sorpresas.

**No depende de nada.** Puedes hacerlo en cualquier momento.

---

## Estrategia: módulo por módulo

Siete archivos, cada uno independiente. Haz uno, pruébalo, haz commit. Si algo
se rompe sabes exactamente dónde.

| Orden | Archivo | Endpoint | Dificultad |
|---|---|---|---|
| 1 | `connect.js` | `/settings`, `/countries`, `/activity` | Baja |
| 2 | `settings.js` | `/settings/ai`, `/payments` | Baja |
| 3 | `automation.js` | `/flows`, `/triggers`, `/media` | Media |
| 4 | `reports.js` | `/contacts` | Media |
| 5 | `dashboard.js` | `/stats` | Media |
| 6 | `chat.js` | `/conversations` | Alta |
| 7 | — | retirar `mock.js` | — |

---

## Patrón común

Todos los módulos siguen la misma forma. Apréndetela una vez:

```js
/* 1 · Cargar al entrar en la sección, no al arrancar el panel */
App.onView('cloud-api', () => cargarAjustes());

/* 2 · Pintar estado de carga, pedir, pintar resultado */
async function cargarAjustes() {
  const caja = qs('#api-log');
  try {
    const datos = await App.session.api('/settings');
    pintar(datos);
  } catch (err) {
    App.toast(`No se pudo cargar: ${err.message}`, 'err');
  }
}

/* 3 · Guardar con el botón en estado ocupado */
qs('#guardar').addEventListener('click', (ev) => {
  App.withBusy(ev.currentTarget, async () => {
    await App.session.api('/settings/cloud-api', {
      method: 'PUT',
      body: { phoneNumberId: qs('#api-phone-id').value.trim() },
    });
    App.toast('Guardado', 'ok');
  }, 'Guardando…');
});
```

`App.session.api()` ya lanza un error con `message` legible si el servidor
responde mal, así que basta con capturarlo y enseñarlo.

---

## Módulo 1 · `connect.js` (Cloud API y países)

### Cargar la configuración

Sustituye el contenido de `initCloudApi()` por:

```js
async function cargarCloudApi() {
  const datos = await App.session.api('/settings');
  const c = datos.cloudApi;

  qs('#webhook-url').value = c.webhookUrl;
  qs('#webhook-token').value = c.verifyToken;
  qs('#api-phone-id').value = c.phoneNumberId;
  qs('#api-waba').value = c.businessId;
  qs('#api-phone').value = c.displayPhone;

  // El token nunca vuelve en claro: se muestra enmascarado como marcador
  const token = qs('#api-token');
  token.value = '';
  token.placeholder = c.hasToken ? c.tokenMask : 'EAAG…';

  setApiStatus(c.connected);
  App.setBotState(c.botRunning);
}

async function cargarActividad() {
  const lineas = await App.session.api('/activity');
  const caja = qs('#api-log');
  caja.innerHTML = '';
  lineas.forEach((l) => log(l.message, l.level, l.at));
  if (!lineas.length) log('Sin actividad todavía', 'info');
}
```

Ajusta `log()` para aceptar la fecha del servidor:

```js
function log(message, level = 'info', at = null) {
  const box = qs('#api-log');
  const ts = new Date(at || Date.now()).toLocaleTimeString('es-MX', { hour12: false });
  // …resto igual
}
```

### Guardar

```js
qs('#api-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const ok = App.validate([
    { input: '#api-phone-id', test: App.notEmpty },
    { input: '#api-phone', test: App.isPhone },
    { input: '#api-waba', test: App.notEmpty },
  ]);
  if (!ok) { App.toast('Faltan datos obligatorios', 'err'); return; }

  App.withBusy(qs('#api-form button[type="submit"]'), async () => {
    const token = qs('#api-token').value.trim();
    await App.session.api('/settings/cloud-api', {
      method: 'PUT',
      body: {
        phoneNumberId: qs('#api-phone-id').value.trim(),
        businessId: qs('#api-waba').value.trim(),
        displayPhone: qs('#api-phone').value.trim(),
        // Solo se manda si escribió uno nuevo: si no, el backend conserva el actual
        ...(token ? { token } : {}),
      },
    });
    qs('#api-token').value = '';
    await cargarCloudApi();
    await cargarActividad();
    App.toast('Configuración guardada', 'ok');
  }, 'Guardando…');
});
```

### Probar conexión, iniciar y detener

```js
qs('#test-conn-btn').addEventListener('click', (ev) => {
  App.withBusy(ev.currentTarget, async () => {
    try {
      const r = await App.session.api('/settings/cloud-api/test', { method: 'POST' });
      App.toast(`Conectado · ${r.latencyMs} ms · calidad ${r.qualityRating || 'n/d'}`, 'ok');
      setApiStatus(true);
    } catch (err) {
      App.toast(err.message, 'err');
      setApiStatus(false);
    }
    await cargarActividad();
  }, 'Probando…');
});

qs('#fetch-meta-btn').addEventListener('click', (ev) => {
  const token = qs('#auto-token').value.trim();
  if (!App.validate([{ input: '#auto-token', test: (v) => v.length >= 20 }])) return;

  App.withBusy(ev.currentTarget, async () => {
    const d = await App.session.api('/settings/cloud-api/discover', {
      method: 'POST', body: { token },
    });
    qs('#meta-waba').textContent = d.businessId;
    qs('#meta-phone-id').textContent = d.phoneNumberId;
    qs('#meta-verified-name').textContent = d.verifiedName;
    qs('#meta-display-phone').textContent = d.displayPhone;
    qs('#meta-result').classList.remove('hidden');
  }, 'Consultando Meta…');
});

['start', 'stop'].forEach((accion) => {
  qs(accion === 'start' ? '#start-bot-btn' : '#stop-bot-btn')
    .addEventListener('click', async (ev) => {
      if (accion === 'stop') {
        const ok = await App.confirmModal('Detener el bot',
          'Dejará de responder. Los mensajes entrantes quedan en cola en Meta hasta 72 h.',
          { confirmText: 'Detener', danger: true });
        if (!ok) return;
      }
      App.withBusy(ev.currentTarget, async () => {
        const r = await App.session.api(`/settings/bot/${accion}`, { method: 'POST' });
        App.setBotState(r.running);
        await cargarActividad();
        App.toast(r.running ? 'Bot en marcha' : 'Bot detenido', r.running ? 'ok' : 'warn');
      }, accion === 'start' ? 'Iniciando…' : 'Deteniendo…');
    });
});

qs('#clear-log-btn').addEventListener('click', async () => {
  await App.session.api('/activity', { method: 'DELETE' });
  await cargarActividad();
});
```

### Países

```js
async function cargarPaises() {
  const bloqueados = await App.session.api('/countries');
  const codigos = new Set(bloqueados.map((b) => b.code));
  App.COUNTRIES.forEach((c) => { c.blocked = codigos.has(c.code); });
  renderCountries(qs('#country-search').value);
  updateBlockedCount();
}

qs('#countries-save').addEventListener('click', (ev) => {
  App.withBusy(ev.currentTarget, async () => {
    const blocked = App.COUNTRIES.filter((c) => c.blocked)
      .map((c) => ({ code: c.code, dial: c.dial }));
    const r = await App.session.api('/countries', { method: 'PUT', body: { blocked } });
    App.toast(`Lista guardada · ${r.blocked} países bloqueados`, 'ok');
  }, 'Guardando…');
});
```

> La lista de 48 países en `mock.js` **se queda**: es un catálogo estático, no
> datos de usuario. Solo el estado `blocked` viene del servidor.

Al final del módulo:

```js
App.connect = {
  init() { initCloudApi(); initCountries(); },
  log,
};
App.onView('cloud-api', () => {
  cargarCloudApi().catch((e) => App.toast(e.message, 'err'));
  cargarActividad().catch(() => {});
});
App.onView('countries', () => cargarPaises().catch((e) => App.toast(e.message, 'err')));
```

**Prueba:** cambia el Phone Number ID, guarda, recarga la página. Debe persistir.

---

## Módulo 2 · `settings.js` (IA y pagos)

```js
async function cargarIa() {
  const { ai } = await App.session.api('/settings');
  qs('#ai-enabled').checked = ai.enabled;
  qs('#ai-model').value = ai.model;
  qs('#ai-delay').value = ai.delaySeconds;
  qs('#ai-delay-value').textContent = ai.delaySeconds;
  qs('#ai-prompt').value = ai.prompt;
  qs('#ai-key').value = '';
  qs('#ai-key').placeholder = ai.hasKey ? ai.keyMask : 'sk-…';
  qs('#ai-prompt-chars').textContent = App.num(ai.prompt.length);
  qs('#ai-enabled-label').textContent = ai.enabled ? 'IA activada' : 'IA desactivada';
}

qs('#ai-save').addEventListener('click', (ev) => {
  const key = qs('#ai-key').value.trim();
  App.withBusy(ev.currentTarget, async () => {
    await App.session.api('/settings/ai', {
      method: 'PUT',
      body: {
        enabled: qs('#ai-enabled').checked,
        model: qs('#ai-model').value,
        delaySeconds: Number(qs('#ai-delay').value),
        prompt: qs('#ai-prompt').value,
        ...(key ? { apiKey: key } : {}),
      },
    });
    qs('#ai-key').value = '';
    await cargarIa();
    App.toast('Configuración de IA guardada', 'ok');
  }, 'Guardando…');
});

async function cargarPagos() {
  const d = await App.session.api('/payments');
  qs('#pay-msg-ok').value = d.messageOk;
  qs('#pay-msg-bad').value = d.messageInvalid;
  qs('#pay-postflow').value = d.postFlowId || '';
  App.PAY_RULES.length = 0;
  App.PAY_RULES.push(...d.rules.map((r) => ({ ...r, files: r.files || [] })));
  App.PAY_QUICK.length = 0;
  App.PAY_QUICK.push(...d.quickReplies);
  renderPayRules();
  renderQuickReplies();
}

qs('#pay-save').addEventListener('click', (ev) => {
  App.withBusy(ev.currentTarget, async () => {
    await App.session.api('/payments', {
      method: 'PUT',
      body: {
        messageOk: qs('#pay-msg-ok').value,
        messageInvalid: qs('#pay-msg-bad').value,
        postFlowId: qs('#pay-postflow').value || null,
        rules: App.PAY_RULES,
        quickReplies: App.PAY_QUICK,
      },
    });
    await cargarPagos();
    App.toast('Configuración de pagos guardada', 'ok');
  }, 'Guardando…');
});

App.onView('ai-config', () => cargarIa().catch((e) => App.toast(e.message, 'err')));
App.onView('payments', () => cargarPagos().catch((e) => App.toast(e.message, 'err')));
```

> Tutoriales y FAQ **se quedan en `mock.js`**: son contenido tuyo, no datos de
> usuario. No tiene sentido meterlos en base.

---

## Módulo 3 · `automation.js` (flujos, disparadores, archivos)

```js
async function cargarFlujos() {
  const [simples, avanzados] = await Promise.all([
    App.session.api('/flows?kind=simple'),
    App.session.api('/flows?kind=advanced'),
  ]);

  App.SIMPLE_FLOWS.length = 0;
  App.SIMPLE_FLOWS.push(...simples.map((f) => ({
    id: f.id, name: f.name, steps: f.steps || [],
  })));

  App.ADVANCED_FLOWS.length = 0;
  App.ADVANCED_FLOWS.push(...avanzados.map((f) => ({
    id: f.id, name: f.name, tree: f.tree,
    updated: String(f.updated_at).slice(0, 10),
    nodes: contarNodos(f.tree),
  })));

  refreshFlowSelects();
}

function contarNodos(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((s, c) => s + contarNodos(c), 0);
}
```

Guardar un flujo simple:

```js
qs('#sf-save').addEventListener('click', (ev) => {
  if (!sfCurrent) return;
  if (sfCurrent.steps.some((s) => !String(s.value || '').trim())) {
    App.toast('Hay pasos vacíos', 'err'); return;
  }
  App.withBusy(ev.currentTarget, async () => {
    await App.session.api(`/flows/${sfCurrent.id}`, {
      method: 'PUT', body: { name: sfCurrent.name, steps: sfCurrent.steps },
    });
    App.toast(`Flujo "${sfCurrent.name}" guardado`, 'ok');
  }, 'Guardando…');
});

qs('#sf-new').addEventListener('click', async () => {
  const name = await App.promptModal('Crear flujo simple', 'Nombre del flujo', '');
  if (!name) return;
  const flow = await App.session.api('/flows', {
    method: 'POST', body: { kind: 'simple', name, steps: [] },
  });
  await cargarFlujos();
  loadSimpleFlow(flow.id);
  App.toast(`Flujo "${name}" creado`, 'ok');
});

qs('#sf-delete').addEventListener('click', async () => {
  if (!sfCurrent) return;
  const ok = await App.confirmModal('Eliminar flujo',
    `Se eliminará <strong>${App.escapeHtml(sfCurrent.name)}</strong>.`,
    { confirmText: 'Eliminar', danger: true });
  if (!ok) return;
  await App.session.api(`/flows/${sfCurrent.id}`, { method: 'DELETE' });
  await cargarFlujos();
  loadSimpleFlow(App.SIMPLE_FLOWS[0]?.id);
});
```

Disparadores:

```js
async function cargarDisparadores() {
  const rows = await App.session.api(`/triggers?kind=${trigTab}`);
  App.TRIGGERS[trigTab] = rows.map((t) => ({
    id: t.id, keyword: t.keyword, flow: t.flowId, isDefault: t.isDefault,
  }));
  renderTriggers();
}

qs('#trig-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const keyword = qs('#trig-keyword').value.trim();
  if (!App.validate([{ input: qs('#trig-keyword'), test: App.notEmpty }])) return;
  try {
    await App.session.api('/triggers', {
      method: 'POST',
      body: { kind: trigTab, keyword, flowId: qs('#trig-flow').value },
    });
    qs('#trig-keyword').value = '';
    await cargarDisparadores();
    App.toast(`Disparador "${keyword}" agregado`, 'ok');
  } catch (err) {
    App.setError(qs('#trig-keyword'), true, err.message);
    App.toast(err.message, 'err');
  }
});
```

Marcar predeterminado y eliminar usan `POST /triggers/:id/default` y
`DELETE /triggers/:id`, luego `cargarDisparadores()`.

---

## Módulo 4 · `reports.js`

Aquí cambia el modelo: **la paginación y el filtrado pasan al servidor**.

```js
const reports = { page: 1, perPage: 10, total: 0, rows: [] };

async function cargarContactos() {
  const params = new URLSearchParams({
    page: reports.page, perPage: reports.perPage,
  });
  const telefono = qs('#rep-phone').value.trim();
  if (telefono) params.set('phone', telefono);
  if (qs('#rep-status').value) params.set('status', qs('#rep-status').value);
  if (qs('#rep-from').value) params.set('from', qs('#rep-from').value);
  if (qs('#rep-to').value) params.set('to', qs('#rep-to').value);

  const data = await App.session.api(`/contacts?${params}`);
  reports.rows = data.rows;
  reports.total = data.total;
  renderReports();
}
```

`renderReports()` deja de cortar el array: ya llega cortado.

```js
function renderReports() {
  const tbody = qs('#rep-tbody');
  tbody.innerHTML = '';
  // …pinta reports.rows tal cual…

  const pages = Math.max(1, Math.ceil(reports.total / reports.perPage));
  qs('#rep-total').textContent = App.num(reports.total);
  App.renderPager(qs('#rep-pager'), reports.page, pages, (n) => {
    reports.page = n;
    cargarContactos();
  });
}

async function markPaid(contact) {
  const ok = await App.confirmModal('Marcar como pagado',
    `<strong>${App.escapeHtml(contact.name)}</strong> · ${contact.phone}<br><br>
     <span class="text-red-600 font-semibold">Esta acción es irreversible</span>.`,
    { confirmText: 'Sí, marcar como pagado' });
  if (!ok) return;
  await App.session.api(`/contacts/${contact.id}/paid`, { method: 'POST' });
  await cargarContactos();
  App.toast(`${contact.name} marcado como pagado`, 'ok');
}
```

### Exportación CSV en el servidor

Añade en `api.js`:

```js
router.get('/contacts/export.csv', async (req, res, next) => {
  try {
    const filtro = req.query.status
      ? { sql: 'AND status = $2', params: [req.query.status] }
      : { sql: '', params: [] };

    const rows = await many(
      `SELECT name, phone, status, source, amount, currency, last_message_at
         FROM contacts WHERE account_id = $1 ${filtro.sql}
        ORDER BY last_message_at DESC`,
      [account(req), ...filtro.params]
    );

    const escapar = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [
      ['Nombre', 'Teléfono', 'Estado', 'Origen', 'Monto', 'Moneda', 'Último contacto'],
      ...rows.map((r) => [r.name, r.phone, r.status, r.source, r.amount, r.currency,
                          new Date(r.last_message_at).toISOString().slice(0, 10)]),
    ].map((f) => f.map(escapar).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="apolai-contactos-${new Date().toISOString().slice(0,10)}.csv"`);
    // El BOM hace que Excel no destroce los acentos
    res.send('﻿' + csv);
  } catch (err) { next(err); }
});
```

Y en el frontend, los botones de exportar pasan a ser enlaces:

```js
App.qsa('[data-export]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.export;
  const estado = { paid: 'paid', pending: 'pending', rejected: 'rejected' }[kind];
  window.location.href = `/api/contacts/export.csv${estado ? `?status=${estado}` : ''}`;
}));
```

---

## Módulo 5 · `dashboard.js`

```js
async function cargarEstadisticas() {
  const { totals, daily, byHour } = await App.session.api('/stats');

  qs('#stat-contacts-30').textContent = App.num(totals.contacts30);
  qs('#stat-pending').textContent = App.num(totals.pending);
  qs('#stat-sales-30').textContent = App.num(totals.sales30);
  qs('#stat-conversion').textContent = App.pct(totals.conversion);
  qs('#stat-contacts-today').textContent = App.num(totals.contactsToday);
  qs('#stat-pending-today').textContent = App.num(totals.pendingToday);
  qs('#stat-sales-today').textContent = App.num(totals.salesToday);

  qs('#sales-total').textContent = App.money(totals.revenueTotal);
  qs('#sales-30').textContent = App.money(totals.revenue30);
  qs('#sales-today').textContent = App.money(totals.revenueToday);
  qs('#sales-ticket').textContent = App.money(
    totals.sales30 ? totals.revenue30 / totals.sales30 : 0);

  // Los gráficos se realimentan en vez de recrearse: así no parpadean
  const etiquetas = daily.map((d) =>
    new Date(d.date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }));

  charts.daily.data.labels = etiquetas;
  charts.daily.data.datasets[0].data = daily.map((d) => d.contacts);
  charts.daily.data.datasets[1].data = daily.map((d) => d.sales);
  charts.daily.update();

  charts.revenue.data.labels = etiquetas;
  charts.revenue.data.datasets[0].data = daily.map((d) => d.revenue * currentRate());
  charts.revenue.update();

  const porDia = [0, 0, 0, 0, 0, 0, 0];
  daily.forEach((d) => { porDia[new Date(d.date).getDay()] += d.contacts; });
  charts.weekday.data.datasets[0].data = porDia;
  charts.weekday.update();

  const porHora = Array.from({ length: 24 }, (_, h) =>
    byHour.find((b) => b.hour === h)?.contacts || 0);
  charts.hour.data.datasets[0].data = porHora;
  charts.hour.update();
}

App.onView('dashboard', () => {
  Object.values(charts).forEach((c) => c && c.resize());
  cargarEstadisticas().catch((e) => App.toast(e.message, 'err'));
});
```

> **Recurrencia y rendimiento por distribuidor no tienen endpoint.** O los
> calculas (recurrencia = contactos con más de una compra) o quitas esas
> tarjetas. No las dejes con datos falsos: es lo que verá un cliente.

---

## Módulo 6 · `chat.js` (el más laborioso)

`createChatPanel` recibe hoy un array. Pásale una función que trae datos:

```js
function createChatPanel(cfg) {
  // …
  let data = [];

  async function cargarConversaciones() {
    const rows = await App.session.api(
      `/conversations?scope=${cfg.scope}&page=${page}&perPage=${perPage || 20}`);
    data = rows.map((c) => ({
      id: c.id, name: c.name || c.phone, phone: c.phone, status: c.status,
      ad: c.adName, aiEnabled: c.aiEnabled, lastAt: c.lastAt,
      preview: c.preview || '', unread: 0, messages: [],
    }));
    renderList();
  }

  async function select(convId) {
    current = data.find((c) => c.id === convId) || null;
    if (!current) return;

    // Los mensajes se piden al abrir, no antes: cargar todos sería absurdo
    current.messages = (await App.session.api(`/conversations/${convId}/messages`))
      .map((m) => ({ from: m.direction, text: m.body, at: m.at }));

    // …resto igual que ahora…
  }

  async function send(ev) {
    ev.preventDefault();
    if (!current) return;
    const input = id('input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    // Se pinta al momento y luego se confirma: el operador no espera a la red
    pushMessage(text, 'out');

    try {
      const r = await App.session.api(`/conversations/${current.id}/messages`, {
        method: 'POST', body: { body: text },
      });
      if (r.outsideWindow) App.toast(r.warning, 'warn', 8000);
    } catch (err) {
      App.toast(`No se pudo enviar: ${err.message}`, 'err');
    }
  }
```

Los botones del cabecero:

```js
id('ai-toggle').addEventListener('change', async (ev) => {
  if (!current) return;
  await App.session.api(`/conversations/${current.id}/ai`, {
    method: 'PUT', body: { enabled: ev.target.checked },
  });
  current.aiEnabled = ev.target.checked;
  App.toast(ev.target.checked ? 'IA activada' : 'IA desactivada', 'ok');
});

id('stop-automation').addEventListener('click', async () => {
  const ok = await App.confirmModal('Detener automatización',
    'Se cancelan flujos y remarketing programados, y la IA deja de responder.',
    { confirmText: 'Detener', danger: true });
  if (!ok) return;
  await App.session.api(`/conversations/${current.id}/stop-automation`, { method: 'POST' });
  id('ai-toggle').checked = false;
  App.toast('Automatización detenida', 'warn');
});

id('mark-paid').addEventListener('click', async () => {
  const ok = await App.confirmModal('Marcar como pagado',
    'Se ejecutará el flujo post-pago. <strong>No se puede revertir.</strong>');
  if (!ok) return;
  await App.session.api(`/contacts/${current.id}/paid`, { method: 'POST' });
  current.status = 'paid';
  renderHeader();
  App.toast('Contacto marcado como pagado', 'ok');
});
```

### Actualización periódica

Sin websockets, lo razonable es preguntar cada pocos segundos **solo mientras la
sección esté visible**:

```js
let timer = null;

App.onView('live-chat', () => {
  App.livePanel.cargarConversaciones();
  clearInterval(timer);
  timer = setInterval(() => {
    if (App.state.view !== 'live-chat') { clearInterval(timer); return; }
    App.livePanel.refrescar();
  }, 10_000);
});
```

`refrescar()` recarga la lista y, si hay chat abierto, sus mensajes nuevos.

> Websockets serían mejores, pero añaden bastante complejidad. Con diez
> segundos de retraso el chat se siente vivo y el servidor no sufre.

---

## Módulo 7 · Retirar `mock.js`

Cuando todo lo demás funcione, `mock.js` debe quedarse **solo** con catálogos
estáticos:

```js
App.CURRENCIES   // monedas y tipos de cambio
App.COUNTRIES    // catálogo de países con prefijo
App.TIMEZONES    // zonas horarias
App.AI_MODELS    // modelos disponibles
App.EMOJIS       // selector de emojis
App.TUTORIALS    // tus videos
App.FAQ          // tus preguntas
App.PROMPT_EXAMPLE
App.FLOW_TEMPLATES
```

Borra: `DAILY`, `BY_HOUR`, `BRANCHES`, `CONTACTS`, `LIVE_CHATS`,
`HISTORY_CHATS`, `ADS`, `MEDIA`, `SIMPLE_FLOWS`, `ADVANCED_FLOWS`, `TRIGGERS`,
`REMARKETING`, `PAY_RULES`, `PAY_QUICK`.

Comprueba que no queda nada colgando:

```bash
grep -rn "App\.\(CONTACTS\|LIVE_CHATS\|HISTORY_CHATS\|ADS\|DAILY\|BRANCHES\)" assets/js/
```

Y renombra el archivo a `catalogs.js` para que el nombre diga la verdad.

---

## Lista de verificación

- [ ] Cloud API guarda y persiste tras recargar
- [ ] La terminal muestra actividad real de la base
- [ ] Países bloqueados se guardan y se aplican en el motor
- [ ] Prompt y modelo de IA persisten
- [ ] Crear, editar y borrar flujos funciona
- [ ] Los disparadores duplicados dan error legible
- [ ] Reportes pagina en el servidor
- [ ] La exportación CSV descarga datos reales
- [ ] El dashboard muestra ceros en una cuenta nueva (no datos inventados)
- [ ] Chat en Vivo muestra conversaciones reales y envía mensajes
- [ ] Marcar como pagado se refleja en la base
- [ ] `mock.js` solo tiene catálogos

## Errores frecuentes

| Síntoma | Causa |
|---|---|
| 401 en cada petición | Falta `credentials: 'same-origin'` — usa `App.session.api()` y no `fetch` a pelo |
| Los gráficos parpadean | Estás recreando el Chart en vez de actualizar `data` y llamar `update()` |
| El token se borra al guardar | Estás mandando `token: ''`. Mándalo solo si el usuario escribió uno |
| La paginación salta datos | Estás cortando el array además de paginar en el servidor |
| Todo vacío y sin error | La cuenta es nueva: no hay datos. Es correcto |
