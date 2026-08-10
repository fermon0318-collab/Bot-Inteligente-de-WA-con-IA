# Bloque H · Modo App

> WhatsApp vinculado por código QR, sin migrar el número a Cloud API.
> Arquitectura, reglas de protección y plan de escalado hasta 1000 usuarios.

---

## 1. Por qué existe este módulo

Cloud API es la vía oficial y, para un negocio que empieza de cero, la buena.
Para un negocio que lleva años atendiendo desde su WhatsApp Business, conectarlo
a Cloud API significa:

| Lo que pierde o le cuesta | Detalle |
|---|---|
| El historial | La migración a Cloud API no lleva las conversaciones consigo. |
| La agenda de contactos | Los contactos viven en el teléfono, no en la WABA. |
| La conversación espontánea | Fuera de la ventana de 24 h solo se puede escribir con plantilla aprobada. |
| Dinero | Cada conversación fuera de esa ventana se factura. |
| Tiempo | Alta en Meta Business, verificación, aprobación de plantillas. |
| Clientes | Los que tenían cita agendada y ya no se les puede escribir sin plantilla. |

Nada de eso es un fallo de Cloud API: es su diseño, pensado para marcas que
hacen envíos a escala y necesitan garantías de entrega. Pero al cliente que
factura por atender a quien le escribe, ese diseño le cobra por lo único que
hace y le quita lo único que tenía.

**Modo App vincula Elorai al WhatsApp Business que el cliente ya usa**, por el
mismo mecanismo que WhatsApp Web: un dispositivo más en «Dispositivos
vinculados». No migra nada. El historial, los contactos, los grupos y el número
siguen donde estaban, y no hay ventana de 24 h ni coste por mensaje.

### A cambio: el riesgo cambia de manos

En Cloud API los límites los pone Meta, y cuando algo no se puede hacer llega un
error. En Modo App no hay nadie delante. El cliente usa un cliente no oficial
sobre su propia cuenta, con años de historial dentro. Si el software se pasa de
rosca, no aparece un error 131_047: aparece una cuenta restringida.

Por eso este módulo no es "Cloud API pero por QR". Es un módulo cuyo trabajo
principal —más que enviar mensajes— es **impedir que el cliente se autobloquee**.
Todo lo que viene a continuación se entiende desde ahí.

### Para quién sí y para quién no

| Encaja | No encaja |
|---|---|
| Negocio de servicios que atiende a quien le escribe | Campañas, promociones y difusiones |
| Años de historial en ese número | Escribir primero a listas de contactos |
| Responder a un cliente días después | Necesita cuenta verificada o soporte de Meta |
| Volumen bajo o medio, conversacional | Miles de mensajes al día |

El panel dice esto mismo, con estas palabras, en la propia vista de Modo App. No
es letra pequeña: es lo que decide si el módulo ayuda o hace daño.

---

## 2. Baileys, no whatsapp-web.js

Las dos opciones hacen lo mismo de cara al cliente. Por dentro no se parecen.

| | **Baileys** (elegida) | whatsapp-web.js |
|---|---|---|
| Cómo funciona | Habla el protocolo WebSocket directamente | Automatiza un Chromium real con Puppeteer |
| RAM por sesión | ~40-60 MB | ~300-500 MB |
| **1000 sesiones** | **~50 GB** | **~400 GB** |
| Arranque | Segundos | ~30 s (levantar navegador) |
| CPU en reposo | Casi nada | El render loop del navegador |
| Contenedor | Node y poco más | Node + Chromium + fuentes + libs de X |
| Fallo típico | Cambio de protocolo → actualizar la librería | Cambio de HTML → el selector deja de encontrar el botón |
| Estado de sesión | Objeto serializable, va a Postgres | Perfil de Chromium en disco |

