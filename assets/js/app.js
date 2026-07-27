/* ============================================================================
   Elorai — arranque de la aplicación
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs } = App;

  // ?demo=1 (el link "Ver el panel de demostración" de la landing): se navega
  // el panel completo sin sesión real, pero ninguna acción de escritura llega
  // al servidor — ver el guard en session.js `api()`.
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';
  App.state.demo = isDemo;

  // Datos mostrados mientras llega /api/me. Si el backend no responde (por
  // ejemplo abriendo el HTML en local), el panel sigue siendo explorable.
  const SESSION = isDemo
    ? { name: 'Cuenta de demostración', email: 'demo@elorai.io', plan: 'Demo', expiry: '—' }
    : { name: 'Administrador', email: 'admin@elorai.io', plan: 'Pro', expiry: '—' };

  function paintSession() {
    qs('#user-avatar').textContent = App.initials(SESSION.name);
    qs('#user-name').textContent = SESSION.name;
    qs('#user-email-short').textContent = SESSION.email;
    qs('#user-menu-name').textContent = SESSION.name;
    qs('#user-menu-email').textContent = SESSION.email;
    qs('#user-menu-expiry').textContent = SESSION.expiry;
  }

  const PLAN_LABEL = { monthly: 'Mensual', yearly: 'Anual' };

  /** Sustituye los datos de ejemplo por los de la sesión real. */
  async function loadRealSession() {
    const session = App.session;
    if (!session) return;

    let me;
    try {
      me = await session.currentUser();
    } catch {
      return; // backend no disponible: se conserva el modo de exploración
    }
    if (!me) {
      // El link "Ver el panel de demostración" trae aquí a propósito sin
      // sesión: se queda en modo exploración en vez de mandar a login.
      if (isDemo) return;
      // nginx ya impide llegar aquí sin sesión; esto cubre el acceso directo
      // al archivo o una sesión caducada mientras el panel estaba abierto.
      window.location.href = session.loginUrl('/dashboard.html');
      return;
    }

    const { user, subscription } = me;
    qs('#user-avatar').textContent = App.initials(user.name || user.email);
    qs('#user-name').textContent = user.name || user.email;
    qs('#user-email-short').textContent = user.email;
    qs('#user-menu-name').textContent = user.name || user.email;
    qs('#user-menu-email').textContent = user.email;

    const menu = qs('#user-menu');
    const [label, badgeClass] = session.SUBSCRIPTION_LABEL[subscription.status]
      || session.SUBSCRIPTION_LABEL.none;

    const planCell = menu.querySelector('.badge.badge-brand');
    if (planCell) planCell.textContent = subscription.plan ? PLAN_LABEL[subscription.plan] : '—';

    const statusCell = menu.querySelector('.badge.badge-ok');
    if (statusCell) {
      statusCell.className = `badge ${badgeClass}`;
      statusCell.textContent = label;
    }

    qs('#user-menu-expiry').textContent = subscription.current_period_end
      ? App.dateShort(subscription.current_period_end)
      : '—';

    // Acceso al portal de Stripe desde el menú de usuario
    if (subscription.status !== 'bypass' && subscription.status !== 'none') {
      const portal = App.el('button', {
        type: 'button',
        class: 'btn btn-ghost w-full !justify-start',
        html: '<i class="fa-solid fa-credit-card"></i> Gestionar suscripción',
        onclick: () => session.openBillingPortal().catch((e) => App.toast(e.message, 'err')),
      });
      qs('#logout-btn').parentElement.prepend(portal);
    }

    // Un cobro fallido no corta el servicio, pero sí se avisa
    if (subscription.status === 'past_due' || subscription.status === 'unpaid') {
      const banner = qs('#alert-banner');
      qs('#alert-banner-text').textContent =
        'Tu último cobro no se completó. Actualiza el método de pago para no perder el servicio.';
      banner.classList.remove('hidden');
    }
  }

  function boot() {
    paintSession();
    App.initShell();
    App.initCopyButtons();

    if (isDemo) qs('#demo-banner').classList.remove('hidden');

    App.dashboard.init();
    App.connect.init();
    App.chat.init();
    App.reports.init();
    App.automation.init();
    App.settings.init();

    App.setConnection(true);
    App.setBotState(true);
    App.navigate(location.hash.slice(1) || 'dashboard');

    setTimeout(App.hideLoader, 450);

    // La sesión real llega después de pintar: el panel no se queda en blanco
    // esperando a la red.
    loadRealSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.Elorai);
