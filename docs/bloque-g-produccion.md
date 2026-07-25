# Bloque G · Endurecer para producción

Lo que hay que tener resuelto **antes** de que el sistema lleve dinero y datos
de clientes reales. No añade funciones: evita que un mal día se convierta en un
desastre.

**Tiempo estimado:** 4–6 horas repartidas.

---

## 1 · Copias de seguridad (lo más importante)

Sin esto, un borrado accidental o un disco corrupto se lleva las conversaciones
de todos tus clientes. Es lo primero que debes montar.

### Script

`/usr/local/bin/apolai-backup.sh` en el servidor:

```bash
#!/usr/bin/env bash
# Copia diaria de la base y de los archivos subidos.
set -euo pipefail

DESTINO=/var/backups/apolai
RETENCION_DIAS=30
FECHA=$(date +%F-%H%M)

mkdir -p "$DESTINO"

# Base de datos
sudo -u postgres pg_dump apolai | gzip > "$DESTINO/db-$FECHA.sql.gz"

# Archivos de los clientes
tar czf "$DESTINO/uploads-$FECHA.tar.gz" -C /var/www/apolai uploads

# Configuración: contiene ENCRYPTION_KEY, sin la cual el dump no sirve de nada
cp /etc/apolai/apolai.env "$DESTINO/env-$FECHA.bak"
chmod 600 "$DESTINO/env-$FECHA.bak"

# Limpieza
find "$DESTINO" -type f -mtime +$RETENCION_DIAS -delete

echo "$(date -Is) copia completada: $(du -sh "$DESTINO" | cut -f1)"
```

```bash
sudo chmod +x /usr/local/bin/apolai-backup.sh
sudo crontab -e
```

```cron
# Copia diaria a las 03:15
15 3 * * * /usr/local/bin/apolai-backup.sh >> /var/log/apolai-backup.log 2>&1
```

### Sácalas del servidor

