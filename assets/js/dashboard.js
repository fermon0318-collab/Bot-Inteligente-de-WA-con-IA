/* ============================================================================
   Elorai — Dashboard: estadísticas, resumen de ventas y gráficos
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, money, num, pct } = App;

  const PALETTE = {
    brand: '#4f46e5',
    accent: '#7c3aed',
    plum: '#9333ea',
    soft: '#a78bfa',
    ok: '#10b981',
    warn: '#f59e0b',
    grid: 'rgba(124, 58, 237, 0.12)',
    ticks: '#7a78a3',
  };

  const charts = {};

  /* --- Defaults de Chart.js ---------------------------------------------- */
  function applyChartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = '"Plus Jakarta Sans", system-ui, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = PALETTE.ticks;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;
    Chart.defaults.plugins.legend.labels.padding = 14;
    Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(30, 27, 75, 0.94)';
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.cornerRadius = 8;
    Chart.defaults.plugins.tooltip.titleFont = { weight: '700' };
    Chart.defaults.maintainAspectRatio = false;
  }

  const axes = (opts = {}) => ({
    x: {
      grid: { display: false },
      ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: opts.xTicks || 8 },
      stacked: !!opts.stacked,
    },
    y: {
      beginAtZero: true,
      grid: { color: PALETTE.grid, drawBorder: false },
      ticks: { callback: opts.yFormat || ((v) => num(v)) },
      stacked: !!opts.stacked,
    },
  });

  /* --- Totales ------------------------------------------------------------ */
  function totals() {
    const daily = App.DAILY;
    const today = daily[daily.length - 1];
    const contacts30 = daily.reduce((s, d) => s + d.contacts, 0);
    const sales30 = daily.reduce((s, d) => s + d.sales, 0);
    const revenue30 = daily.reduce((s, d) => s + d.revenue, 0);
    const pending = App.CONTACTS.filter((c) => c.status === 'pending').length;
    const pendingToday = App.CONTACTS.filter((c) =>
      c.status === 'pending' && new Date(c.lastContact).toDateString() === new Date().toDateString()).length;
    const revenueTotal = revenue30 * 4.7; // acumulado histórico simulado
    return {
      contacts30, sales30, revenue30, pending, pendingToday,
      contactsToday: today.contacts, salesToday: today.sales, revenueToday: today.revenue,
      conversion: contacts30 ? (sales30 / contacts30) * 100 : 0,
      recurrence: 18.4,
      revenueTotal,
      ticket: sales30 ? revenue30 / sales30 : 0,
    };
  }

  /* --- Tarjetas ----------------------------------------------------------- */
  function renderStats() {
    const t = totals();
    qs('#stat-contacts-30').textContent = num(t.contacts30);
    qs('#stat-pending').textContent = num(t.pending);
    qs('#stat-sales-30').textContent = num(t.sales30);
    qs('#stat-conversion').textContent = pct(t.conversion);
    qs('#stat-contacts-today').textContent = num(t.contactsToday);
    qs('#stat-pending-today').textContent = num(t.pendingToday);
    qs('#stat-sales-today').textContent = num(t.salesToday);
    qs('#stat-recurrence').textContent = pct(t.recurrence);
  }

  function renderSales() {
    const t = totals();
    qs('#sales-total').textContent = money(t.revenueTotal);
    qs('#sales-30').textContent = money(t.revenue30);
    qs('#sales-today').textContent = money(t.revenueToday);
    qs('#sales-ticket').textContent = money(t.ticket);
  }

  function renderBranches() {
    const tbody = qs('#branches-tbody');
    tbody.innerHTML = '';
    App.BRANCHES.forEach((b) => {
      const conv = b.contacts ? (b.sales / b.contacts) * 100 : 0;
      tbody.appendChild(el('tr', {}, [
        el('td', { class: 'font-semibold text-ink', text: b.name }),
        el('td', { text: num(b.contacts) }),
        el('td', { text: num(b.sales) }),
        el('td', {}, el('span', { class: `badge ${conv >= 22 ? 'badge-ok' : conv >= 17 ? 'badge-brand' : 'badge-warn'}`, text: pct(conv) })),
        el('td', { class: 'font-bold text-ink', text: money(b.revenue) }),
      ]));
    });
  }

  /* --- Gráficos ----------------------------------------------------------- */
  function gradient(ctx, from, to) {
    const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height || 240);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  }

  function buildCharts() {
    if (!window.Chart) return;
    Object.values(charts).forEach((c) => c && c.destroy());

    const daily = App.DAILY;
    const labels = daily.map((d) => d.label);

    // 1. Clientes y ventas por día
    const c1 = qs('#chart-daily').getContext('2d');
    charts.daily = new Chart(c1, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Contactos', data: daily.map((d) => d.contacts), backgroundColor: gradient(c1, PALETTE.brand, '#818cf8'), borderRadius: 5, maxBarThickness: 18 },
          { label: 'Ventas', data: daily.map((d) => d.sales), backgroundColor: gradient(c1, PALETTE.plum, '#d8b4fe'), borderRadius: 5, maxBarThickness: 18 },
        ],
      },
      options: { scales: axes(), plugins: { legend: { position: 'top', align: 'end' } } },
    });

    // 2. Ingresos diarios
    const c2 = qs('#chart-revenue').getContext('2d');
    charts.revenue = new Chart(c2, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Ingresos',
          data: daily.map((d) => +(d.revenue * currentRate()).toFixed(2)),
          backgroundColor: gradient(c2, PALETTE.accent, '#e9d5ff'),
          borderRadius: 5, maxBarThickness: 22,
        }],
      },
      options: {
        scales: axes({ yFormat: (v) => money(v / currentRate()) }),
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (i) => ` ${money(i.parsed.y / currentRate())}` } },
        },
      },
    });

    // 3. Día de la semana
    const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const byDow = DOW.map((_, i) => daily.filter((d) => d.weekday === i).reduce((s, d) => s + d.contacts, 0));
    charts.weekday = new Chart(qs('#chart-weekday'), {
      type: 'doughnut',
      data: {
        labels: DOW,
        datasets: [{
          data: byDow,
          backgroundColor: ['#4f46e5', '#6366f1', '#7c3aed', '#8b5cf6', '#9333ea', '#a855f7', '#c084fc'],
          borderWidth: 2, borderColor: '#fff', hoverOffset: 8,
        }],
      },
      options: { cutout: '58%', plugins: { legend: { position: 'right' } } },
    });

    // 4. Hora del día
    const c4 = qs('#chart-hour').getContext('2d');
    charts.hour = new Chart(c4, {
      type: 'line',
      data: {
        labels: App.BY_HOUR.map((h) => `${String(h.hour).padStart(2, '0')}h`),
        datasets: [{
          label: 'Contactos',
          data: App.BY_HOUR.map((h) => h.contacts),
          borderColor: PALETTE.accent,
          backgroundColor: gradient(c4, 'rgba(124,58,237,0.35)', 'rgba(124,58,237,0.02)'),
          fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: PALETTE.plum, borderWidth: 2.5,
        }],
      },
      options: { scales: axes({ xTicks: 12 }), plugins: { legend: { display: false } }, interaction: { intersect: false, mode: 'index' } },
    });

    // 5. Distribuidores
    charts.branches = new Chart(qs('#chart-branches'), {
      type: 'bar',
      data: {
        labels: App.BRANCHES.map((b) => b.name),
        datasets: [
          { label: 'Contactos', data: App.BRANCHES.map((b) => b.contacts), backgroundColor: '#6366f1', borderRadius: 5 },
          { label: 'Ventas', data: App.BRANCHES.map((b) => b.sales), backgroundColor: '#9333ea', borderRadius: 5 },
        ],
      },
      options: {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { color: PALETTE.grid, drawBorder: false } },
          y: { grid: { display: false } },
        },
        plugins: { legend: { position: 'top', align: 'end' } },
      },
    });
  }

  const currentRate = () => (App.CURRENCIES.find((c) => c.code === App.state.currency) || App.CURRENCIES[0]).rate;

  function refreshCurrencyDependent() {
    renderSales();
    renderBranches();
    if (charts.revenue) {
      charts.revenue.data.datasets[0].data = App.DAILY.map((d) => +(d.revenue * currentRate()).toFixed(2));
      charts.revenue.update();
    }
  }

  /* --- Init --------------------------------------------------------------- */
  function init() {
    applyChartDefaults();

    const select = qs('#currency-select');
    App.fillCurrencySelect(select);
    select.value = App.state.currency;
    select.addEventListener('change', () => {
      App.state.currency = select.value;
      refreshCurrencyDependent();
      App.toast(`Montos en ${select.value}`, 'info', 2000);
      document.dispatchEvent(new CustomEvent('elorai:currency', { detail: select.value }));
    });

    qs('#refresh-sales').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(750);
        renderStats();
        refreshCurrencyDependent();
        App.toast('Resumen de ventas actualizado', 'ok');
      }, 'Actualizando…');
    });

    renderStats();
    renderSales();
    renderBranches();
    buildCharts();

    // Al volver al dashboard, Chart.js necesita recalcular el tamaño del canvas
    App.onView('dashboard', () => Object.values(charts).forEach((c) => c && c.resize()));
  }

  App.dashboard = { init, refreshCurrencyDependent };

})(window.Elorai);
