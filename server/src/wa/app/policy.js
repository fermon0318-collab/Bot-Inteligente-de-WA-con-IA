/**
 * Guardián de políticas de Meta para Modo App.
 *
 * Modo App no pasa por la infraestructura de Meta, pero sí está sujeto a sus
 * normas: la Política de Mensajería de WhatsApp Business y las Condiciones de
 * WhatsApp Business prohíben igual el envío masivo no solicitado, la
 * automatización que suplanta a una persona sin avisar y el uso de clientes no
 * autorizados. Lo que cambia no es la norma, es quién la hace cumplir: no hay
 * un error 131_047 que frene al cliente, hay una restricción de la cuenta
 * cuando ya es tarde.
 *
 * Este módulo mira el comportamiento real de cada cuenta y avisa ANTES. Los
 * patrones que WhatsApp usa para restringir cuentas son públicos y conocidos:
 *
 *   · muchos mensajes en muy poco tiempo (ráfaga)
 *   · el mismo texto exacto a muchos destinatarios distintos
 *   · escribir a gente que nunca escribió primero (contacto en frío)
 *   · una proporción alta de conversaciones sin respuesta — el mejor
 *     indicador indirecto de bloqueos y reportes, que WhatsApp no nos cuenta
 *   · automatización total, sin ninguna intervención humana
 *   · envíos en horario nocturno
 *   · desequilibrio entre lo que se envía y lo que se recibe
 *
 * Cada patrón produce un `policy_event`. Los graves además pausan los envíos:
 * es preferible que el bot deje de responder una hora a que el cliente pierda
 * el número donde tiene años de historial.
 */

import { many, one, query } from '../../db/pool.js';

/** No repetir el mismo aviso una y otra vez mientras el usuario no lo lea. */
const COOLDOWN_MINUTES = 60;

/**
 * Umbrales. Son deliberadamente conservadores: el cliente típico de Modo App
 * es un negocio de servicios que contesta a quien le escribe, así que cruzar
 * uno de estos números casi siempre significa que algo se configuró mal.
 */
export const THRESHOLDS = {
  // Ráfaga: mensajes en 60 s y en 5 min.
  burstPerMinute: 25,
  burstPer5Minutes: 80,
  // Mismo texto a N contactos distintos en 24 h.
  identicalContacts: 15,
  // Destinatarios que nunca escribieron primero, en 24 h, y su proporción.
  coldContacts: 10,
  coldRatio: 0.3,
  // Proporción de contactos escritos en 24 h que no contestaron nada.
  noReplyRatio: 0.6,
  noReplyMinContacts: 15,
  // Salientes por cada entrante en 24 h.
  outboundRatio: 4,
  outboundMinMessages: 40,
  // Franja considerada nocturna en la zona horaria del negocio.
  nightStartHour: 22,
  nightEndHour: 7,
  nightMessages: 10,
};

/* ==========================================================================
   Detectores
   ========================================================================== */

/**
 * Cada detector devuelve `null` o un hallazgo
 * `{ code, severity, score, message, detail }`.
 *
 * `severity: 'critical'` implica pausa automática de los envíos.
 */

async function detectBurst(accountId) {
  const row = await one(
    `SELECT
       count(*) FILTER (WHERE sent_at > now() - interval '1 minute')  AS m1,
       count(*) FILTER (WHERE sent_at > now() - interval '5 minutes') AS m5
     FROM wa_app_sends WHERE account_id = $1 AND sent_at > now() - interval '5 minutes'`,
    [accountId]
  );
  const m1 = Number(row?.m1 || 0);
  const m5 = Number(row?.m5 || 0);

  if (m1 < THRESHOLDS.burstPerMinute && m5 < THRESHOLDS.burstPer5Minutes) return null;

  return {
    code: 'rafaga',
    severity: 'critical',
    score: 90,
    message: `Se enviaron ${m1} mensajes en el último minuto y ${m5} en cinco minutos. `
      + 'WhatsApp interpreta este ritmo como envío masivo y es la causa más frecuente de '
      + 'restricción de una cuenta. Pausamos los envíos para protegerte.',
    detail: { lastMinute: m1, last5Minutes: m5 },
  };
}

