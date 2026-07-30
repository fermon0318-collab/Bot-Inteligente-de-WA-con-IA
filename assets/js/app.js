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

    const { user, subscription, support } = me;
    if (support?.whatsapp) {
      // Corrige también el mensaje predefinido para cada vista: si `.set()` ya
      // se llamó antes de que llegara esta respuesta, el enlace visible en
      // pantalla se arregla con applyWhatsapp; las próximas veces que se
      // llame usan directamente el href ya corregido aquí.
      Object.values(App.WA_MESSAGES || {}).forEach((cfg) => {
        cfg.href = cfg.href.replace('[WHATSAPP_NUMBER]', support.whatsapp);
      });
      App.session.applyWhatsapp(support.whatsapp);
    }
    qs('#user-avatar').textContent = App.initials(user.name || user.email);
    qs('#user-name').textContent = user.name || user.email;
    qs('#user-email-short').textContent = user.email;
    qs('#user-menu-name').textContent = user.name || user.email;
    qs('#user-menu-email').textContent = user.email;

    // Otros módulos (Facturación) necesitan saber quién está dentro.
    App.state.user = user;
    App.state.subscription = subscription;

    const [label, badgeClass] = session.SUBSCRIPTION_LABEL[subscription.status]
      || session.SUBSCRIPTION_LABEL.none;

    qs('#user-menu-plan').textContent = subscription.plan ? PLAN_LABEL[subscription.plan] : '—';

    const statusCell = qs('#user-menu-status');
    statusCell.className = `badge ${badgeClass}`;
    statusCell.textContent = label;

    // Durante la prueba lo que importa no es "vence" sino cuándo se cobra.
    const trialing = subscription.status === 'trialing';
    const expiryDate = trialing ? subscription.trial_ends_at : subscription.current_period_end;
    qs('#user-menu-expiry-label').textContent = trialing ? 'Primer cobro' : 'Vence';
    qs('#user-menu-expiry').textContent = expiryDate ? App.dateShort(expiryDate) : '—';

    // Cuenta regresiva de la prueba gratis en el propio menú
    if (App.paintTrialInMenu) App.paintTrialInMenu(subscription);

    // Una cuenta gratuita de por vida no tiene nada que facturar.
    qs('#user-menu-billing').classList.toggle('hidden', subscription.status === 'bypass');

    // Acceso al portal de Stripe desde el menú de usuario — Wompi no tiene
    // portal de autogestión, así que este botón solo aplica con Stripe.
    if (subscription.provider === 'stripe' && subscription.status !== 'bypass' && subscription.status !== 'none') {
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
      const text = qs('#alert-banner-text');
      if (subscription.provider === 'wompi') {
        text.innerHTML = 'Tu último cobro no se completó. ' +
          '<a href="/onboarding.html?mode=update&next=/dashboard.html" class="underline font-bold">Actualiza tu tarjeta</a> para no perder el servicio.';
      } else {
        text.textContent = 'Tu último cobro no se completó. Actualiza el método de pago para no perder el servicio.';
      }
      banner.classList.remove('hidden');
    }
  }

  function boot() {
    paintSession();
    App.initShell();
    App.initMediaViewer();
    App.initCopyButtons();

    if (isDemo) qs('#demo-banner').classList.remove('hidden');

    App.dashboard.init();
    App.connect.init();
    App.chat.init();
    App.reports.init();
    App.automation.init();
    App.settings.init();
    App.agenda.init();
    App.billing.init();

    // Botón flotante de WhatsApp: un mensaje por vista, no una tarjeta metida
    // en el contenido. Cada vista con oferta de ayuda registra su propio
    // texto aquí; reports.js reutiliza App.WA_MESSAGES.ads para volver al
    // mensaje normal cuando el ROI deja de estar bajo.
    App.whatsappFab = App.initWhatsappFab();
    App.WA_MESSAGES = {
      'cloud-api': {
        key: 'wa-cloudapi',
        message: '¿Deseas que hagamos la conexión por ti?',
        href: `https://wa.me/[WHATSAPP_NUMBER]?text=${encodeURIComponent('Hola, necesito ayuda para conectar mi WhatsApp Cloud API a Elorai')}`,
      },
      ads: {
        key: 'wa-ads',
        message: '¿Deseas que hagamos la conexión por ti?',
        href: `https://wa.me/[WHATSAPP_NUMBER]?text=${encodeURIComponent('Hola, necesito ayuda para conectar Meta Ads a Elorai')}`,
      },
    };
    App.onAnyView((view) => {
      const cfg = App.WA_MESSAGES[view];
      if (cfg) App.whatsappFab.set(cfg);
      else App.whatsappFab.hide();
    });

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
