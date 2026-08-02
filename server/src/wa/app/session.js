/**
 * Sesiones de Modo App (Baileys).
 *
 * Una sesión es un socket WebSocket abierto contra WhatsApp que se comporta
 * como un dispositivo vinculado más — el mismo mecanismo que WhatsApp Web.
 * Por eso el cliente conserva su historial, sus contactos y su número: no
 * migra nada, solo autoriza un dispositivo.
 *
 * ── Por qué Baileys y no whatsapp-web.js ────────────────────────────────────
 * whatsapp-web.js automatiza un Chromium real por cada cuenta: 300-500 MB de
 * RAM y un proceso de navegador por cliente. A mil usuarios eso son cientos de
 * gigas y una factura absurda. Baileys habla el protocolo directamente por
 * WebSocket: decenas de MB por sesión, sin navegador, sin pantalla, y arranca
 * en segundos en lugar de en medio minuto. Para el rango en el que vamos a
 * estar es la única de las dos que sale a cuenta.
 *
 * ── Sobre la dependencia ────────────────────────────────────────────────────
 * Baileys se carga con `import()` dinámico y está en `optionalDependencies`. Si
 * el despliegue no la tiene (o la versión nueva rompe al arrancar), Modo App
 * responde "no disponible" y el resto de Elorai —incluida Cloud API— sigue
 * funcionando. Cuando WhatsApp cambia su protocolo, esta es la diferencia
 * entre un módulo caído y una plataforma caída.
 */

import { EventEmitter } from 'node:events';
import { config } from '../../config.js';
import { many, one, query } from '../../db/pool.js';
import { avisarError } from '../../lib/alert.js';
import { clearAuthState, hasAuthState, loadAuthState } from './authStore.js';

/** Sesiones vivas en este proceso: accountId → sesión. */
const sessions = new Map();

/** Se emiten cambios de estado para que la API pueda responder sin sondear. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Vida de un QR antes de pedir uno nuevo. WhatsApp los rota cada ~20 s. */
const QR_TTL_MS = 60_000;
/** Cuánto tiempo se reserva una cuenta para este proceso. */
const LEASE_MS = 2 * 60_000;

/* ==========================================================================
   Carga perezosa de Baileys
   ========================================================================== */

let baileysPromise = null;
let baileysError = null;

async function loadBaileys() {
  if (baileysError) throw baileysError;
  if (!baileysPromise) {
    baileysPromise = import('baileys')
      .then((mod) => mod.default && mod.default.makeWASocket ? mod.default : mod)
      .catch((err) => {
        baileysError = new Error(
          'Modo App no está disponible en este despliegue: falta la dependencia "baileys". '
          + `Instálala con "npm install" en el servidor. (${err.message})`
        );
        baileysPromise = null;
        throw baileysError;
      });
  }
  return baileysPromise;
}

