-- ============================================================================
-- Modo App · WhatsApp vinculado por código QR (Baileys)
--
-- El negocio sigue usando SU aplicación de WhatsApp Business de siempre: no
-- migra el número a Cloud API, no pierde el historial ni los contactos, y no
-- paga a Meta por escribir fuera de la ventana de 24 h. Elorai se vincula como
-- un dispositivo más (el mismo mecanismo que WhatsApp Web) y responde desde ahí.
--
-- A cambio, este canal NO tiene garantías de Meta: es la propia cuenta del
-- cliente la que está en juego. Por eso el esquema no guarda solo credenciales:
-- guarda también el ritmo de envío permitido y un registro de riesgo, porque
-- aquí el trabajo del producto es impedir que el cliente se autobloquee.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Canal activo por cuenta
--
-- 'cloud' → WhatsApp Cloud API (lo que había)
-- 'app'   → Modo App (este bloque)
--
-- Es una sola columna a propósito: una cuenta atiende por un canal a la vez.
-- Tener los dos encendidos sobre el mismo número duplicaría respuestas.
-- --------------------------------------------------------------------------
ALTER TABLE bot_settings
    ADD COLUMN wa_channel text NOT NULL DEFAULT 'cloud'
    CHECK (wa_channel IN ('cloud', 'app'));

-- --------------------------------------------------------------------------
-- Sesión de Modo App
--
-- Una fila por cuenta. Contiene el estado del enlace (QR, conectado, cerrado)
-- y los límites de ritmo, que son por número porque el riesgo también lo es.
-- --------------------------------------------------------------------------
CREATE TABLE wa_app_sessions (
  account_id        uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,

  -- Implementación concreta detrás del canal. Hoy 'baileys'; el día que haya
  -- que sustituirla, esta columna dice qué sesión hay que volver a vincular.
  provider          text NOT NULL DEFAULT 'baileys',

  -- disconnected → nunca vinculado o desvinculado por el usuario
  -- qr_pending    → hay un QR vivo esperando a que lo escaneen
  -- connecting    → credenciales válidas, abriendo el socket
  -- connected     → operativo
  -- logged_out    → WhatsApp invalidó la sesión: hace falta QR nuevo
  -- banned        → la cuenta fue restringida por WhatsApp
  status            text NOT NULL DEFAULT 'disconnected'
                    CHECK (status IN ('disconnected','qr_pending','connecting','connected','logged_out','banned')),

  jid               text NOT NULL DEFAULT '',   -- 5215512345678@s.whatsapp.net
  display_phone     text NOT NULL DEFAULT '',
  push_name         text NOT NULL DEFAULT '',

  -- QR en base64 (data URL). Es efímero por diseño: caduca en ~60 s y se
  -- borra en cuanto la vinculación termina. Nunca es una credencial.
  qr_png            text,
  qr_expires_at     timestamptz,

  last_error        text,

  -- Escalado: qué proceso tiene abierto el socket de esta cuenta y hasta
  -- cuándo. Si el arrendamiento vence (el proceso murió), otro puede tomarla
  -- sin que dos trabajadores abran el mismo número a la vez — que es lo que
  -- WhatsApp interpreta como sesión duplicada y acaba en cierre.
  worker_id         text,
  lease_until       timestamptz,

  -- --- Ritmo de envío (impuesto, no sugerido) -----------------------------
  -- Entre mensaje y mensaje se espera un tiempo aleatorio dentro de este
  -- rango. El mínimo del producto son 5 s; el panel no deja bajar de ahí.
  min_gap_seconds   integer NOT NULL DEFAULT 5  CHECK (min_gap_seconds >= 5),
  max_gap_seconds   integer NOT NULL DEFAULT 15 CHECK (max_gap_seconds <= 120),
  -- Techo por minuto y por día del propio número.
  per_minute_limit  integer NOT NULL DEFAULT 20 CHECK (per_minute_limit BETWEEN 1 AND 30),
  daily_limit       integer NOT NULL DEFAULT 500 CHECK (daily_limit BETWEEN 1 AND 5000),

  -- Freno automático: lo activa el guardián de políticas cuando detecta un
  -- patrón que pone la cuenta en riesgo. El usuario lo levanta a mano tras
  -- leer el aviso, no se levanta solo.
  paused            boolean NOT NULL DEFAULT false,
  paused_reason     text,

  connected_at      timestamptz,
  disconnected_at   timestamptz,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CHECK (max_gap_seconds >= min_gap_seconds)
);