Una copia en el mismo disco que la base no es una copia. Con
[rclone](https://rclone.org) a cualquier almacenamiento:

```bash
sudo apt install rclone
rclone config          # configura tu destino: "remoto"
```

Añade al final del script:

```bash
rclone copy "$DESTINO" remoto:apolai-backups --max-age 24h
```

### Prueba la restauración

**Una copia que nunca restauraste no es una copia.** Hazlo una vez, ahora:

```bash
sudo -u postgres createdb apolai_prueba
gunzip -c /var/backups/apolai/db-FECHA.sql.gz | sudo -u postgres psql apolai_prueba
sudo -u postgres psql apolai_prueba -c "SELECT count(*) FROM contacts;"
sudo -u postgres dropdb apolai_prueba
```

---

## 2 · Compilar Tailwind

En producción el CDN de Tailwind es lento y obliga a permitir `'unsafe-eval'`
en la política de seguridad de contenido.

```bash
cd /var/www/apolai
npm install -D tailwindcss@^3.4
npx tailwindcss -i tools/tailwind-input.css -o assets/css/tailwind.css --minify
```

En los cuatro HTML (`index`, `dashboard`, `privacidad`, `terminos`), sustituye:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { … };
</script>
```

por:

```html
<link rel="stylesheet" href="assets/css/tailwind.css" />
```

Y en `deploy/apolai-headers.conf`, quita de la CSP:

```
'unsafe-eval' https://cdn.tailwindcss.com
```

Recarga y comprueba en la consola del navegador que no hay violaciones de CSP.

> Añade el comando de compilación a `deploy.sh`, justo después del `npm ci`, o
> se te olvidará en el siguiente despliegue y el sitio quedará sin estilos.

---

## 3 · Monitorización

### Comprobación de vida

El endpoint ya existe: `GET /api/health` devuelve 503 si la base no responde.

Date de alta en un servicio gratuito de monitorización
([Uptime Kuma](https://uptime.kuma.pet) autoalojado, o Better Stack) y apunta a:

```
https://tudominio.com/api/health
```

Configúralo para que te avise por WhatsApp o Telegram. Un correo a las 4 de la
mañana no lo lee nadie.

### Qué vigilar además

```bash
# Envíos atascados: si esto crece, algo va mal con Meta
psql $DATABASE_URL -c "SELECT count(*) FROM outbox WHERE status='pending' AND scheduled_at < now() - interval '10 minutes';"

# Eventos sin procesar
psql $DATABASE_URL -c "SELECT count(*) FROM wa_events WHERE processed_at IS NULL;"

# Espacio en disco
df -h /
```

Un script sencillo que revise esto cada hora y te escriba si algo se pasa de
umbral vale más que cualquier panel sofisticado.

---

## 4 · Registro de errores agregado

Cuando tengas clientes, `journalctl` no basta: necesitas enterarte de los fallos
sin mirar.

Opción mínima sin dependencias, en `server/src/index.js`:

```js
/**
 * Aviso de errores graves.
 * Se limita a uno cada diez minutos por mensaje: un fallo en bucle no debe
 * convertirse en cien notificaciones.
 */
const avisados = new Map();

async function avisarError(contexto, err) {
  const clave = `${contexto}:${err.message}`.slice(0, 200);
  const ahora = Date.now();
  if (ahora - (avisados.get(clave) || 0) < 600_000) return;
  avisados.set(clave, ahora);

  console.error(`[grave] ${contexto}: ${err.stack || err.message}`);

  // Sustituye por tu canal: correo, Telegram, o tu propio WhatsApp
  if (process.env.ALERT_WEBHOOK) {
    fetch(process.env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `⚠️ ApolAI · ${contexto}\n${err.message}` }),
    }).catch(() => {});
  }
}
```

Úsalo en el manejador de errores para los 500 y en los `catch` de los
trabajadores.

Si prefieres algo hecho: [Sentry](https://sentry.io) tiene plan gratuito y son
diez líneas de integración.

---

## 5 · Rotación de registros

El log de nginx crece sin freno. Ubuntu ya trae `logrotate`, pero comprueba que
cubre lo tuyo:

```bash
cat /etc/logrotate.d/nginx    # debería existir
```

Para el log de copias:

`/etc/logrotate.d/apolai`

```
/var/log/apolai-backup.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
}
```

---

## 6 · Límites y abuso

### En nginx (ya configurado)

`deploy/nginx.conf` limita `/auth/` a 20 peticiones por minuto y `/api/` a 120.
Revisa que sigue teniendo sentido con tu volumen real.

### Coste de la IA

Un cliente con un bucle mal configurado puede quemar su presupuesto de IA en
horas. Añade un tope por cuenta:

```sql
-- Migración 007
ALTER TABLE bot_settings
    ADD COLUMN ai_daily_limit integer NOT NULL DEFAULT 500;

CREATE TABLE ai_usage (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date        date NOT NULL DEFAULT current_date,
  calls       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, date)
);
```

En `services/ai.js`, antes de llamar al proveedor:

```js
const uso = await one(
  `INSERT INTO ai_usage (account_id, date, calls) VALUES ($1, current_date, 1)
   ON CONFLICT (account_id, date) DO UPDATE SET calls = ai_usage.calls + 1
   RETURNING calls`,
  [accountId]
);

const limite = await one(
  'SELECT ai_daily_limit FROM bot_settings WHERE account_id = $1', [accountId]);

if (uso.calls > limite.ai_daily_limit) {
  await query(
    `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'warn', $2)`,
    [accountId, `Límite diario de IA alcanzado (${limite.ai_daily_limit} respuestas)`]);
  return null;
}
```

### Comprobantes

Igual: limita a un comprobante por contacto cada pocos minutos, o alguien puede
mandarte cien fotos y pagarás cien lecturas.

---

## 7 · Seguridad

### Repaso de configuración

```bash
# ¿El .env es solo legible por quien debe?
ls -l /etc/apolai/apolai.env     # esperado: -rw-r----- root apolai

# ¿PostgreSQL está cerrado al exterior?
sudo ss -tlnp | grep 5432        # debe decir 127.0.0.1, nunca 0.0.0.0