La cuenta de la RAM decide sola: whatsapp-web.js a mil usuarios es un orden de
magnitud más caro en infraestructura. Pero incluso a cincuenta usuarios Baileys
gana en lo que importa a diario: el estado de autenticación es un objeto que se
puede cifrar y guardar en la base, en vez de un directorio de perfil de navegador
que hay que persistir en un volumen y que ata la sesión a una máquina concreta.

**Riesgo asumido:** Baileys es ingeniería inversa del protocolo. Cuando Meta lo
cambia, se rompe hasta que la comunidad publica una versión nueva. La sección 8
es el plan para eso.

---

## 3. Piezas

```
                        ┌──────────────────────────────────┐
   navegador  ───────►  │  routes/api.js                   │
   (panel)              │  /api/settings/app-mode/*        │
                        └───────────────┬──────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
 ┌─────────────┐              ┌──────────────────┐            ┌─────────────────┐
 │ wa/app/     │              │ wa/app/session.js│            │ wa/app/policy.js│
 │ authStore.js│◄─────────────┤  sockets vivos   ├───────────►│ guardián Meta   │
 │ estado      │   cifra/     │  QR, reconexión  │  avisa/    │ 7 detectores    │
 │ cifrado     │   descifra   │  arrendamiento   │  frena     │ pausa envíos    │
 └──────┬──────┘              └────────┬─────────┘            └────────┬────────┘
        │                              │  ▲                            │
        │                    entrantes │  │ salientes                  │
        ▼                              ▼  │                            ▼
 ┌────────────────────────────────────────┴────────────────────────────────────┐
 │                              PostgreSQL                                     │
 │  wa_app_auth · wa_app_sessions · wa_app_sends · policy_events               │
 └─────────────────────────────────────────────────────────────────────────────┘
                                        ▲
                                        │
 ┌──────────────────┐        ┌──────────┴──────────┐        ┌──────────────────┐
 │ services/engine  │───────►│ services/outbox.js  │───────►│ services/         │
 │ flujos, IA,      │ encola │ cola + reintentos   │ envía  │ providers/        │
 │ agenda, pagos    │        │ puerta de ritmo     │        │ cloud.js │ app.js │
 └──────────────────┘        └─────────────────────┘        └──────────────────┘
```

| Archivo | Responsabilidad |
|---|---|
| `services/providers/index.js` | Resuelve el proveedor de cada cuenta según su canal. |
| `services/providers/cloud.js` | Adaptador de Cloud API sobre `services/whatsapp.js`. |
| `services/providers/app.js` | Adaptador de Modo App. Único con puerta de ritmo real. |
| `wa/app/session.js` | Sockets de Baileys: QR, reconexión, arrendamiento, traducción de mensajes. |
| `wa/app/authStore.js` | Estado de autenticación en Postgres, cifrado con AES-256-GCM. |
| `wa/app/pacing.js` | Pausas, topes por minuto y por día, antiduplicados. |
| `wa/app/policy.js` | Siete detectores de patrones de riesgo, avisos y freno de emergencia. |

### La frontera que hace todo esto sostenible

Nada fuera de `wa/app/` sabe que existe Baileys. El motor, la cola, el
remarketing y la agenda hablan con un **proveedor**, que siempre expone lo mismo:

```js
{
  name, ready, reason, readyRetryable, capabilities,
  beforeSend, afterSend,
  sendText, sendMedia, sendTemplate, markAsRead,
}
```

Consecuencias prácticas:

- **Cambiar de implementación** = un archivo nuevo en `services/providers/` y una
  línea en el registro. No se toca la plataforma.
- **Un canal que no sabe hacer algo** lo declara en `capabilities` y quien llama
  se adapta. Ejemplo real: `capabilities.templates === false` hace que la cola
  convierta una plantilla en texto plano en vez de fallar por una restricción
  que en este canal no existe.
- **El motor no se duplica.** Flujos, disparadores, IA, comprobantes de pago y
  agenda funcionan igual en los dos canales porque `session.js` traduce los
  mensajes de Baileys al vocabulario que el motor ya hablaba.

---

## 4. Recorrido de un mensaje

### Entrante