/** ¿Puede este despliegue ofrecer Modo App? Lo consulta el panel. */
export async function available() {
  try {
    await loadBaileys();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/* ==========================================================================
   Estado en la base
   ========================================================================== */

export async function getSessionRow(accountId) {
  return one('SELECT * FROM wa_app_sessions WHERE account_id = $1', [accountId]);
}

async function setStatus(accountId, status, extra = {}) {
  const fields = ['status = $2', 'updated_at = now()'];
  const values = [accountId, status];
  let i = 3;

  for (const [column, value] of Object.entries(extra)) {
    fields.push(`${column} = $${i}`);
    values.push(value);
    i++;
  }

  await query(
    `INSERT INTO wa_app_sessions (account_id, status) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET ${fields.join(', ')}`,
    values
  );

  bus.emit('status', { accountId, status, ...extra });
  return status;
}

async function log(accountId, message, level = 'info') {
  await query(
    'INSERT INTO activity_log (account_id, level, message) VALUES ($1, $2, $3)',
    [accountId, level, `Modo App · ${message}`]
  ).catch(() => {});
}

/* ==========================================================================
   Arrendamiento de cuentas entre trabajadores
   ========================================================================== */

/**
 * Reclama una cuenta para este proceso.
 *
 * Dos sockets abiertos sobre el mismo número es justo lo que WhatsApp
 * interpreta como sesión duplicada, y acaba cerrando la buena. El
 * arrendamiento lo impide: solo el proceso que tiene la fila reservada abre el
 * socket, y si ese proceso muere el arrendamiento caduca y otro la recoge.
 */
async function claimLease(accountId) {
  const row = await one(
    `UPDATE wa_app_sessions
        SET worker_id = $2, lease_until = now() + make_interval(secs => $3)
      WHERE account_id = $1
        AND (worker_id IS NULL OR worker_id = $2 OR lease_until IS NULL OR lease_until < now())
      RETURNING account_id`,
    [accountId, config.appMode.workerId, LEASE_MS / 1000]
  );
  return Boolean(row);
}

async function releaseLease(accountId) {
  await query(
    `UPDATE wa_app_sessions SET worker_id = NULL, lease_until = NULL WHERE account_id = $1 AND worker_id = $2`,
    [accountId, config.appMode.workerId]
  ).catch(() => {});
}

async function renewLeases() {
  if (!sessions.size) return;
  await query(
    `UPDATE wa_app_sessions
        SET lease_until = now() + make_interval(secs => $2), last_seen_at = now()
      WHERE account_id = ANY($1::uuid[]) AND worker_id = $3`,
    [[...sessions.keys()], LEASE_MS / 1000, config.appMode.workerId]
  ).catch((err) => console.error('[modo-app] renovación de arrendamiento:', err.message));
}

/* ==========================================================================
   Ciclo de vida de una sesión
   ========================================================================== */

/**
 * Cierra el socket de una sesión existente (si lo tiene) y cancela cualquier
 * reconexión que tuviera programada. No toca el mapa `sessions`: quien llama
 * decide qué hacer con la entrada (reemplazarla o borrarla).
 */
function detenerSesionExistente(session) {
  if (!session) return;
  // Cancela la reconexión con espera creciente si había una programada. Sin
  // esto, un connect()/disconnect() manual no evita que el setTimeout de una
  // reconexión anterior dispare más tarde y reviva la sesión igual.
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.closing = true;
  if (session.socket) {
    try { session.socket.end(undefined); } catch { /* ya podría estar muerto */ }
  }
}

/**
 * Abre (o reabre) la sesión de una cuenta.
 *
 * `forceQr: true` descarta las credenciales guardadas y fuerza un código nuevo
 * — es lo que hace el botón "Vincular otro teléfono" del panel.
 */
export async function connect(accountId, { forceQr = false } = {}) {
  const existing = sessions.get(accountId);

  // Ya hay un socket vivo: si no se pide forzar un QR nuevo, no hay nada que
  // hacer — devuelve el estado tal cual.
  if (existing?.socket && !forceQr) {
    return { status: existing.status, alreadyOpen: true };
  }
  // Ya hay OTRO intento en curso para esta cuenta (un marcador recién puesto
  // por una llamada concurrente) o una reconexión con espera ya programada:
  // no se arranca un segundo intento encima, se deja que el primero termine.
  // Esto vale incluso con forceQr — forzar sobre algo que ya está en vuelo
  // es exactamente el escenario que produce dos sockets para el mismo número.
  if (existing?.placeholder || existing?.reconnectTimer) {
    return { status: existing.status, alreadyOpen: true, inProgress: true };
  }

  // Reclama la cuenta EN EL ACTO, antes de cualquier `await`. Es lo único que
  // impide que dos llamadas casi simultáneas — doble clic en "Generar QR", dos
  // pestañas, o el trabajador periódico compitiendo con un clic manual —
  // pasen las dos de largo mientras esta función todavía resuelve promesas
  // (loadBaileys, claimLease, loadAuthState…) y acaben abriendo DOS sockets
  // de WhatsApp para el mismo número. `claimLease` por sí solo no bastaba
  // para esto: usa el worker_id del proceso, así que una segunda llamada del
  // mismo proceso lo reclama igual de bien que la primera.
  detenerSesionExistente(existing);
  const marcador = { accountId, status: 'connecting', placeholder: true, closing: false };
  sessions.set(accountId, marcador);

  try {
    const baileys = await loadBaileys();

    if (!(await claimLease(accountId))) {
      // La cuenta la lleva otro proceso: se suelta el marcador, no es nuestra.
      if (sessions.get(accountId) === marcador) sessions.delete(accountId);
      return { status: 'connecting', message: 'La sesión está abierta en otro proceso.' };
    }

    if (forceQr) await clearAuthState(accountId);

    const { state, saveCreds } = await loadAuthState({ accountId, baileys });
    const reconectando = await hasAuthState(accountId);

    await setStatus(accountId, reconectando ? 'connecting' : 'qr_pending', { last_error: null });

    const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const socket = baileys.makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // La caché de claves evita ir a Postgres por cada mensaje descifrado.
        keys: baileys.makeCacheableSignalKeyStore(state.keys, silentLogger()),
      },
      logger: silentLogger(),
      // Nada de marcarse en línea permanentemente: un número "siempre conectado"
      // desde un cliente no oficial llama la atención sin aportar nada.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: baileys.Browsers.appropriate('Desktop'),
      generateHighQualityLinkPreview: false,
    });

    const session = {
      accountId,
      socket,
      baileys,
      status: reconectando ? 'connecting' : 'qr_pending',
      reconnectAttempts: existing?.reconnectAttempts || 0,
      closing: false,
    };
    sessions.set(accountId, session);

    socket.ev.on('creds.update', () => {
      saveCreds().catch((err) => console.error(`[modo-app] guardar credenciales ${accountId}:`, err.message));
    });

    socket.ev.on('connection.update', (update) => {
      handleConnectionUpdate(session, update).catch((err) => {
        console.error(`[modo-app] connection.update ${accountId}:`, err.message);
      });
    });

    socket.ev.on('messages.upsert', (payload) => {
      handleIncoming(session, payload).catch((err) => {
        console.error(`[modo-app] mensaje entrante ${accountId}:`, err.message);
      });
    });

    return { status: session.status };
  } catch (err) {
    // No dejar el marcador huérfano si algo falló a mitad de camino: la
    // próxima llamada a connect() debe poder intentarlo de nuevo.
    if (sessions.get(accountId) === marcador) sessions.delete(accountId);
    throw err;
  }
}

