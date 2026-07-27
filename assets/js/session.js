/* ============================================================================
   Elorai — sesión y cobros en el navegador
   Compartido por la landing y el panel: una sola forma de hablar con la API.
   ========================================================================== */

window.Elorai = window.Elorai || {};

(function (App) {
  'use strict';

  /**
   * Cliente HTTP de la API.
   *
   * `credentials: 'same-origin'` es lo que hace viajar la cookie de sesión.
   * Un 401 no se trata como error del programa: significa "no has entrado", y
   * cada pantalla decide qué hacer con eso.
   */
  async function api(path, { method = 'GET', body, raw = false } = {}) {
    // Panel de demostración: se navega y se lee con normalidad, pero ninguna
    // escritura llega al servidor (no hay sesión real detrás).
    if (App.state?.demo && method !== 'GET' && !path.startsWith('/auth/')) {
      const err = new Error('Esto es una demo — inicia sesión para guardar cambios de verdad.');
      err.status = 401;
      err.code = 'demo_mode';
      throw err;
    }

    // Las rutas de autenticación cuelgan de /auth, no de /api
    const url = path.startsWith('/auth/') ? path : `/api${path}`;
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (raw) return res;

    let data = null;
    try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }

    if (!res.ok) {
      // En demo, un 401 de lectura es normal (no hay sesión real detrás de
      // ninguna vista) — se marca para que no salga como error en pantalla.
      const silent = App.state?.demo && method === 'GET' && res.status === 401;
      const err = new Error(`${silent ? '__demo_silent__' : ''}${data?.message || `Error ${res.status}`}`);
      err.status = res.status;
      err.code = data?.error;
      throw err;
    }
    return data;
  }

  /** Devuelve la sesión actual, o null si no hay. No lanza en caso de 401. */
  async function currentUser() {
    try {
      return await api('/me');
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  }

  const loginUrl = (next = '/dashboard.html') =>
    `/auth/google?next=${encodeURIComponent(next)}`;

  function goToLogin(next) {
    window.location.href = loginUrl(next);
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/';
  }

  /**
   * Inicia la contratación de un plan.
   * Si no hay sesión, primero se pasa por Google y se vuelve aquí.
   */
  async function startCheckout(plan) {
    try {
      const { url } = await api('/billing/checkout', { method: 'POST', body: { plan } });
      window.location.href = url;
    } catch (err) {
      if (err.status === 401) {
        goToLogin(`/?plan=${plan}#precios`);
        return;
      }
      throw err;
    }
  }

  /** Abre el portal de Stripe para cambiar o cancelar el plan. */
  async function openBillingPortal() {
    const { url } = await api('/billing/portal', { method: 'POST' });
    window.location.href = url;
  }

  const SUBSCRIPTION_LABEL = {
    active: ['Activa', 'badge-ok'],
    trialing: ['Prueba', 'badge-brand'],
    past_due: ['Pago pendiente', 'badge-warn'],
    canceled: ['Cancelada', 'badge-danger'],
    unpaid: ['Impagada', 'badge-danger'],
    incomplete: ['Incompleta', 'badge-warn'],
    bypass: ['Interna', 'badge-brand'],
    none: ['Sin plan', 'badge-muted'],
  };

  App.session = {
    api, currentUser, loginUrl, goToLogin, logout,
    startCheckout, openBillingPortal, SUBSCRIPTION_LABEL,
  };

})(window.Elorai);
