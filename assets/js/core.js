/* ============================================================================
   ApolAI — núcleo: helpers, navegación, modales, toasts, loader
   ========================================================================== */

(function (App) {
  'use strict';

  /* --- Helpers de DOM ----------------------------------------------------- */
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : children ? [children] : []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* --- Formato ------------------------------------------------------------ */
  function money(amountUsd, currencyCode) {
    const cur = App.CURRENCIES.find((c) => c.code === (currencyCode || App.state.currency)) || App.CURRENCIES[0];
    const value = amountUsd * cur.rate;
    const decimals = ['COP', 'CLP', 'PYG', 'ARS'].includes(cur.code) ? 0 : 2;
    return cur.symbol + value.toLocaleString('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  const num = (n) => Number(n).toLocaleString('es-MX');
  const pct = (n) => `${Number(n).toFixed(1)}%`;

  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
    if (diff < 604800) return `hace ${Math.floor(diff / 86400)} d`;
    return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  }

  const clock = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const dateShort = (iso) => new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });

  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /* --- Estado global ------------------------------------------------------ */
  App.state = {
    currency: 'USD',
    view: 'dashboard',
    botRunning: true,
    connected: true,
  };

  /* --- Toasts ------------------------------------------------------------- */
  const TOAST_ICONS = { ok: 'fa-circle-check', err: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' };

  function toast(message, kind = 'ok', ms = 3400) {
    const stack = qs('#toast-stack');
    const node = el('div', { class: `toast ${kind}`, role: 'status' }, [
      el('i', { class: `fa-solid ${TOAST_ICONS[kind] || TOAST_ICONS.info}` }),
      el('span', { text: message }),
    ]);
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    }, ms);
  }

  /* --- Loader ------------------------------------------------------------- */
  function showLoader(text) {
    const l = qs('#global-loader');
    if (text) qs('#loader-text').textContent = text;
    l.classList.remove('hidden');
  }
  const hideLoader = () => qs('#global-loader').classList.add('hidden');

  /* --- Modal genérico ------------------------------------------------------
     modal({ title, icon, body (string|Node), confirmText, cancelText, danger,
             hideCancel, onConfirm }) → Promise<boolean|any>
     Si onConfirm devuelve `false`, el modal no se cierra (útil para validar).
     ------------------------------------------------------------------------ */
  let modalResolve = null;

  function closeModal(result) {
    const backdrop = qs('#modal');
    backdrop.classList.remove('open');
    if (modalResolve) { modalResolve(result); modalResolve = null; }
  }

  function modal(opts) {
    const o = Object.assign({
      title: 'Confirmar', icon: 'fa-circle-question', body: '',
      confirmText: 'Confirmar', cancelText: 'Cancelar',
      danger: false, hideCancel: false, onConfirm: null,
    }, opts);

    const backdrop = qs('#modal');
    qs('#modal-title').textContent = o.title;
    qs('#modal-icon').className = `fa-solid ${o.icon}`;

    const body = qs('#modal-body');
    body.innerHTML = '';
    if (typeof o.body === 'string') body.innerHTML = o.body;
    else if (o.body) body.appendChild(o.body);

    const confirmBtn = qs('#modal-confirm');
    const cancelBtn = qs('#modal-cancel');
    confirmBtn.textContent = o.confirmText;
    confirmBtn.className = `btn ${o.danger ? 'btn-danger' : 'btn-primary'}`;
    cancelBtn.textContent = o.cancelText;
    cancelBtn.classList.toggle('hidden', !!o.hideCancel);

    // Se reemplazan los botones para limpiar listeners de aperturas previas
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.replaceWith(newConfirm);
    newConfirm.addEventListener('click', () => {
      const result = o.onConfirm ? o.onConfirm(body) : true;
      if (result === false) return; // validación fallida: se mantiene abierto
      closeModal(result === undefined ? true : result);
    });

    backdrop.classList.add('open');
    setTimeout(() => {
      const focusable = body.querySelector('input, textarea, select') || newConfirm;
      focusable.focus();
      if (focusable.select) focusable.select();
    }, 120);

    return new Promise((resolve) => { modalResolve = resolve; });
  }

  function confirmModal(title, message, opts) {
    return modal(Object.assign({
      title, icon: 'fa-triangle-exclamation',
      body: `<p class="text-sm text-ink/75 leading-relaxed">${message}</p>`,
    }, opts));
  }

  function promptModal(title, label, value, opts) {
    const input = el('input', { class: 'input', value: value || '', placeholder: (opts && opts.placeholder) || '' });
    const err = el('p', { class: 'error-msg', text: 'Este campo no puede quedar vacío.' });
    const wrap = el('div', {}, [el('label', { class: 'label', text: label }), input, err]);
    return modal(Object.assign({
      title, icon: 'fa-pen', body: wrap, confirmText: 'Guardar',
      onConfirm: () => {
        const v = input.value.trim();
        if (!v) { input.classList.add('is-invalid'); err.classList.add('show'); return false; }
        return v;
      },
    }, opts));
  }

  /* --- Validación --------------------------------------------------------- */
  function setError(input, on, message) {
    input.classList.toggle('is-invalid', !!on);
    const msg = qs(`[data-error-for="${input.id}"]`);
    if (msg) {
      msg.classList.toggle('show', !!on);
      if (message) msg.textContent = message;
    }
  }

  function validate(rules) {
    let ok = true;
    rules.forEach(({ input, test, message }) => {
      const node = typeof input === 'string' ? qs(input) : input;
      if (!node) return;
      const valid = test(node.value.trim(), node);
      setError(node, !valid, message);
      if (!valid) ok = false;
    });
    return ok;
  }

  const notEmpty = (v) => v.length > 0;
  const isPhone = (v) => v.replace(/\D/g, '').length >= 10;

  /* --- Copiar / mostrar contraseñas --------------------------------------- */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function initCopyButtons() {
    document.addEventListener('click', async (ev) => {
      const copyBtn = ev.target.closest('[data-copy]');
      if (copyBtn) {
        const target = qs(copyBtn.dataset.copy);
        if (!target) return;
        const done = await copyText(target.value !== undefined ? target.value : target.textContent);
        toast(done ? 'Copiado al portapapeles' : 'No se pudo copiar', done ? 'ok' : 'err');
        return;
      }
      const eyeBtn = ev.target.closest('[data-toggle-visibility]');
      if (eyeBtn) {
        const target = qs(eyeBtn.dataset.toggleVisibility);
        if (!target) return;
        const hidden = target.type === 'password';
        target.type = hidden ? 'text' : 'password';
        eyeBtn.querySelector('i').className = hidden ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
      }
    });
  }

  /* --- Navegación entre vistas -------------------------------------------- */
  const VIEWS = {
    'dashboard': ['Dashboard', 'Resumen de actividad de tu bot'],
    'cloud-api': ['Cloud API', 'Conexión con WhatsApp Business'],
    'countries': ['Bloqueo por País', 'Filtra mensajes por prefijo telefónico'],
    'live-chat': ['Chat en Vivo', 'Conversaciones en curso'],
    'chat-history': ['Histórico Chats', 'Conversaciones anteriores'],
    'reports': ['Reportes', 'Contactos, estados y exportaciones'],
    'ads': ['Métricas de Anuncios', 'Retorno real de tus campañas'],
    'media': ['Archivos', 'Biblioteca de medios del bot'],
    'flows-simple': ['Flujos Simples', 'Secuencias lineales de mensajes'],
    'flows-advanced': ['Flujos Avanzados', 'Conversaciones con ramificaciones'],
    'remarketing': ['Remarketing', 'Recuperación de contactos'],
    'triggers': ['Disparadores', 'Palabras clave que activan flujos'],
    'payments': ['Pagos y Acceso', 'Verificación y entrega automática'],
    'ai-config': ['Configurar IA', 'Modelo, prompt y comportamiento'],
    'tutorials': ['Tutoriales', 'Videos guía de ApolAI'],
    'faq': ['Preguntas Frecuentes', 'Dudas resueltas'],
  };

  const viewHooks = {};
  App.onView = (name, fn) => { (viewHooks[name] = viewHooks[name] || []).push(fn); };

  function navigate(view) {
    if (!VIEWS[view]) view = 'dashboard';
    App.state.view = view;

    qsa('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
    qsa('.nav-link').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });

    const [title, subtitle] = VIEWS[view];
    qs('#view-title').textContent = title;
    qs('#view-subtitle').textContent = subtitle;
    document.title = `ApolAI · ${title}`;

    if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
    closeSidebar();
    window.scrollTo({ top: 0, behavior: 'auto' });
    (viewHooks[view] || []).forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }

  /* --- Sidebar ------------------------------------------------------------ */
  function openSidebar() {
    qs('#sidebar').classList.add('open');
    const ov = qs('#sidebar-overlay');
    ov.classList.remove('opacity-0', 'pointer-events-none');
    qs('#sidebar-toggle').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeSidebar() {
    qs('#sidebar').classList.remove('open');
    const ov = qs('#sidebar-overlay');
    ov.classList.add('opacity-0', 'pointer-events-none');
    qs('#sidebar-toggle').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  function initShell() {
    qsa('.nav-link').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.view)));
    qs('#sidebar-toggle').addEventListener('click', () =>
      qs('#sidebar').classList.contains('open') ? closeSidebar() : openSidebar());
    qs('#sidebar-close').addEventListener('click', closeSidebar);
    qs('#sidebar-overlay').addEventListener('click', closeSidebar);

    // Menú de usuario
    const menuBtn = qs('#user-menu-btn');
    const menu = qs('#user-menu');
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = menu.classList.toggle('hidden');
      menuBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', (ev) => {
      if (!menu.contains(ev.target) && !menuBtn.contains(ev.target)) {
        menu.classList.add('hidden');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });

    qs('#logout-btn').addEventListener('click', async () => {
      menu.classList.add('hidden');
      const ok = await confirmModal('Cerrar sesión', '¿Seguro que quieres salir de tu panel de ApolAI?', {
        confirmText: 'Cerrar sesión', danger: true, icon: 'fa-right-from-bracket',
      });
      if (ok) {
        showLoader('Cerrando sesión…');
        // Sin backend todavía: se vuelve al sitio público
        setTimeout(() => { location.href = 'index.html'; }, 900);
      }
    });

    // Banner de alerta
    qs('#alert-banner-close').addEventListener('click', () => qs('#alert-banner').classList.add('hidden'));

    // Modal: cerrar
    qs('#modal-x').addEventListener('click', () => closeModal(false));
    qs('#modal-cancel').addEventListener('click', () => closeModal(false));
    qs('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(false); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (qs('#modal').classList.contains('open')) closeModal(false);
      else if (qs('#sidebar').classList.contains('open')) closeSidebar();
    });

    window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
    qs('#footer-year').textContent = new Date().getFullYear();
  }

  /* --- Indicador de conexión --------------------------------------------- */
  function setConnection(connected) {
    App.state.connected = connected;
    const box = qs('#conn-indicator');
    const label = qs('#conn-label');
    box.className = connected
      ? 'hidden sm:flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5'
      : 'hidden sm:flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1.5';
    label.className = connected ? 'text-xs font-bold text-emerald-700' : 'text-xs font-bold text-red-700';
    label.textContent = connected ? 'Conectado' : 'Desconectado';
    box.querySelector('.dot').className = `dot ${connected ? 'dot-ok' : 'dot-off'} block`;
    box.querySelector('.pulse-ring').style.display = connected ? '' : 'none';
  }

  function setBotState(running) {
    App.state.botRunning = running;
    qs('#sidebar-bot-dot').className = `dot ${running ? 'dot-ok' : 'dot-off'} block`;
    const label = qs('#sidebar-bot-state');
    label.textContent = running ? 'Activo' : 'Detenido';
    label.className = `text-sm font-bold ${running ? 'text-emerald-600' : 'text-ink/50'}`;
  }

  /* --- Selectores auxiliares reutilizables -------------------------------- */
  function fillCurrencySelect(select) {
    select.innerHTML = '';
    App.CURRENCIES.forEach((c) => select.appendChild(el('option', { value: c.code, text: `${c.code} — ${c.name}` })));
  }

  function fillFlowSelect(select, includeNone) {
    select.innerHTML = '';
    if (includeNone) select.appendChild(el('option', { value: '', text: '— Ninguno —' }));
    const simple = el('optgroup', { label: 'Flujos simples' });
    App.SIMPLE_FLOWS.forEach((f) => simple.appendChild(el('option', { value: f.id, text: f.name })));
    const adv = el('optgroup', { label: 'Flujos avanzados' });
    App.ADVANCED_FLOWS.forEach((f) => adv.appendChild(el('option', { value: f.id, text: f.name })));
    select.append(simple, adv);
  }

  const flowName = (id) => {
    const f = App.SIMPLE_FLOWS.concat(App.ADVANCED_FLOWS).find((x) => x.id === id);
    return f ? f.name : '—';
  };

  /* --- Descarga de CSV ---------------------------------------------------- */
  function downloadCsv(filename, rows) {
    const csv = rows.map((row) => row.map((cell) => {
      const v = cell === null || cell === undefined ? '' : String(cell);
      return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* --- Paginador ---------------------------------------------------------- */
  function renderPager(container, page, totalPages, onGo) {
    container.innerHTML = '';
    if (totalPages <= 1) return;
    const add = (label, target, opts = {}) => {
      const b = el('button', {
        type: 'button',
        class: `pager-btn ${opts.active ? 'active' : ''}`,
        html: label,
        disabled: !!opts.disabled,
        'aria-label': opts.label || undefined,
      });
      if (!opts.disabled && !opts.active) b.addEventListener('click', () => onGo(target));
      container.appendChild(b);
    };
    add('<i class="fa-solid fa-chevron-left"></i>', page - 1, { disabled: page === 1, label: 'Anterior' });
    const pages = new Set([1, totalPages, page, page - 1, page + 1]);
    let last = 0;
    Array.from(pages).filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b).forEach((p) => {
      if (p - last > 1) container.appendChild(el('span', { class: 'text-ink/40 px-0.5', text: '…' }));
      add(String(p), p, { active: p === page });
      last = p;
    });
    add('<i class="fa-solid fa-chevron-right"></i>', page + 1, { disabled: page === totalPages, label: 'Siguiente' });
  }

  /* --- Simulación de llamada al backend ----------------------------------- */
  const fakeRequest = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

  async function withBusy(button, task, busyText) {
    if (!button) return task();
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${busyText || 'Procesando…'}`;
    try { return await task(); }
    finally { button.disabled = false; button.innerHTML = original; }
  }

  /* --- Exportación -------------------------------------------------------- */
  Object.assign(App, {
    qs, qsa, el, escapeHtml,
    money, num, pct, timeAgo, clock, dateShort, initials, fileSize,
    toast, showLoader, hideLoader,
    modal, confirmModal, promptModal, closeModal,
    validate, setError, notEmpty, isPhone,
    copyText, initCopyButtons,
    navigate, initShell, closeSidebar,
    setConnection, setBotState,
    fillCurrencySelect, fillFlowSelect, flowName,
    downloadCsv, renderPager, fakeRequest, withBusy,
  });

})(window.ApolAI);
