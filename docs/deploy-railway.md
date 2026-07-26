# Desplegar en Railway (sin nginx, plan gratuito de 30 días)

Esta es la ruta de publicación mientras usas el plan gratuito de Railway. Cuando
haga falta escalar a un VPS propio, `deploy/README.md` (Hetzner + nginx) sigue
intacto y listo para ese momento — no hay que migrar código, solo el destino
del despliegue.

**Diferencia clave con la guía de Hetzner:** ahí nginx sirve los archivos
estáticos, termina TLS y protege `dashboard.html` con `auth_request`. Aquí no
hay nginx: el propio proceso de Node (`server/src/index.js`) hace las tres
cosas — ya está preparado para eso, no hace falta tocar código.

**Tiempo estimado:** 40–60 minutos.

---

## 0 · Antes de empezar

- Cuenta de Railway conectada a tu GitHub (ya la tienes).
- El repositorio empujado a GitHub con los últimos cambios.
- `openssl` a mano para generar secretos (viene en Mac/Linux; en Windows usa Git Bash).

---

## 1 · Base de datos PostgreSQL

1. En tu proyecto de Railway → **New** → **Database** → **Add PostgreSQL**.
2. Railway crea el servicio y le asigna una variable `DATABASE_URL` propia.
   No hay que copiarla a mano: en el paso 3 se referencia desde el servicio
   web con `${{Postgres.DATABASE_URL}}`.

---

## 2 · Servicio web (el backend)

1. **New** → **GitHub Repo** → selecciona `Bot-Inteligente-de-WA-con-IA`.
2. Entra a **Settings** del servicio recién creado:
   - **Root Directory:** `server` (ahí vive `package.json`; así Railway no
     intenta construir el repo entero).
   - **Start Command:** déjalo vacío si `server/railway.json` se detecta solo,
     o pon `npm run migrate && npm start` a mano si Railway no lo recoge —
     ese archivo ya está en el repo con esa orden.

`npm run migrate` es idempotente (registra en `schema_migrations` lo ya
aplicado), así que ejecutarlo en cada arranque no hace daño y garantiza que la
base nunca se quede desactualizada tras un `git push`.

**Sobre el CSS de Tailwind:** con Root Directory en `server`, Railway nunca
construye el `package.json` de la raíz — por eso `assets/css/tailwind.css`
va compilado y comiteado al repositorio, no se genera en el despliegue. Si
cambias clases de Tailwind en el HTML o en `assets/js/`, corre
`npm run build:css` en tu máquina y sube el resultado junto con tu cambio, o
el sitio se verá desactualizado hasta el siguiente commit que sí lo incluya.
(En Hetzner esto no aplica: `deploy/deploy.sh` lo recompila solo en cada
despliegue.)

---

## 3 · Variables de entorno

En **Variables** del servicio web, añade:

```
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}

SESSION_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>

BILLING_PROVIDER=none
```

`HOST=0.0.0.0` es obligatorio aquí: el valor por defecto del código
(`127.0.0.1`) es el correcto para Hetzner+nginx, pero en Railway el proxy de
borde no llega a un proceso que solo escucha en loopback.

Con `BILLING_PROVIDER=none` el panel funciona y cualquier cuenta con sesión
entra sin pagar — así puedes publicar y probar todo el flujo de WhatsApp antes
de que Wompi esté listo. Nadie queda bloqueado por falta de pasarela.

**No hace falta `PUBLIC_URL` todavía.** Si no la defines, el servidor usa
`https://${RAILWAY_PUBLIC_DOMAIN}` automáticamente (Railway inyecta esa
variable sola en cuanto generas un dominio en el paso 4). Puedes fijar
`PUBLIC_URL` a mano más adelante cuando compres `elorai.*` y lo conectes.

**Google (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) se deja vacío por
ahora**, tal como lo dejaste en la consola de Google. El servidor arranca
igual sin ellas: el botón "Acceder con Google" redirige con un aviso en vez de
romper el sitio. Las completas en el paso 6, cuando ya tengas la URL pública
real que Google exige para la URI de redirección.

---

## 4 · Dominio público

1. En el servicio web → **Settings** → **Networking** → **Generate Domain**.
2. Railway te da algo como `elorai-production.up.railway.app` con HTTPS ya
   activo — no hay que tocar Cloudflare ni comprar nada para esto.
3. Esa es tu `RAILWAY_PUBLIC_DOMAIN`. Confírmalo abriendo
   `https://<ese-dominio>/api/health`: debe responder `{"ok":true,...}`.

Si el `/api/health` falla, revisa **Deployments → View Logs** del servicio:
casi siempre es una variable de entorno que falta (el log de arranque dice
exactamente cuál).

---

## 5 · Volumen para los archivos subidos (Bloque F)

El filesystem del contenedor es efímero: cualquier PDF o imagen que suban tus
clientes desaparece en el siguiente despliegue si no hay un Volume.

