/* ============================================================================
   Elorai — Reportes y Métricas de Anuncios
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, money, num } = App;

  const STATUS_META = {
    paid: ['Pagado', 'badge-ok'],
    pending: ['Pendiente', 'badge-warn'],
    rejected: ['Rechazado', 'badge-danger'],
    new: ['Nuevo', 'badge-muted'],
  };

  /* ========================================================================
     Reportes
     ===================================================================== */
  const reports = { page: 1, perPage: 10, rows: [] };

  function applyFilters() {
    const phone = qs('#rep-phone').value.trim().replace(/\D/g, '');
    const status = qs('#rep-status').value;
    const from = qs('#rep-from').value ? new Date(qs('#rep-from').value + 'T00:00:00') : null;
    const to = qs('#rep-to').value ? new Date(qs('#rep-to').value + 'T23:59:59') : null;

    reports.rows = App.CONTACTS.filter((c) => {
      if (phone && !c.phone.replace(/\D/g, '').includes(phone)) return false;
      if (status && c.status !== status) return false;
      const d = new Date(c.lastContact);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    reports.page = 1;
    renderReports();
  }

  function renderReports() {
    const tbody = qs('#rep-tbody');
    const total = reports.rows.length;
    const pages = Math.max(1, Math.ceil(total / reports.perPage));
    if (reports.page > pages) reports.page = pages;
    const start = (reports.page - 1) * reports.perPage;
    const slice = reports.rows.slice(start, start + reports.perPage);

    tbody.innerHTML = '';
    if (!slice.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '7' },
        el('div', { class: 'empty-state', html: '<i class="fa-regular fa-folder-open"></i>Ningún contacto coincide con los filtros.' }))));
    }

    slice.forEach((c) => {
      const [label, cls] = STATUS_META[c.status];
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
          el('span', { class: 'avatar !w-8 !h-8 !text-[0.7rem]', text: App.initials(c.name) }),
          el('span', { class: 'font-semibold text-ink', text: c.name }),
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
    App.renderPager(qs('#rep-pager'), reports.page, pages, (n) => { reports.page = n; renderReports(); });
  }

  async function markPaid(contact) {
    const ok = await App.confirmModal('Marcar como pagado',
      `Vas a marcar a <strong>${App.escapeHtml(contact.name)}</strong> (${contact.phone}) como pagado.<br><br>
       <span class="text-red-600 font-semibold">Esta acción es irreversible</span> y disparará la entrega automática del producto.`,
      { confirmText: 'Sí, marcar como pagado', icon: 'fa-circle-check' });
    if (!ok) return;
    contact.status = 'paid';
    if (!contact.amount) contact.amount = 89;
    renderReports();
    App.toast(`${contact.name} marcado como pagado`, 'ok');
  }

  function exportContacts(kind) {
    const map = { all: null, paid: 'paid', pending: 'pending', rejected: 'rejected' };
    const status = map[kind];
    const rows = App.CONTACTS.filter((c) => !status || c.status === status);
    if (!rows.length) { App.toast('No hay contactos para exportar', 'warn'); return; }
    const header = ['Nombre', 'Teléfono', 'Estado', 'Origen', 'Último contacto', `Monto (${App.state.currency})`];
    const body = rows.map((c) => [
      c.name, c.phone, STATUS_META[c.status][0], c.source,
      App.dateShort(c.lastContact), c.amount ? money(c.amount).replace(/[^\d.,-]/g, '') : '0',
    ]);
    App.downloadCsv(`elorai-contactos-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body]);
    App.toast(`${rows.length} contactos exportados`, 'ok');
  }

  function initReports() {
    reports.rows = App.CONTACTS.slice();
    renderReports();

    qs('#rep-apply').addEventListener('click', applyFilters);
    qs('#rep-reset').addEventListener('click', () => {
      ['#rep-phone', '#rep-from', '#rep-to'].forEach((s) => { qs(s).value = ''; });
      qs('#rep-status').value = '';
      applyFilters();
      App.toast('Filtros restablecidos', 'info', 2000);
    });
    qs('#rep-phone').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyFilters(); });
    App.qsa('[data-export]').forEach((b) => b.addEventListener('click', () => exportContacts(b.dataset.export)));

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

})(window.Elorai);
