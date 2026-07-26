/**
 * Remarketing programado.
 *
 * Se ejecuta cada pocos minutos y busca contactos que se enfriaron. La franja
 * horaria se respeta en la zona horaria de cada cuenta: escribirle a alguien a
 * las 3 de la mañana es la mejor forma de que te reporte, y unos cuantos
 * reportes bajan la calidad del número ante Meta.
 */

import { many, query } from '../db/pool.js';
import { enqueue } from './outbox.js';

/**
 * ¿Es hora permitida en la zona de la cuenta?
 * Se compara en minutos desde medianoche para que funcione igual con franjas
 * normales (09:00–21:00) y nocturnas (22:00–02:00).
 */
export function dentroDeFranja({ inicio, fin, timezone, ahora = new Date() }) {
  const hhmm = new Intl.DateTimeFormat('es-MX', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ahora);

  const aMinutos = (s) => {
    const [h, m] = String(s).slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  };

  const actual = aMinutos(hhmm);
  const desde = aMinutos(inicio);
  const hasta = aMinutos(fin);

  return desde <= hasta
    ? actual >= desde && actual < hasta
    : actual >= desde || actual < hasta;   // franja que cruza medianoche
}

/** Cuentas con remarketing activo y al menos un paso configurado. */
async function cuentasActivas() {
  return many(
    `SELECT s.account_id, s.rm_hours, s.rm_minutes, s.rm_window_start,
            s.rm_window_end, s.rm_timezone
       FROM bot_settings s
      WHERE s.rm_enabled = true
        AND s.bot_running = true
        AND EXISTS (SELECT 1 FROM remarketing_steps r WHERE r.account_id = s.account_id)`
  );
}

/** Contactos que cumplen todas las condiciones para recibir remarketing. */
async function candidatos({ accountId, minutosEspera }) {
  return many(
    `SELECT c.id, c.phone, c.name
       FROM contacts c
      WHERE c.account_id = $1
        AND c.status IN ('new', 'pending')
        AND c.automation_off = false
        AND c.last_inbound_at IS NOT NULL
        AND c.last_inbound_at <= now() - make_interval(mins => $2)
        -- Nada de perseguir contactos de hace un mes
        AND c.last_inbound_at > now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM remarketing_sends s
           WHERE s.account_id = c.account_id AND s.contact_id = c.id
        )
        -- Si tiene algo pendiente de enviarse, aún está en conversación
        AND NOT EXISTS (
          SELECT 1 FROM outbox o
           WHERE o.contact_id = c.id AND o.status = 'pending'
        )
      LIMIT 100`,
    [accountId, minutosEspera]
  );
}

/** Encola la secuencia para un contacto. */
async function enviarSecuencia({ accountId, contactId, pasos }) {
  let retraso = 0;
  let encolados = 0;

  for (const paso of pasos) {
    if (paso.step_type === 'delay') {
      retraso += Math.max(0, Number(paso.value) || 0);
      continue;
    }
    if (!String(paso.value || '').trim()) continue;

    await enqueue({
      accountId, contactId,
      kind: paso.step_type === 'file' ? 'media' : 'text',
      body: paso.step_type === 'file' ? '' : paso.value,
      mediaName: paso.step_type === 'file' ? paso.value : null,
      origin: 'remarketing',
      delaySeconds: retraso,
    });
    encolados++;
    retraso += 3;
  }

  await query(
    `INSERT INTO remarketing_sends (account_id, contact_id, steps_queued)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [accountId, contactId, encolados]
  );

  return encolados;
}

/** Una pasada completa. Devuelve cuántos contactos recibieron secuencia. */
export async function run() {
  const cuentas = await cuentasActivas();
  let total = 0;

  for (const cuenta of cuentas) {
    const enHora = dentroDeFranja({
      inicio: cuenta.rm_window_start,
      fin: cuenta.rm_window_end,
      timezone: cuenta.rm_timezone,
    });
    // Fuera de la franja no se hace nada: en la siguiente pasada seguirán ahí
    if (!enHora) continue;

    const pasos = await many(
      `SELECT step_type, value FROM remarketing_steps
        WHERE account_id = $1 ORDER BY position`,
      [cuenta.account_id]
    );
    if (!pasos.length) continue;

    const espera = (Number(cuenta.rm_hours) || 0) * 60 + (Number(cuenta.rm_minutes) || 0);
    if (espera <= 0) continue;

    const lista = await candidatos({ accountId: cuenta.account_id, minutosEspera: espera });

    for (const contacto of lista) {
      const n = await enviarSecuencia({
        accountId: cuenta.account_id, contactId: contacto.id, pasos,
      });
      if (n) total++;
    }

    if (lista.length) {
      await query(
        `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'info', $2)`,
        [cuenta.account_id, `Remarketing enviado a ${lista.length} contacto(s)`]
      );
    }
  }

  return total;
}

/** Arranca el trabajador. Devuelve una función para detenerlo. */
export function startWorker({ intervalMs = 5 * 60 * 1000 } = {}) {
  let corriendo = false;

  const timer = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const n = await run();
      if (n) console.log(`[remarketing] secuencia enviada a ${n} contacto(s)`);
    } catch (err) {
      console.error('[remarketing] fallo:', err.message);
    } finally {
      corriendo = false;
    }
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
