/* ============================================================================
   Elorai — Facturación: plan, método de pago, facturas y cancelación
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, escapeHtml, toast } = App;

  const PLAN_NAME = { monthly: 'Plan Mensual', yearly: 'Plan Anual' };

  const STATUS_BADGE = {
    active: ['Activa', 'badge-ok'],
    trialing: ['En prueba gratis', 'badge-brand'],
    past_due: ['Pago pendiente', 'badge-warn'],
    canceled: ['Cancelada', 'badge-danger'],
    unpaid: ['Impagada', 'badge-danger'],
    incomplete: ['Incompleta', 'badge-warn'],
    bypass: ['Gratis de por vida', 'badge-brand'],
    none: ['Sin plan', 'badge-muted'],
  };

  const INVOICE_BADGE = {
    APPROVED: ['Pagada', 'badge-ok'],
    PENDING: ['En proceso', 'badge-warn'],
    DECLINED: ['Rechazada', 'badge-danger'],
    ERROR: ['Fallida', 'badge-danger'],
    VOIDED: ['Anulada', 'badge-muted'],
  };

  /** Los importes de Wompi vienen en centavos (COP × 100). */
  const fmtMoney = (cents, currency) => new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: currency || 'COP', maximumFractionDigits: 0,
  }).format((Number(cents) || 0) / 100);

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric',
  }) : '—');

  /**
   * Días completos que faltan para una fecha. Se redondea hacia arriba: si
   * quedan 6 h el usuario todavía "tiene 1 día", no 0.
   */
  function daysUntil(iso) {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
  }

  let state = { subscription: null, invoices: [] };

  /* --- Cuenta regresiva del trial (se reutiliza en el menú de usuario) ----- */
  function paintTrial(sub, ids) {
    const box = qs(ids.box);
    if (!box) return;

    const days = sub && sub.status === 'trialing' ? daysUntil(sub.trial_ends_at) : null;
    if (days === null) { box.classList.add('hidden'); return; }

    box.classList.remove('hidden');
    qs(ids.days).textContent = days;
    qs(ids.unit).textContent = days === 1 ? 'día de prueba gratis' : 'días de prueba gratis';

    const total = (sub.trialDays || 7);
    qs(ids.bar).style.width = `${Math.max(0, Math.min(100, (days / total) * 100))}%`;

    if (ids.note) {
      qs(ids.note).textContent = sub.cancel_at_period_end
        ? 'Cancelaste: al terminar la prueba no se te cobrará nada.'
        : days === 0
          ? 'Tu prueba termina hoy; el primer cobro se hace enseguida.'
          : `Termina el ${fmtDate(sub.trial_ends_at)}. Después se cobra tu plan automáticamente.`;
    }
  }

  /** Pinta la cuenta regresiva dentro del menú de usuario del encabezado. */
  App.paintTrialInMenu = (sub) => paintTrial(sub, {
    box: '#user-menu-trial', days: '#user-menu-trial-days',
    unit: '#user-menu-trial-unit', bar: '#user-menu-trial-bar',
    note: '#user-menu-trial-note',
  });

  /* --- Render de la vista -------------------------------------------------- */
  function renderPlan() {
    const sub = state.subscription || { status: 'none' };
    const isBypass = sub.status === 'bypass';

    qs('#bill-bypass').classList.toggle('hidden', !isBypass);
    qs('#bill-main').classList.toggle('hidden', isBypass);
    if (isBypass) return;

    qs('#bill-plan-name').textContent = PLAN_NAME[sub.plan] || 'Sin plan';

    const [label, cls] = STATUS_BADGE[sub.status] || STATUS_BADGE.none;
    const badge = qs('#bill-plan-status');
    badge.className = `badge ${cls}`;
    badge.textContent = label;

    const price = sub.prices && sub.plan ? sub.prices[sub.plan] : null;
    qs('#bill-plan-price').textContent = price
      ? `${fmtMoney(price, sub.currency)} ${sub.plan === 'yearly' ? 'al año' : 'al mes'}`
      : 'Todavía no has elegido un plan.';

    // Qué pasa después, en cristiano
    const renewal = qs('#bill-plan-renewal');
    if (sub.cancel_at_period_end) {
      const until = sub.status === 'trialing' ? sub.trial_ends_at : sub.current_period_end;
      renewal.innerHTML = `<i class="fa-solid fa-circle-info text-amber-500"></i> Cancelada — mantienes el acceso hasta el ${escapeHtml(fmtDate(until))}.`;
    } else if (sub.status === 'trialing') {
      renewal.textContent = `Primer cobro el ${fmtDate(sub.trial_ends_at)}.`;
    } else if (sub.status === 'active') {
      renewal.textContent = `Se renueva el ${fmtDate(sub.current_period_end)}.`;
    } else if (sub.status === 'past_due') {
      renewal.textContent = 'No pudimos cobrar tu último pago. Actualiza la tarjeta para no perder el servicio.';
    } else {
      renewal.textContent = '—';
    }

    qs('#bill-resume').classList.toggle('hidden', !sub.cancel_at_period_end);
    qs('#bill-cancel').classList.toggle('hidden', !!sub.cancel_at_period_end);

    // Aviso del último cobro fallido
    const hasError = Boolean(sub.last_charge_error) && sub.status !== 'active';
    qs('#bill-card-error').classList.toggle('hidden', !hasError);
    if (hasError) qs('#bill-card-error-text').textContent = `Último intento de cobro: ${sub.last_charge_error}`;

    paintTrial(sub, {
      box: '#bill-trial', days: '#bill-trial-days', unit: '#bill-trial-unit',
      bar: '#bill-trial-bar', note: '#bill-trial-note',
    });
  }

  function renderInvoices() {
    const tbody = qs('#bill-invoices-tbody');
    tbody.innerHTML = '';
    qs('#bill-invoice-count').textContent = state.invoices.length;
    qs('#bill-invoices-empty').classList.toggle('hidden', state.invoices.length > 0);

    state.invoices.forEach((inv) => {
      const [label, cls] = INVOICE_BADGE[inv.status] || [inv.status, 'badge-muted'];
      const concept = inv.plan === 'yearly' ? 'Plan Anual' : inv.plan === 'monthly' ? 'Plan Mensual' : 'Suscripción';
      const period = inv.period_start && inv.period_end
        ? `<span class="block text-xs text-ink/45">${escapeHtml(fmtDate(inv.period_start))} – ${escapeHtml(fmtDate(inv.period_end))}</span>`
        : '';

      const ref = inv.pdf_url
        ? `<a href="${escapeHtml(inv.pdf_url)}" target="_blank" rel="noopener" class="brand-text font-semibold">Descargar PDF</a>`
        : `<span class="font-mono text-xs text-ink/50">${escapeHtml(inv.transaction_id || '—')}</span>`;

      tbody.appendChild(el('tr', {
        html: `
          <td>${escapeHtml(fmtDate(inv.created_at))}</td>
          <td>${escapeHtml(concept)}${period}</td>
          <td class="font-semibold">${escapeHtml(fmtMoney(inv.amount_cents, inv.currency))}</td>
          <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
          <td>${ref}</td>`,
      }));
    });
  }

  /* --- Carga --------------------------------------------------------------- */
  async function load() {
    try {
      const sub = await App.session.api('/billing/status');
      state.subscription = sub;
      App.paintTrialInMenu(sub);
      renderPlan();
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'err');
      return;
    }

    // Las facturas son secundarias: si fallan, el resto de la vista sigue útil.
    try {
      const { invoices } = await App.session.api('/billing/invoices');
      state.invoices = invoices || [];
      renderInvoices();
    } catch {
      state.invoices = [];
      renderInvoices();
    }
  }

  /* --- Acciones ------------------------------------------------------------ */
  async function changePlan() {
    const sub = state.subscription || {};
    const current = sub.plan || 'monthly';
    const prices = sub.prices || {};

    const pick = el('div', { class: 'space-y-2' });
    ['monthly', 'yearly'].forEach((plan) => {
      const price = prices[plan];
      const isCurrent = plan === current;
      const saving = plan === 'yearly' && prices.monthly && prices.yearly
        ? Math.round(100 - (prices.yearly / (prices.monthly * 12)) * 100)
        : 0;

      const btn = el('button', {
        type: 'button',
        class: `w-full text-left p-3 rounded-xl border-2 transition ${isCurrent ? 'border-brand-500 bg-accent-50' : 'border-accent-200 hover:border-accent-400'}`,
        html: `
          <span class="flex items-center gap-2">
            <span class="font-extrabold text-ink">${escapeHtml(PLAN_NAME[plan])}</span>
            ${isCurrent ? '<span class="badge badge-brand">Actual</span>' : ''}
            ${saving > 0 ? `<span class="badge badge-ok">Ahorras ${saving}%</span>` : ''}
          </span>
          <span class="block text-sm text-ink/60 mt-0.5">${escapeHtml(price ? fmtMoney(price, sub.currency) : '—')} ${plan === 'yearly' ? 'al año' : 'al mes'}</span>`,
      });
      btn.addEventListener('click', () => { pick.dataset.chosen = plan;
        [...pick.children].forEach((c) => c.className = c === btn
          ? 'w-full text-left p-3 rounded-xl border-2 border-brand-500 bg-accent-50 transition'
          : 'w-full text-left p-3 rounded-xl border-2 border-accent-200 hover:border-accent-400 transition');
      });
      pick.appendChild(btn);
    });
    pick.dataset.chosen = current;

    const wrap = el('div', {}, [
      pick,
      el('p', {
        class: 'text-xs text-ink/50 mt-3',
        text: 'El cambio se aplica en tu próximo cobro. No se cobra ni se devuelve nada ahora.',
      }),
    ]);

    const chosen = await App.modal({
      title: 'Cambiar de plan', icon: 'fa-arrows-rotate', body: wrap,
      confirmText: 'Guardar cambio',
      onConfirm: () => pick.dataset.chosen,
    });
    if (!chosen || chosen === current) return;

    try {
      await App.session.api('/billing/plan', { method: 'POST', body: { plan: chosen } });
      toast(`Listo: tu próximo cobro será el ${PLAN_NAME[chosen].toLowerCase()}.`, 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function cancel() {
    const sub = state.subscription || {};
    const until = sub.status === 'trialing' ? sub.trial_ends_at : sub.current_period_end;
    const ok = await App.confirmModal(
      'Cancelar suscripción',
      `Mantienes el acceso completo hasta el <strong>${escapeHtml(fmtDate(until))}</strong> y no se te vuelve a cobrar. Puedes reactivarla cuando quieras antes de esa fecha.`,
      { confirmText: 'Sí, cancelar', danger: true }
    );
    if (!ok) return;

    try {
      await App.session.api('/billing/cancel', { method: 'POST' });
      toast('Suscripción cancelada. Sigues teniendo acceso hasta el final del periodo.', 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function resume() {
    try {
      await App.session.api('/billing/resume', { method: 'POST' });
      toast('Suscripción reactivada.', 'ok');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* --- Eliminar cuenta ------------------------------------------------------
   * Irreversible y en cascada: se exige escribir el propio correo, igual que
   * valida el backend, para que ningún clic accidental borre meses de datos.
   */
  async function deleteAccount() {
    const email = (App.state.user && App.state.user.email) || '';

    const input = el('input', { class: 'input mt-2', placeholder: email, autocomplete: 'off' });
    const err = el('p', { class: 'error-msg', text: 'El correo no coincide.' });
    const body = el('div', {}, [
      el('p', {
        class: 'text-sm text-ink/75 leading-relaxed',
        html: 'Esto borra <strong>para siempre</strong> tu cuenta y todo lo que contiene: conversaciones, contactos, agenda, flujos y la conexión con WhatsApp. No se puede deshacer.',
      }),
      el('label', { class: 'label mt-3', text: `Escribe ${email} para confirmar` }),
      input, err,
    ]);

    const confirmed = await App.modal({
      title: 'Eliminar cuenta', icon: 'fa-trash-can', body,
      confirmText: 'Eliminar mi cuenta', danger: true,
      onConfirm: () => {
        const v = input.value.trim().toLowerCase();
        if (v !== email.toLowerCase()) {
          input.classList.add('is-invalid');
          err.classList.add('show');
          return false;
        }
        return true;
      },
    });
    if (!confirmed) return;

    try {
      await App.session.api('/account', { method: 'DELETE', body: { confirmEmail: email } });
      window.location.href = '/?cuenta=eliminada';
    } catch (err2) {
      toast(err2.message, 'err');
    }
  }

  /* --- Arranque ------------------------------------------------------------ */
  function init() {
    qs('#bill-change-plan').addEventListener('click', changePlan);
    qs('#bill-cancel').addEventListener('click', cancel);
    qs('#bill-resume').addEventListener('click', resume);
    qs('#bill-update-card').addEventListener('click', () => {
      window.location.href = '/onboarding.html?mode=update&next=/dashboard.html%23billing';
    });

    // Ambos salen del menú flotante: hay que cerrarlo antes o se queda
    // encima del contenido bloqueando los clics de la vista.
    qs('#delete-account-btn').addEventListener('click', () => {
      App.closeUserMenu();
      deleteAccount();
    });
    qs('#user-menu-billing').addEventListener('click', () => {
      App.closeUserMenu();
      App.navigate('billing');
    });

    App.onView('billing', load);
  }

  App.billing = { init, load, deleteAccount };

})(window.Elorai);