1. Baileys emite `messages.upsert` (solo `type: 'notify'`; los `append` son
   historial viejo que llega al vincular y contestarlo sería absurdo).
2. Se descartan grupos, estados, canales y lo que escribió el propio negocio.
3. `normalizeIncoming()` traduce a la forma de Cloud API.
4. Se guarda en `wa_events` con `ON CONFLICT DO NOTHING` sobre `wa_message_id`
   → idempotencia.
5. `engine.handleIncomingMessage({ accountId, channel: 'app', ... })`.
6. A partir de aquí, el camino es exactamente el de Cloud API.

### Saliente

1. Cualquier parte del sistema llama a `outbox.enqueue()`.
2. El trabajador toma lo vencido con `FOR UPDATE SKIP LOCKED`.
3. `providers.forAccount()` devuelve el proveedor del canal activo.
4. **`provider.beforeSend()`** — la puerta:
   - ¿duplicado? → se descarta, no se aplaza
   - ¿envíos en pausa por el guardián? → espera
   - ¿tope diario o por minuto? → espera
   - ¿no ha pasado la pausa aleatoria desde el último envío? → espera
5. Se envía. Antes, "escribiendo…" durante un tiempo proporcional al texto.
6. **`provider.afterSend()`** anota en `wa_app_sends`: es la memoria del ritmo,
   del antiduplicados y la materia prima del guardián.

Un "espera" nunca pierde el mensaje: lo reprograma. Sale igual, más despacio.

---

## 5. Reglas de protección

### Ritmo (`pacing.js`)

| Regla | Por defecto | Configurable |
|---|---|---|
| Pausa entre mensajes | 5-15 s, **aleatoria** | Sí, hacia arriba (5-120 s) |
| Máximo por minuto | 20 | Sí, hasta 30 |
| Máximo por día | 500 | Sí, hasta 5000 |
| Mismo texto al mismo contacto | Bloqueado 60 min | No |

Tres decisiones que no son obvias:

- **El azar no es decorativo.** Un intervalo exacto de 10 s repetido cien veces
  delata la automatización más que el propio volumen.
- **El suelo de 5 s se aplica en el backend**, no solo en el formulario. Nadie
  baja de ahí ni tocando la API a mano.
- **Las cuentas van contra Postgres, no contra memoria.** Un reinicio del proceso
  no regala una ráfaga, y con varios trabajadores el límite es del número, no de
  la instancia.

### Guardián de políticas (`policy.js`)

Cada 5 minutos, sobre las cuentas conectadas:

| Código | Detecta | Umbral | Severidad |
|---|---|---|---|
| `rafaga` | Mensajes en 1 y 5 min | 25 / 80 | **critical** |
| `identicos` | Mismo texto a N contactos en 24 h | 15 (30 → critical) | warn |
| `desconocidos` | Destinatarios que nunca escribieron primero | 10 y >30 % | warn |
| `sin_respuesta` | Contactos escritos que no contestan | >60 % de 15+ | warn |
| `automatizacion` | Volumen sin ninguna intervención humana | 60+ y <5 % manual | warn |
| `ratio_saliente` | Salientes por cada entrante | 4:1 con 40+ | warn |
| `horario` | Envíos entre 22:00 y 07:00 | 10 | info |

- **`critical` pausa los envíos automáticamente.** Solo la primera vez: si el
  usuario ya lo vio y decidió seguir, no se le frena en cada vuelta.
- Reanudar es un acto deliberado del usuario, con el aviso delante.
- Un mismo código no repite aviso antes de una hora.
- Todo aviso entra además en la terminal de actividad del panel.

**Sobre `sin_respuesta`:** WhatsApp no nos dice cuántos bloquearon o reportaron
al número — ese dato no sale del teléfono. La tasa de silencio es el mejor
indicador indirecto disponible, y es honesto decirlo así en el aviso.

### Correspondencia con las normas de Meta

Modo App no pasa por la infraestructura de Meta, pero está sujeto a las mismas
normas. Lo que cada regla del producto cubre:

| Norma de Meta | Cómo se cubre aquí |
|---|---|
| Prohibido el envío masivo no solicitado | `rafaga`, `identicos`, topes por minuto y día |
| Prohibido contactar a quien no dio consentimiento | `desconocidos`, `ratio_saliente` |
| Hay que ofrecer hablar con una persona | `automatizacion` avisa cuando no hay ninguna |
| Prohibidos los clientes no autorizados | Se dice sin rodeos en el panel, antes de vincular |
| Calidad del número y reportes | `sin_respuesta` como indicador indirecto |
| Respetar el descanso del destinatario | `horario` |

---

## 6. Estado de autenticación

Baileys trae `useMultiFileAuthState`, que escribe un directorio de ficheros JSON.
No sirve aquí:

- el disco del contenedor es efímero (Railway lo borra en cada despliegue), y
  perder el estado significa pedirle otro QR al cliente — justo la fricción que
  este módulo existe para evitar;
- son claves privadas de Signal en texto plano dentro del contenedor;
- ata la sesión a una máquina concreta, que es lo contrario de lo que hace falta
  para escalar.

**En su lugar:** tabla `wa_app_auth`, una fila por clave, cifrada con
AES-256-GCM y la misma `ENCRYPTION_KEY` que protege los tokens de Meta.

Troceado por clave y no como un único blob porque Baileys escribe claves sueltas
constantemente: guardar el estado entero sería un `UPDATE` de megabytes por
mensaje enviado.

> ⚠️ **Si se pierde `ENCRYPTION_KEY`, estas sesiones son irrecuperables** y todos
> los clientes de Modo App tendrán que volver a escanear el QR. Guárdala aparte,
> igual que ya se hace por los tokens de Meta.

### Cuándo hay que pedir un QR nuevo

| Motivo del cierre | Reacción |
|---|---|
| `loggedOut` / `badSession` | Borrar credenciales, estado `logged_out`, pedir QR. **Sin reintentos**: insistir con credenciales muertas es un bucle. |
| `forbidden` | Estado `banned`, avisar al equipo. No hay reintento que valga. |
| `connectionReplaced` | Otro dispositivo tomó la sesión. **No se reconecta**: reconectar en bucle es lo que dispara el cierre definitivo. |
| Corte de red, `restartRequired`, timeout | Reconexión con espera creciente, hasta 8 intentos (máx. 30 s). |
| Despliegue / SIGTERM | Se suelta el socket **conservando las credenciales**. Nadie escanea nada. |

El panel sondea `/api/settings/app-mode/qr` cada 3 s mientras hay un QR vivo, y
deja de hacerlo al salir de la vista. Un QR caducado nunca se entrega: solo
conseguiría que el cliente escanee en vano.

---

## 7. Escalado a 1000 usuarios

### El problema, en una frase

El resto de Elorai es sin estado: cualquier réplica atiende cualquier petición.
**Una sesión de Modo App es un socket abierto que vive en un proceso concreto.**
Dos procesos con el mismo número abierto es exactamente lo que WhatsApp
interpreta como sesión duplicada, y cierra la buena.

### La pieza que lo resuelve: el arrendamiento

Ya está implementada, desde el primer día, aunque hoy solo haya un proceso:

```sql
UPDATE wa_app_sessions
   SET worker_id = $yo, lease_until = now() + interval '2 minutes'
 WHERE account_id = $cuenta
   AND (worker_id IS NULL OR worker_id = $yo OR lease_until < now())
```

- Solo quien tiene la fila reservada abre el socket.
- El arrendamiento se renueva cada minuto.
- Si el proceso muere, caduca en 2 minutos y otro la recoge.
- No hace falta Redis, ni ZooKeeper, ni un coordinador: la reserva es una fila.

Escribir esto al principio cuesta unas pocas líneas. Añadirlo cuando ya hay
cientos de sesiones en producción cuesta una migración delicada y un incidente.

### Fases

