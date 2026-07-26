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
  // Última respuesta de /stats: se reutiliza al cambiar de moneda sin repetir la petición.
  let lastStats = null;

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

  /* --- Tarjetas ------------------------------------------------------------ */
  function renderStats(totals) {
    qs('#stat-contacts-30').textContent = num(totals.contacts30);
    qs('#stat-pending').textContent = num(totals.pending);
    qs('#stat-sales-30').textContent = num(totals.sales30);
    qs('#stat-conversion').textContent = pct(totals.conversion);
    qs('#stat-contacts-today').textContent = num(totals.contactsToday);
    qs('#stat-pending-today').textContent = num(totals.pendingToday);
    qs('#stat-sales-today').textContent = num(totals.salesToday);
  }

  function renderSales(totals) {
    qs('#sales-total').textContent = money(totals.revenueTotal);
    qs('#sales-30').textContent = money(totals.revenue30);
    qs('#sales-today').textContent = money(totals.revenueToday);
    qs('#sales-ticket').textContent = money(totals.sales30 ? totals.revenue30 / totals.sales30 : 0);
  }

  /* --- Gráficos ----------------------------------------------------------- */
  function gradient(ctx, from, to) {
    const g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height || 240);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  }

  const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  /** Los cuatro gráficos se crean vacíos; cargarEstadisticas() los rellena. */
  function buildCharts() {
    if (!window.Chart) return;
    Object.values(charts).forEach((c) => c && c.destroy());

    const c1 = qs('#chart-daily').getContext('2d');
    charts.daily = new Chart(c1, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Contactos', data: [], backgroundColor: gradient(c1, PALETTE.brand, '#818cf8'), borderRadius: 5, maxBarThickness: 18 },
          { label: 'Ventas', data: [], backgroundColor: gradient(c1, PALETTE.plum, '#d8b4fe'), borderRadius: 5, maxBarThickness: 18 },
        ],
      },
      options: { scales: axes(), plugins: { legend: { position: 'top', align: 'end' } } },
    });

    const c2 = qs('#chart-revenue').getContext('2d');
    charts.revenue = new Chart(c2, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Ingresos', data: [],
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

    charts.weekday = new Chart(qs('#chart-weekday'), {
      type: 'doughnut',
      data: {
        labels: DOW,
        datasets: [{
          data: [0, 0, 0, 0, 0, 0, 0],
          backgroundColor: ['#4f46e5', '#6366f1', '#7c3aed', '#8b5cf6', '#9333ea', '#a855f7', '#c084fc'],
          borderWidth: 2, borderColor: '#fff', hoverOffset: 8,
        }],
      },
      options: { cutout: '58%', plugins: { legend: { position: 'right' } } },
    });

    const c4 = qs('#chart-hour').getContext('2d');
    charts.hour = new Chart(c4, {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}h`),
        datasets: [{
          label: 'Contactos', data: Array.from({ length: 24 }, () => 0),
          borderColor: PALETTE.accent,
          backgroundColor: gradient(c4, 'rgba(124,58,237,0.35)', 'rgba(124,58,237,0.02)'),
          fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5,
          pointHoverBackgroundColor: PALETTE.plum, borderWidth: 2.5,
        }],
      },
      options: { scales: axes({ xTicks: 12 }), plugins: { legend: { display: false } }, interaction: { intersect: false, mode: 'index' } },
    });
  }

  const currentRate = () => (App.CURRENCIES.find((c) => c.code === App.state.currency) || App.CURRENCIES[0]).rate;

  /* --- Carga real ----------------------------------------------------------- */
  async function cargarEstadisticas() {
    const { totals, daily, byHour } = await App.session.api('/stats');
    lastStats = { totals, daily, byHour };
    pintarEstadisticas();
  }

  /** Repinta con los últimos datos cargados — no repite la petición al cambiar de moneda. */
  function pintarEstadisticas() {
    if (!lastStats) return;
    const { totals, daily, byHour } = lastStats;

    renderStats(totals);
    renderSales(totals);

    if (!charts.daily) return; // Chart.js no cargó (por ejemplo, sin conexión al CDN)

    const etiquetas = daily.map((d) =>
      new Date(d.date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }));

    charts.daily.data.labels = etiquetas;
    charts.daily.data.datasets[0].data = daily.map((d) => d.contacts);
    charts.daily.data.datasets[1].data = daily.map((d) => d.sales);
    charts.daily.update();

    charts.revenue.data.labels = etiquetas;
    charts.revenue.data.datasets[0].data = daily.map((d) => +(d.revenue * currentRate()).toFixed(2));
    charts.revenue.update();

    const porDia = [0, 0, 0, 0, 0, 0, 0];
    daily.forEach((d) => { porDia[new Date(d.date).getDay()] += d.contacts; });
    charts.weekday.data.datasets[0].data = porDia;
    charts.weekday.update();

    const porHora = Array.from({ length: 24 }, (_, h) => byHour.find((b) => b.hour === h)?.contacts || 0);
    charts.hour.data.datasets[0].data = porHora;
    charts.hour.update();
  }

  /* --- Init --------------------------------------------------------------- */
  function init() {
    applyChartDefaults();

    const select = qs('#currency-select');
    App.fillCurrencySelect(select);
    select.value = App.state.currency;
    select.addEventListener('change', () => {
      App.state.currency = select.value;
      pintarEstadisticas();
      App.toast(`Montos en ${select.value}`, 'info', 2000);
      document.dispatchEvent(new CustomEvent('elorai:currency', { detail: select.value }));
    });

    qs('#refresh-sales').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        try {
          await cargarEstadisticas();
          App.toast('Resumen de ventas actualizado', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Actualizando…');
    });

    buildCharts();

    // Al volver al dashboard, Chart.js necesita recalcular el tamaño del canvas
    App.onView('dashboard', () => {
      Object.values(charts).forEach((c) => c && c.resize());
      cargarEstadisticas().catch((e) => App.toast(e.message, 'err'));
    });
  }

  App.dashboard = { init };

})(window.Elorai);
