/* ============================================================================
   Elorai — Onboarding: datos de negocio tras el primer login con Google
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, validate, setError, toast } = App;

  // Igual que en el servidor (server/src/routes/api.js) — validación en el
  // cliente es solo para dar feedback inmediato; la real ocurre en el backend.
  const PHONE_LENGTHS = {
    CO: [10, 10], MX: [10, 10], AR: [10, 11], CL: [9, 9], PE: [9, 9], BR: [10, 11],
    US: [10, 10], CA: [10, 10], ES: [9, 9], EC: [9, 9], VE: [10, 10], UY: [8, 9],
    PY: [9, 9], BO: [8, 8], GT: [8, 8], DO: [10, 10], PA: [7, 8], CR: [8, 8],
  };

  const flagEmoji = (code) => code.toUpperCase().replace(/./g, (c) =>
    String.fromCodePoint(127397 + c.charCodeAt(0)));

  function fillPhoneCountry() {
    const select = qs('#ob-phone-country');
    select.innerHTML = '';
    App.COUNTRIES.forEach((c) => {
      select.appendChild(el('option', { value: c.code, text: `${flagEmoji(c.code)} ${c.dial}` }));
    });
    select.value = 'CO';
  }

  function phoneLimits() {
    const code = qs('#ob-phone-country').value;
    return PHONE_LENGTHS[code] || [7, 15];
  }

  function validateForm() {
    const [min, max] = phoneLimits();
    return validate([
      { input: '#ob-business-type', test: (v) => !!v, message: 'Elige el tipo de negocio.' },
      { input: '#ob-team-size', test: (v) => !!v, message: 'Indica cuántas personas atienden en tu negocio.' },
      { input: '#ob-name', test: (v) => v.length >= 3, message: 'Escribe tu nombre y apellido.' },
      {
        input: '#ob-phone',
        test: (v) => { const digits = v.replace(/\D/g, ''); return digits.length >= min && digits.length <= max; },
        message: min === max ? `El teléfono debe tener ${min} dígitos.` : `El teléfono debe tener entre ${min} y ${max} dígitos.`,
      },
    ]);
  }

  function validateCardForm() {
    return validate([
      { input: '#card-number', test: (v) => v.replace(/\D/g, '').length >= 13, message: 'Escribe un número de tarjeta válido.' },
      { input: '#card-exp', test: (v) => /^\d{2}\/\d{2}$/.test(v.trim()), message: 'Usa el formato MM/AA.' },
      { input: '#card-cvc', test: (v) => /^\d{3,4}$/.test(v.trim()), message: 'Escribe el código de seguridad.' },
      { input: '#card-holder', test: (v) => v.trim().length >= 3, message: 'Escribe el nombre del titular.' },
      { input: '#card-accept', test: () => qs('#card-accept').checked, message: 'Debes aceptar los términos de Wompi.' },
    ]);
  }

  const fmtCOP = (cop) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cop);

  /** Cambia una tarjeta tokenizada directamente contra la API de Wompi — el
   *  número nunca pasa por nuestro servidor (alcance PCI reducido a SAQ A). */
  async function tokenizeCard(widget, { number, expMonth, expYear, cvc, cardHolder }) {
    const res = await fetch(`${widget.apiBase}/tokens/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${widget.publicKey}` },
      body: JSON.stringify({
        number: number.replace(/\D/g, ''),
        cvc,
        exp_month: expMonth,
        exp_year: expYear,
        card_holder: cardHolder,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.error?.messages ? Object.values(json.error.messages).flat().join(' ') : null;
      throw new Error(detail || 'No pudimos validar la tarjeta. Revisa los datos.');
    }
    return json.data.id;
  }

  let widgetConfig = null;
  let chosenPlan = 'monthly';
  let updateMode = false;

  function showCardStep() {
    qs('#onboarding-form').classList.add('hidden');
    qs('#card-form').classList.remove('hidden');
    if (widgetConfig?.acceptanceLink) qs('#card-accept-link').href = widgetConfig.acceptanceLink;
    if (updateMode) {
      qs('#card-form h2').textContent = 'Actualiza tu tarjeta';
      qs('#card-price-line').parentElement.textContent = 'Al guardarla, reintentamos el cobro pendiente de inmediato.';
      qs('#card-submit').innerHTML = 'Actualizar y reintentar cobro <i class="fa-solid fa-lock"></i>';
      return;
    }
    const price = chosenPlan === 'yearly' ? widgetConfig.prices.yearly : widgetConfig.prices.monthly;
    if (price) {
      qs('#card-price-line').textContent =
        `el primer cobro será de ${fmtCOP(price / 100)} al terminar el trial de ${widgetConfig.trialDays} días`;
    }
  }

  async function init() {
    fillPhoneCountry();

    const params = new URLSearchParams(window.location.search);
    if (params.get('plan') === 'yearly') chosenPlan = 'yearly';
    updateMode = params.get('mode') === 'update';
    // ?step=card — viene de contratar un plan o del muro de pago: si el
    // perfil del negocio ya está completo, no tiene sentido volver a pedirlo.
    const wantsCard = params.get('step') === 'card';

    try {
      widgetConfig = await App.session.api('/billing/wompi/widget-config');
    } catch {
      widgetConfig = null; // proveedor distinto a Wompi (o aún no configurado): se salta el paso de tarjeta
    }

    if (updateMode) {
      // Cuenta con cobro fallido: se salta el formulario de perfil y se va
      // directo a la tarjeta — el negocio ya está registrado.
      if (!widgetConfig) { window.location.href = '/dashboard.html'; return; }
      showCardStep();
      qs('#card-form').addEventListener('submit', onCardSubmit);
      return;
    }

    let tienePerfil = false;
    try {
      const { profile, email, suggestedName } = await App.session.api('/onboarding');
      qs('#ob-email').value = email || '';
      if (profile) {
        tienePerfil = true;
        qs('#ob-business-type').value = profile.businessType;
        qs('#ob-team-size').value = profile.teamSize;
        qs('#ob-name').value = profile.fullName;
        qs('#ob-phone-country').value = profile.phoneCountry;
        qs('#ob-phone').value = profile.phoneNumber;
        qs('#welcome-line').textContent = 'Ya completaste este formulario antes — puedes actualizarlo si algo cambió.';
      } else if (suggestedName) {
        qs('#ob-name').value = suggestedName;
      }
    } catch (err) {
      if (err.status === 401) { window.location.href = '/'; return; }
      toast(err.message, 'err');
    }

    // Perfil ya completo + venía a poner tarjeta: directo al paso de pago.
    // Si aún no tiene perfil, se queda en el formulario y el flujo normal
    // lo llevará a la tarjeta al enviarlo.
    if (wantsCard && widgetConfig && tienePerfil) showCardStep();

    // Solo dígitos: evita que el navegador acepte letras en un campo que solo admite números.
    qs('#ob-phone').addEventListener('input', (ev) => {
      const digitsOnly = ev.target.value.replace(/\D/g, '');
      if (digitsOnly !== ev.target.value) ev.target.value = digitsOnly;
    });

    qs('#ob-phone-country').addEventListener('change', () => {
      const [, max] = phoneLimits();
      qs('#ob-phone').maxLength = max;
      // Revalida de inmediato: un número válido para el país anterior puede no serlo para el nuevo.
      if (qs('#ob-phone').value) validateForm();
    });

    qs('#onboarding-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!validateForm()) {
        qs('#onboarding-form .is-invalid')?.focus();
        return;
      }

      const submitBtn = qs('#ob-submit');
      await App.withBusy(submitBtn, async () => {
        try {
          await App.session.api('/onboarding', {
            method: 'POST',
            body: {
              businessType: qs('#ob-business-type').value,
              teamSize: qs('#ob-team-size').value,
              fullName: qs('#ob-name').value.trim(),
              phoneCountry: qs('#ob-phone-country').value,
              phoneNumber: qs('#ob-phone').value.replace(/\D/g, ''),
            },
          });
          if (widgetConfig) {
            showCardStep();
          } else {
            const params = new URLSearchParams(window.location.search);
            window.location.href = params.get('next') || '/dashboard.html';
          }
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Creando tu cuenta…');
    });

    qs('#card-form').addEventListener('submit', onCardSubmit);
  }

  async function onCardSubmit(ev) {
    ev.preventDefault();
    if (!validateCardForm()) {
      qs('#card-form .is-invalid')?.focus();
      return;
    }

    const submitBtn = qs('#card-submit');
    await App.withBusy(submitBtn, async () => {
      try {
        const [expMonth, expYear] = qs('#card-exp').value.trim().split('/');
        const cardToken = await tokenizeCard(widgetConfig, {
          number: qs('#card-number').value,
          expMonth,
          expYear,
          cvc: qs('#card-cvc').value.trim(),
          cardHolder: qs('#card-holder').value.trim(),
        });

        const body = {
          cardToken,
          acceptanceToken: widgetConfig.acceptanceToken,
          personalDataAuthToken: widgetConfig.personalDataAuthToken,
        };
        if (!updateMode) body.plan = chosenPlan;

        await App.session.api(`/billing/wompi/${updateMode ? 'update-card' : 'attach-card'}`, {
          method: 'POST',
          body,
        });

        const params = new URLSearchParams(window.location.search);
        window.location.href = params.get('next') || (updateMode ? '/dashboard.html?pago=ok' : '/dashboard.html?trial=ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    }, updateMode ? 'Actualizando tu tarjeta…' : 'Activando tu prueba gratis…');
  }

  document.addEventListener('DOMContentLoaded', init);

})(window.Elorai);