# ¿El cortafuegos solo deja pasar lo necesario?
sudo ufw status                  # 22, 80, 443 y nada más

# ¿Node escucha solo en local?
sudo ss -tlnp | grep 3000        # 127.0.0.1:3000
```

### Actualizaciones automáticas de seguridad

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### Acceso SSH

```bash
# Desactiva la contraseña, deja solo clave
sudo nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin prohibit-password
sudo systemctl restart ssh
```

### Rotación de secretos

Ten pensado qué harías si se filtra algo:

| Secreto | Cómo rotarlo | Consecuencia |
|---|---|---|
| `SESSION_SECRET` | Cambiar y reiniciar | Todos cierran sesión |
| `STRIPE_SECRET_KEY` | Nueva clave en Stripe | Ninguna si actualizas a la vez |
| `GOOGLE_CLIENT_SECRET` | Regenerar en Google Cloud | Ninguna |
| `ENCRYPTION_KEY` | **Requiere descifrar y recifrar todo** | Sin el proceso, se pierden los tokens de todos los clientes |

Para `ENCRYPTION_KEY`, escribe el script de migración **antes** de necesitarlo:
lee con la clave vieja, escribe con la nueva, dentro de una transacción.

---

## 8 · Pruebas automatizadas

Node trae ejecutor de pruebas desde la versión 18. Sin dependencias:

`server/test/flows.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/services/flows.js';

test('normalize quita acentos y signos', () => {
  assert.equal(normalize('¿Cuál es el PRECIO?'), 'cual es el precio');
  assert.equal(normalize('  Información   '), 'informacion');
});

test('normalize tolera entradas vacías', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});
```

`server/test/remarketing.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dentroDeFranja } from '../src/services/remarketing.js';

test('franja normal', () => {
  const a = new Date('2026-07-25T18:00:00Z');   // 12:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '09:00', fin: '21:00', timezone: 'America/Mexico_City', ahora: a }), true);
});

test('franja que cruza medianoche', () => {
  const a = new Date('2026-07-25T07:00:00Z');   // 01:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '22:00', fin: '02:00', timezone: 'America/Mexico_City', ahora: a }), true);
});
```

En `package.json`:

```json
"scripts": {
  "test": "node --test test/"
}
```

```bash
npm test
```

Prioriza probar lo que **da miedo tocar**: coincidencia de disparadores,
comparación de montos con reglas, franjas horarias y el cálculo de la ventana de
24 h. La interfaz cambia mucho y no compensa.

---

## 9 · Antes de abrir al público

```
[ ] Copias diarias funcionando Y restauración probada una vez
[ ] ENCRYPTION_KEY guardada fuera del servidor
[ ] Tailwind compilado, 'unsafe-eval' fuera de la CSP
[ ] Monitorización avisando a un canal que sí lees
[ ] Marcadores de index.html sustituidos
[ ] Privacidad y términos revisados por un abogado
[ ] Pantalla de consentimiento de Google publicada
[ ] Stripe en claves de producción
[ ] BILLING_BYPASS_EMAILS solo con tus correos
[ ] Bloque de "Resultados esperables" con datos reales o eliminado
[ ] Actualizaciones de seguridad automáticas
[ ] SSH sin contraseña
[ ] Probado el recorrido completo con un número real y una tarjeta real
```

---

## 10 · Cuando crezcas

No lo hagas antes de necesitarlo, pero ten claro qué toca:

| Señal | Qué hacer |
|---|---|
| El servidor va justo de CPU | Subir de plan antes que complicar la arquitectura |
| Muchos envíos en cola | Subir la frecuencia del trabajador o procesar en tandas mayores |
| Varias instancias de Node | El límite de peticiones en memoria deja de servir: mover a Redis |
| La base va lenta | `EXPLAIN ANALYZE` sobre las consultas del panel antes de añadir índices a ciegas |
| Muchas conversaciones antiguas | Archivar mensajes de más de un año en otra tabla |
| Clientes con equipos | Añadir usuarios por cuenta: el esquema ya lo contempla con `users.account_id` |
