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

  async function init() {
    fillPhoneCountry();

    try {
      const { profile, email, suggestedName } = await App.session.api('/onboarding');
      qs('#ob-email').value = email || '';
      if (profile) {
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
          const params = new URLSearchParams(window.location.search);
          window.location.href = params.get('next') || '/dashboard.html';
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Creando tu cuenta…');
    });
  }

  document.addEventListener('DOMContentLoaded', init);

})(window.Elorai);
