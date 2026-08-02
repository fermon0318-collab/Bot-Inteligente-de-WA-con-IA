/* ============================================================================
   Elorai — Plantillas de WhatsApp

   Meta guarda las plantillas del lado de ellos y las identifica por su NOMBRE
   dentro de la cuenta de WhatsApp del negocio. Aquí no se crean: se registran
   las que el negocio ya aprobó allí, para poder elegirlas y rellenarlas desde
   el panel.
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, el, escapeHtml, toast } = App;

  let mias = [];

  /* --- Plantillas registradas ---------------------------------------------- */
  function renderMias() {
    const box = qs('#tpl-mine');
    box.innerHTML = '';
    qs('#tpl-count').textContent = mias.length;
    qs('#tpl-mine-empty').classList.toggle('hidden', mias.length > 0);

    mias.forEach((t) => {
      const borrar = el('button', {
        type: 'button', class: 'btn btn-ghost btn-icon text-red-600 hover:!text-red-700',
        html: '<i class="fa-solid fa-trash-can"></i>', title: 'Quitar',
      });
      borrar.addEventListener('click', () => quitar(t));

      box.appendChild(el('div', { class: 'flex items-start gap-3 p-3 rounded-xl border border-accent-200' }, [
        el('div', { class: 'flex-1 min-w-0' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
            el('span', { class: 'font-mono text-xs font-bold text-ink', text: t.name }),
            el('span', { class: `badge ${t.category === 'MARKETING' ? 'badge-warn' : 'badge-ok'}`,
              text: t.category === 'MARKETING' ? 'Promoción' : 'Utilidad' }),
            el('span', { class: 'badge badge-muted', text: t.language }),
          ]),
          el('p', { class: 'text-sm text-ink/70 mt-1 whitespace-pre-line', text: t.body }),
        ]),
        borrar,
      ]));
    });

    renderSelectorRecordatorio();
  }

  async function quitar(t) {
    const ok = await App.confirmModal('Quitar plantilla',
      `Se quita <strong>${escapeHtml(t.name)}</strong> del panel. La plantilla sigue existiendo en Meta — esto solo la saca de aquí.`,
      { confirmText: 'Quitar', danger: true });
    if (!ok) return;
    try {
      await App.session.api(`/templates/${t.id}`, { method: 'DELETE' });
      mias = mias.filter((x) => x.id !== t.id);
      renderMias();
      toast('Plantilla quitada', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* --- Catálogo listo para copiar ------------------------------------------ */
  function renderCatalogo() {
    const box = qs('#tpl-catalog');
    box.innerHTML = '';

    // Agrupadas por tema para que se puedan hojear
    const grupos = {};
    App.WA_TEMPLATE_CATALOG.forEach((t) => {
      (grupos[t.group] = grupos[t.group] || []).push(t);
    });

    Object.entries(grupos).forEach(([grupo, lista]) => {
      const items = lista.map((t) => {
        const registrada = mias.some((m) => m.name === t.name);

        const copiar = el('button', {
          type: 'button', class: 'btn btn-ghost !py-1 !px-2.5 !text-xs',
          html: '<i class="fa-regular fa-copy"></i> Copiar texto',
        });
        copiar.addEventListener('click', () => {
          App.copyText(t.body);
          toast('Texto copiado. Pégalo en Meta Business Manager.', 'ok');
        });

        const registrar = el('button', {
          type: 'button',
          class: `btn ${registrada ? 'btn-ghost' : 'btn-gradient'} !py-1 !px-2.5 !text-xs`,
          html: registrada
            ? '<i class="fa-solid fa-check"></i> Ya registrada'
            : '<i class="fa-solid fa-plus"></i> Ya la aprobé',
          disabled: registrada ? 'disabled' : null,
        });
        if (!registrada) registrar.addEventListener('click', () => registrar_(t));

        return el('div', { class: 'p-3 rounded-xl border border-accent-200' }, [
          el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
            el('span', { class: 'text-sm font-extrabold text-ink mr-auto', text: t.title }),
            el('span', { class: `badge ${t.category === 'MARKETING' ? 'badge-warn' : 'badge-ok'}`,
              text: t.category === 'MARKETING' ? 'Promoción' : 'Utilidad' }),
          ]),
          el('p', { class: 'text-xs text-ink/55 mt-0.5', text: t.desc }),
          el('p', { class: 'text-sm text-ink/80 bg-accent-50 rounded-lg p-2.5 mt-2 whitespace-pre-line', text: t.body }),
          el('p', { class: 'text-2xs text-ink/45 mt-1.5',
            text: `Nombre en Meta: ${t.name}${t.varLabels.length ? ` · Datos: ${t.varLabels.join(', ')}` : ''}` }),
          el('div', { class: 'flex gap-2 mt-2 flex-wrap' }, [copiar, registrar]),
        ]);
      });

      box.appendChild(el('div', {}, [
        el('p', { class: 'text-xs font-extrabold text-ink/50 uppercase tracking-wide mb-2', text: grupo }),
        el('div', { class: 'grid lg:grid-cols-2 gap-3' }, items),
      ]));
    });
  }

  /** Registra en el panel una plantilla del catálogo ya aprobada en Meta. */
  async function registrar_(t) {
    const ok = await App.confirmModal('¿Ya la aprobó Meta?',
      `Regístrala solo si <strong>${escapeHtml(t.name)}</strong> ya aparece como aprobada en tu WhatsApp Manager. ` +
      'Si aún no, el envío fallará porque Meta no la reconocerá.',
      { confirmText: 'Sí, ya está aprobada', icon: 'fa-circle-question' });
    if (!ok) return;

    try {
      const nueva = await App.session.api('/templates', {
        method: 'POST',
        body: { name: t.name, language: 'es', category: t.category, body: t.body, varLabels: t.varLabels },
      });
      mias = [...mias.filter((m) => m.id !== nueva.id), nueva].sort((a, b) => a.name.localeCompare(b.name));
      renderMias();
      renderCatalogo();
      toast('Plantilla registrada. Ya puedes usarla en Chat en Vivo.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* --- Recordatorios automáticos ------------------------------------------- */
  let recordatorio = { enabled: false, hours: 24, templateId: null };

  function renderSelectorRecordatorio() {
    const sel = qs('#tpl-reminder-template');
    if (!sel) return;
    const previo = recordatorio.templateId;
    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: mias.length ? 'Elige una plantilla…' : 'Registra una plantilla primero' }));
    mias.forEach((t) => sel.appendChild(el('option', { value: t.id, text: t.name })));
    if (previo && mias.some((t) => t.id === previo)) sel.value = previo;
  }

  async function cargarRecordatorio() {
    try {
      recordatorio = await App.session.api('/templates/reminder');
      qs('#tpl-reminder-on').checked = Boolean(recordatorio.enabled);
      qs('#tpl-reminder-hours').value = String(recordatorio.hours || 24);
      renderSelectorRecordatorio();
    } catch { /* sin sesión real: se queda con los valores por defecto */ }
  }

  async function guardarRecordatorio(ev) {
    const btn = ev.currentTarget;
    await App.withBusy(btn, async () => {
      try {
        const body = {
          enabled: qs('#tpl-reminder-on').checked,
          hours: Number(qs('#tpl-reminder-hours').value),
          templateId: qs('#tpl-reminder-template').value || null,
        };
        await App.session.api('/templates/reminder', { method: 'PUT', body });
        recordatorio = body;
        toast(body.enabled
          ? `Listo: se avisará ${body.hours} h antes de cada cita.`
          : 'Recordatorios desactivados.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }, 'Guardando…');
  }

  /* --- Carga --------------------------------------------------------------- */
  async function load() {
    try {
      mias = await App.session.api('/templates');
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'err');
      mias = [];
    }
    renderMias();
    renderCatalogo();
    await cargarRecordatorio();
  }

  function init() {
    qs('#tpl-reminder-save').addEventListener('click', guardarRecordatorio);
    App.onView('templates', load);
  }

  App.templates = { init, load };

})(window.Elorai);