async function detectIdentical(accountId) {
  const row = await one(
    `SELECT body_hash, count(DISTINCT contact_id) AS contactos
       FROM wa_app_sends
      WHERE account_id = $1 AND sent_at > now() - interval '24 hours'
        AND body_hash <> '' AND contact_id IS NOT NULL
      GROUP BY body_hash
      ORDER BY contactos DESC
      LIMIT 1`,
    [accountId]
  );
  const contactos = Number(row?.contactos || 0);
  if (contactos < THRESHOLDS.identicalContacts) return null;

  return {
    code: 'identicos',
    severity: contactos >= THRESHOLDS.identicalContacts * 2 ? 'critical' : 'warn',
    score: Math.min(95, 40 + contactos * 2),
    message: `El mismo mensaje se envió a ${contactos} contactos distintos en 24 horas. `
      + 'Los mensajes idénticos en volumen son el patrón que más reportes genera. '
      + 'Personaliza el texto (nombre, servicio, fecha) o reduce el alcance.',
    detail: { contactos },
  };
}

async function detectCold(accountId) {
  const row = await one(
    `SELECT
       count(DISTINCT contact_id) FILTER (WHERE inbound_first = false) AS frios,
       count(DISTINCT contact_id)                                      AS total
     FROM wa_app_sends
     WHERE account_id = $1 AND sent_at > now() - interval '24 hours' AND contact_id IS NOT NULL`,
    [accountId]
  );
  const frios = Number(row?.frios || 0);
  const total = Number(row?.total || 0);
  if (!total || frios < THRESHOLDS.coldContacts) return null;

  const ratio = frios / total;
  if (ratio < THRESHOLDS.coldRatio) return null;

  return {
    code: 'desconocidos',
    severity: ratio > 0.7 ? 'critical' : 'warn',
    score: Math.round(40 + ratio * 50),
    message: `${frios} de ${total} contactos de las últimas 24 horas nunca te habían escrito. `
      + 'Escribir primero a personas que no iniciaron la conversación es exactamente lo que '
      + 'WhatsApp considera mensajería no solicitada, aunque el contenido sea legítimo.',
    detail: { frios, total, ratio: Number(ratio.toFixed(2)) },
  };
}

async function detectNoReply(accountId) {
  // Contactos a los que se escribió en 24 h y que no respondieron después.
  const row = await one(
    `WITH escritos AS (
       SELECT DISTINCT contact_id, min(sent_at) AS primer_envio
         FROM wa_app_sends
        WHERE account_id = $1 AND sent_at > now() - interval '24 hours' AND contact_id IS NOT NULL
        GROUP BY contact_id
     )
     SELECT
       count(*) AS total,
       count(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1 FROM messages m
            WHERE m.contact_id = escritos.contact_id
              AND m.direction = 'in'
              AND m.created_at > escritos.primer_envio
         )
       ) AS sin_respuesta
     FROM escritos`,
    [accountId]
  );
  const total = Number(row?.total || 0);
  const sinRespuesta = Number(row?.sin_respuesta || 0);
  if (total < THRESHOLDS.noReplyMinContacts) return null;

  const ratio = sinRespuesta / total;
  if (ratio < THRESHOLDS.noReplyRatio) return null;

  return {
    code: 'sin_respuesta',
    severity: 'warn',
    score: Math.round(30 + ratio * 40),
    message: `${sinRespuesta} de ${total} contactos no respondieron a tus mensajes. `
      + 'WhatsApp no nos dice cuántos te bloquearon o reportaron, pero una tasa alta de '
      + 'silencio suele ir de la mano. Revisa a quién estás escribiendo.',
    detail: { sinRespuesta, total, ratio: Number(ratio.toFixed(2)) },
  };
}

