/* ============================================================================
   Elorai — Agenda: reservas, bloqueos de horario y profesionales
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el, toast, confirmModal, withBusy, escapeHtml } = App;

  const HOUR_START = 7;
  const HOUR_END = 21; // exclusivo — última fila visible es 20:00–21:00
  const HOUR_H = 52; // px por hora, referenciado también por --hour-h en CSS
  const DOW_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  const STATUS = {
    reservado:  { label: 'Reservado',   dot: '#38bdf8', bg: '#e0f2fe', text: '#0369a1' },
    confirmado: { label: 'Confirmado',  dot: '#fbbf24', bg: '#fef3c7', text: '#92400e' },
    asiste:     { label: 'Asiste',      dot: '#f472b6', bg: '#fce7f3', text: '#9d174d' },
    no_asistio: { label: 'No asistió',  dot: '#fb923c', bg: '#ffedd5', text: '#9a3412' },
    pendiente:  { label: 'Pendiente',   dot: '#f87171', bg: '#fee2e2', text: '#991b1b' },
    en_espera:  { label: 'En espera',   dot: '#34d399', bg: '#d1fae5', text: '#065f46' },
    cancelada:  { label: 'Cancelada',   dot: '#94a3b8', bg: '#f1f5f9', text: '#475569' },
  };
  const STATUS_ORDER = ['reservado', 'confirmado', 'asiste', 'no_asistio', 'pendiente', 'en_espera', 'cancelada'];

  const state = {
    mode: 'week',
    anchor: startOfDay(new Date()),
    miniMonth: startOfMonth(new Date()),
    professionals: [],
    services: [],
    filterProfessional: '',
    filterStatus: '',
    events: { appointments: [], blocks: [] },
    editingAppointmentId: null,
    selectedClient: null,
    popover: null,
  };

  /* --- Fechas --------------------------------------------------------------- */
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  // Lunes como primer día de la semana
  function startOfWeek(d) { const day = (d.getDay() + 6) % 7; return addDays(startOfDay(d), -day); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDateInput(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function fmtTimeInput(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  function fmtDateShort(d) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`; }
  function combineDateTime(dateStr, timeStr) {
    const [y, m, day] = dateStr.split('-').map(Number);
    const [h, min] = timeStr.split(':').map(Number);
    return new Date(y, m - 1, day, h, min, 0, 0);
  }
  function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

  function daysToShow() {
    if (state.mode === 'day') return [state.anchor];
    const start = startOfWeek(state.anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }

  function rangeForView() {
    const days = daysToShow();
    return { from: days[0], to: addDays(days[days.length - 1], 1) };
  }

  /* --- Datos base (profesionales / servicios) -------------------------------- */

  function fillSelect(select, items, { includeAll, allLabel } = {}) {
    const current = select.value;
    select.innerHTML = '';
    if (includeAll) select.appendChild(el('option', { value: '', text: allLabel || 'Todos' }));
    items.forEach((it) => select.appendChild(el('option', { value: it.id, text: it.name })));
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  }

  async function loadProfessionals() {
    state.professionals = await App.session.api('/agenda/professionals');
    fillSelect(qs('#agenda-professional-filter'), state.professionals, { includeAll: true, allLabel: 'Todos los profesionales' });
    fillSelect(qs('#block-professional'), state.professionals);
    fillSelect(qs('#appt-professional'), state.professionals);
    if (!state.filterProfessional && state.professionals[0]) {
      state.filterProfessional = state.professionals[0].id;
      qs('#agenda-professional-filter').value = state.filterProfessional;
    }
  }

  async function loadServices() {
    state.services = await App.session.api('/agenda/services');
    const select = qs('#appt-service');
    select.innerHTML = '';
    select.appendChild(el('option', { value: '', text: 'Sin servicio específico' }));
    state.services.filter((s) => s.active).forEach((s) =>
      select.appendChild(el('option', { value: s.id, text: `${s.name} · ${s.duration_min} min` })));
  }

  function professionalName(id) {
    return state.professionals.find((p) => p.id === id)?.name || '—';
  }

  /* --- Mini-calendario -------------------------------------------------------- */

  function renderMiniCalendar() {
    const wrap = qs('#agenda-mini-calendar');
    wrap.innerHTML = '';
    qs('#agenda-mini-label').textContent = `${MONTHS[state.miniMonth.getMonth()]} ${state.miniMonth.getFullYear()}`;

    const grid = el('div', { class: 'grid grid-cols-7 gap-0.5' });
    DOW_SHORT.forEach((d) => grid.appendChild(el('span', { class: 'text-[0.65rem] font-bold text-ink/35 text-center', text: d[0] })));

    const first = state.miniMonth;
    const firstWeekday = (first.getDay() + 6) % 7; // 0 = lunes
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < firstWeekday; i++) grid.appendChild(el('span', {}));
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(first.getFullYear(), first.getMonth(), day);
      const classes = ['agenda-mini-day'];
      if (sameDay(date, today)) classes.push('is-today');
      if (sameDay(date, state.anchor)) classes.push('is-selected');
      const btn = el('button', { type: 'button', class: classes.join(' '), text: String(day) });
      btn.addEventListener('click', () => {
        state.anchor = startOfDay(date);
        if (state.mode === 'day') state.anchor = startOfDay(date);
        renderMiniCalendar();
        loadEvents();
      });
      grid.appendChild(btn);
    }
    wrap.appendChild(grid);
  }

  function syncMiniMonthToAnchor() {
    if (state.miniMonth.getFullYear() !== state.anchor.getFullYear() || state.miniMonth.getMonth() !== state.anchor.getMonth()) {
      state.miniMonth = startOfMonth(state.anchor);
    }
  }

  /* --- Leyenda ------------------------------------------------------------- */

  function renderLegend() {
    const wrap = qs('#agenda-legend');
    wrap.innerHTML = '';
    STATUS_ORDER.forEach((key) => {
      const s = STATUS[key];
      wrap.appendChild(el('div', { class: 'agenda-legend-item' }, [
        el('span', { class: 'agenda-legend-dot', style: `background:${s.dot}` }),
        el('span', { text: s.label }),
      ]));
    });
  }

  /* --- Carga de eventos ------------------------------------------------------- */

  async function loadEvents() {
    syncMiniMonthToAnchor();
    renderMiniCalendar();
    updateRangeLabel();

    const { from, to } = rangeForView();
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (state.filterProfessional) params.set('professionalId', state.filterProfessional);
    if (state.filterStatus) params.set('status', state.filterStatus);

    try {
      state.events = await App.session.api(`/agenda/events?${params}`);
    } catch (err) {
      if (err.status === 401) { App.session.goToLogin('/dashboard.html#agenda'); return; }
      toast(`No se pudo cargar la agenda: ${err.message}`, 'err');
      state.events = { appointments: [], blocks: [] };
    }
    renderGrid();
  }

  function updateRangeLabel() {
    const days = daysToShow();
    const label = state.mode === 'day'
      ? days[0].toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: 'long' })
      : `${fmtDateShort(days[0])} – ${fmtDateShort(days[6])} de ${MONTHS[days[6].getMonth()]}`;
    qs('#agenda-range-label').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  }

  /* --- Segmentos por día (recorta citas/bloqueos multi-día en cada columna) --- */

  /**
   * Convierte un evento real (que puede empezar/terminar fuera de este día, o
   * fuera de las horas visibles) en el segmento que corresponde pintar en la
   * columna de `day`. startMin/endMin quedan en 0–1440 (todo el día, no solo
   * el rango visible) para que el reparto de carriles sea correcto; el recorte
   * a las horas visibles ocurre después, al calcular la posición en píxeles.
   */
  function makeSegment(kind, raw, realStart, realEnd, dayStart, dayEnd) {
    const startMin = realStart <= dayStart ? 0 : minutesOfDay(realStart);
    const endMinRaw = realEnd >= dayEnd ? 24 * 60 : minutesOfDay(realEnd);
    return {
      kind, raw, realStart, realEnd,
      startMin, endMin: Math.max(endMinRaw, startMin + 1),
      continuesBefore: realStart < dayStart,
      continuesAfter: realEnd > dayEnd,
    };
  }

  function segmentsForDay(day) {
    const dayStart = startOfDay(day);
    const dayEnd = addDays(dayStart, 1);
    const appts = state.events.appointments
      .filter((a) => new Date(a.starts_at) < dayEnd && new Date(a.ends_at) > dayStart)
      .map((a) => makeSegment('appointment', a, new Date(a.starts_at), new Date(a.ends_at), dayStart, dayEnd));
    const blocks = state.events.blocks
      .filter((b) => new Date(b.starts_at) < dayEnd && new Date(b.ends_at) > dayStart)
      .map((b) => makeSegment('block', b, new Date(b.starts_at), new Date(b.ends_at), dayStart, dayEnd));
    return [...appts, ...blocks];
  }

  /* --- Layout de eventos superpuestos (por columna/día) ----------------------- */

  function layoutForDay(events) {
    const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let clusterEnd = -1;
    let current = null;
    const clusters = [];
    sorted.forEach((ev) => {
      if (!current || ev.startMin >= clusterEnd) {
        current = [];
        clusters.push(current);
        clusterEnd = ev.endMin;
      } else {
        clusterEnd = Math.max(clusterEnd, ev.endMin);
      }
      current.push(ev);
    });
    clusters.forEach((cluster) => {
      const lanes = [];
      cluster.forEach((ev) => {
        let lane = lanes.findIndex((end) => end <= ev.startMin);
        if (lane === -1) { lane = lanes.length; lanes.push(ev.endMin); }
        else lanes[lane] = ev.endMin;
        ev._lane = lane;
      });
      cluster.forEach((ev) => { ev._laneCount = lanes.length; });
    });
    return sorted;
  }

  /* --- Render del grid ------------------------------------------------------- */

  function renderGrid() {
    const grid = qs('#agenda-grid');
    grid.innerHTML = '';
    grid.style.setProperty('--hour-h', `${HOUR_H}px`);
    const days = daysToShow();
    const cols = `3.5rem repeat(${days.length}, minmax(9rem, 1fr))`;

    // Cabecera
    const head = el('div', { class: 'agenda-head-row', style: `grid-template-columns:${cols}` });
    head.appendChild(el('div', { class: 'agenda-head-cell' }));
    const today = new Date();
    days.forEach((d) => {
      const isToday = sameDay(d, today);
      head.appendChild(el('div', { class: `agenda-head-cell${isToday ? ' is-today' : ''}` }, [
        el('div', { class: 'agenda-head-day', text: DOW_SHORT[d.getDay()] }),
        el('div', { class: 'agenda-head-date', text: fmtDateShort(d) }),
      ]));
    });
    grid.appendChild(head);

    // Cuerpo
    const totalHeight = (HOUR_END - HOUR_START) * HOUR_H;
    const body = el('div', { class: 'agenda-body-row', style: `grid-template-columns:${cols}` });

    const hourCol = el('div', { class: 'agenda-hour-col', style: `height:${totalHeight}px;position:relative;` });
    for (let h = HOUR_START; h < HOUR_END; h++) {
      hourCol.appendChild(el('div', {
        class: 'agenda-hour-label',
        style: `position:absolute;top:${(h - HOUR_START) * HOUR_H}px;left:0;right:0;`,
        text: `${pad2(h)}:00`,
      }));
    }
    body.appendChild(hourCol);

    let totalEvents = 0;
    days.forEach((day) => {
      const isToday = sameDay(day, today);
      const col = el('div', {
        class: `agenda-day-col${isToday ? ' is-today' : ''}`,
        style: `height:${totalHeight}px;`,
        dataset: { date: fmtDateInput(day) },
      });

      const laidOut = layoutForDay(segmentsForDay(day));
      totalEvents += laidOut.length;
      laidOut.forEach((ev) => col.appendChild(renderEventNode(ev, totalHeight)));

      col.addEventListener('click', (ev) => onDayColClick(ev, col, day));
      body.appendChild(col);
    });

    grid.appendChild(body);
    updateNowLine();

    qs('#agenda-empty')?.remove();
    if (totalEvents === 0) {
      grid.insertAdjacentElement('afterend', el('p', {
        id: 'agenda-empty', class: 'text-center text-sm text-ink/45 py-3',
        text: state.filterStatus || state.filterProfessional
          ? 'Sin reservas que coincidan con el filtro en este rango.'
          : 'Sin reservas ni bloqueos en este rango.',
      }));
    }
  }

  function renderEventNode(ev, totalHeight) {
    const bandStart = HOUR_START * 60;
    const bandEnd = HOUR_END * 60;
    const entirelyBefore = ev.endMin <= bandStart;
    const entirelyAfter = ev.startMin >= bandEnd;
    const clampedStart = entirelyBefore ? bandStart : entirelyAfter ? bandEnd : Math.max(ev.startMin, bandStart);
    const clampedEnd = entirelyBefore ? bandStart : entirelyAfter ? bandEnd : Math.min(ev.endMin, bandEnd);

    const rawTop = ((clampedStart - bandStart) / 60) * HOUR_H;
    const height = Math.max(18, ((clampedEnd - clampedStart) / 60) * HOUR_H);
    const top = Math.min(Math.max(rawTop, 0), totalHeight - height);

    const width = 100 / ev._laneCount;
    const left = ev._lane * width;
    const clippedTop = ev.continuesBefore || ev.startMin < bandStart;
    const clippedBottom = ev.continuesAfter || ev.endMin > bandEnd;
    const clipClass = `${clippedTop ? ' is-clipped-top' : ''}${clippedBottom ? ' is-clipped-bottom' : ''}`;
    const style = `top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);`;
    const timeRange = `${fmtTimeInput(ev.realStart)}–${fmtTimeInput(ev.realEnd)}`;

    if (ev.kind === 'block') {
      const node = el('div', {
        class: `agenda-event is-block${clipClass}`, style, tabindex: '0', role: 'button',
        'aria-label': `Bloqueo: ${ev.raw.label || 'sin motivo'}, ${timeRange}`,
        title: `Bloqueado · ${ev.raw.label || 'sin motivo'} · ${timeRange}`,
      }, [
        el('strong', { text: `🔒 ${ev.raw.label || 'Bloqueado'}` }),
        el('span', { text: timeRange }),
      ]);
      const open = (e) => { e.stopPropagation(); confirmDeleteBlock(ev.raw); };
      node.addEventListener('click', open);
      node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
      return node;
    }

    const s = STATUS[ev.raw.status] || STATUS.reservado;
    const node = el('div', {
      class: `agenda-event${clipClass}`, style: `${style}background:${s.bg};color:${s.text};`,
      tabindex: '0', role: 'button',
      'aria-label': `Reserva de ${ev.raw.client_name}, ${s.label}, ${timeRange}`,
      title: `${ev.raw.client_name} · ${s.label} · ${timeRange}`,
    }, [
      el('strong', { text: ev.raw.client_name }),
      el('span', { text: `${fmtTimeInput(ev.realStart)} · ${s.label}${ev.raw.service_name ? ` · ${ev.raw.service_name}` : ''}` }),
    ]);
    const open = (e) => { e.stopPropagation(); openApptModal({ editing: ev.raw }); };
    node.addEventListener('click', open);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } });
    return node;
  }

  /* --- Línea de "ahora" en tiempo real ---------------------------------------- */

  function updateNowLine() {
    qsa('.agenda-now-line').forEach((n) => n.remove());
    if (App.state.view !== 'agenda') return;
    const now = new Date();
    if (now.getHours() < HOUR_START || now.getHours() >= HOUR_END) return;
    const col = qs(`.agenda-day-col[data-date="${fmtDateInput(now)}"]`);
    if (!col) return;
    const top = ((minutesOfDay(now) - HOUR_START * 60) / 60) * HOUR_H;
    col.appendChild(el('div', { class: 'agenda-now-line', style: `top:${top}px;`, 'data-time': fmtTimeInput(now) }));
  }

  /* --- "+ Agregar" al hacer clic en celda vacía -------------------------------- */

  function closePopover() {
    if (state.popover) { state.popover.remove(); state.popover = null; }
  }

  function onDayColClick(ev, col, day) {
    if (ev.target.closest('.agenda-event')) return;
    closePopover();

    const rect = col.getBoundingClientRect();
    const offsetY = ev.clientY - rect.top;
    const minutesFromStart = HOUR_START * 60 + (offsetY / HOUR_H) * 60;
    const snapped = Math.round(minutesFromStart / 30) * 30;
    const clicked = new Date(day);
    clicked.setHours(0, snapped, 0, 0);

    const pop = el('div', {
      class: 'agenda-add-popover',
      style: `top:${Math.max(0, offsetY - 4)}px;left:6px;`,
    }, [
      el('button', { type: 'button', html: '<i class="fa-solid fa-calendar-plus"></i> Reserva' }),
      el('button', { type: 'button', html: '<i class="fa-solid fa-ban"></i> Bloquear horario' }),
    ]);
    pop.children[0].addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover();
      openApptModal({ date: clicked });
    });
    pop.children[1].addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover();
      openBlockModal({ date: clicked });
    });
    col.appendChild(pop);
    state.popover = pop;
  }

  document.addEventListener('click', (ev) => {
    if (state.popover && !ev.target.closest('.agenda-add-popover') && !ev.target.closest('.agenda-day-col')) closePopover();
  });

  /* --- Modal: Bloqueo de horas ------------------------------------------------- */

  function openModalEl(id) { qs(id).classList.add('open'); }
  function closeModalEl(id) { qs(id).classList.remove('open'); }

  function openBlockModal({ date } = {}) {
    qs('#block-label').value = '';
    qs('#block-error').classList.remove('show');
    fillSelect(qs('#block-professional'), state.professionals);
    if (state.filterProfessional) qs('#block-professional').value = state.filterProfessional;

    const start = date || roundedNow();
    const end = new Date(start.getTime() + 60 * 60000);
    qs('#block-start-date').value = fmtDateInput(start);
    qs('#block-start-time').value = fmtTimeInput(start);
    qs('#block-end-date').value = fmtDateInput(end);
    qs('#block-end-time').value = fmtTimeInput(end);
    openModalEl('#agenda-block-modal');
  }

  async function saveBlock() {
    const professionalId = qs('#block-professional').value;
    const startsAt = combineDateTime(qs('#block-start-date').value, qs('#block-start-time').value);
    const endsAt = combineDateTime(qs('#block-end-date').value, qs('#block-end-time').value);
    const errorEl = qs('#block-error');
    errorEl.classList.remove('show');

    if (!professionalId) { App.setError(qs('#block-professional'), true); return; }
    App.setError(qs('#block-professional'), false);
    if (endsAt <= startsAt) {
      errorEl.textContent = 'La hora de fin debe ser posterior a la de inicio.';
      errorEl.classList.add('show');
      return;
    }

    await withBusy(qs('#block-save'), async () => {
      try {
        await App.session.api('/agenda/blocks', {
          method: 'POST',
          body: { professionalId, label: qs('#block-label').value.trim(), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
        });
        closeModalEl('#agenda-block-modal');
        toast('Horario bloqueado', 'ok');
        loadEvents();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.classList.add('show');
      }
    }, 'Guardando…');
  }

  async function confirmDeleteBlock(block) {
    const ok = await confirmModal('Quitar bloqueo', `¿Quitar el bloqueo "${escapeHtml(block.label || 'sin motivo')}"? Ese horario volverá a estar disponible.`, { confirmText: 'Quitar', danger: true });
    if (!ok) return;
    await App.session.api(`/agenda/blocks/${block.id}`, { method: 'DELETE' });
    toast('Bloqueo eliminado', 'ok');
    loadEvents();
  }

  /* --- Modal: Nueva Reserva / Editar reserva ----------------------------------- */

  function roundedNow() {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() % 30 === 0 ? d.getMinutes() : d.getMinutes() + (30 - d.getMinutes() % 30));
    return d;
  }

  function fillStatusSelect() {
    const select = qs('#appt-status');
    select.innerHTML = '';
    STATUS_ORDER.forEach((key) => select.appendChild(el('option', { value: key, text: STATUS[key].label })));
  }

  function setSelectedClient(client) {
    state.selectedClient = client;
    const line = qs('#appt-client-selected');
    if (client) {
      line.innerHTML = '';
      line.appendChild(el('span', { text: `Cliente: ${client.name}${client.phone ? ` · ${client.phone}` : ''} ` }));
      const clear = el('button', { type: 'button', class: 'font-bold text-accent-600', text: 'cambiar' });
      clear.addEventListener('click', () => { setSelectedClient(null); qs('#appt-client-search').value = ''; qs('#appt-client-search').focus(); });
      line.appendChild(clear);
      App.setError(qs('#appt-client-search'), false);
    } else {
      line.textContent = '';
    }
  }

  function openApptModal({ date, editing } = {}) {
    state.editingAppointmentId = editing ? editing.id : null;
    qs('#agenda-appt-title').textContent = editing ? 'Editar reserva' : 'Nueva Reserva';
    qs('#appt-delete').classList.toggle('hidden', !editing);
    qs('#appt-save-another').classList.toggle('hidden', !!editing);
    qs('#appt-repeat-toggle').closest('label').classList.toggle('hidden', !!editing);
    qs('#appt-repeat-toggle').checked = false;
    qs('#appt-repeat-weeks-wrap').classList.add('hidden');

    fillStatusSelect();
    fillSelect(qs('#appt-professional'), state.professionals);
    qs('#appt-client-results').classList.add('hidden');
    qs('#appt-new-client-form').classList.add('hidden');
    qs('#appt-client-search').value = '';
    ['appt-client-search', 'block-professional'].forEach((id) => App.setError(qs(`#${id}`), false));

    if (editing) {
      qs('#appt-status').value = editing.status;
      qs('#appt-date').value = fmtDateInput(new Date(editing.starts_at));
      qs('#appt-time').value = fmtTimeInput(new Date(editing.starts_at));
      qs('#appt-professional').value = editing.professional_id;
      qs('#appt-service').value = editing.service_id || '';
      setSelectedClient({ id: editing.client_id, name: editing.client_name, phone: editing.client_phone });
    } else {
      const start = date || roundedNow();
      qs('#appt-status').value = 'reservado';
      qs('#appt-date').value = fmtDateInput(start);
      qs('#appt-time').value = fmtTimeInput(start);
      if (state.filterProfessional) qs('#appt-professional').value = state.filterProfessional;
      qs('#appt-service').value = '';
      setSelectedClient(null);
    }
    openModalEl('#agenda-appt-modal');
  }

  function closeApptModal() { closeModalEl('#agenda-appt-modal'); }

  function apptDuration() {
    const service = state.services.find((s) => s.id === qs('#appt-service').value);
    return service ? service.duration_min : 30;
  }

  async function submitAppointment() {
    if (!state.selectedClient) { App.setError(qs('#appt-client-search'), true); return false; }
    App.setError(qs('#appt-client-search'), false);

    const startsAt = combineDateTime(qs('#appt-date').value, qs('#appt-time').value);
    const endsAt = new Date(startsAt.getTime() + apptDuration() * 60000);
    const professionalId = qs('#appt-professional').value;
    const body = {
      professionalId,
      clientId: state.selectedClient.id,
      serviceId: qs('#appt-service').value || null,
      status: qs('#appt-status').value,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    if (!editingNow() && qs('#appt-repeat-toggle').checked) {
      body.repeatWeeks = Math.min(Math.max(Number(qs('#appt-repeat-weeks').value) || 1, 1), 12);
    }

    try {
      if (editingNow()) {
        await App.session.api(`/agenda/appointments/${state.editingAppointmentId}`, { method: 'PUT', body });
      } else {
        await App.session.api('/agenda/appointments', { method: 'POST', body });
      }
      return true;
    } catch (err) {
      toast(err.message, 'err');
      return false;
    }
  }

  const editingNow = () => !!state.editingAppointmentId;

  async function deleteAppointment() {
    if (!editingNow()) return;
    const ok = await confirmModal('Eliminar reserva', '¿Eliminar esta reserva? Esta acción no se puede deshacer.', { confirmText: 'Eliminar', danger: true });
    if (!ok) return;
    await App.session.api(`/agenda/appointments/${state.editingAppointmentId}`, { method: 'DELETE' });
    closeApptModal();
    toast('Reserva eliminada', 'ok');
    loadEvents();
  }

  /* --- Buscador de clientes ---------------------------------------------------- */

  function initClientSearch() {
    let t;
    const input = qs('#appt-client-search');
    const results = qs('#appt-client-results');

    input.addEventListener('input', () => {
      setSelectedClient(null);
      clearTimeout(t);
      const q = input.value.trim();
      if (!q) { results.classList.add('hidden'); return; }
      t = setTimeout(async () => {
        try {
          const { clients, hasMore } = await App.session.api(`/agenda/clients?q=${encodeURIComponent(q)}`);
          results.innerHTML = '';
          if (!clients.length) {
            results.appendChild(el('div', { class: 'px-3 py-2 text-sm text-ink/45', text: 'Sin resultados — crea uno nuevo.' }));
          } else {
            clients.forEach((c) => {
              const btn = el('button', { type: 'button', text: `${c.name}${c.phone ? ` · ${c.phone}` : ''}` });
              btn.addEventListener('click', () => {
                setSelectedClient(c);
                results.classList.add('hidden');
                input.value = '';
              });
              results.appendChild(btn);
            });
            if (hasMore) {
              results.appendChild(el('div', {
                class: 'px-3 py-2 text-xs text-ink/40 border-t border-line-soft',
                text: 'Hay más resultados — sigue escribiendo para afinar la búsqueda.',
              }));
            }
          }
          results.classList.remove('hidden');
        } catch (err) { toast(err.message, 'err'); }
      }, 220);
    });

    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#appt-client-search') && !ev.target.closest('#appt-client-results')) results.classList.add('hidden');
    });

    qs('#appt-new-client-toggle').addEventListener('click', () => {
      qs('#appt-new-client-form').classList.toggle('hidden');
      qs('#new-client-name').value = input.value.trim();
    });

    qs('#new-client-save').addEventListener('click', async () => {
      const name = qs('#new-client-name').value.trim();
      if (!name) { toast('Escribe el nombre del cliente', 'err'); return; }
      await withBusy(qs('#new-client-save'), async () => {
        try {
          const client = await App.session.api('/agenda/clients', {
            method: 'POST',
            body: { name, phone: qs('#new-client-phone').value.trim(), email: qs('#new-client-email').value.trim() },
          });
          setSelectedClient(client);
          qs('#appt-new-client-form').classList.add('hidden');
          ['new-client-name', 'new-client-phone', 'new-client-email'].forEach((id) => { qs(`#${id}`).value = ''; });
          toast('Cliente creado', 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Creando…');
    });
  }

  /* --- Gestión de profesionales / servicios: alta, edición, baja -------------- */

  function manageRow({ item, kind, onSaved, onDeleted }) {
    const nameInput = el('input', { class: 'input flex-1 !py-1.5 !text-sm', value: item.name });
    const activeInput = el('input', { type: 'checkbox', class: 'h-4 w-4' });
    activeInput.checked = item.active;
    const saveBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Guardar', html: '<i class="fa-solid fa-check"></i>' });
    const children = [
      nameInput,
      el('label', { class: 'flex items-center gap-1.5 text-xs font-semibold text-ink/60 flex-none whitespace-nowrap' }, [activeInput, el('span', { text: 'Activo' })]),
      saveBtn,
    ];

    if (kind === 'services') {
      const durationInput = el('input', { type: 'number', min: '5', max: '480', class: 'input !w-16 !py-1.5 !text-sm flex-none', value: String(item.duration_min) });
      children.splice(1, 0, durationInput);
      saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
        try {
          const updated = await App.session.api(`/agenda/services/${item.id}`, {
            method: 'PUT', body: { name: nameInput.value.trim(), active: activeInput.checked, durationMin: Number(durationInput.value) || 30 },
          });
          Object.assign(item, updated);
          toast('Servicio actualizado', 'ok');
          onSaved?.();
        } catch (e) { toast(e.message, 'err'); }
      }));
      const delBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Eliminar', html: '<i class="fa-solid fa-trash text-red-500"></i>' });
      delBtn.addEventListener('click', () => withBusy(delBtn, async () => {
        // Confirmación nativa: el modal genérico de la app es un único elemento
        // compartido y no admite anidar otro modal encima de este panel.
        if (!window.confirm(`¿Eliminar el servicio "${item.name}"? Las citas que ya lo usan no se ven afectadas.`)) return;
        try {
          await App.session.api(`/agenda/services/${item.id}`, { method: 'DELETE' });
          toast('Servicio eliminado', 'ok');
          onDeleted?.();
        } catch (e) { toast(e.message, 'err'); }
      }));
      children.push(delBtn);
    } else {
      saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
        try {
          const updated = await App.session.api(`/agenda/professionals/${item.id}`, {
            method: 'PUT', body: { name: nameInput.value.trim(), active: activeInput.checked },
          });
          Object.assign(item, updated);
          toast('Profesional actualizado', 'ok');
          onSaved?.();
        } catch (e) { toast(e.message, 'err'); }
      }));
    }

    return el('div', { class: 'flex items-center gap-2 p-2 rounded-lg border border-line-soft' }, children);
  }

  async function openManage(kind) {
    const isServices = kind === 'services';
    let items = isServices ? state.services : state.professionals;
    const list = el('div', { class: 'space-y-2 max-h-[20rem] overflow-y-auto scroll-thin' });
    const reloadAndRender = async () => {
      isServices ? await loadServices() : await loadProfessionals();
      items = isServices ? state.services : state.professionals;
      renderRows();
    };
    const renderRows = () => {
      list.innerHTML = '';
      if (!items.length) list.appendChild(el('p', { class: 'text-sm text-ink/45 text-center py-4', text: 'Todavía no hay ninguno.' }));
      items.forEach((item) => list.appendChild(manageRow({
        item, kind,
        onSaved: () => {},
        onDeleted: reloadAndRender,
      })));
    };
    renderRows();

    const newName = el('input', { class: 'input flex-1', placeholder: isServices ? 'Nuevo servicio' : 'Nuevo profesional' });
    const newDuration = isServices ? el('input', { type: 'number', min: '5', max: '480', class: 'input !w-16 flex-none', value: '30' }) : null;
    const addBtn = el('button', { type: 'button', class: 'btn btn-primary btn-sm flex-none', html: '<i class="fa-solid fa-plus"></i> Agregar' });
    addBtn.addEventListener('click', () => withBusy(addBtn, async () => {
      const name = newName.value.trim();
      if (!name) { toast('Escribe un nombre', 'err'); return; }
      try {
        if (isServices) {
          await App.session.api('/agenda/services', { method: 'POST', body: { name, durationMin: Number(newDuration.value) || 30 } });
        } else {
          await App.session.api('/agenda/professionals', { method: 'POST', body: { name } });
        }
        newName.value = '';
        toast(isServices ? 'Servicio agregado' : 'Profesional agregado', 'ok');
        await reloadAndRender();
      } catch (e) { toast(e.message, 'err'); }
    }));

    const body = el('div', { class: 'space-y-3' }, [
      list,
      el('div', { class: 'flex items-center gap-2 pt-2 border-t border-line-soft' }, [newName, newDuration, addBtn].filter(Boolean)),
    ]);

    await App.modal({
      title: isServices ? 'Servicios' : 'Profesionales',
      icon: isServices ? 'fa-briefcase' : 'fa-user-gear',
      body, hideCancel: true, confirmText: 'Cerrar',
      onConfirm: () => true,
    });
  }

  /* --- Init --------------------------------------------------------------- */

  function init() {
    renderLegend();
    fillStatusSelect();
    initClientSearch();

    qsa('.agenda-mode-btn').forEach((btn) => btn.addEventListener('click', () => {
      qsa('.agenda-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
      state.mode = btn.dataset.mode;
      loadEvents();
    }));

    // En pantallas angostas la semana no cabe (7 columnas): arranca en modo Día.
    if (window.innerWidth < 640) {
      state.mode = 'day';
      const dayBtn = qs('.agenda-mode-btn[data-mode="day"]');
      qsa('.agenda-mode-btn').forEach((b) => b.classList.toggle('active', b === dayBtn));
    }

    qs('#agenda-prev').addEventListener('click', () => {
      state.anchor = addDays(state.anchor, state.mode === 'day' ? -1 : -7);
      loadEvents();
    });
    qs('#agenda-next').addEventListener('click', () => {
      state.anchor = addDays(state.anchor, state.mode === 'day' ? 1 : 7);
      loadEvents();
    });
    qs('#agenda-today').addEventListener('click', () => { state.anchor = startOfDay(new Date()); loadEvents(); });
    qs('#agenda-refresh').addEventListener('click', (ev) => withBusy(ev.currentTarget, loadEvents, 'Actualizando…'));
    qs('#agenda-new').addEventListener('click', () => openApptModal({}));

    qs('#agenda-mini-prev').addEventListener('click', () => { state.miniMonth = addMonths(state.miniMonth, -1); renderMiniCalendar(); });
    qs('#agenda-mini-next').addEventListener('click', () => { state.miniMonth = addMonths(state.miniMonth, 1); renderMiniCalendar(); });

    qs('#agenda-professional-filter').addEventListener('change', (ev) => { state.filterProfessional = ev.target.value; loadEvents(); });
    qs('#agenda-status-filter').addEventListener('change', (ev) => { state.filterStatus = ev.target.value; loadEvents(); });

    qs('#agenda-add-professional').addEventListener('click', () => openManage('professionals').catch((e) => toast(e.message, 'err')));
    qs('#agenda-add-service').addEventListener('click', () => openManage('services').catch((e) => toast(e.message, 'err')));

    // Modal de bloqueo
    qsa('[data-close-agenda-block]').forEach((b) => b.addEventListener('click', () => closeModalEl('#agenda-block-modal')));
    qs('#agenda-block-modal').addEventListener('click', (ev) => { if (ev.target.id === 'agenda-block-modal') closeModalEl('#agenda-block-modal'); });
    qs('#block-save').addEventListener('click', () => saveBlock());

    // Modal de reserva
    qsa('[data-close-agenda-appt]').forEach((b) => b.addEventListener('click', closeApptModal));
    qs('#agenda-appt-modal').addEventListener('click', (ev) => { if (ev.target.id === 'agenda-appt-modal') closeApptModal(); });
    qs('#appt-repeat-toggle').addEventListener('change', (ev) => qs('#appt-repeat-weeks-wrap').classList.toggle('hidden', !ev.target.checked));
    qs('#appt-delete').addEventListener('click', () => deleteAppointment());

    qs('#appt-save').addEventListener('click', () => withBusy(qs('#appt-save'), async () => {
      if (!(await submitAppointment())) return;
      closeApptModal();
      toast(editingNow() ? 'Reserva actualizada' : 'Reserva guardada', 'ok');
      loadEvents();
    }, 'Guardando…'));

    qs('#appt-save-another').addEventListener('click', () => withBusy(qs('#appt-save-another'), async () => {
      if (!(await submitAppointment())) return;
      toast('Reserva guardada — agrega la siguiente', 'ok');
      setSelectedClient(null);
      qs('#appt-client-search').value = '';
      loadEvents();
    }, 'Guardando…'));

    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (qs('#agenda-appt-modal').classList.contains('open')) closeApptModal();
      else if (qs('#agenda-block-modal').classList.contains('open')) closeModalEl('#agenda-block-modal');
    });

    // Línea de "ahora": se reposiciona sola, sin recargar todo el grid
    setInterval(updateNowLine, 30000);

    App.onView('agenda', async () => {
      try {
        await Promise.all([loadProfessionals(), loadServices()]);
        await loadEvents();
      } catch (err) {
        if (err.status === 401) { App.session.goToLogin('/dashboard.html#agenda'); return; }
        toast(err.message, 'err');
      }
    });
  }

  App.agenda = { init };

})(window.Elorai);
