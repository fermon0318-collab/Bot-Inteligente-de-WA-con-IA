/* ============================================================================
   Elorai — datos de ejemplo (mock)
   Todo lo que aquí se genera está pensado para sustituirse por respuestas del
   backend. Cada colección expone la misma forma que consumirá la API real.
   ========================================================================== */

window.Elorai = window.Elorai || {};

(function (App) {
  'use strict';

  /* --- PRNG determinista: los números no cambian entre recargas ------------ */
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rnd = seeded(20260725);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  /* --- Monedas ------------------------------------------------------------ */
  // rate = unidades de la moneda por 1 USD
  App.CURRENCIES = [
    { code: 'USD', name: 'Dólar estadounidense', symbol: '$', rate: 1 },
    { code: 'EUR', name: 'Euro', symbol: '€', rate: 0.92 },
    { code: 'MXN', name: 'Peso mexicano', symbol: '$', rate: 17.2 },
    { code: 'COP', name: 'Peso colombiano', symbol: '$', rate: 3950 },
    { code: 'ARS', name: 'Peso argentino', symbol: '$', rate: 985 },
    { code: 'CLP', name: 'Peso chileno', symbol: '$', rate: 940 },
    { code: 'PEN', name: 'Sol peruano', symbol: 'S/', rate: 3.72 },
    { code: 'BRL', name: 'Real brasileño', symbol: 'R$', rate: 5.1 },
    { code: 'UYU', name: 'Peso uruguayo', symbol: '$', rate: 39.5 },
    { code: 'PYG', name: 'Guaraní paraguayo', symbol: '₲', rate: 7350 },
    { code: 'BOB', name: 'Boliviano', symbol: 'Bs', rate: 6.91 },
    { code: 'GTQ', name: 'Quetzal guatemalteco', symbol: 'Q', rate: 7.78 },
  ];

  /* --- Países ------------------------------------------------------------- */
  App.COUNTRIES = [
    ['MX', 'México', '+52'], ['CO', 'Colombia', '+57'], ['AR', 'Argentina', '+54'],
    ['CL', 'Chile', '+56'], ['PE', 'Perú', '+51'], ['BR', 'Brasil', '+55'],
    ['UY', 'Uruguay', '+598'], ['PY', 'Paraguay', '+595'], ['BO', 'Bolivia', '+591'],
    ['EC', 'Ecuador', '+593'], ['VE', 'Venezuela', '+58'], ['GT', 'Guatemala', '+502'],
    ['SV', 'El Salvador', '+503'], ['HN', 'Honduras', '+504'], ['NI', 'Nicaragua', '+505'],
    ['CR', 'Costa Rica', '+506'], ['PA', 'Panamá', '+507'], ['DO', 'Rep. Dominicana', '+1809'],
    ['CU', 'Cuba', '+53'], ['PR', 'Puerto Rico', '+1787'], ['US', 'Estados Unidos', '+1'],
    ['CA', 'Canadá', '+1'], ['ES', 'España', '+34'], ['PT', 'Portugal', '+351'],
    ['FR', 'Francia', '+33'], ['IT', 'Italia', '+39'], ['DE', 'Alemania', '+49'],
    ['GB', 'Reino Unido', '+44'], ['NL', 'Países Bajos', '+31'], ['BE', 'Bélgica', '+32'],
    ['CH', 'Suiza', '+41'], ['MA', 'Marruecos', '+212'], ['NG', 'Nigeria', '+234'],
    ['ZA', 'Sudáfrica', '+27'], ['EG', 'Egipto', '+20'], ['IN', 'India', '+91'],
    ['PK', 'Pakistán', '+92'], ['BD', 'Bangladés', '+880'], ['ID', 'Indonesia', '+62'],
    ['PH', 'Filipinas', '+63'], ['VN', 'Vietnam', '+84'], ['CN', 'China', '+86'],
    ['RU', 'Rusia', '+7'], ['TR', 'Turquía', '+90'], ['AE', 'Emiratos Árabes', '+971'],
    ['AU', 'Australia', '+61'], ['JP', 'Japón', '+81'], ['KR', 'Corea del Sur', '+82'],
  ].map(([code, name, dial]) => ({ code, name, dial, blocked: ['IN', 'PK', 'BD', 'NG'].includes(code) }));

  /* --- Zonas horarias ----------------------------------------------------- */
  App.TIMEZONES = [
    'America/Mexico_City', 'America/Bogota', 'America/Argentina/Buenos_Aires',
    'America/Santiago', 'America/Lima', 'America/Sao_Paulo', 'America/Montevideo',
    'America/Asuncion', 'America/La_Paz', 'America/Guayaquil', 'America/Caracas',
    'America/Guatemala', 'America/Panama', 'America/Santo_Domingo',
    'America/New_York', 'America/Los_Angeles', 'Europe/Madrid', 'UTC',
  ];

  /* --- Modelos de IA ------------------------------------------------------ */
  App.AI_MODELS = [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — equilibrio ideal' },
    { id: 'claude-opus-5', label: 'Claude Opus 5 — máxima calidad' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — el más rápido' },
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ];

  /* --- Series para gráficos ---------------------------------------------- */
  const DAYS = 30;
  App.DAILY = (function () {
    const out = [];
    const today = new Date();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dow = d.getDay();
      const weekendDrop = dow === 0 || dow === 6 ? 0.55 : 1;
      const contacts = Math.round((between(28, 74) * weekendDrop));
      const sales = Math.max(0, Math.round(contacts * (0.14 + rnd() * 0.13)));
      out.push({
        date: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }),
        weekday: dow,
        contacts,
        sales,
        revenue: +(sales * (39 + rnd() * 46)).toFixed(2), // en USD
      });
    }
    return out;
  })();

  App.BY_HOUR = Array.from({ length: 24 }, (_, h) => {
    // Curva realista: pico a media mañana y otro al caer la tarde
    const shape = Math.exp(-Math.pow(h - 11, 2) / 14) + 0.85 * Math.exp(-Math.pow(h - 19, 2) / 10);
    return { hour: h, contacts: Math.round(shape * 120 + rnd() * 12) };
  });

  App.BRANCHES = [
    { name: 'Distribuidor Norte', contacts: 412, sales: 96, revenue: 6820 },
    { name: 'Distribuidor Centro', contacts: 538, sales: 141, revenue: 9975 },
    { name: 'Distribuidor Sur', contacts: 287, sales: 52, revenue: 3640 },
    { name: 'Equipo Interno', contacts: 196, sales: 61, revenue: 4880 },
    { name: 'Afiliados', contacts: 324, sales: 68, revenue: 4420 },
  ];

  /* --- Contactos (Reportes) ---------------------------------------------- */
  const FIRST = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Diego', 'Valentina', 'Javier', 'Camila', 'Andrés',
    'Lucía', 'Miguel', 'Daniela', 'Ricardo', 'Paula', 'Fernando', 'Gabriela', 'Tomás', 'Renata', 'Sebastián'];
  const LAST = ['Ramírez', 'Torres', 'Vargas', 'Mendoza', 'Castillo', 'Herrera', 'Rojas', 'Delgado',
    'Ibarra', 'Peña', 'Cabrera', 'Molina', 'Suárez', 'Navarro', 'Fuentes'];
  const SOURCES = ['Anuncio Meta', 'Orgánico', 'Referido', 'Link directo', 'Instagram'];
  const STATUSES = ['paid', 'pending', 'rejected', 'new'];

  App.CONTACTS = Array.from({ length: 87 }, (_, i) => {
    const status = rnd() < 0.34 ? 'paid' : rnd() < 0.5 ? 'pending' : rnd() < 0.55 ? 'rejected' : 'new';
    const d = new Date();
    d.setDate(d.getDate() - between(0, 29));
    d.setHours(between(7, 22), between(0, 59), 0, 0);
    return {
      id: 'ct_' + (1000 + i),
      name: `${pick(FIRST)} ${pick(LAST)}`,
      phone: `+52 55 ${between(1000, 9999)} ${between(1000, 9999)}`,
      status: STATUSES.includes(status) ? status : 'new',
      source: pick(SOURCES),
      lastContact: d.toISOString(),
      amount: status === 'paid' ? +(39 + rnd() * 160).toFixed(2) : 0,
    };
  }).sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));

  /* --- Conversaciones ----------------------------------------------------- */
  const AD_NAMES = ['Curso IA · Video 15s', 'Promo Julio · Carrusel', 'Retargeting Compradores', 'Lead Ads · Reels'];

  function buildMessages(kind) {
    const base = [
      { from: 'in', text: 'Hola, vi el anuncio y quiero información 👋' },
      { from: 'bot', text: '¡Hola! Soy el asistente de Elorai 🤖 Con gusto te explico. ¿Buscas el plan mensual o el acceso completo?' },
      { from: 'in', text: 'El acceso completo, ¿cuánto cuesta?' },
      { from: 'bot', text: 'El acceso completo cuesta $89 USD por única vez e incluye todas las actualizaciones. ¿Te comparto los medios de pago?' },
      { from: 'in', text: 'Sí, por favor' },
      { from: 'bot', text: 'Perfecto. Puedes pagar por transferencia, SPEI o tarjeta. Escríbeme "transferencia" o "tarjeta" y te paso los datos.' },
    ];
    if (kind === 'paid') {
      base.push(
        { from: 'in', text: 'Ya hice la transferencia, adjunto comprobante 📎' },
        { from: 'bot', text: '¡Pago confirmado! 🎉 En un momento recibes tus accesos.' },
        { from: 'out', text: 'Bienvenido, cualquier duda me escribes por aquí.' },
      );
    } else if (kind === 'pending') {
      base.push({ from: 'in', text: 'Déjame ver y te aviso' });
    } else {
      base.push(
        { from: 'in', text: 'Envié el comprobante pero dice que no es válido' },
        { from: 'out', text: 'Lo reviso manualmente y te confirmo en unos minutos 🙏' },
      );
    }
    const now = Date.now();
    return base.map((m, i) => ({
      ...m,
      at: new Date(now - (base.length - i) * between(4, 26) * 60000).toISOString(),
    }));
  }

  function buildConversation(i, live) {
    const kind = rnd() < 0.35 ? 'paid' : rnd() < 0.65 ? 'pending' : 'rejected';
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const msgs = buildMessages(kind);
    const fromAd = rnd() < 0.5;
    return {
      id: (live ? 'lc_' : 'hc_') + (100 + i),
      name,
      phone: `+52 ${between(55, 81)} ${between(1000, 9999)} ${between(1000, 9999)}`,
      status: kind,
      online: live && rnd() < 0.45,
      unread: live ? (rnd() < 0.4 ? between(1, 4) : 0) : 0,
      aiEnabled: rnd() < 0.75,
      ad: fromAd ? pick(AD_NAMES) : null,
      messages: msgs,
      lastAt: msgs[msgs.length - 1].at,
    };
  }

  App.LIVE_CHATS = Array.from({ length: 9 }, (_, i) => buildConversation(i, true))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  App.HISTORY_CHATS = Array.from({ length: 34 }, (_, i) => buildConversation(i, false))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  /* --- Anuncios ----------------------------------------------------------- */
  App.ADS = [
    { name: 'Curso IA · Video 15s', campaign: 'Adquisición Julio', spend: 842.5, convos: 611, sales: 88, revenue: 7832, status: 'active' },
    { name: 'Promo Julio · Carrusel', campaign: 'Adquisición Julio', spend: 496.2, convos: 344, sales: 41, revenue: 3649, status: 'active' },
    { name: 'Retargeting Compradores', campaign: 'Remarketing', spend: 218.9, convos: 152, sales: 37, revenue: 3293, status: 'active' },
    { name: 'Lead Ads · Reels', campaign: 'Prospección Fría', spend: 613.4, convos: 402, sales: 29, revenue: 2581, status: 'paused' },
    { name: 'Testimonios · Story', campaign: 'Prueba Social', spend: 187.6, convos: 138, sales: 22, revenue: 1958, status: 'active' },
    { name: 'Webinar · Imagen', campaign: 'Prospección Fría', spend: 329.8, convos: 176, sales: 14, revenue: 1246, status: 'paused' },
  ];

  /* --- Flujos simples ----------------------------------------------------- */
  App.SIMPLE_FLOWS = [
    {
      id: 'sf_bienvenida', name: 'Bienvenida',
      steps: [
        { type: 'text', value: '¡Hola! 👋 Soy el asistente de Elorai. ¿En qué puedo ayudarte hoy?' },
        { type: 'delay', value: '3' },
        { type: 'text', value: 'Puedo contarte sobre precios, formas de pago o resolver dudas del producto.' },
      ],
    },
    {
      id: 'sf_precios', name: 'Lista de precios',
      steps: [
        { type: 'text', value: 'Estos son nuestros planes 👇' },
        { type: 'file', value: 'catalogo-precios.pdf' },
        { type: 'delay', value: '5' },
        { type: 'text', value: '¿Cuál te interesa más?' },
      ],
    },
    {
      id: 'sf_pago', name: 'Datos de pago',
      steps: [
        { type: 'text', value: 'Puedes pagar por transferencia o tarjeta. Te comparto los datos:' },
        { type: 'text', value: 'Banco: BBVA\nCLABE: 012 180 0123 4567 8901\nTitular: Elorai SA de CV' },
      ],
    },
  ];

  /* --- Flujos avanzados (árbol) ------------------------------------------- */
  App.ADVANCED_FLOWS = [
    {
      id: 'af_calificacion', name: 'Calificación de leads', updated: '2026-07-21', nodes: 9,
      tree: {
        kind: 'start', title: 'Inicio', text: 'El contacto escribe por primera vez',
        children: [{
          kind: 'message', title: 'Saludo', text: '¡Hola! ¿Buscas el plan mensual o el acceso completo?',
          children: [{
            kind: 'condition', title: '¿Qué respondió?', text: 'Se evalúa la intención del mensaje',
            children: [
              { kind: 'message', title: 'Rama: mensual', text: 'Te explico el plan mensual de $19 USD…', children: [{ kind: 'action', title: 'Etiquetar', text: 'lead_mensual', children: [] }] },
              { kind: 'message', title: 'Rama: completo', text: 'El acceso completo son $89 USD…', children: [{ kind: 'action', title: 'Etiquetar', text: 'lead_premium', children: [] }] },
              { kind: 'message', title: 'Rama: sin match', text: 'Deriva a la IA para responder libre', children: [] },
            ],
          }],
        }],
      },
    },
    {
      id: 'af_postventa', name: 'Onboarding post-venta', updated: '2026-07-18', nodes: 7,
      tree: {
        kind: 'start', title: 'Pago confirmado', text: 'Se detecta un comprobante válido',
        children: [{
          kind: 'message', title: 'Bienvenida', text: '¡Bienvenido! 🎉 Aquí están tus accesos',
          children: [{
            kind: 'action', title: 'Enviar archivos', text: 'acceso-curso.pdf · credenciales.png',
            children: [{
              kind: 'delay', title: 'Esperar 24h', text: 'Pausa antes del seguimiento',
              children: [{ kind: 'message', title: 'Seguimiento', text: '¿Pudiste entrar sin problema?', children: [] }],
            }],
          }],
        }],
      },
    },
    {
      id: 'af_objeciones', name: 'Manejo de objeciones', updated: '2026-07-11', nodes: 11,
      tree: {
        kind: 'start', title: 'Objeción detectada', text: 'La IA identifica duda o rechazo',
        children: [{
          kind: 'condition', title: 'Tipo de objeción', text: 'Precio · confianza · tiempo',
          children: [
            { kind: 'message', title: 'Precio', text: 'Te muestro el retorno esperado…', children: [] },
            { kind: 'message', title: 'Confianza', text: 'Te comparto testimonios reales…', children: [{ kind: 'action', title: 'Enviar', text: 'testimonios.mp4', children: [] }] },
            { kind: 'message', title: 'Tiempo', text: 'Son solo 20 min al día…', children: [] },
          ],
        }],
      },
    },
  ];

  App.FLOW_TEMPLATES = [
    { id: 'tpl_ventas', name: 'Embudo de ventas clásico', desc: 'Saludo → calificación → precios → cierre' },
    { id: 'tpl_soporte', name: 'Soporte nivel 1', desc: 'Clasifica el problema y escala a un humano' },
    { id: 'tpl_citas', name: 'Agendamiento de citas', desc: 'Propone horarios y confirma por WhatsApp' },
  ];

  /* --- Disparadores ------------------------------------------------------- */
  App.TRIGGERS = {
    simple: [
      { id: 'tg_1', keyword: 'hola', flow: 'sf_bienvenida', isDefault: true },
      { id: 'tg_2', keyword: 'precio', flow: 'sf_precios', isDefault: false },
      { id: 'tg_3', keyword: 'cuánto cuesta', flow: 'sf_precios', isDefault: false },
      { id: 'tg_4', keyword: 'transferencia', flow: 'sf_pago', isDefault: false },
    ],
    advanced: [
      { id: 'tga_1', keyword: 'quiero información', flow: 'af_calificacion', isDefault: true },
      { id: 'tga_2', keyword: 'es muy caro', flow: 'af_objeciones', isDefault: false },
    ],
  };

  /* --- Remarketing -------------------------------------------------------- */
  App.REMARKETING = {
    hours: 24, minutes: 0, start: '09:00', end: '21:00', tz: 'America/Mexico_City',
    steps: [
      { type: 'text', value: 'Hola 👋 ¿Sigues interesado? Aparté tu lugar por 24 horas.' },
      { type: 'delay', value: '30' },
      { type: 'text', value: 'Si tienes dudas del pago, te ayudo por aquí sin compromiso.' },
    ],
  };

  /* --- Pagos y acceso ----------------------------------------------------- */
  App.PAY_RULES = [
    { id: 'pr_1', amount: '89', context: 'acceso completo, curso completo', message: '¡Listo! Aquí tienes el acceso completo 🎉', files: ['acceso-curso.pdf', 'credenciales.png'] },
    { id: 'pr_2', amount: '19', context: 'mensual, plan básico', message: 'Tu plan mensual está activo. Renueva el mismo día del próximo mes.', files: ['guia-rapida.pdf'] },
  ];

  App.PAY_QUICK = [
    { id: 'pq_1', keyword: 'transferencia', reply: 'Banco: BBVA\nCLABE: 012 180 0123 4567 8901\nTitular: Elorai SA de CV\n\nEnvíame el comprobante cuando termines 🙌' },
    { id: 'pq_2', keyword: 'tarjeta', reply: 'Puedes pagar con tarjeta aquí: https://pago.elorai.io/checkout\nAcepta débito, crédito y hasta 3 MSI.' },
  ];

  /* --- Tutoriales --------------------------------------------------------- */
  App.TUTORIALS = [
    {
      group: 'Guías generales',
      icon: 'fa-compass',
      videos: [
        { id: 'aqz-KE-bpKQ', title: 'Tour completo por Elorai', desc: 'Recorrido por cada sección del panel en 12 minutos.' },
        { id: 'ScMzIvxBSi4', title: 'Tu primer bot en 10 minutos', desc: 'Del número vacío a un bot respondiendo de verdad.' },
        { id: '0Gu-2QQOZcE', title: 'Estrategia de embudo en WhatsApp', desc: 'Cómo estructurar la conversación para vender más.' },
      ],
    },
    {
      group: 'Configuración básica',
      icon: 'fa-screwdriver-wrench',
      videos: [
        { id: 'ZK-rNEhJIDs', title: 'Conectar WhatsApp Cloud API', desc: 'Token permanente, webhook y verificación paso a paso.' },
        { id: 'wnhvanMdx4s', title: 'Configurar el prompt de la IA', desc: 'Cómo escribir instrucciones que la IA sí respeta.' },
        { id: 'kJQP7kiw5Fk', title: 'Verificación automática de pagos', desc: 'Reglas de acceso, montos y entrega de archivos.' },
      ],
    },
  ];

  /* --- FAQ ---------------------------------------------------------------- */
  App.FAQ = [
    { q: '¿Qué necesito para poner en marcha Elorai?', a: 'Un número de WhatsApp Business conectado a Cloud API (no puede estar activo en la app normal), una cuenta de Meta for Developers con Access Token permanente, y una API Key del proveedor de IA que elijas. Con esos tres datos, la sección Cloud API te deja el bot activo en minutos.' },
    { q: '¿Puedo usar mi número personal de WhatsApp?', a: 'No. Meta exige que el número esté dado de alta en Cloud API y desvinculado de la app de WhatsApp o WhatsApp Business. Si lo migras, perderás el historial local de ese teléfono, así que lo recomendable es usar un número dedicado al negocio.' },
    { q: '¿Cómo decide Elorai qué flujo lanzar?', a: 'Al llegar un mensaje se buscan coincidencias con tus disparadores, de la frase más específica a la más general. Si ninguno coincide, se ejecuta el disparador marcado como predeterminado. Si tampoco hay predeterminado y la IA está activada, responde la IA con tu prompt base.' },
    { q: '¿Cómo verifica los pagos si el comprobante es una imagen?', a: 'Elorai lee el comprobante y extrae monto, fecha y referencia. Luego los compara con tus reglas de acceso (monto + contexto). Si coinciden, envía el mensaje y los archivos de esa regla; si no, responde con tu mensaje de "comprobante no válido" y deja el contacto en estado pendiente para que lo revises manualmente.' },
    { q: '¿Puedo intervenir una conversación que está llevando la IA?', a: 'Sí. En Chat en Vivo cada conversación tiene un switch de IA. Al apagarlo, el bot deja de responder a ese contacto y tú escribes directamente. El botón "Detener automatización" además cancela los flujos y el remarketing que estuvieran programados para esa persona.' },
    { q: '¿Cuándo se envía el remarketing?', a: 'Cuando pasa el tiempo que configuraste desde el primer contacto sin que haya conversión. Si ese momento cae fuera de tu franja horaria permitida, el mensaje se encola y sale al abrir la siguiente ventana, para no escribirle a nadie de madrugada.' },
    { q: '¿Qué hace exactamente la Conversions API?', a: 'Devuelve a Meta cada venta confirmada dentro de WhatsApp, algo que el píxel por sí solo no puede ver. Con esa señal el algoritmo aprende qué perfil compra de verdad y deja de optimizar hacia gente que solo abre conversación. Suele notarse en el costo por venta a partir de la segunda semana.' },
    { q: '¿Por qué aparece el aviso de que Meta no entrega mis mensajes?', a: 'Significa que la calidad de tu número bajó, casi siempre por bloqueos o reportes de usuarios. Revisa el estado en Cloud API, baja el volumen de mensajes en frío y evita escribir fuera de la ventana de 24 horas sin plantilla aprobada. La calificación se recupera sola con buen comportamiento. Ten en cuenta que la decisión es de Meta: ninguna herramienta puede revertir una limitación o una suspensión de tu número.' },
    { q: '¿Para qué sirve el bloqueo por país?', a: 'Filtra por prefijo telefónico los mensajes que el bot ignorará por completo. Es la forma más simple de cortar spam masivo desde regiones donde no vendes, sin gastar créditos de IA ni ensuciar tus métricas de conversión.' },
    {
      q: '¿Los datos de mis conversaciones se comparten con alguien?',
      a: 'No se venden ni se ceden para publicidad de terceros, y el contenido de tus chats no se usa para entrenar modelos. Las conversaciones se guardan cifradas y a tu proveedor de IA solo viaja el fragmento necesario para generar cada respuesta. Si activas Conversions API, a Meta se le envía el evento de compra con su valor y moneda, no la conversación. Tras darte de baja conservamos tus datos [DIAS_RETENCION] días para que puedas recuperarlos, y después se eliminan.',
      link: { href: 'privacidad.html', label: 'Leer la política de privacidad' },
    },
    {
      q: '¿Quién es el responsable de los datos de mis contactos?',
      a: 'Tú. Sobre los datos de tu cuenta Elorai actúa como responsable, pero sobre las conversaciones de las personas que te escriben actúa como encargado del tratamiento: las procesa por cuenta tuya y siguiendo tus instrucciones. Eso significa que a ti te toca informar a tus contactos de que conversan con un sistema automatizado y atender las solicitudes de acceso o borrado que te dirijan. Desde Reportes puedes exportar o eliminar lo que necesites para responderlas.',
      link: { href: 'privacidad.html#roles', label: 'Ver el detalle de los roles' },
    },
    {
      q: '¿El precio incluye lo que cobran Meta y la IA?',
      a: 'No. Tu plan de Elorai cubre la plataforma. Aparte quedan lo que Meta te facture por las conversaciones de WhatsApp Cloud API y el consumo del proveedor de inteligencia artificial cuya API Key configures. Ambos te los cobran ellos directamente, con sus propias tarifas.',
      link: { href: 'terminos.html#planes', label: 'Ver planes y facturación' },
    },
    {
      q: '¿Tienen política de reembolso?',
      a: 'Sí: [PLAZO_REEMBOLSO] días desde la contratación inicial, siempre que no hayas superado [LIMITE_CONVERSACIONES_REEMBOLSO] conversaciones procesadas. Se solicita escribiendo a soporte y se devuelve por el mismo medio de pago. Pasado ese plazo las cuotas ya abonadas no son reembolsables, sin perjuicio de los derechos que te reconozca la normativa de consumo de tu país.',
      link: { href: 'terminos.html#reembolsos', label: 'Ver la cláusula completa' },
    },
    { q: '¿Qué pasa si se cae mi servidor o Meta tiene una incidencia?', a: 'Los mensajes entrantes quedan en cola en Meta hasta 72 horas y Elorai los procesa al reconectar. En la terminal de Cloud API verás el detalle de la reconexión y cuántos mensajes se recuperaron.' },
  ];

  /* --- Prompt de referencia ---------------------------------------------- */
  App.PROMPT_EXAMPLE = `# IDENTIDAD
Eres el asistente comercial de {{NEGOCIO}}. Hablas por WhatsApp, en español
neutro, cercano pero profesional. Nunca dices que eres una IA salvo que te lo
pregunten directamente.

# OBJETIVO
Llevar al contacto desde su primera duda hasta el pago confirmado, sin presionar.
Si detectas que no es el momento, agenda un seguimiento y cierra amable.

# PRODUCTO
- Acceso completo: $89 USD, pago único, incluye actualizaciones de por vida.
- Plan mensual: $19 USD, se renueva cada 30 días, cancelable cuando quiera.

# REGLAS
1. Mensajes cortos: máximo 3 líneas. Uno o dos emojis, nunca más.
2. Una sola pregunta por mensaje.
3. Nunca inventes precios, plazos, garantías ni fechas de entrega.
4. Si piden datos de pago, responde con la palabra clave "transferencia" o
   "tarjeta" para que se dispare la respuesta rápida correspondiente.
5. Si envían un comprobante, no confirmes tú el pago: el sistema lo valida.

# LÍMITES
- No das asesoría legal, médica ni financiera.
- No prometes resultados económicos concretos.
- Si el contacto se molesta o pide un humano, respondes:
  "Claro, te paso con una persona del equipo ahora mismo 🙌" y te detienes.

# CIERRE
Cuando el contacto muestre intención clara de compra, resume el beneficio
principal en una línea y pregunta cómo prefiere pagar.`;

  /* --- Emojis ------------------------------------------------------------- */
  App.EMOJIS = ['😀','😃','😄','😁','😊','😍','🥰','😎','🤩','🤗','🤔','😅','😉','🙌','👏','👍','👌','🙏','💪','🔥',
    '✨','🎉','🎊','💜','💙','❤️','⭐','✅','❌','⚠️','📎','📄','📷','🎥','🎵','💰','💳','🏦','🛒','📦',
    '🚀','⏰','📅','📌','🔔','💬','🤖','👋','😇','🥳'];

  /* --- Archivos ----------------------------------------------------------- */
  App.MEDIA = [
    { id: 'md_1', name: 'catalogo-precios.pdf', type: 'pdf', size: 842000, at: '2026-07-19' },
    { id: 'md_2', name: 'acceso-curso.pdf', type: 'pdf', size: 1240000, at: '2026-07-14' },
    { id: 'md_3', name: 'credenciales.png', type: 'image', size: 318000, at: '2026-07-14' },
    { id: 'md_4', name: 'testimonios.mp4', type: 'video', size: 8940000, at: '2026-07-08' },
    { id: 'md_5', name: 'guia-rapida.pdf', type: 'pdf', size: 512000, at: '2026-06-30' },
    { id: 'md_6', name: 'bienvenida.mp3', type: 'audio', size: 226000, at: '2026-06-22' },
  ];

})(window.Elorai);