async function handleConnectionUpdate(session, { connection, lastDisconnect, qr }) {
  const { accountId, baileys } = session;

  /* --- Hay un QR nuevo que mostrar ---------------------------------------- */
  if (qr) {
    const { toDataURL } = await import('qrcode');
    const png = await toDataURL(qr, { margin: 1, width: 320 });
    session.status = 'qr_pending';
    await setStatus(accountId, 'qr_pending', {
      qr_png: png,
      qr_expires_at: new Date(Date.now() + QR_TTL_MS),
      last_error: null,
    });
    bus.emit('qr', { accountId, png });
    return;
  }

  if (connection === 'open') {
    session.status = 'connected';
    session.reconnectAttempts = 0;

    const jid = session.socket.user?.id || '';
    // 5215512345678:12@s.whatsapp.net → +5215512345678
    const phone = jid.split(':')[0].split('@')[0];

    await setStatus(accountId, 'connected', {
      jid,
      display_phone: phone ? `+${phone}` : '',
      push_name: session.socket.user?.name || '',
      qr_png: null,
      qr_expires_at: null,
      last_error: null,
      connected_at: new Date(),
      last_seen_at: new Date(),
    });
    await log(accountId, `vinculado con ${phone ? `+${phone}` : 'el teléfono'}`, 'ok');
    return;
  }

  if (connection !== 'close') return;

  /* --- Se cerró: hay que decidir si merece la pena reintentar -------------- */
  const code = lastDisconnect?.error?.output?.statusCode
    ?? lastDisconnect?.error?.output?.payload?.statusCode;
  const { DisconnectReason } = baileys;

  // Solo se borra la entrada del mapa si sigue siendo ESTA sesión: si ya se
  // reemplazó por un marcador o una sesión más nueva —una reconexión manual
  // disparada mientras esta terminaba de cerrarse—, borrar por clave a secas
  // tiraría por la borda la entrada nueva sin querer.
  if (sessions.get(accountId) === session) sessions.delete(accountId);
  if (session.closing) return; // lo cerramos nosotros a propósito

  // WhatsApp invalidó la sesión: las credenciales ya no sirven de nada y
  // reintentar con ellas solo genera un bucle de reconexiones fallidas.
  if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
    await clearAuthState(accountId);
    await setStatus(accountId, 'logged_out', {
      qr_png: null,
      qr_expires_at: null,
      disconnected_at: new Date(),
      last_error: 'La sesión dejó de ser válida. Escanea el código QR otra vez.',
    });
    await log(accountId, 'la sesión dejó de ser válida — hace falta un QR nuevo', 'err');
    await releaseLease(accountId);
    return;
  }

  // WhatsApp restringió la cuenta. Aquí no hay reintento que valga: hay que
  // decírselo al cliente con todas las letras.
  if (code === DisconnectReason.forbidden) {
    await setStatus(accountId, 'banned', {
      qr_png: null,
      disconnected_at: new Date(),
      last_error: 'WhatsApp restringió esta cuenta. Revisa los avisos de políticas.',
    });
    await log(accountId, 'WhatsApp restringió la cuenta', 'err');
    await avisarError(`modo-app cuenta ${accountId}`, new Error('cuenta restringida por WhatsApp')).catch(() => {});
    await releaseLease(accountId);
    return;
  }

  // Otro dispositivo tomó la sesión (el cliente vinculó Elorai en otro sitio,
  // o hay dos procesos peleándose). No se reintenta: reconectar en bucle es
  // precisamente lo que dispara el cierre definitivo.
  if (code === DisconnectReason.connectionReplaced) {
    await setStatus(accountId, 'disconnected', {
      disconnected_at: new Date(),
      last_error: 'Otro dispositivo tomó esta sesión.',
    });
    await log(accountId, 'otra sesión reemplazó a esta', 'warn');
    await releaseLease(accountId);
    return;
  }

  /* --- Corte transitorio: reconexión con espera creciente ------------------ */
  const attempts = session.reconnectAttempts + 1;
  if (attempts > 8) {
    await setStatus(accountId, 'disconnected', {
      disconnected_at: new Date(),
      last_error: 'No se pudo reconectar tras varios intentos.',
    });
    await log(accountId, 'no se pudo reconectar; reintentaremos más tarde', 'err');
    await releaseLease(accountId);
    return;
  }

  const waitMs = Math.min(30_000, 2 ** attempts * 1000);
  await setStatus(accountId, 'connecting', {
    last_error: lastDisconnect?.error?.message || 'conexión interrumpida',
  });

  const timer = setTimeout(() => {
    connect(accountId)
      .then(() => {
        const s = sessions.get(accountId);
        if (s) s.reconnectAttempts = attempts;
      })
      .catch((err) => console.error(`[modo-app] reconexión ${accountId}:`, err.message));
  }, waitMs);
  timer.unref();

  // Se deja un marcador con el timer, en vez de borrar la entrada sin más:
  // es lo que permite que disconnect() o un connect() manual encuentren esta
  // reconexión programada y la cancelen. Sin esto, un "Desvincular" o un
  // cambio de canal justo en esta ventana no evitaba que el timeout disparara
  // igual más tarde y abriera un socket nuevo pidiendo un QR — reviviendo
  // Modo App justo después de que el usuario dijo que ya no lo quería.
  //
  // Solo se planta si el mapa sigue vacío para esta cuenta: el `await
  // setStatus` de arriba deja una ventana en la que un connect() manual pudo
  // colarse y ya estar abriendo una sesión de verdad, y no hay que pisarla.
  if (!sessions.has(accountId)) {
    sessions.set(accountId, {
      accountId, status: 'connecting', reconnectAttempts: attempts,
      reconnectTimer: timer, closing: false,
    });
  } else {
    clearTimeout(timer);
  }
}

