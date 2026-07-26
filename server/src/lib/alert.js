/**
 * Aviso de errores graves.
 *
 * `journalctl` no basta cuando ya hay clientes: hace falta enterarse de los
 * fallos sin tener que ir a mirar. Se limita a uno cada diez minutos por
 * mensaje, para que un fallo en bucle no se convierta en cien notificaciones.
 */

const avisados = new Map();

export async function avisarError(contexto, err) {
  const clave = `${contexto}:${err.message}`.slice(0, 200);
  const ahora = Date.now();
  if (ahora - (avisados.get(clave) || 0) < 600_000) return;
  avisados.set(clave, ahora);

  console.error(`[grave] ${contexto}: ${err.stack || err.message}`);

  // ALERT_WEBHOOK es opcional: sin él, esto se queda en avisar por consola
  // (journalctl / logs de Railway), que es mejor que nada mientras se
  // configura un canal real (correo, Telegram, tu propio WhatsApp…).
  if (process.env.ALERT_WEBHOOK) {
    fetch(process.env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `⚠️ Elorai · ${contexto}\n${err.message}` }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