-- Reparto de sesiones entre trabajadores: "dame las que nadie tiene arrendadas"
CREATE INDEX wa_app_sessions_lease_idx ON wa_app_sessions(lease_until)
  WHERE status IN ('connecting', 'connected', 'qr_pending');

-- --------------------------------------------------------------------------
-- Estado de autenticación
--
-- Baileys guarda por defecto un directorio de ficheros JSON. Eso no sirve
-- aquí: el contenedor es efímero (Railway borra el disco en cada despliegue) y
-- perder este estado significa pedirle otro QR al cliente. Va en la base,
-- cifrado con la misma AES-256-GCM que los tokens de Meta, y troceado por
-- clave para no reescribir megabytes en cada mensaje.
--
--   category = 'creds'   → item_id = ''      (identidad del dispositivo)
--   category = 'pre-key' → item_id = '42'    (claves de Signal, muchas y pequeñas)
-- --------------------------------------------------------------------------
CREATE TABLE wa_app_auth (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category    text NOT NULL,
  item_id     text NOT NULL DEFAULT '',
  value_enc   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, category, item_id)
);

-- --------------------------------------------------------------------------
-- Registro de envíos
--
-- Es la memoria del ritmo y del antiduplicados: cuántos van este minuto, hace
-- cuánto fue el último, y si este mismo texto ya se le mandó a este contacto.
-- También es la materia prima del guardián de políticas.
--
-- `body_hash` es un SHA-256 del texto normalizado: sirve para detectar el
-- mismo mensaje repetido a muchos destinatarios sin guardar el texto otra vez.
-- --------------------------------------------------------------------------
CREATE TABLE wa_app_sends (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  phone       text NOT NULL DEFAULT '',
  body_hash   text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT 'text',
  origin      text NOT NULL DEFAULT 'flow',   -- flow | ai | manual | remarketing
  -- ¿el contacto había escrito antes a este número? Un envío a alguien que
  -- nunca inició conversación es justo lo que Meta considera contacto en frío.
  inbound_first boolean NOT NULL DEFAULT true,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wa_app_sends_account_idx ON wa_app_sends(account_id, sent_at DESC);
CREATE INDEX wa_app_sends_dedupe_idx  ON wa_app_sends(account_id, contact_id, body_hash, sent_at DESC);

-- --------------------------------------------------------------------------
-- Avisos del guardián de políticas
--
-- Cada patrón detectado deja una fila. El panel muestra las no reconocidas y
-- las graves además paran los envíos (wa_app_sessions.paused).
--
--   severity: info | warn | critical
--   code:     rafaga | identicos | desconocidos | sin_respuesta | automatizacion
--             | horario | ratio_saliente
-- --------------------------------------------------------------------------
CREATE TABLE policy_events (
  id              bigserial PRIMARY KEY,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel         text NOT NULL DEFAULT 'app',
  code            text NOT NULL,
  severity        text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
  -- 0-100: cuánto pesa este patrón. Alimenta el semáforo de salud del panel.
  score           integer NOT NULL DEFAULT 0,
  message         text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX policy_events_account_idx ON policy_events(account_id, created_at DESC);
CREATE INDEX policy_events_open_idx ON policy_events(account_id, severity)
  WHERE acknowledged_at IS NULL;

-- Un mismo patrón no debe repetir aviso cada minuto: el guardián solo inserta
-- si no hay uno del mismo código sin reconocer en la última hora (lo resuelve
-- la consulta, este índice es el que la hace barata).
CREATE INDEX policy_events_code_idx ON policy_events(account_id, code, created_at DESC);

-- --------------------------------------------------------------------------
-- Sesión para las cuentas que ya existen
-- --------------------------------------------------------------------------
INSERT INTO wa_app_sessions (account_id)
SELECT id FROM accounts
ON CONFLICT (account_id) DO NOTHING;