/**
 * Cierra la sesión.
 *
 * `logout: true` la cierra también en el teléfono del cliente (equivale a
 * "Cerrar sesión" desde Dispositivos vinculados) y borra las credenciales.
 * Sin `logout`, solo se suelta el socket: sirve para apagar el proceso sin que
 * el cliente tenga que volver a escanear nada.
 */
export async function disconnect(accountId, { logout = false, keepAuth = true } = {}) {
  const session = sessions.get(accountId);

  if (session) {
    // Cancela cualquier reconexión programada: sin esto, desvincular (o
    // cambiar de canal) mientras una reconexión con espera está pendiente no
    // impedía que el timeout disparara igual más tarde y revivicara la
    // sesión con un QR nuevo, justo después de que se pidió lo contrario.
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.closing = true;
    try {
      if (logout) await session.socket?.logout();
      else session.socket?.end(undefined);
    } catch {
      // Un socket ya muerto al cerrarlo no es un problema
    }
    if (sessions.get(accountId) === session) sessions.delete(accountId);
  }

  if (logout || !keepAuth) await clearAuthState(accountId);

  if (logout) {
    await setStatus(accountId, 'disconnected', {
      jid: '', display_phone: '', push_name: '',
      qr_png: null, qr_expires_at: null,
      disconnected_at: new Date(),
      last_error: null,
    });
    await log(accountId, 'desvinculado desde el panel', 'warn');
  }

  await releaseLease(accountId);
  return { ok: true };
}

