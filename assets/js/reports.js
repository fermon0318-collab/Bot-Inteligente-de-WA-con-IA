/* ============================================================================
   Elorai — Reportes y Métricas de Anuncios
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, money, num } = App;

  // Bloque E (Métricas y Conversions API) todavía no tiene endpoint: arranca
  // vacío en vez de mostrar cifras de ejemplo que un cliente podría confundir
  // con su rendimiento real.
  App.ADS = [];

  const STATUS_META = {
    paid: ['Pagado', 'badge-ok'],
    pending: ['Pendiente', 'badge-warn'],
    rejected: ['Rechazado', 'badge-danger'],
    new: ['Nuevo', 'badge-muted'],
  };

  /* ========================================================================
     Reportes
     ===================================================================== */
  const reports = { page: 1, perPage: 10, total: 0, rows: [] };

  async function cargarContactos() {
    const params = new URLSearchParams({ page: reports.page, perPage: reports.perPage });
    const telefono = qs('#rep-phone').value.trim();
    if (telefono) params.set('phone', telefono);
    if (qs('#rep-status').value) params.set('status', qs('#rep-status').value);
    if (qs('#rep-from').value) params.set('from', qs('#rep-from').value);
    if (qs('#rep-to').value) params.set('to', qs('#rep-to').value);

    const data = await App.session.api(`/contacts?${params}`);
    reports.rows = data.rows;
    reports.total = data.total;
    renderReports();
  }

  function applyFilters() {
    reports.page = 1;
    cargarContactos().catch((e) => App.toast(e.message, 'err'));
  }

  function renderReports() {
    const tbody = qs('#rep-tbody');
    const total = reports.total;
    const pages = Math.max(1, Math.ceil(total / reports.perPage));
    const start = (reports.page - 1) * reports.perPage;

    tbody.innerHTML = '';
    if (!reports.rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '7' },
        el('div', { class: 'empty-state', html: '<i class="fa-regular fa-folder-open"></i>Ningún contacto coincide con los filtros.' }))));
    }

    reports.rows.forEach((c) => {
      const [label, cls] = STATUS_META[c.status] || STATUS_META.new;
      const payBtn = el('button', {
        type: 'button',
        class: `btn btn-sm ${c.status === 'paid' ? 'btn-ghost' : 'btn-success'}`,
        disabled: c.status === 'paid',
        html: c.status === 'paid'
          ? '<i class="fa-solid fa-check"></i> Pagado'
          : '<i class="fa-solid fa-circle-check"></i> Marcar pagado',
      });
      payBtn.addEventListener('click', () => markPaid(c));

      tbody.appendChild(el('tr', {}, [
        el('td', {}, el('div', { class: 'flex items-center gap-2' }, [
          el('span', { class: 'avatar !w-8 !h-8 !text-[0.7rem]', text: App.initials(c.name || c.phone) }),
          el('span', { class: 'font-semibold text-ink', text: c.name || c.phone }),
        ])),
        el('td', { class: 'font-mono text-xs', text: c.phone }),
        el('td', {}, el('span', { class: `badge ${cls}`, text: label })),
        el('td', { class: 'text-ink/70', text: c.source }),
        el('td', { class: 'text-ink/70 whitespace-nowrap', text: App.dateShort(c.lastContact) }),
        el('td', { class: 'font-bold text-ink whitespace-nowrap', text: c.amount ? money(c.amount) : '—' }),
        el('td', { class: 'text-right' }, payBtn),
      ]));
    });

    qs('#rep-total').textContent = num(total);
    qs('#rep-range').textContent = total
      ? `Mostrando ${start + 1}–${Math.min(start + reports.perPage, total)} de ${num(total)}`
      : 'Sin resultados';
    App.renderPager(qs('#rep-pager'), reports.page, pages, (n) => { reports.page = n; cargarContactos(); });
  }

  async function markPaid(contact) {
    const ok = await App.confirmModal('Marcar como pagado',
      `Vas a marcar a <strong>${App.escapeHtml(contact.name || contact.phone)}</strong> (${contact.phone}) como pagado.<br><br>
       <span class="text-red-600 font-semibold">Esta acción es irreversible</span> y disparará la entrega automática del producto.`,
      { confirmText: 'Sí, marcar como pagado', icon: 'fa-circle-check' });
    if (!ok) return;
    try {
      await App.session.api(`/contacts/${contact.id}/paid`, { method: 'POST' });
      await cargarContactos();
      App.toast(`${contact.name || contact.phone} marcado como pagado`, 'ok');
    } catch (err) {
      App.toast(err.message, 'err');
    }
  }

  function initReports() {
    renderReports();

    qs('#rep-apply').addEventListener('click', applyFilters);
    qs('#rep-reset').addEventListener('click', () => {
      ['#rep-phone', '#rep-from', '#rep-to'].forEach((s) => { qs(s).value = ''; });
      qs('#rep-status').value = '';
      applyFilters();
      App.toast('Filtros restablecidos', 'info', 2000);
    });
    qs('#rep-phone').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyFilters(); });

    // La exportación se genera en el servidor: sin límite de 100 filas por página
    App.qsa('[data-export]').forEach((b) => b.addEventListener('click', () => {
      const status = { all: '', paid: 'paid', pending: 'pending', rejected: 'rejected' }[b.dataset.export];
      window.location.href = `/api/contacts/export.csv${status ? `?status=${status}` : ''}`;
    }));

    document.addEventListener('elorai:currency', renderReports);
  }

  /* ========================================================================
     Métricas de anuncios
     ===================================================================== */
  function adsRows() {
    return App.ADS.map((a) => {
      const costPerConvo = a.convos ? a.spend / a.convos : 0;
      const costPerSale = a.sales ? a.spend / a.sales : 0;
      const roi = a.spend ? ((a.revenue - a.spend) / a.spend) * 100 : 0;
      return Object.assign({}, a, { costPerConvo, costPerSale, roi });
    });
  }

  function renderAds() {
    const rows = adsRows();
    const tbody = qs('#ads-tbody');
    tbody.innerHTML = '';

    if (!rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '10' },
        el('div', { class: 'empty-state', html: '<i class="fa-regular fa-chart-bar"></i>Todavía no hay métricas de anuncios. Conecta Meta Ads arriba para verlas aquí.' }))));
    }

    rows.forEach((a) => {
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'font-semibold text-ink', text: a.name }),
        el('td', { class: 'text-ink/70', text: a.campaign }),
        el('td', { class: 'whitespace-nowrap', text: money(a.spend) }),
        el('td', { text: num(a.convos) }),
        el('td', { text: num(a.sales) }),
        el('td', { class: 'font-bold text-ink whitespace-nowrap', text: money(a.revenue) }),
        el('td', { class: 'whitespace-nowrap', text: money(a.costPerConvo) }),
        el('td', { class: 'whitespace-nowrap', text: money(a.costPerSale) }),
        el('td', {}, el('span', {
          class: `badge ${a.roi >= 300 ? 'badge-ok' : a.roi >= 100 ? 'badge-brand' : 'badge-danger'}`,
          text: `${a.roi.toFixed(0)}%`,
        })),
        el('td', {}, el('span', {
          class: `badge ${a.status === 'active' ? 'badge-ok' : 'badge-muted'}`,
          text: a.status === 'active' ? 'Activo' : 'Pausado',
        })),
      ]));
    });

    const totals = rows.reduce((acc, a) => ({
      spend: acc.spend + a.spend,
      convos: acc.convos + a.convos,
      sales: acc.sales + a.sales,
      revenue: acc.revenue + a.revenue,
    }), { spend: 0, convos: 0, sales: 0, revenue: 0 });

    qs('#ads-spend').textContent = money(totals.spend);
    qs('#ads-convos').textContent = num(totals.convos);
    qs('#ads-sales').textContent = num(totals.sales);
    qs('#ads-roi').textContent = totals.spend
      ? `${(((totals.revenue - totals.spend) / totals.spend) * 100).toFixed(0)}%` : '—';
  }

  function initAds() {
    App.fillCurrencySelect(qs('#capi-currency'));
    qs('#capi-currency').value = 'USD';

    const today = new Date();
    const monthAgo = new Date(today);
    monthAgo.setDate(today.getDate() - 29);
    qs('#ads-from').value = monthAgo.toISOString().slice(0, 10);
    qs('#ads-to').value = today.toISOString().slice(0, 10);

    renderAds();

    qs('#ads-save').addEventListener('click', (ev) => {
      const ok = App.validate([
        { input: '#ads-account', test: (v) => /^act_\d{6,}$/.test(v), message: 'Formato esperado: act_1234567890' },
        { input: '#ads-token', test: (v) => v.length >= 8, message: 'El Access Token parece incompleto.' },
      ]);
      if (!ok) { App.toast('Revisa las credenciales de Meta Ads', 'err'); return; }
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(750);
        App.toast('Credenciales de Meta Ads guardadas', 'ok');
      }, 'Guardando…');
    });

    qs('#capi-save').addEventListener('click', (ev) => {
      const enabled = qs('#capi-enabled').checked;
      if (enabled) {
        const ok = App.validate([{ input: '#capi-pixel', test: (v) => /^\d{10,}$/.test(v), message: 'El Pixel ID debe tener al menos 10 dígitos.' }]);
        if (!ok) { App.toast('Revisa el Pixel ID', 'err'); return; }
      }
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(700);
        App.toast(enabled ? 'Conversions API activada' : 'Conversions API desactivada', enabled ? 'ok' : 'warn');
      }, 'Guardando…');
    });

    qs('#capi-enabled').addEventListener('change', (ev) => {
      qs('#capi-pixel').disabled = false;
      if (ev.target.checked) App.toast('Recuerda guardar para aplicar el cambio', 'info', 2600);
    });

    qs('#ads-apply').addEventListener('click', (ev) => {
      const from = qs('#ads-from').value;
      const to = qs('#ads-to').value;
      if (from && to && from > to) { App.toast('La fecha inicial no puede ser posterior a la final', 'err'); return; }
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(650);
        renderAds();
        App.toast('Métricas actualizadas', 'ok');
      }, 'Cargando…');
    });

    qs('#ads-export').addEventListener('click', () => {
      const header = ['Anuncio', 'Campaña', 'Gasto', 'Conversaciones', 'Ventas', 'Ingresos', 'Costo/conversación', 'Costo/venta', 'ROI %', 'Estado'];
      const body = adsRows().map((a) => [
        a.name, a.campaign, a.spend.toFixed(2), a.convos, a.sales, a.revenue.toFixed(2),
        a.costPerConvo.toFixed(2), a.costPerSale.toFixed(2), a.roi.toFixed(1),
        a.status === 'active' ? 'Activo' : 'Pausado',
      ]);
      App.downloadCsv(`elorai-anuncios-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body]);
      App.toast('Reporte de anuncios exportado', 'ok');
    });

    document.addEventListener('elorai:currency', renderAds);
  }

  App.reports = { init() { initReports(); initAds(); } };

  App.onView('reports', () => cargarContactos().catch((e) => App.toast(e.message, 'err')));

})(window.Elorai);