Supuesto de trabajo: de 1000 usuarios de Elorai, **~60 % elige Modo App** (el
resto sigue en Cloud API), es decir **~600 sesiones**. A 50 MB por sesión son
~30 GB de RAM solo en sockets.

#### Fase 0 — hasta ~50 sesiones · **es lo que hay hoy**

Todo en el proceso de la API. Sin cambios, sin infraestructura nueva.

```
APP_MODE_ENABLED=true
APP_MODE_MAX_SESSIONS=150
```

Un solo servicio de Railway. Funciona, y no hay que hacer nada más hasta que
deje de funcionar.

#### Fase 1 — 50 a 300 sesiones · separar el estado del resto

El síntoma que la dispara: un despliegue del backend tira todas las sesiones, o
la RAM de la API sube y baja con el número de clientes conectados.

Se parte en dos servicios **del mismo código**, cambiando solo variables:

| Servicio | Réplicas | Variables |
|---|---|---|
| `elorai-api` | 2-N, sin estado | `APP_MODE_ENABLED=false` |
| `elorai-wa` | 1, con estado | `APP_MODE_ENABLED=true`, `APP_MODE_MAX_SESSIONS=300` |

La API deja de sostener sockets y vuelve a ser desplegable sin consecuencias.
El panel sigue leyendo y escribiendo el estado en Postgres, así que **no necesita
hablar con el gateway**: la base es el punto de encuentro. Un botón «Generar QR»
pulsado en la API llega al gateway porque el gateway mira la tabla.

> Ajuste necesario en esta fase: hoy `connect()` se ejecuta en el proceso que
> atiende la petición. Con la API sin sesiones hay que convertir esa llamada en
> una **intención escrita en la tabla** (`status = 'connect_requested'`) que el
> gateway recoge en su siguiente vuelta, ≤1 s de latencia. Es un cambio de una
> función, no de la arquitectura.

#### Fase 2 — 300 a 1000 sesiones · varias réplicas del gateway

| | |
|---|---|
| Réplicas de `elorai-wa` | 4-6 |
| `APP_MODE_MAX_SESSIONS` | 120-150 por réplica |
| RAM por réplica | 8-10 GB |
| `APP_MODE_WORKER_ID` | **distinto en cada réplica** (Railway: `RAILWAY_REPLICA_ID`) |

El reparto lo hace el arrendamiento sin coordinador: cada réplica pide cuentas
libres hasta llenar su cupo. Si una muere, sus sesiones caducan en 2 minutos y
las demás se las reparten.

Lo único que hay que vigilar de verdad es el **efecto manada**: si mueren dos
réplicas a la vez, las supervivientes intentan absorber 300 sesiones de golpe y
WhatsApp ve 300 reconexiones desde la misma IP. Mitigación: `LIMIT` en la
consulta de reparto (ya está) más un retardo aleatorio de 0-30 s antes de cada
`connect()` durante una recuperación masiva.

#### Fase 3 — más de 1000 sesiones

Aquí el arrendamiento por fila empieza a ser ruidoso (cada réplica consultando
la tabla cada minuto). Sustituto natural: **hashing consistente** de
`account_id` sobre el número de réplicas, con el arrendamiento como red de
seguridad para los reequilibrios. Y una cola real (Redis, BullMQ) para el
outbox, que a ese volumen ya no quiere ser un `SELECT ... FOR UPDATE`.

No hace falta pensarlo ahora. Hace falta que nada de lo escrito hoy lo impida —
y no lo impide, porque el reparto está detrás de dos funciones (`claimLease`,
`resumeSessions`) y el envío detrás de la interfaz de proveedor.

### Números para dimensionar