/* ==========================================================================
   Envío
   ========================================================================== */

/** JID de WhatsApp a partir de un teléfono en cualquier formato. */
export function jidFor(phone) {
  return `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
}

function requireSession(accountId) {
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected') {
    const err = new Error('El teléfono no está vinculado. Escanea el código QR en Modo App.');
    err.code = 'app_no_conectado';
    // Transitorio a propósito: la cola lo reintenta cuando la sesión vuelva,
    // en vez de dar por perdido un mensaje que el cliente sí quería enviar.
    err.permanent = false;
    throw err;
  }
  return session;
}

/**
 * Envía texto. Antes escribe "escribiendo…" durante un momento proporcional a
 * la longitud: además de verse natural, obliga a un intervalo mínimo real
 * entre el momento en que se decide enviar y el envío.
 */
export async function sendText({ accountId, to, body }) {
  const session = requireSession(accountId);
  const jid = jidFor(to);

  try {
    await session.socket.presenceSubscribe(jid);
    await session.socket.sendPresenceUpdate('composing', jid);
    await sleep(Math.min(4000, 400 + String(body).length * 25));
    await session.socket.sendPresenceUpdate('paused', jid);
  } catch {
    // Los indicadores de presencia son cosméticos: si fallan, se envía igual
  }

  const sent = await session.socket.sendMessage(jid, { text: String(body) });
  return sent?.key?.id || null;
}

/** Envía un archivo ya leído en memoria. */
export async function sendMedia({ accountId, to, buffer, mimeType, filename, caption, kind = 'document' }) {
  const session = requireSession(accountId);
  const jid = jidFor(to);

  const content = kind === 'image' ? { image: buffer, caption: caption || undefined }
    : kind === 'video' ? { video: buffer, caption: caption || undefined }
    : kind === 'audio' ? { audio: buffer, mimetype: mimeType || 'audio/mp4', ptt: false }
    : { document: buffer, mimetype: mimeType || 'application/octet-stream', fileName: filename || 'archivo' };

  const sent = await session.socket.sendMessage(jid, content);
  return sent?.key?.id || null;
}

/**
 * Descarga un adjunto entrante.
 *
 * Aquí no hay una URL que pedir con un token, como en Cloud API: el archivo
 * viaja cifrado y se descarga a partir del mensaje original, que por eso se
 * conserva entero al recibirlo.
 */
export async function downloadMedia({ accountId, raw }) {
  const session = sessions.get(accountId);
  const baileys = session?.baileys || (await loadBaileys());

  const buffer = await baileys.downloadMediaMessage(
    raw,
    'buffer',
    {},
    // Si el remitente ya no tiene el archivo, WhatsApp permite pedir que lo
    // reenvíe — solo posible con una sesión viva.
    session ? { reuploadRequest: session.socket.updateMediaMessage } : {}
  );

  const contenido = raw?.message || {};
  const mimeType = contenido.imageMessage?.mimetype
    || contenido.documentMessage?.mimetype
    || contenido.audioMessage?.mimetype
    || contenido.videoMessage?.mimetype
    || contenido.stickerMessage?.mimetype
    || '';

  return { buffer, mimeType, size: buffer?.length || 0 };
}

/** Marca como leído: el contacto ve la doble palomita azul. */
export async function markAsRead({ accountId, key }) {
  const session = sessions.get(accountId);
  if (!session || session.status !== 'connected' || !key) return;
  await session.socket.readMessages([key]).catch(() => {});
}

/** ¿Está viva la sesión de esta cuenta en ESTE proceso? */
export const isConnected = (accountId) => sessions.get(accountId)?.status === 'connected';

/* ==========================================================================
   Entrada de mensajes
   ========================================================================== */

/**
 * Traduce un mensaje de Baileys a la forma que ya usa el motor.
 *
 * El motor habla el vocabulario de Cloud API (`{ id, from, type, text: { body } }`)
 * porque es lo que había primero. Traducir aquí es lo que permite que flujos,
 * disparadores, IA, comprobantes y agenda funcionen igual en los dos canales
 * sin tocar una línea del motor.
 */
export function normalizeIncoming(raw) {
  const message = raw?.message || {};
  const key = raw?.key || {};
  // Un JID puede traer sufijo de dispositivo (5215512345678:12@s.whatsapp.net).
  // Hay que quitarlo: el motor construye el teléfono borrando lo que no son
  // dígitos, y sin esto el ":12" se pegaría al número.
  const from = String(key.remoteJid || '').split('@')[0].split(':')[0];
  const id = key.id || '';

  const texto = message.conversation
    || message.extendedTextMessage?.text
    || '';

  if (texto) return { id, from, timestamp: raw.messageTimestamp, type: 'text', text: { body: texto } };

  if (message.imageMessage) {
    return { id, from, type: 'image', image: { id, caption: message.imageMessage.caption || '', mime_type: message.imageMessage.mimetype } };
  }
  if (message.documentMessage) {
    return { id, from, type: 'document', document: { id, filename: message.documentMessage.fileName || 'documento', caption: message.documentMessage.caption || '', mime_type: message.documentMessage.mimetype } };
  }
  if (message.audioMessage) {
    return { id, from, type: 'audio', audio: { id, mime_type: message.audioMessage.mimetype } };
  }
  if (message.videoMessage) {
    return { id, from, type: 'video', video: { id, caption: message.videoMessage.caption || '', mime_type: message.videoMessage.mimetype } };
  }
  if (message.locationMessage) return { id, from, type: 'location', location: message.locationMessage };
  if (message.stickerMessage) return { id, from, type: 'sticker' };

  const boton = message.buttonsResponseMessage?.selectedDisplayText
    || message.templateButtonReplyMessage?.selectedDisplayText
    || message.listResponseMessage?.title;
  if (boton) return { id, from, type: 'button', button: { text: boton } };

  return null;
}

/** ¿Es un mensaje que nos interesa procesar? */
function isRelevant(raw) {
  if (!raw?.key) return false;
  if (raw.key.fromMe) return false;                       // lo escribió el propio negocio
  const jid = String(raw.key.remoteJid || '');
  if (jid.endsWith('@g.us')) return false;                // grupos: fuera de alcance
  if (jid.endsWith('@broadcast') || jid === 'status@broadcast') return false;
  if (jid.endsWith('@newsletter')) return false;          // canales
  return true;
}

async function handleIncoming(session, { messages, type }) {
  // 'append' son mensajes viejos que llegan al sincronizar: responderlos sería
  // contestar conversaciones de hace semanas al vincular el teléfono.
  if (type !== 'notify') return;

  // Import perezoso: el motor importa la cola, que importa los proveedores,
  // que importan este módulo. Cargarlo aquí rompe el ciclo.
  const engine = await import('../../services/engine.js');

  for (const raw of messages || []) {
    if (!isRelevant(raw)) continue;

    const message = normalizeIncoming(raw);
    if (!message?.from) continue;

    // Se guarda el evento antes de procesarlo, igual que en el webhook de
    // Cloud API: si el motor falla, queda constancia de qué llegó.
    const stored = await one(
      `INSERT INTO wa_events (account_id, wa_message_id, event_type, payload)
       VALUES ($1, $2, 'message', $3)
       ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [session.accountId, message.id, JSON.stringify({ channel: 'app', accountId: session.accountId, message })]
    );
    if (!stored) continue; // ya lo teníamos

    try {
      await engine.handleIncomingMessage({
        accountId: session.accountId,
        channel: 'app',
        message,
        contactProfile: { name: raw.pushName || '' },
        rawKey: raw.key,
        // El mensaje original hace falta entero para descargar el adjunto:
        // aquí el archivo va cifrado y no basta con un id como en Cloud API.
        rawMessage: raw,
      });
      await query('UPDATE wa_events SET processed_at = now() WHERE id = $1', [stored.id]);
    } catch (err) {
      await query('UPDATE wa_events SET processed_at = now(), error = $2 WHERE id = $1',
        [stored.id, err.message]);
      console.error(`[modo-app] mensaje ${message.id}:`, err.message);
    }
  }
}

