/* ============================================================================
   Elorai — páginas legales: navbar, índice activo y scroll suave
   ========================================================================== */

(function () {
  'use strict';

  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  /* --- Navbar glass al hacer scroll --------------------------------------- */
  const navbar = qs('#navbar');
  const onScroll = () => navbar.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* --- Scroll suave compensando la navbar fija ---------------------------- */
  qsa('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (ev) => {
      const id = link.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      ev.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - navbar.offsetHeight - 16;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      history.replaceState(null, '', id);
    });
  });

  /* --- Marcar en el índice la sección en pantalla -------------------------- */
  const links = qsa('.legal-toc a');
  const sections = qsa('.prose-legal section');

  if (links.length && sections.length && 'IntersectionObserver' in window) {
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) => a.classList.remove('active'));
        const active = byId.get(entry.target.id);
        if (active) {
          active.classList.add('active');
          // Mantiene visible el elemento activo si el índice tiene scroll propio
          const toc = active.closest('.legal-toc');
          if (toc && toc.scrollHeight > toc.clientHeight) {
            const top = active.offsetTop - toc.clientHeight / 2;
            toc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          }
        }
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

    sections.forEach((s) => io.observe(s));
  }

  /* --- Año del footer ------------------------------------------------------ */
  const year = qs('#footer-year');
  if (year) year.textContent = new Date().getFullYear();

})();
