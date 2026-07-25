# Publicar ApolAI

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

---

## 1 · Servidor y DNS

Crea el VPS con Ubuntu 24.04 y anota su IP pública. Después, en el panel de tu
dominio, crea dos registros:

```
Tipo   Nombre   Valor
A      @        LA_IP_DE_TU_VPS
A      www      LA_IP_DE_TU_VPS
```

Comprueba que ya resuelve antes de seguir — si no, certbot fallará:

```bash
dig +short apolai.io      # debe devolver tu IP
```

Si usas Cloudflare, pon los registros en **DNS only** (nube gris) durante la
instalación. Puedes activar el proxy después de emitir el certificado.

---

## 2 · Credenciales de Google

1. Entra en <https://console.cloud.google.com> y crea un proyecto («ApolAI»).
2. **APIs y servicios → Pantalla de consentimiento de OAuth**
   - Tipo de usuario: **Externo**
   - Nombre de la app, correo de asistencia y logotipo (usa `favicon-512.png`)
   - Dominios autorizados: `apolai.io`
   - Enlaces a `https://apolai.io/privacidad.html` y `https://apolai.io/terminos.html`
   - Permisos: solo `openid`, `email` y `profile` — con eso **no necesitas
     verificación de Google**, que es un trámite de semanas.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth**
   - Tipo: **Aplicación web**
   - Orígenes autorizados: `https://apolai.io`
   - URI de redirección autorizado:

     ```
     https://apolai.io/auth/google/callback
     ```

     Tiene que coincidir **carácter por carácter**, incluida la ausencia de
     barra final. Es el error más común y Google devuelve `redirect_uri_mismatch`.
4. Guarda el **Client ID** y el **Client Secret**.

> Mientras la app esté «en pruebas», solo entran los correos que añadas como
> usuarios de prueba. Publícala cuando vayas a abrir el registro.

---

## 3 · Stripe

1. **Productos** → crea «ApolAI» con dos precios recurrentes:
   - Mensual → copia el id `price_…`
   - Anual → copia el id `price_…`
2. **Desarrolladores → Claves de API** → copia la clave secreta (`sk_live_…`).
3. **Desarrolladores → Webhooks → Añadir endpoint**:
   - URL: `https://apolai.io/api/billing/webhook`
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
> `stripe listen --forward-to https://apolai.io/api/billing/webhook`.

---

## 4 · Desplegar

Conéctate por SSH y ejecuta:

```bash
ssh root@LA_IP_DE_TU_VPS

git clone https://github.com/fermon0318-collab/Bot-Inteligente-de-WA-con-IA.git /var/www/apolai
cd /var/www/apolai
sudo bash deploy/deploy.sh apolai.io
```

La primera pasada instala todo (nginx, PostgreSQL, Node, certbot), genera los
secretos y **se detiene** pidiéndote las credenciales. Complétalas:

```bash
sudo nano /etc/apolai/apolai.env
```

Rellena `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY` y `STRIPE_PRICE_YEARLY`.
Añade tu correo en `BILLING_BYPASS_EMAILS` para poder entrar sin pagarte a ti
mismo. Y vuelve a ejecutar:

```bash
sudo bash deploy/deploy.sh apolai.io
```

Es idempotente: para desplegar cambios futuros basta con repetir ese comando.

---

## 5 · Comprobar que quedó bien

```bash
curl -I https://apolai.io                    # 200 y cabeceras de seguridad
curl https://apolai.io/api/health            # {"ok":true,...}
curl -I https://apolai.io/dashboard.html     # 302 → /?login=required
systemctl status apolai                      # active (running)
```

Y en el navegador:

1. Entra en `https://apolai.io` → pulsa **Ingresar** → **Continuar con Google**.
2. Tras autorizar, deberías aterrizar en `/dashboard.html` con tu nombre y tu
   correo reales arriba a la derecha.
3. Cierra sesión y prueba a abrir `/dashboard.html` directamente: debe echarte.
4. Con un correo que **no** esté en `BILLING_BYPASS_EMAILS`, entra y pulsa un
   plan: debe llevarte al checkout de Stripe. Paga con la tarjeta de prueba y
   comprueba que vuelves al panel con la suscripción activa.

Si el paso 4 no actualiza el estado, el webhook no está llegando:
`journalctl -u apolai -f` y mira si aparece `[billing]`.

---

## 6 · Operación diaria

```bash
journalctl -u apolai -f            # registro en vivo
systemctl restart apolai           # reiniciar
sudo bash deploy/deploy.sh apolai.io   # desplegar cambios
```

**Copias de seguridad.** Lo mínimo imprescindible, en cron diario:

```bash
sudo -u postgres pg_dump apolai | gzip > /var/backups/apolai-$(date +%F).sql.gz
```

Guarda también `/etc/apolai/apolai.env` en un gestor de contraseñas. Contiene
`ENCRYPTION_KEY`: **si lo pierdes, los tokens de Meta y las API Key de IA de tus
clientes son irrecuperables** y tendrán que volver a introducirlas.

**Renovación del certificado.** `certbot.timer` la hace sola. Verifica con
`systemctl list-timers | grep certbot`.

---

## 7 · Antes de abrir al público

- [ ] Sustituir los marcadores de `index.html` (`grep -n "\[[A-Z_]\+\]" index.html`)
- [ ] Completar y revisar legalmente `privacidad.html` y `terminos.html`
- [ ] Publicar la pantalla de consentimiento de Google
- [ ] Pasar Stripe de claves de prueba a producción
- [ ] Compilar Tailwind (ver abajo)

### Compilar Tailwind

En producción el CDN de Tailwind es lento y obliga a permitir `'unsafe-eval'`
en la CSP. Para cerrarlo:

```bash
npx tailwindcss -i tools/tailwind-input.css -o assets/css/tailwind.css --minify
```

Después, en los cuatro HTML, sustituye el `<script src="https://cdn.tailwindcss.com">`
y su bloque de configuración por:

```html
<link rel="stylesheet" href="assets/css/tailwind.css" />
```

y quita `'unsafe-eval'` y `https://cdn.tailwindcss.com` de la CSP en
`deploy/apolai-headers.conf`.

---

## Problemas frecuentes

| Síntoma | Causa casi siempre |
|---|---|
| `redirect_uri_mismatch` | La URI de Google no coincide exactamente con `https://TUDOMINIO/auth/google/callback` |
| certbot falla | El DNS aún no propaga, o Cloudflare está en modo proxy |
| El panel redirige en bucle | `PUBLIC_URL` no coincide con el dominio real, o la cookie no es Secure porque no hay HTTPS |
| La suscripción no se activa | El webhook no llega: revisa la URL y el `whsec_` |
| nginx no arranca | Servidor sin IPv6 (deploy.sh lo detecta) o certificado inexistente |
| `502 Bad Gateway` | El servicio está caído: `journalctl -u apolai -n 50` |
