/* ============================================================================
   ApolAI — landing pública
   Navbar, menú móvil, modal de login, scroll suave y aparición al hacer scroll.
   ========================================================================== */

(function () {
  'use strict';

  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  /* --- Navbar: efecto glass al hacer scroll -------------------------------- */
  const navbar = qs('#navbar');
  const onScroll = () => navbar.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* --- Menú móvil ---------------------------------------------------------
     Un solo listener de `click`: los navegadores lo emiten también en táctil.
     El guard de tiempo neutraliza el "ghost click" que algunos móviles
     disparan después del touch y que provocaría un doble toggle.
     ---------------------------------------------------------------------- */
  const menuBtn = qs('#menu-toggle');
  const menuIcon = qs('#menu-icon');
  const menu = qs('#mobile-menu');
  let lastToggle = 0;

  function setMenu(open) {
    menu.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
    menuIcon.className = open ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
  }

  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const now = Date.now();
    if (now - lastToggle < 300) return;
    lastToggle = now;
    setMenu(!menu.classList.contains('open'));
  });

  // Cierre al tocar fuera o al elegir un destino
  document.addEventListener('click', (ev) => {
    if (!menu.classList.contains('open')) return;
    if (menu.contains(ev.target) || menuBtn.contains(ev.target)) return;
    setMenu(false);
  });
  qsa('#mobile-menu a').forEach((a) => a.addEventListener('click', () => setMenu(false)));

  // Al pasar a desktop el menú desplegable deja de tener sentido
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 1024 && menu.classList.contains('open')) setMenu(false);
  });

  /* --- Scroll suave a las anclas ------------------------------------------
     `scroll-behavior: smooth` ya viene del sistema de diseño; aquí solo se
     compensa la altura de la navbar fija y se mantiene limpia la URL.
     ---------------------------------------------------------------------- */
  qsa('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (ev) => {
      const id = link.getAttribute('href');
      if (id === '#' || id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      ev.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - navbar.offsetHeight - 12;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      history.replaceState(null, '', id);
    });
  });

  /* --- Modal de login ------------------------------------------------------ */
  const modal = qs('#login-modal');
  let lastFocused = null;

  function openLogin() {
    lastFocused = document.activeElement;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const first = modal.querySelector('a.btn');
      if (first) first.focus();
    }, 150);
  }

  function closeLogin() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
    if (lastFocused) lastFocused.focus();
  }

  qsa('[data-open-login]').forEach((b) => b.addEventListener('click', openLogin));
  qsa('[data-close-login]').forEach((b) => b.addEventListener('click', closeLogin));
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeLogin(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modal.classList.contains('open')) closeLogin();
  });

  /* --- Aparición progresiva al hacer scroll -------------------------------- */
  const revealables = qsa('.reveal');
  if ('IntersectionObserver' in window && revealables.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        // Pequeño escalonado cuando entran varias tarjetas a la vez
        setTimeout(() => entry.target.classList.add('visible'), i * 70);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealables.forEach((node) => io.observe(node));
  } else {
    revealables.forEach((node) => node.classList.add('visible'));
  }

  /* --- Año del footer ------------------------------------------------------ */
  qs('#footer-year').textContent = new Date().getFullYear();

})();