async function detectAutomation(accountId) {
  const row = await one(
    `SELECT
       count(*)                                          AS total,
       count(*) FILTER (WHERE origin = 'manual')         AS manuales
     FROM wa_app_sends
     WHERE account_id = $1 AND sent_at > now() - interval '24 hours'`,
    [accountId]
  );
  const total = Number(row?.total || 0);
  const manuales = Number(row?.manuales || 0);
  if (total < 60) return null;
  if (manuales / total >= 0.05) return null;

  return {
    code: 'automatizacion',
    severity: 'warn',
    score: 45,
    message: `${total} mensajes en 24 horas sin ninguna intervención humana. `
      + 'La política de WhatsApp exige que quede claro que hay automatización y que exista '
      + 'una vía para hablar con una persona. Entra al Chat en Vivo de vez en cuando y '
      + 'asegúrate de que el bot ofrece pasar con un humano.',
    detail: { total, manuales },
  };
}

async function detectNightSending(accountId, timezone = 'America/Mexico_City') {
  const row = await one(
    `SELECT count(*) AS nocturnos
       FROM wa_app_sends
      WHERE account_id = $1
        AND sent_at > now() - interval '24 hours'
        AND (
          extract(hour FROM sent_at AT TIME ZONE $2) >= $3
          OR extract(hour FROM sent_at AT TIME ZONE $2) < $4
        )`,
    [accountId, timezone, THRESHOLDS.nightStartHour, THRESHOLDS.nightEndHour]
  );
  const nocturnos = Number(row?.nocturnos || 0);
  if (nocturnos < THRESHOLDS.nightMessages) return null;

  return {
    code: 'horario',
    severity: 'info',
    score: 20,
    message: `${nocturnos} mensajes salieron entre las ${THRESHOLDS.nightStartHour}:00 y las `
      + `${THRESHOLDS.nightEndHour}:00. Escribir de madrugada multiplica los bloqueos y los `
      + 'reportes. Configura la ventana horaria de tus flujos y del remarketing.',
    detail: { nocturnos, timezone },
  };
}

async function detectOutboundRatio(accountId) {
  const row = await one(
    `SELECT
       count(*) FILTER (WHERE direction IN ('out','bot')) AS salientes,
       count(*) FILTER (WHERE direction = 'in')            AS entrantes
     FROM messages
     WHERE account_id = $1 AND created_at > now() - interval '24 hours'`,
    [accountId]
  );
  const salientes = Number(row?.salientes || 0);
  const entrantes = Number(row?.entrantes || 0);
  if (salientes < THRESHOLDS.outboundMinMessages) return null;

  const ratio = salientes / Math.max(1, entrantes);
  if (ratio < THRESHOLDS.outboundRatio) return null;

  return {
    code: 'ratio_saliente',
    severity: 'warn',
    score: Math.min(80, Math.round(ratio * 12)),
    message: `Enviaste ${salientes} mensajes y recibiste ${entrantes} en 24 horas `
      + `(${ratio.toFixed(1)} a 1). Una cuenta sana conversa; una que solo emite se parece a `
      + 'una lista de difusión, y así la clasifica WhatsApp.',
    detail: { salientes, entrantes, ratio: Number(ratio.toFixed(2)) },
  };
}

const DETECTORS = [
  detectBurst,
  detectIdentical,
  detectCold,
  detectNoReply,
  detectAutomation,
  detectOutboundRatio,
];

/* ==========================================================================
   Evaluación
   ========================================================================== */

/**
 * Pasa todos los detectores sobre una cuenta y registra lo que encuentre.
 *
 * Devuelve `{ findings, paused, score }`. `score` es el máximo de los
 * hallazgos: es lo que el panel pinta como semáforo de salud del número.
 */