1. Servicio web → **Settings** → **Volumes** → **New Volume**.
2. Mount path: `/app/uploads` (con Root Directory=`server`, `/app` es la raíz
   del contenedor, así que esto cae fuera de `server/` y sobrevive a los
   redeploys).
3. Añade la variable `UPLOADS_DIR=/app/uploads`.

Sin este paso, Block F sigue funcionando (sube y envía archivos con
normalidad) pero pierde lo subido en cada despliegue nuevo.

---

## 6 · Terminar Google OAuth

Ya hiciste la pantalla de consentimiento; falta la parte de credenciales, y
ahora sí tienes la URL que pedía:

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   → **Crear credenciales** → **ID de cliente de OAuth** → **Aplicación web**.
2. **Orígenes autorizados de JavaScript:** `https://<tu-dominio-railway>`
3. **URI de redirección autorizada:** `https://<tu-dominio-railway>/auth/google/callback`
   (carácter por carácter, sin barra final).
4. Copia el **Client ID** y el **Client Secret** a las variables
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` del servicio en Railway.
5. Railway redespliega solo al guardar variables. Prueba "Acceder con Google"
   desde `https://<tu-dominio-railway>/`.

Cuando más adelante conectes un dominio propio (`elorai.io`), repite este
paso añadiendo el nuevo origen y URI — Google permite varios a la vez, no hace
falta borrar el de Railway.

---

## 7 · Conectar WhatsApp Cloud API

Con el sitio ya público, en el panel (**Configuración → Cloud API**) usa como
URL del webhook:

```
https://<tu-dominio-railway>/webhook/whatsapp
```

El resto (Access Token, Phone Number ID, verify token) sigue el mismo proceso
que ya tenías documentado — nada cambia por estar en Railway en vez de
Hetzner, porque el bot habla con la Graph API de Meta directamente.

---

## 8 · Sobre Cloudflare (tu cuenta ya conectada a GitHub)

Con este despliegue en Railway, **Cloudflare no hace falta todavía**: Railway
ya te da HTTPS y un hostname público sin configurar nada ahí. Conectar
Cloudflare a GitHub sirve para otra cosa (Cloudflare Pages, que no estás
usando aquí) — no es un paso bloqueante ni hay que deshacerlo, simplemente
queda sin usar por ahora.

Cloudflare vuelve a importar el día que compres el dominio real (`elorai.io`
o el que elijas):

1. Añades el dominio como sitio en Cloudflare y apuntas los nameservers ahí
   (donde lo compraste).
2. Creas un registro `CNAME` de `elorai.io` (o `www`) apuntando al hostname de
   Railway (`elorai-production.up.railway.app`), en modo **DNS only** (nube
   gris, no naranja) — si lo dejas en modo proxy naranja, Railway no puede
   emitir el certificado TLS para tu dominio.
3. En Railway, **Settings → Networking → Custom Domain**, añades `elorai.io`
   y sigues las instrucciones (puede pedir un registro TXT de verificación).
4. Actualizas `PUBLIC_URL=https://elorai.io` en las variables del servicio, y
   repites el paso 6 en Google con el nuevo origen/URI.

Cuando más adelante escales a Hetzner (`deploy/README.md`), el mismo dominio
en Cloudflare solo cambia de destino: el `CNAME`/`A` pasa a apuntar a la IP
del VPS en vez de a Railway, y ahí sí conviene el modo proxy naranja de
Cloudflare (oculta la IP real y añade protección contra ataques).

---

## 9 · Cuando Wompi esté listo

Hoy `BILLING_PROVIDER=none` dentro de `server/src/billing/index.js`. El día
que tengas credenciales de Wompi:

1. Se escribe `server/src/billing/wompi.js` con las mismas cinco funciones que
   ya tiene `stripe.js` (`createCheckout`, `createPortal`, `verifyWebhook`,
   `handleEvent`, `getStatus`) — la interfaz ya está pensada para esto, no hay
   que tocar rutas ni middlewares.
2. Se añade `'wompi'` a la lista `KNOWN` de `billing/index.js`.
3. Se cambia `BILLING_PROVIDER=wompi` en las variables de Railway.

Sin ese adaptador todavía no toco nada: mejor construirlo contra la
documentación real de Wompi y sus credenciales de prueba, en vez de adivinar
su forma de antemano.

---

## Lista de verificación

- [ ] PostgreSQL creado, `DATABASE_URL` referenciada en el servicio web
- [ ] Root Directory = `server`, arranca con `npm run migrate && npm start`
- [ ] `HOST=0.0.0.0`, `SESSION_SECRET` y `ENCRYPTION_KEY` generados y puestos
- [ ] `BILLING_PROVIDER=none` — el panel abre sin pasarela configurada
- [ ] Dominio generado, `/api/health` responde `ok: true`
- [ ] Volumen montado en `UPLOADS_DIR` (si no, los archivos no sobreviven a un redeploy)
- [ ] Credenciales de Google creadas con el dominio real, login funcionando
- [ ] Webhook de WhatsApp apuntando a `https://<dominio>/webhook/whatsapp`