/* ==========================================================================
   Trabajador
   ========================================================================== */

/**
 * Levanta las sesiones que deberían estar vivas y renueva los arrendamientos.
 *
 * Se ejecuta al arrancar y cada minuto: recoge las cuentas cuyo proceso murió
 * (arrendamiento caducado) y reabre las que se cayeron por un corte de red.
 */
export async function resumeSessions() {
  const { ok } = await available();
  if (!ok) return 0;

  const candidatas = await many(
    `SELECT s.account_id
       FROM wa_app_sessions s
       JOIN bot_settings b ON b.account_id = s.account_id
      WHERE b.wa_channel = 'app'
        AND s.status IN ('connected', 'connecting')
        AND (s.worker_id IS NULL OR s.worker_id = $1 OR s.lease_until IS NULL OR s.lease_until < now())
      LIMIT $2`,
    [config.appMode.workerId, config.appMode.maxSessions]
  );

  let abiertas = 0;
  for (const fila of candidatas) {
    if (sessions.has(fila.account_id)) continue;
    if (sessions.size >= config.appMode.maxSessions) break;
    try {
      await connect(fila.account_id);
      abiertas++;
    } catch (err) {
      console.error(`[modo-app] no se pudo reabrir ${fila.account_id}:`, err.message);
    }
  }

  if (abiertas) console.log(`[modo-app] ${abiertas} sesión(es) reabierta(s)`);
  return abiertas;
}

