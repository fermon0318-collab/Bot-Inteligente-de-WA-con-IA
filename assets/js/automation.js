/* ============================================================================
   Elorai — Archivos, Flujos (simples y avanzados), Remarketing y Disparadores
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el } = App;

  /* ========================================================================
     Editor de pasos (compartido por Flujos Simples y Remarketing)
     ===================================================================== */
  const STEP_META = {
    text: { label: 'Mensaje de texto', icon: 'fa-comment', klass: '' },
    file: { label: 'Enviar archivo', icon: 'fa-paperclip', klass: 'ok' },
    delay: { label: 'Pausa', icon: 'fa-stopwatch', klass: 'warn' },
  };

  function createStepEditor(containerSel, emptySel, getSteps) {
    const container = qs(containerSel);
    const empty = qs(emptySel);

    function render() {
      const steps = getSteps();
      container.innerHTML = '';
      empty.classList.toggle('hidden', steps.length > 0);

      steps.forEach((step, index) => {
        const meta = STEP_META[step.type];
        let control;

        if (step.type === 'text') {
          control = el('textarea', { class: 'textarea !min-h-[4.5rem] !text-sm', placeholder: 'Escribe el mensaje que enviará el bot…' });
          control.value = step.value;
        } else if (step.type === 'file') {
          control = el('select', { class: 'select' });
          control.appendChild(el('option', { value: '', text: '— Selecciona un archivo —' }));
          App.MEDIA.forEach((m) => control.appendChild(el('option', { value: m.name, text: m.name })));
          control.value = step.value || '';
        } else {
          control = el('input', { type: 'number', class: 'input', min: '1', max: '3600', placeholder: 'Segundos' });
          control.value = step.value;
        }
        control.addEventListener('input', () => { step.value = control.value; });
        control.addEventListener('change', () => { step.value = control.value; });

        const up = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', html: '<i class="fa-solid fa-arrow-up"></i>', disabled: index === 0, 'aria-label': 'Subir paso' });
        const down = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', html: '<i class="fa-solid fa-arrow-down"></i>', disabled: index === steps.length - 1, 'aria-label': 'Bajar paso' });
        const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm !text-red-600', html: '<i class="fa-solid fa-trash"></i>', 'aria-label': 'Eliminar paso' });

        up.addEventListener('click', () => { steps.splice(index - 1, 0, steps.splice(index, 1)[0]); render(); });
        down.addEventListener('click', () => { steps.splice(index + 1, 0, steps.splice(index, 1)[0]); render(); });
        del.addEventListener('click', () => { steps.splice(index, 1); render(); });

        container.appendChild(el('div', { class: 'step-card' }, [
          el('span', { class: `icon-badge sm ${meta.klass}` }, el('i', { class: `fa-solid ${meta.icon}` })),
          el('div', { class: 'flex-1 min-w-0' }, [
            el('div', { class: 'flex items-center gap-2 mb-2' }, [
              el('span', { class: 'text-xs font-extrabold uppercase tracking-wide text-ink/50', text: `Paso ${index + 1} · ${meta.label}` }),
              el('span', { class: 'ml-auto flex gap-1' }, [up, down, del]),
            ]),
            control,
            step.type === 'delay' ? el('p', { class: 'hint', text: 'Tiempo de espera antes del siguiente paso.' }) : null,
          ]),
        ]));
      });
    }

    function add(type) {
      getSteps().push({ type, value: type === 'delay' ? '5' : '' });
      render();
      container.lastElementChild.querySelector('textarea, select, input').focus();
    }

    return { render, add };
  }

  /* ========================================================================
     Archivos (Media)
     ===================================================================== */
  const FILE_ICONS = {
    pdf: ['fa-file-pdf', 'danger'], image: ['fa-file-image', ''],
    video: ['fa-file-video', 'warn'], audio: ['fa-file-audio', 'ok'], other: ['fa-file', ''],
  };

  function detectType(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'webm'].includes(ext)) return 'video';
    if (['mp3', 'ogg', 'wav', 'm4a'].includes(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    return 'other';
  }

  function renderMedia() {
    const grid = qs('#media-grid');
    grid.innerHTML = '';
    qs('#media-empty').classList.toggle('hidden', App.MEDIA.length > 0);
    qs('#media-count').textContent = App.MEDIA.length;

    App.MEDIA.forEach((m) => {
      const [icon, klass] = FILE_ICONS[m.type] || FILE_ICONS.other;
      const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm !text-red-600', html: '<i class="fa-solid fa-trash"></i>', 'aria-label': `Eliminar ${m.name}` });
      del.addEventListener('click', async () => {
        const ok = await App.confirmModal('Eliminar archivo',
          `Se eliminará <strong>${App.escapeHtml(m.name)}</strong>. Los flujos que lo usen dejarán de enviarlo.`,
          { confirmText: 'Eliminar', danger: true, icon: 'fa-trash' });
        if (!ok) return;
        try {
          await App.session.api(`/media/${m.id}`, { method: 'DELETE' });
          const i = App.MEDIA.indexOf(m);
          if (i >= 0) App.MEDIA.splice(i, 1);
          renderMedia();
          App.toast('Archivo eliminado', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });

      grid.appendChild(el('div', { class: 'card card-hover p-3.5' }, [
        el('div', { class: 'flex items-start gap-3' }, [
          el('span', { class: `icon-badge ${klass}` }, el('i', { class: `fa-solid ${icon}` })),
          el('div', { class: 'min-w-0 flex-1' }, [
            el('p', { class: 'text-sm font-bold text-ink truncate', title: m.name, text: m.name }),
            el('p', { class: 'text-xs text-ink/50', text: `${App.fileSize(m.size)} · ${m.at}` }),
          ]),
        ]),
        el('div', { class: 'flex gap-1 mt-3' }, [
          el('button', { type: 'button', class: 'btn btn-soft btn-sm flex-1', html: '<i class="fa-regular fa-copy"></i> Copiar nombre',
            onclick: async () => { await App.copyText(m.name); App.toast('Nombre copiado', 'ok'); } }),
          del,
        ]),
      ]));
    });
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const form = new FormData();
    files.forEach((f) => form.append('files', f));

    App.toast(`Subiendo ${files.length} archivo(s)…`, 'info');

    try {
      const res = await fetch('/api/media', {
        method: 'POST', credentials: 'same-origin', body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'No se pudo subir');

      data.rejected?.forEach((r) => App.toast(`${r.name}: ${r.reason}`, 'err', 6000));
      if (data.saved?.length) App.toast(`${data.saved.length} archivo(s) subidos`, 'ok');

      await loadMedia();
    } catch (err) {
      App.toast(err.message, 'err');
    }
  }

  async function loadMedia() {
    const files = await App.session.api('/media');
    App.MEDIA.length = 0;
    App.MEDIA.push(...files.map((f) => ({
      id: f.id, name: f.name, type: f.type, size: f.size, at: f.at.slice(0, 10),
    })));
    renderMedia();
  }

  function initMedia() {
    loadMedia().catch(() => renderMedia());
    const zone = qs('#media-dropzone');
    const input = qs('#media-input');

    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); } });
    input.addEventListener('change', (ev) => { uploadFiles(ev.target.files); ev.target.value = ''; });

    ['dragenter', 'dragover'].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.remove('drag'); }));
    zone.addEventListener('drop', (ev) => uploadFiles(ev.dataTransfer.files));
  }

  /* ========================================================================
     Flujos simples
     ===================================================================== */
  let sfCurrent = null;
  let sfEditor = null;

  function refreshFlowSelects() {
    const sel = qs('#sf-select');
    const keep = sel.value;
    sel.innerHTML = '';
    App.SIMPLE_FLOWS.forEach((f) => sel.appendChild(el('option', { value: f.id, text: f.name })));
    if (App.SIMPLE_FLOWS.some((f) => f.id === keep)) sel.value = keep;

    App.fillFlowSelect(qs('#trig-flow'));
    App.fillFlowSelect(qs('#pay-postflow'), true);
  }

  function loadSimpleFlow(id) {
    sfCurrent = App.SIMPLE_FLOWS.find((f) => f.id === id) || App.SIMPLE_FLOWS[0] || null;
    qs('#sf-select').value = sfCurrent ? sfCurrent.id : '';
    sfEditor.render();
  }

  function initSimpleFlows() {
    sfEditor = createStepEditor('#sf-steps', '#sf-empty', () => (sfCurrent ? sfCurrent.steps : []));
    refreshFlowSelects();
    loadSimpleFlow(App.SIMPLE_FLOWS[0] && App.SIMPLE_FLOWS[0].id);

    qs('#sf-select').addEventListener('change', (ev) => loadSimpleFlow(ev.target.value));
    qsa('[data-sf-add]').forEach((b) => b.addEventListener('click', () => {
      if (!sfCurrent) { App.toast('Crea un flujo primero', 'warn'); return; }
      sfEditor.add(b.dataset.sfAdd);
    }));

    qs('#sf-new').addEventListener('click', async () => {
      const name = await App.promptModal('Crear flujo simple', 'Nombre del flujo', '', { placeholder: 'Ej. Recordatorio de pago' });
      if (!name) return;
      const flow = { id: 'sf_' + Date.now(), name, steps: [] };
      App.SIMPLE_FLOWS.push(flow);
      refreshFlowSelects();
      loadSimpleFlow(flow.id);
      App.toast(`Flujo "${name}" creado`, 'ok');
    });

    qs('#sf-delete').addEventListener('click', async () => {
      if (!sfCurrent) return;
      const ok = await App.confirmModal('Eliminar flujo',
        `Se eliminará el flujo <strong>${App.escapeHtml(sfCurrent.name)}</strong> y sus ${sfCurrent.steps.length} paso(s). Los disparadores que lo usen quedarán sin destino.`,
        { confirmText: 'Eliminar', danger: true, icon: 'fa-trash' });
      if (!ok) return;
      const i = App.SIMPLE_FLOWS.indexOf(sfCurrent);
      App.SIMPLE_FLOWS.splice(i, 1);
      refreshFlowSelects();
      loadSimpleFlow(App.SIMPLE_FLOWS[0] && App.SIMPLE_FLOWS[0].id);
      App.toast('Flujo eliminado', 'ok');
    });

    qs('#sf-save').addEventListener('click', (ev) => {
      if (!sfCurrent) return;
      const invalid = sfCurrent.steps.find((s) => !String(s.value || '').trim());
      if (invalid) { App.toast('Hay pasos vacíos: complétalos antes de guardar', 'err'); return; }
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(700);
        App.toast(`Flujo "${sfCurrent.name}" guardado`, 'ok');
      }, 'Guardando…');
    });
  }

  /* ========================================================================
     Flujos avanzados
     ===================================================================== */
  const NODE_STYLE = {
    start: ['node-h-ok', 'fa-play'],
    message: ['node-h-brand', 'fa-comment'],
    condition: ['node-h-plum', 'fa-code-branch'],
    action: ['node-h-brand', 'fa-bolt'],
    delay: ['node-h-warn', 'fa-stopwatch'],
  };

  let afCurrent = null;
  let afZoom = 1;

  function renderTree(node) {
    const [head, icon] = NODE_STYLE[node.kind] || NODE_STYLE.message;
    const card = el('div', { class: 'node' }, [
      el('div', { class: `node-head ${head}` }, [el('i', { class: `fa-solid ${icon}` }), el('span', { text: node.title })]),
      el('div', { class: 'node-body', text: node.text }),
    ]);

    const wrap = el('div', { class: 'flex flex-col items-start' }, card);
    if (node.children && node.children.length) {
      const connector = el('div', { class: 'w-px h-5 bg-accent-300 ml-8' });
      const branch = el('div', { class: 'branch space-y-4 py-1' });
      node.children.forEach((child) => branch.appendChild(renderTree(child)));
      wrap.append(connector, branch);
    }
    return wrap;
  }

  function renderGallery(filter = '') {
    const grid = qs('#af-gallery');
    const term = filter.trim().toLowerCase();
    grid.innerHTML = '';

    // Crear nuevo
    const createCard = el('button', { type: 'button', class: 'card card-hover p-4 text-left border-dashed !border-2 !border-accent-400' }, [
      el('span', { class: 'icon-badge mb-3' }, el('i', { class: 'fa-solid fa-plus' })),
      el('p', { class: 'text-sm font-extrabold text-ink', text: 'Crear flujo nuevo' }),
      el('p', { class: 'text-xs text-ink/50 mt-1', text: 'Empieza desde un lienzo en blanco' }),
    ]);
    createCard.addEventListener('click', createAdvancedFlow);

    const tplCard = el('button', { type: 'button', class: 'card card-hover p-4 text-left border-dashed !border-2 !border-accent-400' }, [
      el('span', { class: 'icon-badge' }, el('i', { class: 'fa-solid fa-file-import' })),
      el('p', { class: 'text-sm font-extrabold text-ink mt-3', text: 'Cargar template' }),
      el('p', { class: 'text-xs text-ink/50 mt-1', text: 'Parte de una estructura probada' }),
    ]);
    tplCard.addEventListener('click', loadTemplate);

    grid.append(createCard, tplCard);

    App.ADVANCED_FLOWS
      .filter((f) => !term || f.name.toLowerCase().includes(term))
      .forEach((f) => {
        const card = el('button', { type: 'button', class: 'card card-hover p-4 text-left' }, [
          el('div', { class: 'flex items-start gap-3' }, [
            el('span', { class: 'icon-badge' }, el('i', { class: 'fa-solid fa-diagram-project' })),
            el('div', { class: 'min-w-0' }, [
              el('p', { class: 'text-sm font-extrabold text-ink truncate', text: f.name }),
              el('p', { class: 'text-xs text-ink/50', text: `${f.nodes} nodos · actualizado ${f.updated}` }),
            ]),
          ]),
          el('span', { class: 'badge badge-brand mt-3', html: '<i class="fa-solid fa-pen"></i>Abrir editor' }),
        ]);
        card.addEventListener('click', () => openEditor(f.id));
        grid.appendChild(card);
      });
  }

  function openEditor(id) {
    afCurrent = App.ADVANCED_FLOWS.find((f) => f.id === id);
    if (!afCurrent) return;
    qs('#af-gallery-wrap').classList.add('hidden');
    qs('#af-editor').classList.remove('hidden');
    qs('#af-title').textContent = afCurrent.name;
    const stage = qs('#af-stage');
    stage.innerHTML = '';
    stage.appendChild(renderTree(afCurrent.tree));
    setZoom(1);
  }

  function setZoom(z) {
    afZoom = Math.min(1.8, Math.max(0.4, z));
    qs('#af-stage').style.transform = `scale(${afZoom})`;
    qs('#af-zoom-label').textContent = `${Math.round(afZoom * 100)}%`;
  }

  function fitToView() {
    const canvas = qs('#af-canvas');
    const stage = qs('#af-stage');
    stage.style.transform = 'scale(1)';
    const w = stage.scrollWidth;
    const h = stage.scrollHeight;
    if (!w || !h) return;
    setZoom(Math.min((canvas.clientWidth - 24) / w, (canvas.clientHeight - 24) / h, 1.8));
  }

  async function createAdvancedFlow() {
    const name = await App.promptModal('Crear flujo avanzado', 'Nombre del flujo', '', { placeholder: 'Ej. Recuperación de carrito' });
    if (!name) return;
    const flow = {
      id: 'af_' + Date.now(), name, updated: new Date().toISOString().slice(0, 10), nodes: 2,
      tree: {
        kind: 'start', title: 'Inicio', text: 'Punto de entrada del flujo',
        children: [{ kind: 'message', title: 'Primer mensaje', text: 'Edita este nodo para escribir tu mensaje', children: [] }],
      },
    };
    App.ADVANCED_FLOWS.push(flow);
    refreshFlowSelects();
    renderGallery(qs('#af-search').value);
    openEditor(flow.id);
    App.toast(`Flujo "${name}" creado`, 'ok');
  }

  async function loadTemplate() {
    const select = el('select', { class: 'select' });
    App.FLOW_TEMPLATES.forEach((t) => select.appendChild(el('option', { value: t.id, text: `${t.name} — ${t.desc}` })));
    const body = el('div', {}, [el('label', { class: 'label', text: 'Template' }), select]);
    const chosen = await App.modal({
      title: 'Cargar template', icon: 'fa-file-import', body, confirmText: 'Cargar',
      onConfirm: () => select.value,
    });
    if (!chosen) return;
    const tpl = App.FLOW_TEMPLATES.find((t) => t.id === chosen);
    const flow = {
      id: 'af_' + Date.now(), name: tpl.name, updated: new Date().toISOString().slice(0, 10), nodes: 5,
      tree: {
        kind: 'start', title: 'Inicio', text: tpl.desc,
        children: [{
          kind: 'message', title: 'Saludo', text: 'Mensaje inicial del template',
          children: [{
            kind: 'condition', title: 'Bifurcación', text: 'Define aquí tus condiciones',
            children: [
              { kind: 'message', title: 'Rama A', text: 'Respuesta para la primera opción', children: [] },
              { kind: 'message', title: 'Rama B', text: 'Respuesta para la segunda opción', children: [] },
            ],
          }],
        }],
      },
    };
    App.ADVANCED_FLOWS.push(flow);
    refreshFlowSelects();
    renderGallery();
    openEditor(flow.id);
    App.toast(`Template "${tpl.name}" cargado`, 'ok');
  }

  function initAdvancedFlows() {
    renderGallery();

    let t;
    qs('#af-search').addEventListener('input', (ev) => {
      clearTimeout(t);
      t = setTimeout(() => renderGallery(ev.target.value), 160);
    });

    qs('#af-back').addEventListener('click', () => {
      qs('#af-editor').classList.add('hidden');
      qs('#af-gallery-wrap').classList.remove('hidden');
      afCurrent = null;
    });

    qsa('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      const mode = b.dataset.zoom;
      if (mode === 'in') setZoom(afZoom + 0.15);
      else if (mode === 'out') setZoom(afZoom - 0.15);
      else if (mode === 'reset') setZoom(1);
      else fitToView();
    }));

    qs('#af-rename').addEventListener('click', async () => {
      if (!afCurrent) return;
      const name = await App.promptModal('Renombrar flujo', 'Nuevo nombre', afCurrent.name);
      if (!name) return;
      afCurrent.name = name;
      qs('#af-title').textContent = name;
      refreshFlowSelects();
      renderGallery(qs('#af-search').value);
      App.toast('Flujo renombrado', 'ok');
    });

    qs('#af-save').addEventListener('click', (ev) => {
      if (!afCurrent) return;
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(700);
        afCurrent.updated = new Date().toISOString().slice(0, 10);
        renderGallery(qs('#af-search').value);
        App.toast(`Flujo "${afCurrent.name}" guardado`, 'ok');
      }, 'Guardando…');
    });
  }

  /* ========================================================================
     Remarketing
     ===================================================================== */
  function initRemarketing() {
    const cfg = App.REMARKETING;
    const tz = qs('#rm-tz');
    App.TIMEZONES.forEach((z) => tz.appendChild(el('option', { value: z, text: z.replace(/_/g, ' ') })));
    tz.value = cfg.tz;
    qs('#rm-hours').value = cfg.hours;
    qs('#rm-minutes').value = cfg.minutes;
    qs('#rm-start').value = cfg.start;
    qs('#rm-end').value = cfg.end;

    const editor = createStepEditor('#rm-steps', '#rm-empty', () => cfg.steps);
    editor.render();
    qsa('[data-rm-add]').forEach((b) => b.addEventListener('click', () => editor.add(b.dataset.rmAdd)));

    qs('#rm-save').addEventListener('click', (ev) => {
      const hours = parseInt(qs('#rm-hours').value, 10) || 0;
      const minutes = parseInt(qs('#rm-minutes').value, 10) || 0;
      if (hours === 0 && minutes === 0) {
        App.setError(qs('#rm-hours'), true, 'Define un tiempo mayor a 0.');
        App.toast('El tiempo de disparo no puede ser cero', 'err');
        return;
      }
      App.setError(qs('#rm-hours'), false);

      if (qs('#rm-start').value >= qs('#rm-end').value) {
        App.toast('La hora de inicio debe ser anterior a la de fin', 'err');
        return;
      }
      if (!cfg.steps.length) { App.toast('Agrega al menos un paso a la secuencia', 'err'); return; }
      if (cfg.steps.some((s) => !String(s.value || '').trim())) { App.toast('Hay pasos vacíos: complétalos antes de guardar', 'err'); return; }

      Object.assign(cfg, {
        hours, minutes,
        start: qs('#rm-start').value, end: qs('#rm-end').value, tz: tz.value,
      });
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(750);
        App.toast(`Remarketing configurado a ${hours}h ${minutes}min del primer contacto`, 'ok');
      }, 'Guardando…');
    });
  }

  /* ========================================================================
     Disparadores
     ===================================================================== */
  let trigTab = 'simple';

  function trigList() { return App.TRIGGERS[trigTab]; }

  function renderTriggers() {
    const list = qs('#trig-list');
    const items = trigList();
    list.innerHTML = '';
    qs('#trig-empty').classList.toggle('hidden', items.length > 0);
    qs('#trig-count').textContent = items.length;
    qs('#trig-list-title').textContent = trigTab === 'simple' ? 'Disparadores activos' : 'Disparadores avanzados activos';

    items.forEach((t) => {
      const defBtn = el('button', {
        type: 'button',
        class: `btn btn-sm ${t.isDefault ? 'btn-gradient' : 'btn-ghost'}`,
        html: `<i class="fa-solid fa-star"></i> ${t.isDefault ? 'Predeterminado' : 'Hacer predeterminado'}`,
      });
      defBtn.addEventListener('click', () => {
        items.forEach((x) => { x.isDefault = false; });
        t.isDefault = true;
        renderTriggers();
        App.toast(`"${t.keyword}" es ahora el disparador predeterminado`, 'ok');
      });

      const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm !text-red-600', html: '<i class="fa-solid fa-trash"></i>', 'aria-label': 'Eliminar disparador' });
      del.addEventListener('click', async () => {
        const ok = await App.confirmModal('Eliminar disparador',
          `Se eliminará el disparador <strong>"${App.escapeHtml(t.keyword)}"</strong>.`,
          { confirmText: 'Eliminar', danger: true, icon: 'fa-trash' });
        if (!ok) return;
        items.splice(items.indexOf(t), 1);
        renderTriggers();
        App.toast('Disparador eliminado', 'ok');
      });

      list.appendChild(el('div', { class: 'step-card !items-center' }, [
        el('span', { class: 'icon-badge sm' }, el('i', { class: 'fa-solid fa-bolt' })),
        el('div', { class: 'flex-1 min-w-0' }, [
          el('p', { class: 'text-sm font-bold text-ink truncate', text: `"${t.keyword}"` }),
          el('p', { class: 'text-xs text-ink/50 truncate', html: `<i class="fa-solid fa-arrow-right-long"></i> ${App.escapeHtml(App.flowName(t.flow))}` }),
        ]),
        el('div', { class: 'flex items-center gap-1.5 flex-wrap justify-end' }, [defBtn, del]),
      ]));
    });
  }

  function initTriggers() {
    renderTriggers();

    qsa('[data-trig-tab]').forEach((btn) => btn.addEventListener('click', () => {
      trigTab = btn.dataset.trigTab;
      qs('#trig-tab-simple').className = `btn ${trigTab === 'simple' ? 'btn-soft' : 'btn-ghost'}`;
      qs('#trig-tab-advanced').className = `btn ${trigTab === 'advanced' ? 'btn-soft' : 'btn-ghost'}`;
      renderTriggers();
    }));

    qs('#trig-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const input = qs('#trig-keyword');
      const keyword = input.value.trim();
      if (!App.validate([{ input, test: App.notEmpty }])) return;

      if (trigList().some((t) => t.keyword.toLowerCase() === keyword.toLowerCase())) {
        App.setError(input, true, 'Ya existe un disparador con esa palabra clave.');
        App.toast('Esa palabra clave ya está en uso', 'err');
        return;
      }
      trigList().push({
        id: 'tg_' + Date.now(), keyword, flow: qs('#trig-flow').value,
        isDefault: trigList().length === 0,
      });
      input.value = '';
      renderTriggers();
      App.toast(`Disparador "${keyword}" agregado`, 'ok');
    });

    qs('#trig-save').addEventListener('click', (ev) => {
      App.withBusy(ev.currentTarget, async () => {
        await App.fakeRequest(700);
        App.toast('Disparadores guardados', 'ok');
      }, 'Guardando…');
    });
  }

  App.automation = {
    init() {
      initMedia();
      initSimpleFlows();
      initAdvancedFlows();
      initRemarketing();
      initTriggers();
    },
    createStepEditor,
    refreshFlowSelects,
  };

})(window.Elorai);
