/**
 * Recordatorios automáticos de citas.
 *
 * Cuando una cita se acordó hace días, escribirle al cliente con texto libre
 * ya no funciona: Meta rechaza cualquier mensaje pasadas 24 h desde el último
 * del cliente, y él nunca se entera. Por eso el recordatorio se envía como
 * plantilla aprobada, que es la única vía válida fuera de esa ventana.
 *
 * El trabajador busca citas que empiezan dentro de las próximas N horas y
 * todavía no se avisaron. `reminder_sent_at` es lo que evita reenviar el
 * mismo recordatorio en cada pasada.
 */

import { many, one, query } from '../db/pool.js';
import { avisarError } from '../lib/alert.js';
import * as engine from './engine.js';

/** Fecha y hora legibles en la zona horaria del negocio, no la del servidor. */
function formatoLocal(fecha, timezone) {
  const tz = timezone || 'America/Bogota';
  const dia = new Intl.DateTimeFormat('es-CO', {
    timeZone: tz, day: '2-digit', month: 'long',
  }).format(fecha);
  const hora = new Intl.DateTimeFormat('es-CO', {
    timeZone: tz, hour: '2-digit', minute: '2-digit',
  }).format(fecha);
  return { dia, hora };
}

/**
 * Busca el contacto de WhatsApp de un cliente de la agenda por su teléfono.
 * Si nunca escribió al negocio no existe como contacto, así que se crea: sin
 * eso no habría a quién enviarle el recordatorio.
 */
async function contactoDeCliente({ accountId, phone, name }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  const row = await one(
    `INSERT INTO contacts (account_id, phone, name, source)
     VALUES ($1, $2, $3, 'agenda')
     ON CONFLICT (account_id, phone) DO UPDATE SET
       name = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END
     RETURNING id`,
    [accountId, digits, name || '']
  );
  return row?.id || null;
}

/** Envía los recordatorios que toquen. Devuelve el recuento. */
export async function run() {
  // Solo cuentas con recordatorios encendidos Y plantilla elegida: sin
  // plantilla no hay forma legal de escribir fuera de la ventana.
  const cuentas = await many(
    `SELECT s.account_id, s.reminder_hours, s.rm_timezone,
            t.id AS template_id, t.name, t.language, t.body, t.variables
       FROM bot_settings s
       JOIN wa_templates t ON t.id = s.reminder_template_id
      WHERE s.reminder_enabled = true AND s.wa_connected = true`
  );

  let enviados = 0;

  for (const cuenta of cuentas) {
    // Citas que empiezan dentro de la ventana de aviso y siguen vigentes.
    // Se excluyen las canceladas y las que ya pasaron: recordar algo que ya
    // ocurrió solo molesta al cliente.
    const citas = await many(
      `SELECT a.id, a.starts_at, c.name AS client_name, c.phone,
              COALESCE(sv.name, 'tu cita') AS service_name
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
    LEFT JOIN services sv ON sv.id = a.service_id
        WHERE a.account_id = $1
          AND a.reminder_sent_at IS NULL
          AND a.status NOT IN ('cancelada', 'no_asistio')
          AND a.starts_at > now()
          AND a.starts_at <= now() + make_interval(hours => $2)
        LIMIT 50`,
      [cuenta.account_id, cuenta.reminder_hours]
    );

    for (const cita of citas) {
      try {
        const contactId = await contactoDeCliente({
          accountId: cuenta.account_id, phone: cita.phone, name: cita.client_name,
        });

        if (!contactId) {
          // Sin teléfono válido no hay recordatorio posible. Se marca igual
          // para no reintentarlo en cada pasada durante horas.
          await query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [cita.id]);
          continue;
        }

        const { dia, hora } = formatoLocal(new Date(cita.starts_at), cuenta.rm_timezone);
        // Orden fijo, el mismo que documenta la plantilla del catálogo:
        // nombre, servicio, fecha, hora. Se recorta a lo que pida la
        // plantilla registrada — Meta rechaza el envío si sobran o faltan.
        const values = [cita.client_name, cita.service_name, dia, hora].slice(0, cuenta.variables);

        await engine.sendTemplateTo({
          accountId: cuenta.account_id,
          contactId,
          template: { name: cuenta.name, language: cuenta.language, body: cuenta.body },
          values,
        });

        await query('UPDATE appointments SET reminder_sent_at = now() WHERE id = $1', [cita.id]);
        enviados++;
      } catch (err) {
        console.error(`[recordatorios] cita ${cita.id}: ${err.message}`);
      }
    }
  }

  return enviados;
}

export function startWorker({ intervalMs = 10 * 60 * 1000 } = {}) {
  let corriendo = false;

  const timer = setInterval(async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const n = await run();
      if (n) console.log(`[recordatorios] ${n} recordatorio(s) de cita enviados`);
    } catch (err) {
      console.error('[recordatorios] fallo:', err.message);
      avisarError('reminders.startWorker', err).catch(() => {});
    } finally {
      corriendo = false;
    }
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