| Concepto | Estimación | Nota |
|---|---|---|
| RAM por sesión inactiva | 40-60 MB | Medir en producción; varía con el tamaño del historial |
| RAM por réplica (150 sesiones) | 8-10 GB | Incluye Node y margen |
| Reconexión de una sesión | 3-8 s | Con credenciales guardadas, sin QR |
| Escrituras en `wa_app_auth` | ~5-20 por mensaje | Claves de Signal por conversación |
| Escrituras totales a 600 sesiones × 200 msg/día | ~1-2 M filas/día (~20/s) | Cómodo para un Postgres bien dimensionado |
| Conexiones a Postgres por réplica | `DATABASE_POOL_MAX` | Vigilar: 6 réplicas × 10 = 60 conexiones |

**El primer límite que se toca no es la RAM ni la CPU: es `max_connections` de
Postgres.** Antes de la fase 2 hay que poner PgBouncer delante o subir el
límite del plan.

### Qué falla primero, y cómo se ve

| Síntoma | Causa probable | Dónde mirar |
|---|---|---|
| Sesiones que caen y vuelven en bucle | Dos procesos con el mismo `APP_MODE_WORKER_ID` | `SELECT worker_id, count(*) FROM wa_app_sessions GROUP BY 1` |
| Todo pasa a `logged_out` a la vez | Versión de Baileys incompatible tras un cambio de Meta | Log de arranque, sección 8 |
| La cola crece y no baja | Guardián con los envíos en pausa | `SELECT paused, paused_reason FROM wa_app_sessions WHERE paused` |
| Sesiones que nadie recoge | Cupo lleno en todas las réplicas | `APP_MODE_MAX_SESSIONS` frente a sesiones vivas |
| Timeouts de Postgres | `max_connections` agotado | PgBouncer |

---

## 8. Cuando Meta actualiza WhatsApp Web

Es cuestión de cuándo, no de si. El plan tiene cuatro partes, y tres ya están en
el código.

### 1 · La dependencia es opcional y está clavada

```json
"optionalDependencies": { "baileys": "6.7.24" }
```

- **Opcional**: si la instalación o la carga fallan, Elorai arranca igual y solo
  Modo App queda «no disponible». Cloud API, el panel y el resto siguen en pie.
  La diferencia entre un módulo caído y una plataforma caída.
- **Sin `^`**: una actualización silenciosa aquí puede tirar las sesiones de
  todos los clientes a la vez. Se sube a mano, después de probarla.

### 2 · La carga es perezosa y tolerante

`import('baileys')` dentro de `loadBaileys()`, con el error capturado y
convertido en un mensaje que el panel entiende. `available()` responde a la API
sin lanzar.

### 3 · Procedimiento de actualización

1. Leer el changelog y los issues abiertos de la versión nueva.
2. Instalar en un entorno de pruebas con una cuenta de WhatsApp de prueba.
3. Comprobar: vincular por QR · recibir texto, imagen y documento · enviar texto
   y archivo · reconectar tras reinicio · desvincular.
4. Correr `npm test`.
5. Desplegar **primero en una sola réplica** del gateway y observar una hora.
   Las demás siguen en la versión anterior: si algo va mal, afecta a 1/6 de los
   clientes, no a todos.
6. Extender al resto.

### 4 · Plan si se rompe sin aviso

- Síntoma: sesiones a `logged_out` en masa, o `loadBaileys()` fallando.
- Contención: `APP_MODE_ENABLED=false` en el gateway. Los mensajes **se quedan en
  la cola**, no se pierden — la cola los reintenta cuando el canal vuelva.
- Comunicación: el panel ya muestra el estado real de la sesión y el motivo.
- Salida: actualizar la librería, o proponer Cloud API a quien no pueda esperar.

---

## 9. Cambiar de proveedor de WhatsApp

Lo que hay que escribir para sustituir Baileys por otra cosa:

```js
// server/src/services/providers/loquesea.js
export const name = 'loquesea';
export async function build(accountId) {
  return {
    name, accountId,
    ready, reason, readyRetryable,
    capabilities: { templates, window24h, mediaById },
    beforeSend, afterSend,
    sendText, sendMedia, sendTemplate, markAsRead,
  };
}
```

Y una línea en `providers/index.js`:

```js
const REGISTRY = { cloud, app, loquesea };
```

Lo que **no** hay que tocar: el motor, la cola, los flujos, la IA, la agenda, los
comprobantes, el remarketing, el panel. Esa es toda la razón de ser de la capa.

Si el proveedor nuevo también mantiene sockets, reutiliza `wa/app/authStore.js`,
`pacing.js` y `policy.js` tal cual: ninguno de los tres sabe qué librería hay
debajo.

---

## 10. Configuración

| Variable | Por defecto | Para qué |
|---|---|---|
| `APP_MODE_ENABLED` | `true` | `false` apaga el módulo en este despliegue |
| `APP_MODE_WORKER_ID` | `RAILWAY_REPLICA_ID` o uno aleatorio | **Distinto por réplica**, obligatorio |
| `APP_MODE_MAX_SESSIONS` | `150` | Techo de sesiones por proceso |

## 11. Rutas de la API

| Método y ruta | Qué hace |
|---|---|
| `GET /api/settings/app-mode` | Estado, límites, consumo y avisos de políticas |
| `POST /api/settings/app-mode/connect` | Abre sesión. `{ forceQr: true }` fuerza QR nuevo |
| `GET /api/settings/app-mode/qr` | QR vigente (lo sondea el panel cada 3 s) |
| `POST /api/settings/app-mode/disconnect` | Desvincula y borra credenciales |
| `PUT /api/settings/app-mode/limits` | Ajusta el ritmo (el backend recorta lo inseguro) |
| `POST /api/settings/app-mode/resume` | Reanuda tras una pausa del guardián |
| `POST /api/settings/app-mode/policy/:id/ack` | Marca un aviso como leído |
| `PUT /api/settings/channel` | Cambia entre `cloud` y `app` |

## 12. Tablas

| Tabla | Contenido |
|---|---|
| `bot_settings.wa_channel` | `cloud` o `app`. Uno a la vez: los dos duplicarían respuestas |
| `wa_app_sessions` | Estado del enlace, QR efímero, límites, pausa, arrendamiento |
| `wa_app_auth` | Estado de autenticación, cifrado, una fila por clave |
| `wa_app_sends` | Registro de envíos: ritmo, antiduplicados y materia prima del guardián |
| `policy_events` | Avisos del guardián, con severidad y puntuación |

Limpieza: `pacing.purgeOldSends()` borra el registro de envíos a los 30 días.
Solo se usa para ventanas cortas.

---

## 13. Estado de las pruebas

Verificado contra PostgreSQL 16 real y Baileys 6.7.24 real:

- Las 17 migraciones aplican en orden sobre una base limpia.
- Ritmo: primer envío permitido, freno por pausa, freno por tope por minuto,
  descarte de duplicados, respeto de la pausa del guardián.
- Guardián: los 7 detectores se ejecutan sin error de SQL; `rafaga` detecta una
  ráfaga real y pausa los envíos automáticamente.
- Proveedores: resolución por canal, `ready`/`readyRetryable` correctos en cada
  uno, `capabilities` coherentes.
- Estado de autenticación: credenciales de Baileys cifradas en la base (se
  comprobó que no quedan en claro), `Buffer` intactos en el viaje de ida y
  vuelta, borrado por valor nulo, y **las credenciales sobreviven a un reinicio
  del proceso** — que es la garantía de no volver a pedir QR tras un despliegue.
- Arranque del servidor con todo el cableado nuevo, y reapertura automática de
  sesiones al arrancar.
- 38 pruebas unitarias en verde (`npm test`).

**No verificado:** la generación del QR de extremo a extremo y el envío o
recepción de un mensaje real. Requieren alcanzar los servidores de WhatsApp, que
el entorno donde se desarrolló esto tiene bloqueados. El socket abre y la
máquina de estados llega a `qr_pending`, pero el código QR en sí no llegó a
emitirse. **Es lo primero que hay que probar en un entorno con salida a
internet**, con el guion del paso 3 de la sección 8.
