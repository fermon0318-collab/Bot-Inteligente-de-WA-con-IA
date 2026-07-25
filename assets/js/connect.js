/* ============================================================================
   ApolAI — Cloud API y Bloqueo por País
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el } = App;

  /* ========================================================================
     Terminal de logs
     ===================================================================== */
  function log(message, level = 'info') {
    const box = qs('#api-log');
    const ts = new Date().toLocaleTimeString('es-MX', { hour12: false });
    const line = el('div', {}, [
      el('span', { class: 'ts', text: `[${ts}] ` }),
      el('span', { class: `lv-${level}`, text: message }),
    ]);
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function seedLog() {
    [
      ['Servicio ApolAI iniciado · v1.0.0', 'ok'],
      ['Webhook verificado por Meta (hub.challenge OK)', 'ok'],
      ['Suscripción a campos: messages, message_status', 'info'],
      ['Mensaje entrante de +52 55 4821 9930', 'info'],
      ['Disparador "precio" → flujo "Lista de precios"', 'info'],
      ['Comprobante recibido · monto detectado 89.00 USD', 'ok'],
      ['Calidad del número: MEDIA — revisa el volumen de envíos', 'warn'],
      ['Reintento de entrega para wamid.HBgNNTI1…gA=', 'info'],
    ].forEach(([m, l]) => log(m, l));
  }

  /* ========================================================================
     Cloud API
     ===================================================================== */
  function initCloudApi() {
    seedLog();

    qs('#clear-log-btn').addEventListener('click', () => {
      qs('#api-log').innerHTML = '';
      log('Registro limpiado por el usuario', 'info');
    });

    /* --- Flujo semi-automático ------------------------------------------- */
    qs('#fetch-meta-btn').addEventListener('click', (ev) => {
      const ok = App.validate([
        { input: '#auto-token', test: (v) => v.length >= 8, message: 'El Access Token parece incompleto.' },
        { input: '#auto-phone', test: App.isPhone },
      ]);
      if (!ok) { App.toast('Revisa los campos marcados', 'err'); return; }

      App.withBusy(ev.currentTarget, async () => {
        log('Consultando Graph API de Meta…', 'info');
        await App.fakeRequest(1100);
        const phone = qs('#auto-phone').value.trim();
        qs('#meta-waba').textContent = '209' + Math.floor(1e11 + Math.random() * 8e11);
        qs('#meta-phone-id').textContent = '109' + Math.floor(1e11 + Math.random() * 8e11);
        qs('#meta-verified-name').textContent = 'ApolAI Store';
        qs('#meta-display-phone').textContent = phone;
        qs('#meta-result').classList.remove('hidden');
        log('Datos de Meta recuperados correctamente', 'ok');
        App.toast('Datos obtenidos de Meta', 'ok');
      }, 'Consultando Meta…');
    });

    qs('#apply-meta-btn').addEventListener('click', () => {
      qs('#api-waba').value = qs('#meta-waba').textContent;
      qs('#api-phone-id').value = qs('#meta-phone-id').textContent;
      qs('#api-phone').value = qs('#meta-display-phone').textContent;
      qs('#api-token').value = qs('#auto-token').value;
      [qs('#api-waba'), qs('#api-phone-id'), qs('#api-phone'), qs('#api-token')].forEach((i) => App.setError(i, false));
      App.toast('Configuración completada automáticamente', 'ok');
      log('Configuración aplicada desde los datos de Meta', 'ok');
    });

    /* --- Guardar configuración ------------------------------------------- */
    qs('#api-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const ok = App.validate([
        { input: '#api-phone-id', test: App.notEmpty },
        { input: '#api-phone', test: App.isPhone },
        { input: '#api-waba', test: App.notEmpty },
        { input: '#api-token', test: App.notEmpty },
      ]);
      if (!ok) { App.toast('Faltan datos obligatorios', 'err'); return; }

      App.withBusy(qs('#api-form button[type="submit"]'), async () => {
        await App.fakeRequest(800);
        log('Credenciales guardadas y cifradas', 'ok');
        App.toast('Configuración guardada', 'ok');
      }, 'Guardando…');
    });

    /* --- Probar conexión -------------------------------------------------- */
    qs('#test-conn-btn').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        log('Enviando ping a graph.facebook.com/v20.0…', 'info');
        await App.fakeRequest(950);
        const healthy = !!qs('#api-token').value.trim();
        if (healthy) {
          log('Conexión correcta · latencia 214 ms', 'ok');
          setApiStatus(true);
          App.setConnection(true);
          App.toast('Conexión establecida con Cloud API', 'ok');
        } else {
          log('Fallo de autenticación: falta el Access Token', 'err');
          setApiStatus(false);
          App.setConnection(false);
          App.toast('No se pudo conectar: revisa el token', 'err');
        }
      }, 'Probando…');
    });

    /* --- Iniciar / detener bot ------------------------------------------- */
    qs('#start-bot-btn').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(700);
        App.setBotState(true);
        setApiStatus(true);
        log('Bot iniciado · escuchando mensajes entrantes', 'ok');
        App.toast('Bot en marcha', 'ok');
      }, 'Iniciando…');
    });

    qs('#stop-bot-btn').addEventListener('click', async () => {
      const ok = await App.confirmModal(
        'Detener el bot',
        'Mientras esté detenido, ApolAI dejará de responder mensajes. Los mensajes entrantes quedarán en cola en Meta hasta 72 horas.',
        { confirmText: 'Detener bot', danger: true, icon: 'fa-stop' }
      );
      if (!ok) return;
      App.setBotState(false);
      log('Bot detenido por el usuario', 'warn');
      App.toast('Bot detenido', 'warn');
    });
  }

  function setApiStatus(connected) {
    qs('#api-status-dot').className = `dot ${connected ? 'dot-ok' : 'dot-off'}`;
    qs('#api-status-text').textContent = connected ? 'Conectado' : 'Sin conexión';
  }

  /* ========================================================================
     Bloqueo por país
     ===================================================================== */
  function renderCountries(filter = '') {
    const list = qs('#country-list');
    const term = filter.trim().toLowerCase();
    list.innerHTML = '';

    const visible = App.COUNTRIES.filter((c) =>
      !term || c.name.toLowerCase().includes(term) || c.dial.includes(term) || c.code.toLowerCase() === term);

    if (!visible.length) {
      list.appendChild(el('div', { class: 'empty-state sm:col-span-2 xl:col-span-3', html: '<i class="fa-solid fa-magnifying-glass"></i>Ningún país coincide con la búsqueda.' }));
      return;
    }

    visible.forEach((c) => {
      const input = el('input', { type: 'checkbox', id: `country-${c.code}` });
      input.checked = c.blocked;
      const label = el('label', { class: `check-item ${c.blocked ? 'is-blocked' : ''}`, for: `country-${c.code}` }, [
        input,
        el('span', { class: 'text-sm font-semibold text-ink flex-1 truncate', text: c.name }),
        el('span', { class: 'text-xs font-mono text-ink/45', text: c.dial }),
      ]);
      input.addEventListener('change', () => {
        c.blocked = input.checked;
        label.classList.toggle('is-blocked', c.blocked);
        updateBlockedCount();
      });
      list.appendChild(label);
    });
  }

  function updateBlockedCount() {
    qs('#blocked-count').textContent = App.COUNTRIES.filter((c) => c.blocked).length;
  }

  function initCountries() {
    renderCountries();
    updateBlockedCount();

    let t;
    qs('#country-search').addEventListener('input', (ev) => {
      clearTimeout(t);
      t = setTimeout(() => renderCountries(ev.target.value), 160);
    });

    qs('#countries-clear').addEventListener('click', async () => {
      const blocked = App.COUNTRIES.filter((c) => c.blocked).length;
      if (!blocked) { App.toast('No hay países bloqueados', 'info'); return; }
      const ok = await App.confirmModal('Desbloquear todos',
        `Se desbloquearán <strong>${blocked}</strong> países. El bot volverá a responder mensajes desde esos prefijos.`,
        { confirmText: 'Desbloquear', danger: true });
      if (!ok) return;
      App.COUNTRIES.forEach((c) => { c.blocked = false; });
      renderCountries(qs('#country-search').value);
      updateBlockedCount();
      App.toast('Todos los países desbloqueados', 'ok');
    });

    qs('#countries-save').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(650);
        const n = App.COUNTRIES.filter((c) => c.blocked).length;
        App.toast(`Lista guardada · ${n} ${n === 1 ? 'país bloqueado' : 'países bloqueados'}`, 'ok');
      }, 'Guardando…');
    });
  }

  App.connect = { init() { initCloudApi(); initCountries(); }, log };

})(window.ApolAI);
