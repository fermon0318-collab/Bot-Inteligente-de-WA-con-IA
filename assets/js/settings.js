/* ============================================================================
   Elorai — Pagos y Acceso, Configurar IA, Tutoriales y FAQ
   ========================================================================== */

(function (App) {
  'use strict';

  const { qs, qsa, el } = App;

  // Arranca vacío; cargarPagos() lo llena al entrar a la sección.
  App.PAY_RULES = [];
  App.PAY_QUICK = [];

  /* ========================================================================
     Pagos y acceso
     ===================================================================== */
  function renderPayRules() {
    const box = qs('#pay-rules');
    box.innerHTML = '';
    qs('#pay-rules-empty').classList.toggle('hidden', App.PAY_RULES.length > 0);

    App.PAY_RULES.forEach((rule, i) => {
      const amount = el('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Ej. 89', value: rule.amount });
      const context = el('input', { class: 'input', placeholder: 'Ej. acceso completo, curso', value: rule.context });
      const message = el('textarea', { class: 'textarea !min-h-[4.5rem] !text-sm' });
      message.value = rule.message;

      amount.addEventListener('input', () => { rule.amount = amount.value; });
      context.addEventListener('input', () => { rule.context = context.value; });
      message.addEventListener('input', () => { rule.message = message.value; });

      const filesBox = el('div', { class: 'flex flex-wrap gap-1.5' });
      function renderFiles() {
        filesBox.innerHTML = '';
        rule.files.forEach((f) => {
          const chip = el('span', { class: 'badge badge-brand' }, [
            el('i', { class: 'fa-solid fa-paperclip' }), el('span', { text: f }),
            el('button', { type: 'button', class: 'ml-1 text-brand-700 hover:text-red-600', html: '<i class="fa-solid fa-xmark"></i>', 'aria-label': `Quitar ${f}`,
              onclick: () => { rule.files.splice(rule.files.indexOf(f), 1); renderFiles(); } }),
          ]);
          filesBox.appendChild(chip);
        });
        const add = el('select', { class: 'select !py-1 !text-xs !w-auto' });
        add.appendChild(el('option', { value: '', text: '+ Adjuntar archivo' }));
        App.MEDIA.filter((m) => !rule.files.includes(m.name))
          .forEach((m) => add.appendChild(el('option', { value: m.name, text: m.name })));
        add.addEventListener('change', () => {
          if (!add.value) return;
          rule.files.push(add.value);
          renderFiles();
        });
        filesBox.appendChild(add);
      }
      renderFiles();

      const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm !text-red-600', html: '<i class="fa-solid fa-trash"></i>', 'aria-label': 'Eliminar regla' });
      del.addEventListener('click', async () => {
        const ok = await App.confirmModal('Eliminar regla de acceso',
          'Los pagos que coincidan con esta combinación dejarán de entregarse automáticamente.',
          { confirmText: 'Eliminar', danger: true, icon: 'fa-trash' });
        if (!ok) return;
        App.PAY_RULES.splice(App.PAY_RULES.indexOf(rule), 1);
        renderPayRules();
        App.toast('Regla eliminada', 'ok');
      });

      box.appendChild(el('div', { class: 'rounded-xl border border-accent-200 bg-white/70 p-4' }, [
        el('div', { class: 'flex items-center gap-2 mb-3' }, [
          el('span', { class: 'icon-badge sm' }, el('i', { class: 'fa-solid fa-key' })),
          el('p', { class: 'text-sm font-extrabold text-ink mr-auto', text: `Regla ${i + 1}` }),
          del,
        ]),
        el('div', { class: 'grid sm:grid-cols-2 gap-3' }, [
          el('div', {}, [el('label', { class: 'label', text: 'Monto detectado' }), amount]),
          el('div', {}, [el('label', { class: 'label', text: 'Palabras de contexto' }), context]),
        ]),
        el('div', { class: 'mt-3' }, [el('label', { class: 'label', text: 'Mensaje de acceso' }), message]),
        el('div', { class: 'mt-3' }, [el('label', { class: 'label', text: 'Archivos a entregar' }), filesBox]),
      ]));
    });
  }

  function renderQuickReplies() {
    const box = qs('#pay-quick');
    box.innerHTML = '';

    App.PAY_QUICK.forEach((q) => {
      const keyword = el('input', { class: 'input', placeholder: 'Ej. transferencia', value: q.keyword });
      const reply = el('textarea', { class: 'textarea !min-h-[5rem] !text-sm' });
      reply.value = q.reply;
      keyword.addEventListener('input', () => { q.keyword = keyword.value; });
      reply.addEventListener('input', () => { q.reply = reply.value; });

      const del = el('button', { type: 'button', class: 'btn btn-ghost btn-sm !text-red-600', html: '<i class="fa-solid fa-trash"></i>', 'aria-label': 'Eliminar respuesta' });
      del.addEventListener('click', () => {
        App.PAY_QUICK.splice(App.PAY_QUICK.indexOf(q), 1);
        renderQuickReplies();
        App.toast('Respuesta rápida eliminada', 'ok');
      });

      box.appendChild(el('div', { class: 'rounded-xl border border-accent-200 bg-white/70 p-4' }, [
        el('div', { class: 'grid sm:grid-cols-[1fr_auto] gap-3 items-end' }, [
          el('div', {}, [el('label', { class: 'label', text: 'Palabra clave' }), keyword]),
          del,
        ]),
        el('div', { class: 'mt-3' }, [el('label', { class: 'label', text: 'Respuesta automática' }), reply]),
      ]));
    });
  }

  async function cargarPagos() {
    const d = await App.session.api('/payments');
    qs('#pay-msg-ok').value = d.messageOk;
    qs('#pay-msg-bad').value = d.messageInvalid;
    qs('#pay-postflow').value = d.postFlowId || '';
    App.PAY_RULES.length = 0;
    App.PAY_RULES.push(...d.rules.map((r) => ({ ...r, files: r.files || [] })));
    App.PAY_QUICK.length = 0;
    App.PAY_QUICK.push(...d.quickReplies);
    renderPayRules();
    renderQuickReplies();
  }

  function initPayments() {
    renderPayRules();
    renderQuickReplies();

    qs('#pay-rule-add').addEventListener('click', () => {
      App.PAY_RULES.push({ id: 'pr_' + Date.now(), amount: '', context: '', message: '', files: [] });
      renderPayRules();
      App.toast('Regla agregada: completa monto y contexto', 'info');
    });

    qs('#pay-quick-add').addEventListener('click', () => {
      App.PAY_QUICK.push({ id: 'pq_' + Date.now(), keyword: '', reply: '' });
      renderQuickReplies();
    });

    qs('#pay-save').addEventListener('click', (ev) => {
      const incomplete = App.PAY_RULES.find((r) => !r.amount.trim() || !r.context.trim() || !r.message.trim());
      if (incomplete) { App.toast('Hay reglas de acceso incompletas', 'err'); return; }
      const badQuick = App.PAY_QUICK.find((q) => !q.keyword.trim() || !q.reply.trim());
      if (badQuick) { App.toast('Hay respuestas rápidas incompletas', 'err'); return; }

      App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/payments', {
            method: 'PUT',
            body: {
              messageOk: qs('#pay-msg-ok').value,
              messageInvalid: qs('#pay-msg-bad').value,
              postFlowId: qs('#pay-postflow').value || null,
              rules: App.PAY_RULES,
              quickReplies: App.PAY_QUICK,
            },
          });
          await cargarPagos();
          App.toast('Configuración de pagos guardada', 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Guardando…');
    });
  }

  /* ========================================================================
     Configurar IA
     ===================================================================== */
  async function cargarIa() {
    const { ai } = await App.session.api('/settings');
    qs('#ai-enabled').checked = ai.enabled;
    qs('#ai-model').value = ai.model;
    qs('#ai-delay').value = ai.delaySeconds;
    qs('#ai-delay-value').textContent = ai.delaySeconds;
    qs('#ai-prompt').value = ai.prompt;
    qs('#ai-key').value = '';
    qs('#ai-key').placeholder = ai.hasKey ? ai.keyMask : 'sk-…';
    qs('#ai-prompt-chars').textContent = App.num(ai.prompt.length);
    qs('#ai-enabled-label').textContent = ai.enabled ? 'IA activada' : 'IA desactivada';
  }

  function initAiConfig() {
    const model = qs('#ai-model');
    App.AI_MODELS.forEach((m) => model.appendChild(el('option', { value: m.id, text: m.label })));
    model.value = 'claude-sonnet-5';

    qs('#ai-prompt-example').textContent = App.PROMPT_EXAMPLE;

    const delay = qs('#ai-delay');
    delay.addEventListener('input', () => { qs('#ai-delay-value').textContent = delay.value; });

    const prompt = qs('#ai-prompt');
    const counter = qs('#ai-prompt-chars');
    const updateCount = () => { counter.textContent = App.num(prompt.value.length); };
    prompt.addEventListener('input', updateCount);
    updateCount();

    const enabled = qs('#ai-enabled');
    enabled.addEventListener('change', () => {
      qs('#ai-enabled-label').textContent = enabled.checked ? 'IA activada' : 'IA desactivada';
    });

    qs('#ai-load-example').addEventListener('click', async () => {
      if (prompt.value.trim()) {
        const ok = await App.confirmModal('Reemplazar prompt',
          'Tu prompt actual se sustituirá por el de referencia. ¿Continuamos?',
          { confirmText: 'Reemplazar', icon: 'fa-file-import' });
        if (!ok) return;
      }
      prompt.value = App.PROMPT_EXAMPLE;
      updateCount();
      App.toast('Prompt de referencia cargado', 'ok');
    });

    qs('#ai-save').addEventListener('click', (ev) => {
      const key = qs('#ai-key').value.trim();
      if (prompt.value.trim().length < 40) {
        App.toast('El prompt base es demasiado corto para dar buenos resultados', 'warn');
      }
      App.withBusy(ev.currentTarget, async () => {
        try {
          await App.session.api('/settings/ai', {
            method: 'PUT',
            body: {
              enabled: enabled.checked,
              model: model.value,
              delaySeconds: Number(delay.value),
              prompt: prompt.value,
              ...(key ? { apiKey: key } : {}),
            },
          });
          qs('#ai-key').value = '';
          await cargarIa();
          App.toast(`IA configurada · ${model.options[model.selectedIndex].text.split('—')[0].trim()}`, 'ok');
        } catch (err) {
          App.toast(err.message, 'err');
        }
      }, 'Guardando…');
    });
  }

  /* ========================================================================
     Tutoriales
     ===================================================================== */
  function initTutorials() {
    const box = qs('#tutorials-groups');
    box.innerHTML = '';

    App.TUTORIALS.forEach((group) => {
      const grid = el('div', { class: 'grid sm:grid-cols-2 xl:grid-cols-3 gap-4' });
      group.videos.forEach((v) => {
        grid.appendChild(el('div', { class: 'card card-hover overflow-hidden' }, [
          el('div', { class: 'aspect-video bg-ink/5' },
            el('iframe', {
              class: 'w-full h-full', src: `https://www.youtube-nocookie.com/embed/${v.id}`,
              title: v.title, loading: 'lazy', frameborder: '0', allowfullscreen: '',
              allow: 'accelerometer; clipboard-write; encrypted-media; picture-in-picture',
            })),
          el('div', { class: 'p-4' }, [
            el('p', { class: 'text-sm font-extrabold text-ink', text: v.title }),
            el('p', { class: 'text-xs text-ink/55 mt-1 leading-relaxed', text: v.desc }),
          ]),
        ]));
      });

      box.appendChild(el('div', { class: 'card p-4 lg:p-5' }, [
        el('div', { class: 'flex items-center gap-3 mb-4' }, [
          el('span', { class: 'icon-badge' }, el('i', { class: `fa-solid ${group.icon}` })),
          el('h3', { class: 'text-base font-extrabold text-ink', text: group.group }),
          el('span', { class: 'badge badge-muted ml-auto', text: `${group.videos.length} videos` }),
        ]),
        grid,
      ]));
    });
  }

  /* ========================================================================
     FAQ
     ===================================================================== */
  /* Convierte los marcadores [ASI] del texto en chips visibles, construyendo
     nodos en lugar de inyectar HTML. */
  function withPlaceholders(text) {
    const frag = document.createDocumentFragment();
    const re = /\[[A-Z0-9_]+\]/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      frag.appendChild(el('span', { class: 'ph', title: 'Pendiente de completar', text: match[0] }));
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderFaq(filter = '') {
    const list = qs('#faq-list');
    const term = filter.trim().toLowerCase();
    list.innerHTML = '';

    const items = App.FAQ.filter((f) =>
      !term || f.q.toLowerCase().includes(term) || f.a.toLowerCase().includes(term));
    qs('#faq-empty').classList.toggle('hidden', items.length > 0);

    items.forEach((f, i) => {
      const inner = el('div', { class: 'faq-a-inner' }, el('p', {}, withPlaceholders(f.a)));
      if (f.link) {
        inner.appendChild(el('a', {
          class: 'inline-flex items-center gap-1.5 mt-3 text-sm font-bold text-accent-600 hover:text-accent-700',
          href: f.link.href,
        }, [el('i', { class: 'fa-solid fa-arrow-up-right-from-square text-xs' }), el('span', { text: f.link.label })]));
      }
      const answer = el('div', { class: 'faq-a' }, inner);
      const btn = el('button', {
        type: 'button', class: 'faq-q', 'aria-expanded': 'false', id: `faq-q-${i}`,
      }, [
        el('span', { class: 'icon-badge sm' }, el('i', { class: 'fa-solid fa-circle-question' })),
        el('span', { class: 'flex-1', text: f.q }),
        el('i', { class: 'fa-solid fa-chevron-down chev' }),
      ]);
      const item = el('div', { class: 'faq-item' }, [btn, answer]);

      btn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        // Acordeón: solo una respuesta abierta a la vez
        App.qsa('.faq-item.open', list).forEach((other) => {
          other.classList.remove('open');
          other.querySelector('.faq-a').style.maxHeight = '';
          other.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          item.classList.add('open');
          answer.style.maxHeight = `${answer.scrollHeight}px`;
          btn.setAttribute('aria-expanded', 'true');
        }
      });

      list.appendChild(item);
    });
  }

  function initFaq() {
    renderFaq();
    let t;
    qs('#faq-search').addEventListener('input', (ev) => {
      clearTimeout(t);
      t = setTimeout(() => renderFaq(ev.target.value), 180);
    });
  }

  App.settings = {
    init() {
      initPayments();
      initAiConfig();
      initTutorials();
      initFaq();
    },
  };

  App.onView('payments', () => cargarPagos().catch((e) => App.toast(e.message, 'err')));
  App.onView('ai-config', () => cargarIa().catch((e) => App.toast(e.message, 'err')));

})(window.Elorai);
