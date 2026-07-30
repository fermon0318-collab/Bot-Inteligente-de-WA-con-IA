/* ============================================================================
   Elorai — catálogos estáticos
   Contenido propio (no datos de usuario): monedas, países, zonas horarias,
   modelos de IA, emojis, tutoriales, FAQ y plantillas de flujo. No cambia con
   la cuenta que inicia sesión, así que no tiene sentido pedirlo a la API.
   ========================================================================== */

window.Elorai = window.Elorai || {};

(function (App) {
  'use strict';

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

  /* --- Países -------------------------------------------------------------
     Usado por el selector de teléfono del onboarding (código, nombre, prefijo). */
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
  ].map(([code, name, dial]) => ({ code, name, dial }));

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

  /* --- Plantillas de flujo avanzado ---------------------------------------- */
  App.FLOW_TEMPLATES = [
    { id: 'tpl_ventas', name: 'Embudo de ventas clásico', desc: 'Saludo → calificación → precios → cierre' },
    { id: 'tpl_soporte', name: 'Soporte nivel 1', desc: 'Clasifica el problema y escala a un humano' },
    { id: 'tpl_citas', name: 'Agendamiento de citas', desc: 'Propone horarios y confirma por WhatsApp' },
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

  /* --- Prompt de referencia ------------------------------------------------ */
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

  /* --- Emojis --------------------------------------------------------------- */
  App.EMOJIS = ['😀','😃','😄','😁','😊','😍','🥰','😎','🤩','🤗','🤔','😅','😉','🙌','👏','👍','👌','🙏','💪','🔥',
    '✨','🎉','🎊','💜','💙','❤️','⭐','✅','❌','⚠️','📎','📄','📷','🎥','🎵','💰','💳','🏦','🛒','📦',
    '🚀','⏰','📅','📌','🔔','💬','🤖','👋','😇','🥳'];

  /* --- Catálogo de plantillas de WhatsApp -----------------------------------
     Pasadas 24 h desde el último mensaje del cliente, Meta rechaza el texto
     libre: solo pasa una plantilla que ellos aprobaron antes. Estas son
     propuestas listas para copiar y pegar en Meta Business Manager →
     WhatsApp Manager → Plantillas de mensajes.

     Todas son categoría UTILITY (utilidad) salvo las marcadas: es la que
     corresponde a avisos sobre algo que el cliente ya contrató o pidió, se
     aprueba con más facilidad y cuesta menos que MARKETING. Meta rechaza
     como UTILITY cualquier cosa que sea promoción encubierta.

     `name` va en minúsculas con guiones bajos porque es el formato que exige
     Meta, y debe coincidir EXACTAMENTE con el nombre que se registre allí.
     ------------------------------------------------------------------------ */
  App.WA_TEMPLATE_CATALOG = [
    /* ---------- Citas y reservas ---------- */
    {
      name: 'recordatorio_cita', category: 'UTILITY', group: 'Citas y reservas',
      title: 'Recordatorio de cita',
      desc: 'Avisa al cliente antes de su cita. Es la que usa la Agenda para recordar sola.',
      body: 'Hola {{1}}, te recordamos tu cita de {{2}} el {{3}} a las {{4}}. ¿Nos confirmas tu asistencia?',
      varLabels: ['Nombre del cliente', 'Servicio o clase', 'Fecha', 'Hora'],
    },
    {
      name: 'confirmacion_reserva', category: 'UTILITY', group: 'Citas y reservas',
      title: 'Confirmación de reserva',
      desc: 'Se envía apenas queda agendada una cita.',
      body: '¡Listo {{1}}! Tu reserva de {{2}} quedó confirmada para el {{3}} a las {{4}}. Si necesitas cambiarla, respóndenos por aquí.',
      varLabels: ['Nombre del cliente', 'Servicio o clase', 'Fecha', 'Hora'],
    },
    {
      name: 'reagendar_cita', category: 'UTILITY', group: 'Citas y reservas',
      title: 'Proponer nueva fecha',
      desc: 'Cuando hay que mover una cita ya acordada.',
      body: 'Hola {{1}}, necesitamos mover tu cita del {{2}}. ¿Te sirve el {{3}} a las {{4}}? Cuéntanos y lo dejamos listo.',
      varLabels: ['Nombre del cliente', 'Fecha original', 'Nueva fecha', 'Nueva hora'],
    },
    {
      name: 'cita_cancelada', category: 'UTILITY', group: 'Citas y reservas',
      title: 'Aviso de cancelación',
      desc: 'Avisa que una cita se canceló y ofrece reagendar.',
      body: 'Hola {{1}}, lamentamos avisarte que tu cita del {{2}} a las {{3}} fue cancelada. Escríbenos y buscamos otro horario que te sirva.',
      varLabels: ['Nombre del cliente', 'Fecha', 'Hora'],
    },
    {
      name: 'cliente_no_asistio', category: 'UTILITY', group: 'Citas y reservas',
      title: 'No asistió a la cita',
      desc: 'Retoma el contacto con quien faltó, sin reclamo.',
      body: 'Hola {{1}}, te esperábamos el {{2}} y no pudimos verte. ¿Quieres que reprogramemos? Respóndenos y lo organizamos.',
      varLabels: ['Nombre del cliente', 'Fecha de la cita'],
    },

    /* ---------- Pagos y cobros ---------- */
    {
      name: 'recordatorio_pago', category: 'UTILITY', group: 'Pagos',
      title: 'Recordatorio de pago',
      desc: 'Cobro pendiente de algo que el cliente ya contrató.',
      body: 'Hola {{1}}, te recordamos que tienes un pago pendiente de {{2}} por {{3}}. Si ya lo hiciste, mándanos el comprobante por aquí.',
      varLabels: ['Nombre del cliente', 'Concepto', 'Monto'],
    },
    {
      name: 'pago_confirmado', category: 'UTILITY', group: 'Pagos',
      title: 'Pago confirmado',
      desc: 'Acuse de que el pago se recibió.',
      body: '¡Gracias {{1}}! Confirmamos tu pago de {{2}} por {{3}}. Cualquier cosa que necesites, escríbenos.',
      varLabels: ['Nombre del cliente', 'Monto', 'Concepto'],
    },
    {
      name: 'mensualidad_por_vencer', category: 'UTILITY', group: 'Pagos',
      title: 'Mensualidad por vencer',
      desc: 'Para negocios con plan o membresía mensual.',
      body: 'Hola {{1}}, tu {{2}} vence el {{3}}. Para no perder tu cupo, puedes renovar respondiendo por aquí.',
      varLabels: ['Nombre del cliente', 'Plan o membresía', 'Fecha de vencimiento'],
    },
    {
      name: 'comprobante_no_valido', category: 'UTILITY', group: 'Pagos',
      title: 'Comprobante ilegible',
      desc: 'Cuando el comprobante enviado no se puede verificar.',
      body: 'Hola {{1}}, no pudimos validar el comprobante que nos enviaste. ¿Podrías reenviarlo mostrando el monto, la fecha y la referencia completa?',
      varLabels: ['Nombre del cliente'],
    },

    /* ---------- Pedidos y entregas ---------- */
    {
      name: 'pedido_confirmado', category: 'UTILITY', group: 'Pedidos',
      title: 'Pedido confirmado',
      desc: 'Confirma que el pedido entró y quedó en proceso.',
      body: '¡Gracias {{1}}! Recibimos tu pedido {{2}} y ya está en preparación. Te avisamos apenas salga.',
      varLabels: ['Nombre del cliente', 'Número de pedido'],
    },
    {
      name: 'pedido_en_camino', category: 'UTILITY', group: 'Pedidos',
      title: 'Pedido en camino',
      desc: 'Aviso de despacho con fecha estimada.',
      body: 'Hola {{1}}, tu pedido {{2}} va en camino y llega aproximadamente el {{3}}. Cualquier duda, respóndenos por aquí.',
      varLabels: ['Nombre del cliente', 'Número de pedido', 'Fecha estimada'],
    },
    {
      name: 'pedido_listo_retiro', category: 'UTILITY', group: 'Pedidos',
      title: 'Listo para recoger',
      desc: 'El pedido espera en el local.',
      body: 'Hola {{1}}, tu pedido {{2}} ya está listo para recoger en {{3}}. Te esperamos.',
      varLabels: ['Nombre del cliente', 'Número de pedido', 'Dirección o sucursal'],
    },

    /* ---------- Atención y seguimiento ---------- */
    {
      name: 'retomar_conversacion', category: 'UTILITY', group: 'Atención',
      title: 'Retomar una conversación',
      desc: 'La más útil del día a día: reabre el chat con alguien de hace días, sin vender nada.',
      body: 'Hola {{1}}, te escribimos de {{2}} para retomar tu consulta. ¿Sigues interesado? Respóndenos y seguimos por aquí.',
      varLabels: ['Nombre del cliente', 'Nombre del negocio'],
    },
    {
      name: 'respuesta_pendiente', category: 'UTILITY', group: 'Atención',
      title: 'Tenemos tu respuesta',
      desc: 'Cuando quedó algo pendiente de averiguar y ya hay respuesta.',
      body: 'Hola {{1}}, ya tenemos la información que nos pediste sobre {{2}}. Respóndenos y te contamos los detalles.',
      varLabels: ['Nombre del cliente', 'Tema consultado'],
    },
    {
      name: 'documento_faltante', category: 'UTILITY', group: 'Atención',
      title: 'Falta un dato o documento',
      desc: 'Para trámites que quedaron incompletos.',
      body: 'Hola {{1}}, para continuar con {{2}} nos falta {{3}}. ¿Nos lo puedes enviar por aquí?',
      varLabels: ['Nombre del cliente', 'Trámite o servicio', 'Dato o documento faltante'],
    },
    {
      name: 'encuesta_satisfaccion', category: 'UTILITY', group: 'Atención',
      title: 'Cómo te fue',
      desc: 'Seguimiento tras un servicio prestado.',
      body: 'Hola {{1}}, ¿cómo te fue con {{2}}? Nos ayuda mucho saber tu opinión — puedes contarnos respondiendo aquí.',
      varLabels: ['Nombre del cliente', 'Servicio recibido'],
    },

    /* ---------- Avisos operativos ---------- */
    {
      name: 'cambio_horario', category: 'UTILITY', group: 'Avisos',
      title: 'Cambio de horario',
      desc: 'Avisa un cambio que afecta al cliente.',
      body: 'Hola {{1}}, te avisamos que {{2}} cambia de horario: ahora es {{3}}. Si necesitas ajustar algo, escríbenos.',
      varLabels: ['Nombre del cliente', 'Clase, servicio o sucursal', 'Nuevo horario'],
    },
    {
      name: 'cierre_temporal', category: 'UTILITY', group: 'Avisos',
      title: 'Cierre temporal',
      desc: 'Vacaciones, festivos o mantenimiento.',
      body: 'Hola {{1}}, te contamos que estaremos cerrados del {{2}} al {{3}}. Volvemos con todo y quedamos atentos por aquí.',
      varLabels: ['Nombre del cliente', 'Fecha de inicio', 'Fecha de regreso'],
    },

    /* ---------- Promoción (categoría distinta) ---------- */
    {
      name: 'promocion_general', category: 'MARKETING', group: 'Promoción',
      title: 'Promoción',
      desc: 'MARKETING: cuesta más y el cliente puede tener desactivadas las promociones. Úsala poco — es la que más reportes de spam genera, y eso sí puede costarte el número.',
      body: 'Hola {{1}}, tenemos {{2}} hasta el {{3}}. Si te interesa, respóndenos y te damos los detalles.',
      varLabels: ['Nombre del cliente', 'Promoción', 'Fecha límite'],
    },
  ];

})(window.Elorai);
