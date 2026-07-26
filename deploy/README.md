# Publicar Elorai

Guía completa desde cero: dominio, servidor, credenciales y despliegue.
Tiempo estimado la primera vez: **45–60 minutos**, casi todo esperando a que
propague el DNS.

---

## 0 · Qué vas a necesitar

| Cosa | Dónde | Coste |
|---|---|---|
| Dominio | Namecheap, Cloudflare, GoDaddy… | ~10 €/año |
| VPS | Hetzner, DigitalOcean, Vultr | 4–6 €/mes |
| Cuenta de Google Cloud | console.cloud.google.com | gratis |
| Cuenta de Stripe | dashboard.stripe.com | sin cuota fija |

**VPS recomendado:** Hetzner CX22 (2 vCPU, 4 GB RAM, ~4 €/mes) con **Ubuntu
24.04 LTS**. Sobra para miles de conversaciones diarias. DigitalOcean a 6 $/mes
es equivalente y tiene panel más sencillo.

### ¿Todavía no tienes dominio? Publica gratis para probar

Cloudflare no regala dominios — es DNS/CDN gratuito, pero el dominio en sí
cuesta en cualquier proveedor, incluido el registrador de Cloudflare (vende a
precio de costo, no gratis).

Para probar el sistema completo hoy mismo sin gastar nada, usa
**[sslip.io](https://sslip.io)**: resuelve automáticamente cualquier hostname
que contenga tu IP, sin registro ni cuenta.

```
IP del VPS: 203.0.113.45
Tu "dominio": 203-0-113-45.sslip.io
```

Es un dominio real a efectos prácticos — Let's Encrypt emite certificado válido,
y Google, Stripe y Meta lo aceptan sin problema, porque para ellos es solo una
URL HTTPS pública. Despliega igual que siempre, sustituyendo el dominio:

```bash
sudo bash deploy/deploy.sh 203-0-113-45.sslip.io
```

Y usa esa misma URL donde el resto de esta guía dice `tudominio.com` (Google
Cloud, Stripe, Meta).

**Límite:** sirve para el tramo de desarrollo y pruebas, contigo y unos pocos
testers — mientras tu app de Google esté en modo "Prueba" (hasta 100 usuarios
añadidos a mano) no exige dominio verificado. No sirve para el lanzamiento
público: nadie va a pagar una suscripción con confianza en una URL así, y
Google empezará a pedir verificación de dominio si pasas la app a producción.
Cuando compres el dominio real, repites `deploy.sh` con el nuevo nombre y
actualizas las tres URIs — cinco minutos.

---

## 1 · Servidor y DNS

> Si vas a usar sslip.io del paso anterior, sáltate el resto de esta sección:
> no hace falta comprar dominio ni configurar registros DNS.

Crea el VPS con Ubuntu 24.04 y anota su IP pública. Después, en el panel de tu
dominio, crea dos registros:

```
Tipo   Nombre   Valor
A      @        LA_IP_DE_TU_VPS
A      www      LA_IP_DE_TU_VPS
```

Comprueba que ya resuelve antes de seguir — si no, certbot fallará:

```bash
dig +short elorai.io      # debe devolver tu IP
```

Si usas Cloudflare, pon los registros en **DNS only** (nube gris) durante la
instalación. Puedes activar el proxy después de emitir el certificado.

---

## 2 · Credenciales de Google

1. Entra en <https://console.cloud.google.com> y crea un proyecto («Elorai»).
2. **APIs y servicios → Pantalla de consentimiento de OAuth**
   - Tipo de usuario: **Externo**
   - Nombre de la app, correo de asistencia y logotipo (usa `favicon-512.png`)
   - Dominios autorizados: `elorai.io`
   - Enlaces a `https://elorai.io/privacidad.html` y `https://elorai.io/terminos.html`
   - Permisos: solo `openid`, `email` y `profile` — con eso **no necesitas
     verificación de Google**, que es un trámite de semanas.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth**
   - Tipo: **Aplicación web**
   - Orígenes autorizados: `https://elorai.io`
   - URI de redirección autorizado:

     ```
     https://elorai.io/auth/google/callback
     ```

     Tiene que coincidir **carácter por carácter**, incluida la ausencia de
     barra final. Es el error más común y Google devuelve `redirect_uri_mismatch`.
4. Guarda el **Client ID** y el **Client Secret**.

> Mientras la app esté «en pruebas», solo entran los correos que añadas como
> usuarios de prueba. Publícala cuando vayas a abrir el registro.

---

## 3 · Stripe

1. **Productos** → crea «Elorai» con dos precios recurrentes:
   - Mensual → copia el id `price_…`
   - Anual → copia el id `price_…`
2. **Desarrolladores → Claves de API** → copia la clave secreta (`sk_live_…`).
3. **Desarrolladores → Webhooks → Añadir endpoint**:
   - URL: `https://elorai.io/api/billing/webhook`
   - Eventos:
     ```
     checkout.session.completed
     customer.subscription.created
     customer.subscription.updated
     customer.subscription.deleted
     invoice.paid
     invoice.payment_failed
     ```
   - Copia el **secreto de firma** (`whsec_…`).
4. **Configuración → Impuestos (Stripe Tax)**: actívalo y registra tus
   obligaciones fiscales. El checkout ya envía `automatic_tax: enabled`, pero
   sin activarlo en Stripe no calcula nada.
5. **Configuración → Portal de clientes**: actívalo y permite cambiar de plan y
   cancelar. Es lo que abre el botón «Gestionar suscripción» del panel.

> Para probar sin cobrar de verdad, usa las claves de test (`sk_test_…`) y la
> tarjeta `4242 4242 4242 4242`. El webhook de prueba se reenvía con
> `stripe listen --forward-to https://elorai.io/api/billing/webhook`.

---

## 4 · Desplegar

Conéctate por SSH y ejecuta:

```bash
ssh root@LA_IP_DE_TU_VPS

git clone https://github.com/fermon0318-collab/Bot-Inteligente-de-WA-con-IA.git /var/www/elorai
cd /var/www/elorai
sudo bash deploy/deploy.sh elorai.io
```

La primera pasada instala todo (nginx, PostgreSQL, Node, certbot), genera los
secretos y **se detiene** pidiéndote las credenciales. Complétalas:

```bash
sudo nano /etc/elorai/elorai.env
```

Rellena `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY` y `STRIPE_PRICE_YEARLY`.
Añade tu correo en `BILLING_BYPASS_EMAILS` para poder entrar sin pagarte a ti
mismo. Y vuelve a ejecutar:

```bash
sudo bash deploy/deploy.sh elorai.io
```

Es idempotente: para desplegar cambios futuros basta con repetir ese comando.

---

## 5 · Comprobar que quedó bien

```bash
curl -I https://elorai.io                    # 200 y cabeceras de seguridad
curl https://elorai.io/api/health            # {"ok":true,...}
curl -I https://elorai.io/dashboard.html     # 302 → /?login=required
systemctl status elorai                      # active (running)
```

Y en el navegador:

1. Entra en `https://elorai.io` → pulsa **Ingresar** → **Continuar con Google**.
2. Tras autorizar, deberías aterrizar en `/dashboard.html` con tu nombre y tu
   correo reales arriba a la derecha.
3. Cierra sesión y prueba a abrir `/dashboard.html` directamente: debe echarte.
4. Con un correo que **no** esté en `BILLING_BYPASS_EMAILS`, entra y pulsa un
   plan: debe llevarte al checkout de Stripe. Paga con la tarjeta de prueba y
   comprueba que vuelves al panel con la suscripción activa.

Si el paso 4 no actualiza el estado, el webhook no está llegando:
`journalctl -u elorai -f` y mira si aparece `[billing]`.

---

## 6 · Operación diaria

```bash
journalctl -u elorai -f            # registro en vivo
systemctl restart elorai           # reiniciar
sudo bash deploy/deploy.sh elorai.io   # desplegar cambios
```

**Copias de seguridad.** `deploy.sh` ya instala `elorai-backup.sh` y programa
un cron diario a las 03:15 (base de datos, `uploads/` y una copia de
`elorai.env`, todo en `/var/backups/elorai`). Ver el § 8 de abajo para
sacarlas del servidor y para probar la restauración — **una copia que nunca
restauraste no es una copia**.

Guarda también `/etc/elorai/elorai.env` en un gestor de contraseñas aparte.
Contiene `ENCRYPTION_KEY`: **si lo pierdes, los tokens de Meta y las API Key
de IA de tus clientes son irrecuperables** y tendrán que volver a
introducirlas.

**Renovación del certificado.** `certbot.timer` la hace sola. Verifica con
`systemctl list-timers | grep certbot`.

**Monitorización.** `GET /api/health` devuelve 503 si la base no responde —
dalo de alta en un servicio gratuito ([Uptime Kuma](https://uptime.kuma.pet)
autoalojado, o Better Stack) apuntando a `https://elorai.io/api/health`, y
configúralo para avisarte por un canal que sí revises (no un correo que nadie
lee a las 4 de la mañana). Además, de vez en cuando:

```bash
# Envíos atascados: si crece, algo va mal con Meta
psql $DATABASE_URL -c "SELECT count(*) FROM outbox WHERE status='pending' AND scheduled_at < now() - interval '10 minutes';"
# Eventos de WhatsApp sin procesar
psql $DATABASE_URL -c "SELECT count(*) FROM wa_events WHERE processed_at IS NULL;"
```

**Aviso de errores graves.** Define `ALERT_WEBHOOK` en `elorai.env` con la URL
de un webhook que acepte `POST {text}` (Slack, Discord, un relay a
Telegram…) y los 500 del servidor y los fallos de los trabajadores de fondo
te avisan solos, agrupados uno cada diez minutos como máximo por tipo de
error. Sin definirla, esos mismos avisos se quedan en `journalctl -u elorai`.

---

## 7 · Antes de abrir al público

- [ ] Sustituir los marcadores de `index.html` (`grep -n "\[[A-Z_]\+\]" index.html`)
- [ ] Completar y revisar legalmente `privacidad.html` y `terminos.html`
- [ ] Publicar la pantalla de consentimiento de Google
- [ ] Pasar Stripe de claves de prueba a producción
- [ ] Copias fuera del servidor configuradas (§ 8) y restauración probada una vez
- [ ] Actualizaciones de seguridad automáticas y SSH sin contraseña (§ 9)

### Tailwind ya está compilado

Los cuatro HTML cargan `assets/css/tailwind.css` (compilado, sin CDN ni
`'unsafe-eval'` en la CSP) en vez del `<script src="https://cdn.tailwindcss.com">`.
`deploy.sh` lo recompila solo en cada despliegue — no hace falta tocar nada a
mano. Si cambias clases de Tailwind en el HTML o en `assets/js/`, recuerda que
el CSS servido no se actualiza hasta el siguiente despliegue (o corriendo
`npm run build:css` a mano en local mientras desarrollas).

---

## 8 · Copias de seguridad: sácalas del servidor y prueba la restauración

`deploy.sh` ya deja `elorai-backup.sh` instalado y programado a diario. Una
copia en el mismo disco que la base no es una copia de verdad — sácala con
[rclone](https://rclone.org) a cualquier almacenamiento (S3, un VPS distinto,
Backblaze…):

```bash
sudo apt install rclone
sudo rclone config          # configura tu destino una vez ("remoto")
```

`elorai-backup.sh` detecta solo si ya hay un remoto configurado (`rclone
listremotes`) y sube ahí lo del día — no hace falta tocar el script.

**Prueba la restauración ahora, no cuando la necesites de verdad:**

```bash
sudo -u postgres createdb elorai_prueba
gunzip -c /var/backups/elorai/db-FECHA.sql.gz | sudo -u postgres psql elorai_prueba
sudo -u postgres psql elorai_prueba -c "SELECT count(*) FROM contacts;"
sudo -u postgres dropdb elorai_prueba
```

---

## 9 · Seguridad del servidor

Repaso rápido, de vez en cuando:

```bash
ls -l /etc/elorai/elorai.env     # esperado: -rw-r----- root elorai
sudo ss -tlnp | grep 5432        # PostgreSQL: solo 127.0.0.1, nunca 0.0.0.0
sudo ss -tlnp | grep 3000        # Node: solo 127.0.0.1 (nginx hace de puerta)
sudo ufw status                  # 22, 80, 443 y nada más — deploy.sh ya lo deja así
```

Actualizaciones de seguridad automáticas:

```bash
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

Acceso SSH solo con clave:

```bash
sudo nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin prohibit-password
sudo systemctl restart ssh
```

**Rotación de secretos.** Ten pensado qué harías si se filtra algo:

| Secreto | Cómo rotarlo | Consecuencia |
|---|---|---|
| `SESSION_SECRET` | Cambiar en `elorai.env` y reiniciar | Todos cierran sesión |
| `STRIPE_SECRET_KEY` | Nueva clave en Stripe | Ninguna si actualizas a la vez |
| `GOOGLE_CLIENT_SECRET` | Regenerar en Google Cloud | Ninguna |
| `ENCRYPTION_KEY` | **Requiere descifrar y recifrar todo** | Sin un script de migración, se pierden los tokens de todos los clientes |

Para `ENCRYPTION_KEY` en particular, escribe el script de migración **antes**
de necesitarlo: lee cada credencial con la clave vieja y la reescribe con la
nueva, dentro de una transacción.

---

## Problemas frecuentes

| Síntoma | Causa casi siempre |
|---|---|
| `redirect_uri_mismatch` | La URI de Google no coincide exactamente con `https://TUDOMINIO/auth/google/callback` |
| certbot falla | El DNS aún no propaga, o Cloudflare está en modo proxy |
| El panel redirige en bucle | `PUBLIC_URL` no coincide con el dominio real, o la cookie no es Secure porque no hay HTTPS |
| La suscripción no se activa | El webhook no llega: revisa la URL y el `whsec_` |
| nginx no arranca | Servidor sin IPv6 (deploy.sh lo detecta) o certificado inexistente |
| `502 Bad Gateway` | El servicio está caído: `journalctl -u elorai -n 50` |
