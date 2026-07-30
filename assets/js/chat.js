/* ============================================================================
   Elorai — Chat en Vivo e Histórico de Chats
   Ambas secciones comparten motor; se diferencian por opciones (IA / paginación).
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el } = App;

  const STATE_LABEL = {
    paid: ['Pagado', 'text-emerald-600'],
    pending: ['Pago pendiente', 'text-amber-600'],
    rejected: ['Pago rechazado', 'text-red-600'],
    new: ['Nuevo', 'text-ink/50'],
  };

  function createChatPanel(cfg) {
    const p = cfg.prefix;
    const id = (suffix) => qs(`#${p}-${suffix}`);

    const listPane = id('list-pane');
    const chatPane = id('chat-pane');
    const listBox = id('conversations');
    const msgBox = id('messages');

    let data = [];
    let total = 0;
    let current = null;
    let page = 1;
    const perPage = cfg.perPage || 0;
    let filter = '';

    /* --- Lista de conversaciones ---------------------------------------- */
    async function cargarConversaciones() {
      const rows = await App.session.api(
        `/conversations?scope=${cfg.scope}&page=${page}&perPage=${perPage || 20}`);
      data = rows.map((c) => ({
        id: c.id, name: c.name || c.phone, phone: c.phone, status: c.status,
        ad: c.adName, aiEnabled: c.aiEnabled, lastAt: c.lastAt,
        lastInboundAt: c.lastInboundAt,
        preview: c.preview || '', messages: null,
      }));
      // El endpoint no devuelve el total exacto: se estima por si la página vino llena
      total = page > 1 || rows.length === (perPage || 20) ? page * (perPage || 20) : rows.length;
      renderList();
    }

    function filtered() {
      const term = filter.trim().toLowerCase();
      if (!term) return data;
      return data.filter((c) =>
        c.name.toLowerCase().includes(term) ||
        c.phone.replace(/\s/g, '').includes(term.replace(/\s/g, '')));
    }

    function renderList() {
      const rows = filtered();

      listBox.innerHTML = '';
      if (!rows.length) {
        listBox.appendChild(el('div', { class: 'empty-state', html: '<i class="fa-regular fa-comments"></i>Sin conversaciones.' }));
      }

      rows.forEach((c) => {
        const [label] = STATE_LABEL[c.status] || STATE_LABEL.new;
        const btn = el('button', {
          type: 'button',
          class: `conv-item ${current && current.id === c.id ? 'active' : ''}`,
          dataset: { id: c.id },
        }, [
          el('span', { class: 'relative flex-none' },
            el('span', { class: 'avatar', text: App.initials(c.name) })),
          el('span', { class: 'min-w-0 flex-1' }, [
            el('span', { class: 'flex items-center gap-1.5' }, [
              el('span', { class: 'text-sm font-bold text-ink truncate flex-1', text: c.name }),
              el('span', { class: 'text-[0.68rem] text-ink/40 flex-none', text: App.timeAgo(c.lastAt) }),
            ]),
            el('span', { class: 'block text-xs text-ink/55 truncate', text: c.preview }),
            el('span', { class: 'flex items-center gap-1.5 mt-1' }, [
              el('span', { class: `badge ${c.status === 'paid' ? 'badge-ok' : c.status === 'pending' ? 'badge-warn' : c.status === 'rejected' ? 'badge-danger' : 'badge-muted'}`, text: label }),
              c.ad ? el('span', { class: 'badge badge-brand', html: '<i class="fa-solid fa-bullhorn"></i>Ad' }) : null,
            ]),
          ]),
        ]);
        btn.addEventListener('click', () => select(c.id));
        listBox.appendChild(btn);
      });

      if (cfg.countEl) qs(cfg.countEl).textContent = rows.length;
      if (perPage && qs(`#${p}-pager`)) {
        const pages = Math.max(1, Math.ceil(total / perPage));
        App.renderPager(qs(`#${p}-pager`), page, pages, (n) => { page = n; cargarConversaciones().catch((e) => App.toast(e.message, 'err')); });
      }
    }

    /**
     * Construye el adjunto de un mensaje: foto, video, audio o documento.
     *
     * El archivo se pide por id de mensaje (/api/messages/:id/media) porque la
     * ruta en disco nunca sale del servidor y esa ruta comprueba que el
     * mensaje sea de esta cuenta. Devuelve null si el mensaje no trae adjunto.
     */
    function mediaNode(m) {
      if (!m.hasMedia || !m.id) return null;
      const src = `/api/messages/${m.id}/media`;

      if (m.mediaType === 'image') {
        const img = el('img', { src, alt: m.mediaName || 'Imagen recibida', loading: 'lazy' });
        img.addEventListener('click', () => App.openMediaViewer(src));
        return el('div', { class: 'bubble-media' }, img);
      }

      if (m.mediaType === 'video') {
        return el('div', { class: 'bubble-media' },
          el('video', { src, controls: 'controls', preload: 'metadata' }));
      }

      if (m.mediaType === 'audio') {
        // preload="metadata" para que se vea la duración sin descargar el
        // audio entero de cada nota de voz del historial.
        return el('div', { class: 'bubble-media' },
          el('audio', { src, controls: 'controls', preload: 'metadata' }));
      }

      // pdf y cualquier otro documento
      return el('a', {
        class: 'bubble-doc', href: src, target: '_blank', rel: 'noopener',
      }, [
        el('i', { class: 'fa-solid fa-file-pdf' }),
        el('span', { text: m.mediaName || 'Documento' }),
      ]);
    }

    /* --- Mensajes -------------------------------------------------------- */
    function renderMessages() {
      msgBox.innerHTML = '';
      if (!current || !current.messages) return;
      let lastDay = '';
      current.messages.forEach((m) => {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) {
          lastDay = day;
          msgBox.appendChild(el('div', { class: 'flex justify-center my-3' },
            el('span', { class: 'chat-day', text: App.dateShort(m.at) })));
        }
        const outgoing = m.from !== 'in';
        const partes = [];

        // El adjunto va arriba del texto, como en WhatsApp: la foto primero y
        // el pie de foto debajo.
        const media = mediaNode(m);
        if (media) partes.push(media);

        // Con adjunto, el texto suele ser el relleno que puso el motor
        // ("📷 Imagen"): repetirlo debajo de la propia imagen sobra.
        const esRelleno = m.hasMedia && /^(📷|🎤|🎥|📎|🙂)/.test(m.text || '');
        if (m.text && !esRelleno) {
          partes.push(el('span', { class: 'whitespace-pre-line', text: m.text }));
        }

        partes.push(el('span', {
          class: 'meta',
          text: m.pending
            ? 'Enviando…'
            : `${m.from === 'bot' ? '🤖 IA · ' : m.from === 'out' ? '👤 Manual · ' : ''}${App.clock(m.at)}`,
        }));

        msgBox.appendChild(el('div', { class: `msg-row ${outgoing ? 'out' : ''}` },
          el('div', { class: `bubble ${m.from === 'in' ? 'in' : m.from === 'bot' ? 'bot' : 'out'} ${m.pending ? 'opacity-60' : ''}` }, partes)));
      });
      msgBox.scrollTop = msgBox.scrollHeight;
    }

    /* --- Cabecera del chat ----------------------------------------------- */
    function renderHeader() {
      const [label, cls] = STATE_LABEL[current.status] || STATE_LABEL.new;
      id('avatar').textContent = App.initials(current.name);
      id('name').textContent = current.name;
      id('phone').textContent = current.phone;
      const st = id('state');
      st.textContent = label;
      st.className = `font-semibold ${cls}`;

      const adBadge = id('ad-badge');
      if (current.ad) {
        adBadge.classList.remove('hidden');
        id('ad-name').textContent = current.ad;
      } else {
        adBadge.classList.add('hidden');
      }

      if (cfg.withAi) {
        const toggle = id('ai-toggle');
        toggle.checked = current.aiEnabled;
      }
      const paidBtn = id('mark-paid');
      paidBtn.disabled = current.status === 'paid';
      paidBtn.innerHTML = current.status === 'paid'
        ? '<i class="fa-solid fa-circle-check"></i><span class="hidden sm:inline">Pagado</span>'
        : '<i class="fa-solid fa-circle-check"></i><span class="hidden sm:inline">Marcar como Pagado</span>';
    }

    /* --- Selección ------------------------------------------------------- */
    async function select(convId) {
      current = data.find((c) => c.id === convId) || null;
      if (!current) return;

      id('welcome').classList.add('hidden');
      const active = id('active');
      active.classList.remove('hidden');
      active.classList.add('flex');

      // En móvil el panel de chat sustituye a la lista
      listPane.classList.add('max-lg:hidden');
      chatPane.classList.remove('max-lg:hidden');

      renderHeader();
      renderMessages();
      renderList();
      pintarAvisoVentana();

      // Los mensajes se piden al abrir, no antes: cargar todos sería absurdo
      try {
        const server = (await App.session.api(`/conversations/${convId}/messages`))
          .map((m) => ({ id: m.id, from: m.direction, text: m.body, at: m.at,
                         hasMedia: m.hasMedia, mediaType: m.mediaType, mediaName: m.mediaName }));
        if (current && current.id === convId) {
          current.messages = mergeServerMessages(server);
          renderMessages();
        }
      } catch (err) {
        App.toast(`No se pudieron cargar los mensajes: ${err.message}`, 'err');
      }
    }

    function goBackToList() {
      listPane.classList.remove('max-lg:hidden');
      chatPane.classList.add('max-lg:hidden');
    }

    /* --- Envío de mensajes ----------------------------------------------- */
    function pushMessage(text, from) {
      current.messages = current.messages || [];
      // pending: true hasta que el servidor lo confirme (ver mergeServerMessages) —
      // el mensaje pasó por la cola de salida y puede tardar unos segundos en
      // enviarse de verdad, pero el operador ya lo ve escrito.
      current.messages.push({ from, text, at: new Date().toISOString(), pending: true });
      current.lastAt = current.messages[current.messages.length - 1].at;
      renderMessages();
      renderList();
    }

    /**
     * Combina lo que devuelve el servidor con los mensajes que se pintaron al
     * instante (pushMessage) y que todavía no salieron de la cola. Sin esto,
     * cada refresco de los 10 s reemplazaba el array entero y un mensaje
     * enviado hacía un segundo desaparecía de la pantalla hasta que el
     * siguiente refresco lo trajera ya confirmado — parecía que se hubiera
     * borrado, cuando en realidad solo estaba en camino.
     */
    function mergeServerMessages(serverMessages) {
      const pendientes = (current.messages || []).filter((m) => {
        if (!m.pending) return false;
        // Más de 60 s sin confirmarse: si de verdad falló (número inválido,
        // token vencido…), "Actividad reciente" ya lo avisó — aquí se deja
        // de proteger para no dejar una burbuja fantasma en el chat para
        // siempre. Si sí se envió, el propio filtro de abajo la reemplaza.
        if (Date.now() - new Date(m.at).getTime() > 60_000) return false;
        // Ya llegó del servidor con el mismo texto/dirección: se descarta la
        // copia local optimista a favor de la real (evita el duplicado).
        return !serverMessages.some((s) => s.from === m.from && s.text === m.text);
      });
      return [...serverMessages, ...pendientes].sort((a, b) => new Date(a.at) - new Date(b.at));
    }

    async function send(ev) {
      ev.preventDefault();
      if (!current) return;
      const input = id('input');
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      // Se pinta al momento y luego se confirma: el operador no espera a la red
      pushMessage(text, 'out');

      try {
        const r = await App.session.api(`/conversations/${current.id}/messages`, {
          method: 'POST', body: { body: text },
        });
        if (r.outsideWindow) App.toast(r.warning, 'warn', 8000);
      } catch (err) {
        App.toast(`No se pudo enviar: ${err.message}`, 'err');
      }
    }

    /* --- Ventana de 24 h y plantillas ---------------------------------------
     * Meta solo entrega texto libre dentro de las 24 h siguientes al último
     * mensaje DEL CLIENTE. Pasado ese plazo el mensaje se rechaza en sus
     * servidores y el cliente nunca lo ve, así que conviene avisarlo antes de
     * escribir, no después.
     */
    const VENTANA_MS = 24 * 3600 * 1000;

    function ventanaCerrada() {
      if (!current) return false;
      if (!current.lastInboundAt) return true; // nunca escribió: nunca hubo ventana
      return Date.now() - new Date(current.lastInboundAt).getTime() > VENTANA_MS;
    }

    function pintarAvisoVentana() {
      const aviso = id('window-warning');
      if (!aviso) return;
      aviso.classList.toggle('hidden', !ventanaCerrada());
    }

    /** Modal para elegir plantilla y rellenar sus datos. */
    async function enviarPlantilla() {
      if (!current) return;

      let plantillas = [];
      try {
        plantillas = await App.session.api('/templates');
      } catch (err) {
        App.toast(err.message, 'err');
        return;
      }

      if (!plantillas.length) {
        const ir = await App.confirmModal(
          'Todavía no tienes plantillas',
          'Para escribirle a alguien pasadas 24 h, Meta exige una plantilla que ellos hayan aprobado. ' +
          'En Configuración → Plantillas tienes textos listos para copiar y registrar.',
          { confirmText: 'Ir a Plantillas', icon: 'fa-file-lines' }
        );
        if (ir) App.navigate('templates');
        return;
      }

      const select = el('select', { class: 'select' });
      plantillas.forEach((t) => select.appendChild(
        el('option', { value: t.id, text: `${t.name}${t.category === 'MARKETING' ? ' (promoción)' : ''}` })));

      const campos = el('div', { class: 'space-y-2 mt-3' });
      const vista = el('p', { class: 'text-sm text-ink/70 bg-accent-50 rounded-xl p-3 mt-3 whitespace-pre-line' });

      // Se repinta cada vez que cambia la plantilla: cada una pide datos
      // distintos y la vista previa muestra cómo quedará el mensaje real.
      function refrescar() {
        const t = plantillas.find((x) => x.id === select.value);
        campos.innerHTML = '';
        if (!t) return;
        for (let i = 0; i < t.variables; i++) {
          const etiqueta = (t.varLabels && t.varLabels[i]) || `Dato ${i + 1}`;
          const input = el('input', { class: 'input', placeholder: etiqueta, dataset: { idx: String(i) } });
          input.addEventListener('input', previsualizar);
          campos.appendChild(el('div', {}, [el('label', { class: 'label', text: etiqueta }), input]));
        }
        previsualizar();
      }

      function valores() {
        return [...campos.querySelectorAll('input')].map((i) => i.value.trim());
      }

      function previsualizar() {
        const t = plantillas.find((x) => x.id === select.value);
        if (!t) return;
        const vals = valores();
        vista.textContent = String(t.body).replace(/\{\{(\d+)\}\}/g,
          (_, n) => vals[Number(n) - 1] || `[${(t.varLabels && t.varLabels[Number(n) - 1]) || 'dato'}]`);
      }

      select.addEventListener('change', refrescar);

      const body = el('div', {}, [
        el('label', { class: 'label', text: 'Plantilla aprobada' }), select,
        campos,
        el('p', { class: 'label mt-3', text: 'Así lo recibirá el cliente' }), vista,
      ]);
      refrescar();

      const ok = await App.modal({
        title: 'Enviar plantilla', icon: 'fa-file-lines', body, confirmText: 'Enviar',
        onConfirm: () => {
          const t = plantillas.find((x) => x.id === select.value);
          const vals = valores();
          if (!t || vals.length !== t.variables || vals.some((v) => !v)) {
            App.toast('Completa todos los datos de la plantilla.', 'warn');
            return false;
          }
          return { templateId: t.id, values: vals };
        },
      });
      if (!ok) return;

      try {
        await App.session.api(`/conversations/${current.id}/template`, { method: 'POST', body: ok });
        const t = plantillas.find((x) => x.id === ok.templateId);
        pushMessage(String(t.body).replace(/\{\{(\d+)\}\}/g, (_, n) => ok.values[Number(n) - 1]), 'out');
        App.toast('Plantilla enviada. Cuando el cliente responda podrás escribirle normal.', 'ok', 6000);
      } catch (err) {
        App.toast(err.message, 'err');
      }
    }

    /* --- Nuevo contacto (botón "+") ----------------------------------------
     * Para cuando el negocio necesita escribirle primero a alguien, en vez de
     * esperar a que el contacto escriba primero.
     */
    async function nuevoContacto() {
      const countrySelect = el('select', { class: 'select !w-auto flex-none', style: 'min-width:6.5rem' });
      App.COUNTRIES.forEach((c) => countrySelect.appendChild(
        el('option', { value: c.dial.replace('+', ''), text: `${c.name} ${c.dial}` })
      ));
      countrySelect.value = '57'; // Colombia por defecto: es donde opera Elorai hoy

      const phoneInput = el('input', { class: 'input flex-1', placeholder: '300 1234567', inputmode: 'numeric' });
      phoneInput.addEventListener('input', () => {
        const digits = phoneInput.value.replace(/\D/g, '');
        if (digits !== phoneInput.value) phoneInput.value = digits;
      });

      const nameInput = el('input', { class: 'input', placeholder: 'Nombre (opcional)' });
      const err = el('p', { class: 'error-msg', text: 'Escribe un teléfono válido.' });

      const body = el('div', { class: 'space-y-3' }, [
        el('div', {}, [
          el('label', { class: 'label', text: 'Teléfono' }),
          el('div', { class: 'flex gap-2' }, [countrySelect, phoneInput]),
          err,
        ]),
        el('div', {}, [
          el('label', { class: 'label', text: 'Nombre' }),
          nameInput,
        ]),
      ]);

      const phone = await App.modal({
        title: 'Agregar contacto', icon: 'fa-user-plus', body, confirmText: 'Iniciar conversación',
        onConfirm: () => {
          const digits = phoneInput.value.trim();
          if (digits.length < 6) {
            phoneInput.classList.add('is-invalid');
            err.classList.add('show');
            return false;
          }
          return countrySelect.value + digits;
        },
      });
      if (!phone) return;

      try {
        const contact = await App.session.api('/contacts', {
          method: 'POST', body: { phone, name: nameInput.value.trim() },
        });

        // Un contacto recién creado (o retomado) tiene last_message_at
        // reciente, así que entra en "Conversaciones activas" — pero si ya
        // existía con actividad vieja puede no llegar a tiempo al refresco.
        // Se agrega a la lista igual, en vez de dejar el botón "+" sin efecto.
        await cargarConversaciones();
        if (!data.some((c) => c.id === contact.id)) {
          data.unshift({
            id: contact.id, name: contact.name || contact.phone, phone: contact.phone,
            status: contact.status, ad: contact.adName, aiEnabled: contact.aiEnabled,
            lastAt: contact.lastAt, preview: '', messages: null,
          });
          renderList();
        }
        select(contact.id);
      } catch (err2) {
        App.toast(err2.message, 'err');
      }
    }

    /* --- Emojis ----------------------------------------------------------- */
    function initEmoji() {
      const pop = id('emoji-pop');
      App.EMOJIS.forEach((e) => {
        pop.appendChild(el('button', { type: 'button', text: e, onclick: () => {
          const input = id('input');
          input.value += e;
          input.focus();
          pop.classList.remove('open');
        } }));
      });
      qsa(`[data-emoji-toggle="${p}"]`).forEach((btn) => {
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); pop.classList.toggle('open'); });
      });
      document.addEventListener('click', (ev) => {
        if (!pop.contains(ev.target) && !ev.target.closest(`[data-emoji-toggle="${p}"]`)) pop.classList.remove('open');
      });
    }

    /* --- Acciones de cabecera -------------------------------------------- */
    function initActions() {
      id('back').addEventListener('click', goBackToList);

      // Solo existe en el panel de Chat en Vivo (id('new-contact') es null
      // en el histórico, que no tiene este botón).
      if (id('new-contact')) id('new-contact').addEventListener('click', nuevoContacto);

      // Dos accesos al mismo flujo: el icono de la barra (siempre) y el botón
      // del aviso de ventana cerrada (solo cuando hace falta de verdad).
      if (id('template')) id('template').addEventListener('click', enviarPlantilla);
      if (id('window-template')) id('window-template').addEventListener('click', enviarPlantilla);

      id('form').addEventListener('submit', send);

      id('attach').addEventListener('click', () => id('file-input').click());
      id('file-input').addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (!file || !current) return;

        App.toast(`Subiendo ${file.name}…`, 'info');
        try {
          const form = new FormData();
          form.append('files', file);
          const res = await fetch('/api/media', { method: 'POST', credentials: 'same-origin', body: form });
          const uploaded = await res.json();
          if (!res.ok) throw new Error(uploaded.message || 'No se pudo subir el archivo');
          if (!uploaded.saved?.length) throw new Error(uploaded.rejected?.[0]?.reason || 'Archivo rechazado');

          const name = uploaded.saved[0].name;
          const r = await App.session.api(`/conversations/${current.id}/messages`, {
            method: 'POST', body: { body: '', mediaName: name },
          });
          pushMessage(`📎 ${name}`, 'out');
          if (r.outsideWindow) App.toast(r.warning, 'warn', 8000);
          else App.toast('Archivo enviado', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });

      id('mark-paid').addEventListener('click', async () => {
        if (!current || current.status === 'paid') return;
        const ok = await App.confirmModal('Marcar como pagado',
          `Vas a marcar a <strong>${App.escapeHtml(current.name)}</strong> como pagado y se ejecutará el flujo post-pago.<br><br>
           <span class="text-red-600 font-semibold">Esta acción no se puede revertir.</span>`,
          { confirmText: 'Marcar como pagado', icon: 'fa-circle-check' });
        if (!ok) return;
        try {
          await App.session.api(`/contacts/${current.id}/paid`, { method: 'POST' });
          current.status = 'paid';
          renderHeader();
          renderList();
          App.toast('Contacto marcado como pagado', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });

      if (cfg.withAi) {
        id('ai-toggle').addEventListener('change', async (ev) => {
          if (!current) return;
          try {
            await App.session.api(`/conversations/${current.id}/ai`, {
              method: 'PUT', body: { enabled: ev.target.checked },
            });
            current.aiEnabled = ev.target.checked;
            App.toast(current.aiEnabled ? 'IA activada para este contacto' : 'IA desactivada: responderás manualmente',
              current.aiEnabled ? 'ok' : 'warn');
          } catch (err) {
            ev.target.checked = !ev.target.checked;
            App.toast(err.message, 'err');
          }
        });

        id('stop-automation').addEventListener('click', async () => {
          if (!current) return;
          const ok = await App.confirmModal('Detener automatización',
            `Se cancelarán los flujos y el remarketing programados para <strong>${App.escapeHtml(current.name)}</strong>, y la IA dejará de responderle.<br><br>
             Podrás reactivarla en cualquier momento con el switch de IA.`,
            { confirmText: 'Detener', danger: true, icon: 'fa-hand' });
          if (!ok) return;
          try {
            await App.session.api(`/conversations/${current.id}/stop-automation`, { method: 'POST' });
            current.aiEnabled = false;
            id('ai-toggle').checked = false;
            App.toast('Automatización detenida para este contacto', 'warn');
          } catch (err) {
            App.toast(err.message, 'err');
          }
        });
      }

      let t;
      id('search').addEventListener('input', (ev) => {
        clearTimeout(t);
        t = setTimeout(() => { filter = ev.target.value; renderList(); }, 160);
      });
    }

    /** Recarga la lista y, si hay un chat abierto, sus mensajes — sin tocar el campo de texto. */
    async function refrescar() {
      const openId = current?.id;
      // cargarConversaciones() reconstruye `data` con objetos nuevos (sin
      // mensajes): hay que guardar los pendientes ANTES de perder la
      // referencia al `current` de esta conversación.
      const pendientesPrevios = openId === current?.id ? current.messages : null;
      await cargarConversaciones();
      if (openId) {
        const stillThere = data.find((c) => c.id === openId);
        if (stillThere) {
          current = stillThere;
          current.messages = pendientesPrevios;
          const server = (await App.session.api(`/conversations/${openId}/messages`))
            .map((m) => ({ id: m.id, from: m.direction, text: m.body, at: m.at,
                         hasMedia: m.hasMedia, mediaType: m.mediaType, mediaName: m.mediaName }));
          current.messages = mergeServerMessages(server);
          renderHeader();
          renderMessages();
          pintarAvisoVentana();
        }
      }
    }

    initEmoji();
    initActions();

    return { renderList, select, goBackToList, cargarConversaciones, refrescar, get current() { return current; } };
  }

  let liveTimer = null;

  function init() {
    App.livePanel = createChatPanel({
      prefix: 'live', scope: 'live', withAi: true, countEl: '#live-count',
    });
    App.histPanel = createChatPanel({
      prefix: 'hist', scope: 'history', withAi: false, countEl: '#hist-count', perPage: 8,
    });

    // Al salir de la sección en móvil, se vuelve a la lista
    App.onView('live-chat', () => { if (window.innerWidth < 1024) App.livePanel.goBackToList(); });
    App.onView('chat-history', () => { if (window.innerWidth < 1024) App.histPanel.goBackToList(); });
  }

  App.chat = { init };

  App.onView('live-chat', () => {
    App.livePanel.cargarConversaciones().catch((e) => App.toast(e.message, 'err'));
    clearInterval(liveTimer);
    // Sin websockets, preguntar cada pocos segundos mientras la sección esté
    // visible da una sensación de "vivo" sin sobrecargar el servidor.
    liveTimer = setInterval(() => {
      if (App.state.view !== 'live-chat') { clearInterval(liveTimer); return; }
      App.livePanel.refrescar().catch(() => {});
    }, 10_000);
  });
  App.onView('chat-history', () => App.histPanel.cargarConversaciones().catch((e) => App.toast(e.message, 'err')));

})(window.Elorai);