/** Caduca los QR que nadie escaneó: un QR viejo no sirve y confunde al panel. */
async function expireStaleQrs() {
  await query(
    `UPDATE wa_app_sessions
        SET qr_png = NULL, qr_expires_at = NULL, status = 'disconnected', updated_at = now()
      WHERE status = 'qr_pending' AND qr_expires_at IS NOT NULL
        AND qr_expires_at < now() - interval '2 minutes'`
  ).catch(() => {});
}

export function startWorker({ intervalMs = 60_000 } = {}) {
  if (!config.appMode.enabled) {
    console.log('[modo-app] desactivado por configuración (APP_MODE_ENABLED)');
    return () => {};
  }

  const tick = async () => {
    try {
      await renewLeases();
      await expireStaleQrs();
      await resumeSessions();
    } catch (err) {
      console.error('[modo-app] fallo del trabajador:', err.message);
    }
  };

  tick().catch(() => {});
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    // Al apagar se sueltan los sockets pero NO las credenciales: el cliente no
    // tiene que escanear nada tras un despliegue.
    await Promise.all([...sessions.keys()].map((id) => disconnect(id, { logout: false })));
  };
}

/* --- Utilidades ----------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Baileys espera un logger tipo pino. El suyo escribe cientos de líneas por
 * mensaje; aquí solo interesan los errores, que ya se registran por otra vía.
 */
function silentLogger() {
  const noop = () => {};
  const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  logger.child = () => logger;
  return logger;
}