export async function evaluate(accountId, { timezone } = {}) {
  const findings = [];

  for (const detector of DETECTORS) {
    try {
      const finding = await detector(accountId);
      if (finding) findings.push(finding);
    } catch (err) {
      console.error(`[politicas] fallo en ${detector.name}:`, err.message);
    }
  }

  try {
    const night = await detectNightSending(accountId, timezone);
    if (night) findings.push(night);
  } catch (err) {
    console.error('[politicas] fallo en detectNightSending:', err.message);
  }

  let paused = false;

  for (const finding of findings) {
    const registered = await record(accountId, finding);
    // Solo se pausa cuando el aviso es nuevo: si el usuario ya lo vio y decidió
    // seguir, no se le vuelve a frenar cada vuelta del trabajador.
    if (registered && finding.severity === 'critical') {
      paused = true;
      await pauseSending(accountId, finding.message);
    }
  }

  return {
    findings,
    paused,
    score: findings.reduce((max, f) => Math.max(max, f.score), 0),
  };
}

/**
 * Guarda un hallazgo si no hay ya uno igual sin reconocer y reciente.
 * Devuelve true si se registró (es decir, si es una novedad).
 */
export async function record(accountId, finding) {
  const reciente = await one(
    `SELECT 1 FROM policy_events
      WHERE account_id = $1 AND code = $2
        AND created_at > now() - make_interval(mins => $3)
      LIMIT 1`,
    [accountId, finding.code, COOLDOWN_MINUTES]
  );
  if (reciente) return false;

  await query(
    `INSERT INTO policy_events (account_id, code, severity, score, message, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [accountId, finding.code, finding.severity, finding.score, finding.message,
     JSON.stringify(finding.detail || {})]
  );

  // El aviso también entra en la terminal de actividad: es donde el cliente
  // mira cuando algo va raro.
  await query(
    `INSERT INTO activity_log (account_id, level, message) VALUES ($1, $2, $3)`,
    [accountId, finding.severity === 'info' ? 'warn' : 'err', `Política de Meta · ${finding.message}`]
  );

  return true;
}

/** Freno de emergencia: deja de enviar hasta que el usuario lo reanude. */
export async function pauseSending(accountId, reason) {
  await query(
    `UPDATE wa_app_sessions SET paused = true, paused_reason = $2, updated_at = now()
      WHERE account_id = $1`,
    [accountId, String(reason).slice(0, 500)]
  );
}

/** Reanuda tras leer el aviso. Lo hace el usuario a mano, a propósito. */
export async function resumeSending(accountId) {
  await query(
    `UPDATE wa_app_sessions SET paused = false, paused_reason = NULL, updated_at = now()
      WHERE account_id = $1`,
    [accountId]
  );
  await query(
    `UPDATE policy_events SET acknowledged_at = now()
      WHERE account_id = $1 AND acknowledged_at IS NULL`,
    [accountId]
  );
}

/** Avisos abiertos, para el panel. */
export async function openEvents(accountId, { limit = 20 } = {}) {
  return many(
    `SELECT id, code, severity, score, message, detail, created_at
       FROM policy_events
      WHERE account_id = $1 AND acknowledged_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [accountId, limit]
  );
}

/** Marca un aviso como leído sin reanudar nada. */
export async function acknowledge(accountId, eventId) {
  const { rowCount } = await query(
    `UPDATE policy_events SET acknowledged_at = now()
      WHERE account_id = $1 AND id = $2 AND acknowledged_at IS NULL`,
    [accountId, eventId]
  );
  return rowCount > 0;
}

/**
 * Trabajador periódico: revisa las cuentas con Modo App activo.
 *
 * Cada 5 minutos es suficiente — los detectores miran ventanas de 24 h salvo
 * el de ráfaga, que además ya está contenido por los límites de `pacing.js`.
 */
export function startWorker({ intervalMs = 5 * 60 * 1000 } = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cuentas = await many(
        `SELECT s.account_id, b.rm_timezone
           FROM wa_app_sessions s
           JOIN bot_settings b ON b.account_id = s.account_id
          WHERE b.wa_channel = 'app' AND s.status = 'connected'`
      );
      for (const cuenta of cuentas) {
        await evaluate(cuenta.account_id, { timezone: cuenta.rm_timezone }).catch((err) => {
          console.error(`[politicas] cuenta ${cuenta.account_id}:`, err.message);
        });
      }
    } catch (err) {
      console.error('[politicas] fallo del trabajador:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
