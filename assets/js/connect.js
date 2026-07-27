/* ============================================================================
   Elorai — Cloud API y Bloqueo por País
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el } = App;

  /* ========================================================================
     Terminal de logs
     ===================================================================== */
  function log(message, level = 'info', at = null) {
    const box = qs('#api-log');
    const ts = new Date(at || Date.now()).toLocaleTimeString('es-MX', { hour12: false });
    const line = el('div', {}, [
      el('span', { class: 'ts', text: `[${ts}] ` }),
      el('span', { class: `lv-${level}`, text: message }),
    ]);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  async function cargarActividad() {
    const lineas = await App.session.api('/activity');
    const caja = qs('#api-log');
    caja.innerHTML = '';
    lineas.forEach((l) => log(l.message, l.level, l.at));
    if (!lineas.length) log('Sin actividad todavía', 'info');
  }

  /* ========================================================================
     Cloud API
     ===================================================================== */
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
    App.setConnection(c.connected);
    App.setBotState(c.botRunning);
  }

  function initCloudApi() {
    qs('#clear-log-btn').addEventListener('click', async () => {
      await App.session.api('/activity', { method: 'DELETE' });
      await cargarActividad();
    });

    /* --- Flujo semi-automático ------------------------------------------- */
    qs('#fetch-meta-btn').addEventListener('click', (ev) => {
      const ok = App.validate([
        { input: '#auto-token', test: (v) => v.length >= 8, message: 'El Access Token parece incompleto.' },
      ]);
      if (!ok) { App.toast('Revisa los campos marcados', 'err'); return; }

      App.withBusy(ev.currentTarget, async () => {
        try {
          const d = await App.session.api('/settings/cloud-api/discover', {
            method: 'POST', body: { token: qs('#auto-token').value.trim() },
          });
          qs('#meta-waba').textContent = d.businessId;
          qs('#meta-phone-id').textContent = d.phoneNumberId;
          qs('#meta-verified-name').textContent = d.verifiedName || '—';
          qs('#meta-display-phone').textContent = d.displayPhone || '—';
          qs('#meta-result').classList.remove('hidden');
          App.toast('Datos obtenidos de Meta', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Consultando Meta…');
    });

    qs('#apply-meta-btn').addEventListener('click', () => {
      qs('#api-waba').value = qs('#meta-waba').textContent;
      qs('#api-phone-id').value = qs('#meta-phone-id').textContent;
      qs('#api-phone').value = qs('#meta-display-phone').textContent;
      qs('#api-token').value = qs('#auto-token').value;
      [qs('#api-waba'), qs('#api-phone-id'), qs('#api-phone'), qs('#api-token')].forEach((i) => App.setError(i, false));
      App.toast('Configuración completada automáticamente', 'ok');
    });

    /* --- Guardar configuración ------------------------------------------- */
    qs('#api-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const ok = App.validate([
        { input: '#api-phone-id', test: App.notEmpty },
        { input: '#api-phone', test: App.isPhone },
        { input: '#api-waba', test: App.notEmpty },
      ]);
      if (!ok) { App.toast('Faltan datos obligatorios', 'err'); return; }

      App.withBusy(qs('#api-form button[type="submit"]'), async () => {
        try {
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
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Guardando…');
    });

    /* --- Probar conexión -------------------------------------------------- */
    qs('#test-conn-btn').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        try {
          const r = await App.session.api('/settings/cloud-api/test', { method: 'POST' });
          App.toast(`Conectado · ${r.latencyMs} ms · calidad ${r.qualityRating || 'n/d'}`, 'ok');
          setApiStatus(true);
          App.setConnection(true);
        } catch (err) {
          App.toast(err.message, 'err');
          setApiStatus(false);
          App.setConnection(false);
        }
        await cargarActividad();
      }, 'Probando…');
    });

    /* --- Iniciar / detener bot ------------------------------------------- */
    qs('#start-bot-btn').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        try {
          const r = await App.session.api('/settings/bot/start', { method: 'POST' });
          App.setBotState(r.running);
          await cargarActividad();
          App.toast('Bot en marcha', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Iniciando…');
    });

    qs('#stop-bot-btn').addEventListener('click', async () => {
      const ok = await App.confirmModal(
        'Detener el bot',
        'Mientras esté detenido, Elorai dejará de responder mensajes. Los mensajes entrantes quedarán en cola en Meta hasta 72 horas.',
        { confirmText: 'Detener bot', danger: true, icon: 'fa-stop' }
      );
      if (!ok) return;
      try {
        const r = await App.session.api('/settings/bot/stop', { method: 'POST' });
        App.setBotState(r.running);
        await cargarActividad();
        App.toast('Bot detenido', 'warn');
      } catch (err) {
        App.toast(err.message, 'err');
      }
    });
  }

  function setApiStatus(connected) {
    qs('#api-status-dot').className = `dot ${connected ? 'dot-ok' : 'dot-off'}`;
    qs('#api-status-text').textContent = connected ? 'Conectado' : 'Sin conexión';
  }

  // Nota: "Bloqueo por País" ya no tiene vista en el panel (sustituida por
  // Agenda), pero el filtrado real de mensajes sigue vivo en
  // server/src/services/engine.js contra la tabla blocked_countries — las
  // cuentas que ya bloquearon países no pierden esa protección.

  App.connect = { init() { initCloudApi(); }, log };

  App.onView('cloud-api', () => {
    cargarCloudApi().catch((e) => App.toast(e.message, 'err'));
    cargarActividad().catch(() => {});
  });

})(window.Elorai);
