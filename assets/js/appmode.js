/* ============================================================================
   Elorai — Modo App: vinculación por QR, ritmo de envío y avisos de políticas
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el } = App;

  /** Sondeo del QR mientras el usuario escanea. Se apaga al salir de la vista. */
  let poll = null;

  const SEVERITY = {
    critical: ['badge-danger', 'fa-circle-exclamation', 'text-red-500'],
    warn: ['badge-warn', 'fa-triangle-exclamation', 'text-amber-500'],
    info: ['badge-muted', 'fa-circle-info', 'text-ink/50'],
  };

  const STATUS_LABEL = {
    disconnected: ['Sin vincular', 'dot-off'],
    qr_pending: ['Esperando escaneo', 'dot-warn'],
    connecting: ['Conectando…', 'dot-warn'],
    connected: ['Vinculado', 'dot-ok'],
    logged_out: ['Sesión caducada', 'dot-off'],
    banned: ['Cuenta restringida', 'dot-off'],
  };

  /* ========================================================================
     Pintado
     ===================================================================== */

  function pintarEstado(data) {
    const sesion = data.session || {};
    const [texto, dotClass] = STATUS_LABEL[sesion.status] || STATUS_LABEL.disconnected;

    qs('#app-status-text').textContent = texto;
    qs('#app-status-dot').className = `dot ${dotClass}`;
    qs('#app-detail-status').textContent = texto;
    qs('#app-detail-phone').textContent = sesion.displayPhone || '—';
    qs('#app-detail-name').textContent = sesion.pushName || '—';
    qs('#app-detail-since').textContent = sesion.connectedAt ? App.dateShort(sesion.connectedAt) : '—';

    const error = qs('#app-detail-error');
    error.textContent = sesion.lastError || '';
    error.classList.toggle('hidden', !sesion.lastError);

    pintarQr(sesion);
  }

  function pintarQr(sesion) {
    const img = qs('#app-qr-img');
    const placeholder = qs('#app-qr-placeholder');
    const hint = qs('#app-qr-hint');

    if (sesion.qr) {
      img.src = sesion.qr;
      img.classList.remove('hidden');
      placeholder.classList.add('hidden');
      hint.classList.remove('hidden');
      return;
    }

    img.classList.add('hidden');
    img.removeAttribute('src');
    hint.classList.add('hidden');
    placeholder.classList.remove('hidden');

    // El texto del hueco depende de por qué no hay QR: no es lo mismo "aún no
    // has pulsado el botón" que "tu sesión caducó".
    const mensaje = sesion.status === 'connected'
      ? 'Tu teléfono ya está vinculado'
      : sesion.status === 'logged_out'
        ? 'La sesión caducó — genera un código nuevo'
        : sesion.status === 'banned'
          ? 'WhatsApp restringió esta cuenta'
          : 'Pulsa «Generar código QR»';

    placeholder.innerHTML = '';
    placeholder.appendChild(el('i', {
      class: `fa-solid ${sesion.status === 'connected' ? 'fa-circle-check text-emerald-400' : 'fa-qrcode'} text-5xl mb-3`,
    }));
    placeholder.appendChild(el('p', { class: 'text-sm font-semibold', text: mensaje }));
  }

  function pintarCanal(channel) {
    document.querySelectorAll('.channel-option').forEach((boton) => {
      const activo = boton.dataset.channel === channel;
      boton.classList.toggle('border-accent-500', activo);
      boton.classList.toggle('bg-accent-50/60', activo);
      boton.classList.toggle('border-ink/10', !activo);
      boton.setAttribute('aria-pressed', activo ? 'true' : 'false');
    });
  }

  function pintarLimites(limits, usage) {
    if (limits) {
      qs('#app-min-gap').value = limits.minGapSeconds;
      qs('#app-max-gap').value = limits.maxGapSeconds;
      qs('#app-per-minute').value = limits.perMinuteLimit;
      qs('#app-daily').value = limits.dailyLimit;
    }
    qs('#app-usage-minute').textContent = App.num(usage?.lastMinute || 0);
    qs('#app-usage-hour').textContent = App.num(usage?.lastHour || 0);
    qs('#app-usage-today').textContent = App.num(usage?.today || 0);
  }

  function pintarPoliticas(data) {
    const eventos = data.policy?.events || [];
    const pausado = data.session?.paused;
    const tarjeta = qs('#app-policy-card');

    tarjeta.classList.toggle('hidden', !eventos.length && !pausado);
    if (!eventos.length && !pausado) return;

    const riesgo = data.policy?.risk || 0;
    const badge = qs('#app-risk-badge');
    badge.textContent = riesgo >= 70 ? 'Riesgo alto' : riesgo >= 40 ? 'Riesgo medio' : 'Riesgo bajo';
    badge.className = `badge ${riesgo >= 70 ? 'badge-danger' : riesgo >= 40 ? 'badge-warn' : 'badge-muted'}`;

    const lista = qs('#app-policy-list');
    lista.innerHTML = '';

    eventos.forEach((evento) => {
      const [, icono, colorIcono] = SEVERITY[evento.severity] || SEVERITY.info;
      lista.appendChild(el('div', { class: 'rounded-xl border border-ink/10 bg-white p-3.5 flex gap-3' }, [
        el('i', { class: `fa-solid ${icono} ${colorIcono} mt-0.5` }),
        el('div', { class: 'flex-1 min-w-0' }, [
          el('p', { class: 'text-sm text-ink', text: evento.message }),
          el('p', { class: 'text-xs text-ink/40 mt-1', text: App.timeAgo(evento.at) }),
        ]),
        el('button', {
          type: 'button',
          class: 'btn btn-ghost btn-sm shrink-0',
          html: '<i class="fa-solid fa-check"></i>',
          'aria-label': 'Marcar como leído',
          onclick: () => reconocer(evento.id),
        }),
      ]));
    });

    qs('#app-paused-box').classList.toggle('hidden', !pausado);
    qs('#app-paused-reason').textContent = data.session?.pausedReason || '';
  }

  /* ========================================================================
     Datos
     ===================================================================== */

  async function cargar() {
    const data = await App.session.api('/settings/app-mode');

    const disponible = data.available;
    qs('#app-unavailable').classList.toggle('hidden', disponible);
    if (!disponible) qs('#app-unavailable-reason').textContent = data.unavailableReason || '';

    ['#app-connect-btn', '#app-relink-btn', '#app-disconnect-btn'].forEach((sel) => {
      qs(sel).disabled = !disponible;
    });

    pintarCanal(data.channel);
    pintarEstado(data);
    pintarLimites(data.limits, data.usage);
    pintarPoliticas(data);

    // Mientras hay un QR en pantalla (o la sesión se está abriendo) el estado
    // cambia solo, sin que el usuario toque nada: hay que ir a mirarlo.
    const enCurso = ['qr_pending', 'connecting'].includes(data.session?.status);
    if (enCurso) arrancarSondeo();
    else detenerSondeo();

    return data;
  }

  function arrancarSondeo() {
    if (poll) return;
    poll = setInterval(async () => {
      try {
        const estado = await App.session.api('/settings/app-mode/qr');
        pintarEstado({ session: estado });

        if (estado.status === 'connected') {
          detenerSondeo();
          App.toast(`WhatsApp vinculado · ${estado.displayPhone || 'listo'}`, 'ok');
          await cargar();
        } else if (['disconnected', 'logged_out', 'banned'].includes(estado.status)) {
          detenerSondeo();
        }
      } catch {
        detenerSondeo();
      }
    }, 3000);
  }

  function detenerSondeo() {
    if (!poll) return;
    clearInterval(poll);
    poll = null;
  }

  async function reconocer(eventId) {
    try {
      await App.session.api(`/settings/app-mode/policy/${eventId}/ack`, { method: 'POST' });
      await cargar();
    } catch (err) {
      App.toast(err.message, 'err');
    }
  }

  /* ========================================================================
     Acciones
     ===================================================================== */

  function init() {
    qs('#app-connect-btn').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/settings/app-mode/connect', { method: 'POST' });
          await cargar();
          App.toast('Generando código QR…', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Abriendo sesión…');
    });

    qs('#app-relink-btn').addEventListener('click', async (ev) => {
      const ok = await App.confirmModal(
        'Vincular otro teléfono',
        'Se descartará la vinculación actual y tendrás que escanear un código QR nuevo. '
        + 'Tu historial y tus contactos de WhatsApp no se tocan.',
        { confirmText: 'Generar código nuevo', icon: 'fa-rotate' }
      );
      if (!ok) return;
      // Deshabilita el botón mientras la petición está en curso: sin esto, un
      // doble clic dispara dos POST /connect casi simultáneos, que es
      // exactamente lo que puede acabar abriendo dos sockets de WhatsApp para
      // el mismo número.
      await App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/settings/app-mode/connect', { method: 'POST', body: { forceQr: true } });
          await cargar();
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Generando…');
    });

    qs('#app-disconnect-btn').addEventListener('click', async (ev) => {
      const ok = await App.confirmModal(
        'Desvincular WhatsApp',
        'Elorai dejará de responder por ti y el bot quedará detenido. En tu teléfono no se borra '
        + 'nada: solo desaparece Elorai de «Dispositivos vinculados».',
        { confirmText: 'Desvincular', danger: true, icon: 'fa-link-slash' }
      );
      if (!ok) return;
      await App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/settings/app-mode/disconnect', { method: 'POST' });
          App.setBotState(false);
          await cargar();
          App.toast('Teléfono desvinculado', 'warn');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Desvinculando…');
    });

    /* --- Cambio de canal -------------------------------------------------- */
    document.querySelectorAll('.channel-option').forEach((boton) => {
      boton.addEventListener('click', async () => {
        const channel = boton.dataset.channel;
        const ok = await App.confirmModal(
          channel === 'app' ? 'Cambiar a Modo App' : 'Cambiar a Cloud API',
          'Elorai atiende por un canal a la vez. Al cambiar, el bot se detiene hasta que lo '
          + 'inicies de nuevo desde la pantalla del canal elegido.',
          { confirmText: 'Cambiar canal', icon: 'fa-shuffle' }
        );
        if (!ok) return;
        await App.withBusy(boton, async () => {
          try {
            await App.session.api('/settings/channel', { method: 'PUT', body: { channel } });
            App.setBotState(false);
            await cargar();
            App.toast(channel === 'app' ? 'Canal: Modo App' : 'Canal: Cloud API', 'ok');
          } catch (err) {
            App.toast(err.message, 'err');
          }
        }, 'Cambiando…');
      });
    });

    /* --- Ritmo de envío --------------------------------------------------- */
    qs('#app-limits-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      App.withBusy(qs('#app-limits-form button[type="submit"]'), async () => {
        try {
          const { limits } = await App.session.api('/settings/app-mode/limits', {
            method: 'PUT',
            body: {
              minGapSeconds: Number(qs('#app-min-gap').value),
              maxGapSeconds: Number(qs('#app-max-gap').value),
              perMinuteLimit: Number(qs('#app-per-minute').value),
              dailyLimit: Number(qs('#app-daily').value),
            },
          });
          // El servidor recorta lo que se salga del rango seguro; se repinta
          // con lo que quedó guardado de verdad, no con lo que se escribió.
          pintarLimites(limits, null);
          App.toast('Ritmo de envío guardado', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Guardando…');
    });

    qs('#app-resume-btn').addEventListener('click', async (ev) => {
      const ok = await App.confirmModal(
        'Reanudar envíos',
        'Pausamos los envíos porque detectamos un patrón que puede hacer que WhatsApp restrinja tu '
        + 'número. Antes de reanudar, corrige lo que provocó el aviso.',
        { confirmText: 'Reanudar de todos modos', danger: true, icon: 'fa-play' }
      );
      if (!ok) return;
      await App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/settings/app-mode/resume', { method: 'POST' });
          await cargar();
          App.toast('Envíos reanudados', 'warn');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Reanudando…');
    });
  }

  App.appMode = { init, reload: cargar };

  App.onView('app-mode', () => {
    cargar().catch((e) => App.toast(e.message, 'err'));
  });

  // Al salir de la vista no tiene sentido seguir preguntando por el QR.
  App.onAnyView((view) => {
    if (view !== 'app-mode') detenerSondeo();
  });

})(window.Elorai);
