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
            el('span', { class: 'badge badge-muted', text: App.dateShort(m.at) })));
        }
        const outgoing = m.from !== 'in';
        msgBox.appendChild(el('div', { class: `msg-row ${outgoing ? 'out' : ''}` },
          el('div', { class: `bubble ${m.from === 'in' ? 'in' : m.from === 'bot' ? 'bot' : 'out'}` }, [
            el('span', { class: 'whitespace-pre-line', text: m.text }),
            el('span', { class: 'meta', text: `${m.from === 'bot' ? '🤖 IA · ' : m.from === 'out' ? '👤 Manual · ' : ''}${App.clock(m.at)}` }),
          ])));
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

      // Los mensajes se piden al abrir, no antes: cargar todos sería absurdo
      try {
        current.messages = (await App.session.api(`/conversations/${convId}/messages`))
          .map((m) => ({ from: m.direction, text: m.body, at: m.at }));
        if (current && current.id === convId) renderMessages();
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
      current.messages.push({ from, text, at: new Date().toISOString() });
      current.lastAt = current.messages[current.messages.length - 1].at;
      renderMessages();
      renderList();
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
      await cargarConversaciones();
      if (openId) {
        const stillThere = data.find((c) => c.id === openId);
        if (stillThere) {
          current = stillThere;
          current.messages = (await App.session.api(`/conversations/${openId}/messages`))
            .map((m) => ({ from: m.direction, text: m.body, at: m.at }));
          renderHeader();
          renderMessages();
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
