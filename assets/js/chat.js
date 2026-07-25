/* ============================================================================
   ApolAI — Chat en Vivo e Histórico de Chats
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

    let data = cfg.data;
    let current = null;
    let page = 1;
    const perPage = cfg.perPage || 0;
    let filter = '';

    /* --- Lista de conversaciones ---------------------------------------- */
    function filtered() {
      const term = filter.trim().toLowerCase();
      if (!term) return data;
      return data.filter((c) =>
        c.name.toLowerCase().includes(term) ||
        c.phone.replace(/\s/g, '').includes(term.replace(/\s/g, '')) ||
        c.messages.some((m) => m.text.toLowerCase().includes(term)));
    }

    function renderList() {
      const rows = filtered();
      const total = rows.length;
      const pages = perPage ? Math.max(1, Math.ceil(total / perPage)) : 1;
      if (page > pages) page = pages;
      const slice = perPage ? rows.slice((page - 1) * perPage, page * perPage) : rows;

      listBox.innerHTML = '';
      if (!slice.length) {
        listBox.appendChild(el('div', { class: 'empty-state', html: '<i class="fa-regular fa-comments"></i>Sin conversaciones.' }));
      }

      slice.forEach((c) => {
        const last = c.messages[c.messages.length - 1];
        const [label] = STATE_LABEL[c.status] || STATE_LABEL.new;
        const btn = el('button', {
          type: 'button',
          class: `conv-item ${current && current.id === c.id ? 'active' : ''}`,
          dataset: { id: c.id },
        }, [
          el('span', { class: 'relative flex-none' }, [
            el('span', { class: 'avatar', text: App.initials(c.name) }),
            c.online ? el('span', { class: 'absolute bottom-0 right-0 dot dot-ok ring-2 ring-white' }) : null,
          ]),
          el('span', { class: 'min-w-0 flex-1' }, [
            el('span', { class: 'flex items-center gap-1.5' }, [
              el('span', { class: 'text-sm font-bold text-ink truncate flex-1', text: c.name }),
              el('span', { class: 'text-[0.68rem] text-ink/40 flex-none', text: App.timeAgo(last.at) }),
            ]),
            el('span', { class: 'block text-xs text-ink/55 truncate', text: last.text }),
            el('span', { class: 'flex items-center gap-1.5 mt-1' }, [
              el('span', { class: `badge ${c.status === 'paid' ? 'badge-ok' : c.status === 'pending' ? 'badge-warn' : c.status === 'rejected' ? 'badge-danger' : 'badge-muted'}`, text: label }),
              c.ad ? el('span', { class: 'badge badge-brand', html: '<i class="fa-solid fa-bullhorn"></i>Ad' }) : null,
              c.unread ? el('span', { class: 'ml-auto badge badge-danger', text: String(c.unread) }) : null,
            ]),
          ]),
        ]);
        btn.addEventListener('click', () => select(c.id));
        listBox.appendChild(btn);
      });

      if (cfg.countEl) qs(cfg.countEl).textContent = total;
      if (perPage && qs(`#${p}-pager`)) {
        App.renderPager(qs(`#${p}-pager`), page, pages, (n) => { page = n; renderList(); });
      }
    }

    /* --- Mensajes -------------------------------------------------------- */
    function renderMessages() {
      msgBox.innerHTML = '';
      if (!current) return;
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
    function select(convId) {
      current = data.find((c) => c.id === convId) || null;
      if (!current) return;
      current.unread = 0;

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
      updateUnreadBadge();
    }

    function goBackToList() {
      listPane.classList.remove('max-lg:hidden');
      chatPane.classList.add('max-lg:hidden');
    }

    /* --- Envío de mensajes ----------------------------------------------- */
    function pushMessage(text, from) {
      current.messages.push({ from, text, at: new Date().toISOString() });
      current.lastAt = current.messages[current.messages.length - 1].at;
      renderMessages();
      renderList();
    }

    function send(ev) {
      ev.preventDefault();
      if (!current) return;
      const input = id('input');
      const text = input.value.trim();
      if (!text) return;
      pushMessage(text, 'out');
      input.value = '';

      // Respuesta simulada del contacto / IA
      if (cfg.withAi && current.aiEnabled) {
        setTimeout(() => {
          if (!current) return;
          pushMessage('Perfecto, quedo atento 🙌', 'in');
        }, 1600);
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
      id('file-input').addEventListener('change', (ev) => {
        const file = ev.target.files[0];
        if (!file || !current) return;
        pushMessage(`📎 ${file.name} (${App.fileSize(file.size)})`, 'out');
        App.toast('Archivo enviado', 'ok');
        ev.target.value = '';
      });

      id('mark-paid').addEventListener('click', async () => {
        if (!current || current.status === 'paid') return;
        const ok = await App.confirmModal('Marcar como pagado',
          `Vas a marcar a <strong>${App.escapeHtml(current.name)}</strong> como pagado y se ejecutará el flujo post-pago.<br><br>
           <span class="text-red-600 font-semibold">Esta acción no se puede revertir.</span>`,
          { confirmText: 'Marcar como pagado', icon: 'fa-circle-check' });
        if (!ok) return;
        current.status = 'paid';
        renderHeader();
        renderList();
        pushMessage('¡Pago confirmado! 🎉 En un momento recibes tus accesos.', 'bot');
        App.toast('Contacto marcado como pagado', 'ok');
      });

      if (cfg.withAi) {
        id('ai-toggle').addEventListener('change', (ev) => {
          if (!current) return;
          current.aiEnabled = ev.target.checked;
          App.toast(current.aiEnabled ? 'IA activada para este contacto' : 'IA desactivada: responderás manualmente',
            current.aiEnabled ? 'ok' : 'warn');
        });

        id('stop-automation').addEventListener('click', async () => {
          if (!current) return;
          const ok = await App.confirmModal('Detener automatización',
            `Se cancelarán los flujos y el remarketing programados para <strong>${App.escapeHtml(current.name)}</strong>, y la IA dejará de responderle.<br><br>
             Podrás reactivarla en cualquier momento con el switch de IA.`,
            { confirmText: 'Detener', danger: true, icon: 'fa-hand' });
          if (!ok) return;
          current.aiEnabled = false;
          id('ai-toggle').checked = false;
          App.toast('Automatización detenida para este contacto', 'warn');
        });
      }

      let t;
      id('search').addEventListener('input', (ev) => {
        clearTimeout(t);
        t = setTimeout(() => { filter = ev.target.value; page = 1; renderList(); }, 160);
      });
    }

    initEmoji();
    initActions();
    renderList();

    return { renderList, select, goBackToList, get current() { return current; } };
  }

  function updateUnreadBadge() {
    const total = App.LIVE_CHATS.reduce((s, c) => s + (c.unread || 0), 0);
    const badge = qs('#nav-unread');
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
  }

  function init() {
    App.livePanel = createChatPanel({
      prefix: 'live', data: App.LIVE_CHATS, withAi: true, countEl: '#live-count',
    });
    App.histPanel = createChatPanel({
      prefix: 'hist', data: App.HISTORY_CHATS, withAi: false, countEl: '#hist-count', perPage: 8,
    });
    updateUnreadBadge();

    // Al salir de la sección en móvil, se vuelve a la lista
    App.onView('live-chat', () => { if (window.innerWidth < 1024) App.livePanel.goBackToList(); });
    App.onView('chat-history', () => { if (window.innerWidth < 1024) App.histPanel.goBackToList(); });
  }

  App.chat = { init };

})(window.ApolAI);
