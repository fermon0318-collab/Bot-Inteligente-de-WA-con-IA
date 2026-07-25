/* ============================================================================
   ApolAI — arranque de la aplicación
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs } = App;

  // Sustituir por los datos de la sesión real cuando exista backend
  const SESSION = {
    name: 'Administrador',
    email: 'admin@apolai.io',
    plan: 'Pro',
    expiry: '12/09/2026',
  };

  function paintSession() {
    qs('#user-avatar').textContent = App.initials(SESSION.name);
    qs('#user-name').textContent = SESSION.name;
    qs('#user-email-short').textContent = SESSION.email;
    qs('#user-menu-name').textContent = SESSION.name;
    qs('#user-menu-email').textContent = SESSION.email;
    qs('#user-menu-expiry').textContent = SESSION.expiry;
  }

  function boot() {
    paintSession();
    App.initShell();
    App.initCopyButtons();

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

    // Aviso crítico de ejemplo: en producción lo dispara el estado real del número
    setTimeout(() => {
      qs('#alert-banner').classList.remove('hidden');
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.ApolAI);
