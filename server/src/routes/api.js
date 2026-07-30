/**
 * API del panel.
 *
 * Todas las rutas exigen sesión; las que tocan la operación del bot exigen
 * además suscripción utilizable. Las credenciales de terceros salen siempre
 * enmascaradas: el panel nunca recibe de vuelta un token en claro.
 */

import { Router } from 'express';
import multer from 'multer';
import { billing } from '../billing/index.js';
import { config } from '../config.js';
import { many, one, query, transaction } from '../db/pool.js';
import { decrypt, encrypt, mask } from '../lib/crypto.js';
import { destroySession } from '../lib/session.js';
import { requireAuth, requireSubscription } from '../middleware/auth.js';
import * as adsync from '../services/adsync.js';
import * as capi from '../services/capi.js';
import * as engine from '../services/engine.js';
import * as media from '../services/media.js';
import * as receipts from '../services/receipts.js';
import * as storage from '../services/storage.js';
import { ALLOWED, MAX_BYTES } from '../services/storage.js';

const router = Router();
router.use(requireAuth);

// En memoria: los archivos son pequeños y así no hay temporales que limpiar
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (_req, file, cb) => cb(null, Boolean(ALLOWED[file.mimetype])),
});

const account = (req) => req.user.accountId;

/** Escribe una línea en la terminal de actividad del panel. */
async function log(accountId, message, level = 'info') {
  await query(
    'INSERT INTO activity_log (account_id, level, message) VALUES ($1, $2, $3)',
    [accountId, level, message]
  );
}

/* ==========================================================================
   Sesión y suscripción
   ========================================================================== */

router.get('/me', async (req, res, next) => {
  try {
    const bypass = config.bypassEmails.includes(req.user.email.toLowerCase());
    const subscription = await billing.getStatus(account(req));

    // Una cuenta gratuita de por vida puede tener (o no) una fila en
    // subscriptions; lo que manda es el bypass, igual que en
    // subscriptionAccess(). Sin esto el panel le mostraría "Sin plan".
    if (bypass) subscription.status = 'bypass';

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        avatarUrl: req.user.avatarUrl,
        role: req.user.role,
      },
      subscription,
      support: config.support,
      bypass,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Eliminar la cuenta y todo lo que cuelga de ella.
 *
 * Es irreversible: el borrado de `accounts` arrastra en cascada
 * conversaciones, contactos, agenda, flujos y credenciales. Se exige repetir
 * el correo propio en el cuerpo para que un clic accidental no pueda vaciar
 * una cuenta con meses de historial.
 */
router.delete('/account', async (req, res, next) => {
  try {
    const confirm = String(req.body?.confirmEmail || '').trim().toLowerCase();
    if (confirm !== req.user.email.toLowerCase()) {
      return res.status(400).json({
        error: 'confirmation_mismatch',
        message: 'Escribe tu correo exactamente como aparece para confirmar el borrado.',
      });
    }

    await query('DELETE FROM accounts WHERE id = $1', [account(req)]);
    await destroySession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Onboarding — datos de negocio recogidos tras el primer login con Google
   ========================================================================== */

const BUSINESS_TYPES = new Set([
  'agencia_marketing', 'barberia', 'baile_danza', 'clases', 'clinica', 'crossfit',
  'ecommerce', 'educacion', 'electroestimulacion', 'entrenamiento_funcional', 'estetica',
  'estilista_independiente', 'freelancer', 'gimnasio', 'inmobiliaria',
  'kinesiologo_fisioterapia', 'maquillaje', 'medicina_alternativa', 'odontologia',
  'peluqueria', 'personal_trainer', 'pilates', 'podologia', 'productos_digitales',
  'psicologia', 'quiropractico', 'restaurante', 'salon_belleza', 'salon_cejas_pestanas',
  'salon_manicura_pedicura', 'servicios_profesionales', 'spa', 'veterinaria',
  'yoga_meditacion', 'otro',
]);
const TEAM_SIZES = new Set(['independiente', '2', '3-5', '6-15', '16+']);
// Longitud esperada de teléfono (sin prefijo) por país. Los que no están aquí
// se validan con un rango genérico razonable.
const PHONE_LENGTHS = {
  CO: [10, 10], MX: [10, 10], AR: [10, 11], CL: [9, 9], PE: [9, 9], BR: [10, 11],
  US: [10, 10], CA: [10, 10], ES: [9, 9], EC: [9, 9], VE: [10, 10], UY: [8, 9],
  PY: [9, 9], BO: [8, 8], GT: [8, 8], DO: [10, 10], PA: [7, 8], CR: [8, 8],
};
// Mismos países que ofrece el selector del formulario (assets/js/catalogs.js
// App.COUNTRIES) — cualquier otro código no pudo venir de la UI real.
const PHONE_COUNTRY_CODES = new Set([
  'MX', 'CO', 'AR', 'CL', 'PE', 'BR', 'UY', 'PY', 'BO', 'EC', 'VE', 'GT',
  'SV', 'HN', 'NI', 'CR', 'PA', 'DO', 'CU', 'PR', 'US', 'CA', 'ES', 'PT',
  'FR', 'IT', 'DE', 'GB', 'NL', 'BE', 'CH', 'MA', 'NG', 'ZA', 'EG', 'IN',
  'PK', 'BD', 'ID', 'PH', 'VN', 'CN', 'RU', 'TR', 'AE', 'AU', 'JP', 'KR',
]);

router.get('/onboarding', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM business_profile WHERE account_id = $1', [account(req)]);
    res.json({
      profile: row && {
        businessType: row.business_type,
        teamSize: row.team_size,
        fullName: row.full_name,
        phoneCountry: row.phone_country,
        phoneNumber: row.phone_number,
      },
      email: req.user.email,
      suggestedName: req.user.name,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/onboarding', async (req, res, next) => {
  try {
    const businessType = String(req.body?.businessType || '').trim();
    const teamSize = String(req.body?.teamSize || '').trim();
    const fullName = String(req.body?.fullName || '').trim().slice(0, 120);
    const phoneCountry = String(req.body?.phoneCountry || '').trim().toUpperCase();
    const phoneNumber = String(req.body?.phoneNumber || '').replace(/\D/g, '');

    if (!BUSINESS_TYPES.has(businessType)) {
      return res.status(400).json({ error: 'validation', message: 'Elige el tipo de negocio.' });
    }
    if (!TEAM_SIZES.has(teamSize)) {
      return res.status(400).json({ error: 'validation', message: 'Indica cuántas personas atienden en tu negocio.' });
    }
    if (fullName.length < 3) {
      return res.status(400).json({ error: 'validation', message: 'Escribe tu nombre y apellido.' });
    }
    if (!PHONE_COUNTRY_CODES.has(phoneCountry)) {
      return res.status(400).json({ error: 'validation', message: 'Selecciona un país válido.' });
    }
    const [min, max] = PHONE_LENGTHS[phoneCountry] || [7, 15];
    if (phoneNumber.length < min || phoneNumber.length > max) {
      return res.status(400).json({
        error: 'validation',
        message: `El teléfono debe tener ${min === max ? `${min} dígitos` : `entre ${min} y ${max} dígitos`} para ese país.`,
      });
    }

    const row = await one(
      `INSERT INTO business_profile (account_id, business_type, team_size, full_name, phone_country, phone_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE
         SET business_type = $2, team_size = $3, full_name = $4, phone_country = $5, phone_number = $6
       RETURNING account_id`,
      [account(req), businessType, teamSize, fullName, phoneCountry, phoneNumber]
    );
    await log(account(req), `Onboarding completado · ${fullName}`);
    res.status(201).json({ ok: true, accountId: row.account_id });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Configuración del bot
   ========================================================================== */

function publicSettings(row) {
  return {
    cloudApi: {
      phoneNumberId: row.wa_phone_number_id,
      businessId: row.wa_business_id,
      displayPhone: row.wa_display_phone,
      tokenMask: mask(decrypt(row.wa_token_enc)),
      hasToken: Boolean(row.wa_token_enc),
      verifyToken: row.wa_verify_token,
      webhookUrl: `${config.publicUrl}/webhook/whatsapp`,
      connected: row.wa_connected,
      botRunning: row.bot_running,
    },
    ai: {
      enabled: row.ai_enabled,
      model: row.ai_model,
      keyMask: mask(decrypt(row.ai_key_enc)),
      hasKey: Boolean(row.ai_key_enc),
      delaySeconds: row.ai_delay_seconds,
      prompt: row.ai_prompt,
      dailyLimit: row.ai_daily_limit,
    },
    ads: {
      accountId: row.ads_account_id,
      tokenMask: mask(decrypt(row.ads_token_enc)),
      hasToken: Boolean(row.ads_token_enc),
      pixelId: row.capi_pixel_id,
      currency: row.capi_currency,
      capiEnabled: row.capi_enabled,
    },
    payments: {
      messageOk: row.pay_message_ok,
      messageInvalid: row.pay_message_invalid,
      postFlowId: row.pay_post_flow_id,
    },
    remarketing: {
      enabled: row.rm_enabled,
      hours: row.rm_hours,
      minutes: row.rm_minutes,
      windowStart: String(row.rm_window_start).slice(0, 5),
      windowEnd: String(row.rm_window_end).slice(0, 5),
      timezone: row.rm_timezone,
    },
    currency: row.currency,
  };
}

router.get('/settings', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM bot_settings WHERE account_id = $1', [account(req)]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(publicSettings(row));
  } catch (err) {
    next(err);
  }
});

/**
 * Guarda credenciales de WhatsApp Cloud API.
 * El token solo se reescribe si llega uno nuevo: así el panel puede enviar el
 * formulario completo sin borrar el que ya estaba guardado.
 */
router.put('/settings/cloud-api', requireSubscription, async (req, res, next) => {
  try {
    const { phoneNumberId = '', businessId = '', displayPhone = '', token } = req.body || {};

    if (!phoneNumberId.trim() || !businessId.trim()) {
      return res.status(400).json({ error: 'validation', message: 'Phone Number ID y Business Account ID son obligatorios.' });
    }

    await query(
      `UPDATE bot_settings
          SET wa_phone_number_id = $2,
              wa_business_id = $3,
              wa_display_phone = $4,
              wa_token_enc = COALESCE($5, wa_token_enc),
              updated_at = now()
        WHERE account_id = $1`,
      [account(req), phoneNumberId.trim(), businessId.trim(), displayPhone.trim(),
       token ? encrypt(token) : null]
    );

    await log(account(req), 'Credenciales de Cloud API guardadas', 'ok');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Comprueba las credenciales contra la Graph API de Meta. */
router.post('/settings/cloud-api/test', requireSubscription, async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM bot_settings WHERE account_id = $1', [account(req)]);
    const token = decrypt(row?.wa_token_enc);

    if (!token || !row.wa_phone_number_id) {
      await log(account(req), 'Prueba de conexión sin credenciales completas', 'err');
      return res.status(400).json({ ok: false, message: 'Faltan el Access Token o el Phone Number ID.' });
    }

    const started = Date.now();
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${row.wa_phone_number_id}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const ms = Date.now() - started;

    if (!response.ok) {
      const message = data?.error?.message || 'Meta rechazó la petición';
      await query('UPDATE bot_settings SET wa_connected = false WHERE account_id = $1', [account(req)]);
      await log(account(req), `Fallo de conexión: ${message}`, 'err');
      return res.status(400).json({ ok: false, message });
    }

    await query(
      `UPDATE bot_settings SET wa_connected = true, wa_display_phone = COALESCE($2, wa_display_phone)
        WHERE account_id = $1`,
      [account(req), data.display_phone_number || null]
    );
    await log(account(req), `Conexión correcta · latencia ${ms} ms`, 'ok');

    res.json({
      ok: true,
      latencyMs: ms,
      displayPhone: data.display_phone_number,
      verifiedName: data.verified_name,
      qualityRating: data.quality_rating,
    });
  } catch (err) {
    next(err);
  }
});

/** Recupera de Meta los identificadores a partir del token (alta semi-automática). */
router.post('/settings/cloud-api/discover', requireSubscription, async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (token.length < 20) {
      return res.status(400).json({ error: 'validation', message: 'El Access Token parece incompleto.' });
    }

    const businesses = await fetch(
      'https://graph.facebook.com/v21.0/me/businesses?fields=id,name',
      { headers: { Authorization: `Bearer ${token}` } }
    ).then((r) => r.json());

    if (businesses.error) {
      return res.status(400).json({ error: 'meta', message: businesses.error.message });
    }

    const businessId = businesses.data?.[0]?.id;
    if (!businessId) {
      return res.status(400).json({ error: 'meta', message: 'El token no tiene acceso a ninguna cuenta de empresa.' });
    }

    const wabas = await fetch(
      `https://graph.facebook.com/v21.0/${businessId}/owned_whatsapp_business_accounts?fields=id,name`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then((r) => r.json());

    const wabaId = wabas.data?.[0]?.id;
    if (!wabaId) {
      return res.status(400).json({ error: 'meta', message: 'No hay cuentas de WhatsApp Business asociadas.' });
    }

    const phones = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).then((r) => r.json());

    const phone = phones.data?.[0];
    await log(account(req), 'Datos recuperados de Meta correctamente', 'ok');

    res.json({
      businessId: wabaId,
      phoneNumberId: phone?.id || '',
      displayPhone: phone?.display_phone_number || '',
      verifiedName: phone?.verified_name || '',
    });
  } catch (err) {
    next(err);
  }
});

/** Arranca o detiene el bot. */
router.post('/settings/bot/:action(start|stop)', requireSubscription, async (req, res, next) => {
  try {
    const running = req.params.action === 'start';
    const row = await one('SELECT wa_token_enc, wa_phone_number_id FROM bot_settings WHERE account_id = $1', [account(req)]);

    if (running && (!row?.wa_token_enc || !row.wa_phone_number_id)) {
      return res.status(400).json({ error: 'validation', message: 'Configura Cloud API antes de iniciar el bot.' });
    }

    await query('UPDATE bot_settings SET bot_running = $2, updated_at = now() WHERE account_id = $1',
      [account(req), running]);
    await log(account(req), running ? 'Bot iniciado · escuchando mensajes' : 'Bot detenido por el usuario',
      running ? 'ok' : 'warn');

    res.json({ ok: true, running });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/ai', requireSubscription, async (req, res, next) => {
  try {
    const { enabled = true, model = 'claude-sonnet-5', apiKey, delaySeconds = 15, prompt = '', dailyLimit } = req.body || {};
    const delay = Math.min(30, Math.max(10, Number(delaySeconds) || 15));
    const limite = Math.min(5000, Math.max(1, Number(dailyLimit) || 500));

    await query(
      `UPDATE bot_settings
          SET ai_enabled = $2, ai_model = $3,
              ai_key_enc = COALESCE($4, ai_key_enc),
              ai_delay_seconds = $5, ai_prompt = $6, ai_daily_limit = $7, updated_at = now()
        WHERE account_id = $1`,
      [account(req), Boolean(enabled), String(model), apiKey ? encrypt(apiKey) : null, delay, String(prompt), limite]
    );

    await log(account(req), `Configuración de IA guardada (${model})`, 'ok');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/ads', requireSubscription, async (req, res, next) => {
  try {
    const { adsAccountId = '', token, pixelId = '', currency = 'USD', capiEnabled = false } = req.body || {};

    if (capiEnabled && !/^\d{10,}$/.test(String(pixelId))) {
      return res.status(400).json({ error: 'validation', message: 'El Pixel ID debe tener al menos 10 dígitos.' });
    }

    await query(
      `UPDATE bot_settings
          SET ads_account_id = $2,
              ads_token_enc = COALESCE($3, ads_token_enc),
              capi_pixel_id = $4, capi_currency = $5, capi_enabled = $6, updated_at = now()
        WHERE account_id = $1`,
      [account(req), String(adsAccountId), token ? encrypt(token) : null,
       String(pixelId), String(currency), Boolean(capiEnabled)]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/remarketing', requireSubscription, async (req, res, next) => {
  try {
    const { enabled = false, hours = 24, minutes = 0, windowStart = '09:00', windowEnd = '21:00',
            timezone = 'America/Mexico_City', steps = [] } = req.body || {};

    if (Number(hours) === 0 && Number(minutes) === 0) {
      return res.status(400).json({ error: 'validation', message: 'El tiempo de disparo no puede ser cero.' });
    }
    // Igual a igual es una franja de ancho cero; al revés (22:00–02:00) es una
    // franja nocturna válida, así que solo se rechaza la igualdad exacta.
    if (String(windowStart) === String(windowEnd)) {
      return res.status(400).json({ error: 'validation', message: 'La hora de inicio y la de fin no pueden ser iguales.' });
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE bot_settings
            SET rm_enabled = $7, rm_hours = $2, rm_minutes = $3, rm_window_start = $4,
                rm_window_end = $5, rm_timezone = $6, updated_at = now()
          WHERE account_id = $1`,
        [account(req), Number(hours), Number(minutes), windowStart, windowEnd, timezone, Boolean(enabled)]
      );
      await client.query('DELETE FROM remarketing_steps WHERE account_id = $1', [account(req)]);
      for (const [i, step] of steps.entries()) {
        await client.query(
          `INSERT INTO remarketing_steps (account_id, position, step_type, value)
           VALUES ($1, $2, $3, $4)`,
          [account(req), i, step.type, String(step.value ?? '')]
        );
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/remarketing/steps', async (req, res, next) => {
  try {
    const rows = await many(
      'SELECT step_type AS type, value FROM remarketing_steps WHERE account_id = $1 ORDER BY position',
      [account(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Flujos y disparadores
   ========================================================================== */

router.get('/flows', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'advanced' ? 'advanced' : 'simple';
    const rows = await many(
      `SELECT id, name, steps, tree, updated_at
         FROM flows WHERE account_id = $1 AND kind = $2 ORDER BY created_at`,
      [account(req), kind]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/flows', requireSubscription, async (req, res, next) => {
  try {
    const kind = req.body?.kind === 'advanced' ? 'advanced' : 'simple';
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'validation', message: 'El flujo necesita un nombre.' });

    const row = await one(
      `INSERT INTO flows (account_id, kind, name, steps, tree)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, steps, tree`,
      [account(req), kind, name,
       JSON.stringify(req.body?.steps || []),
       req.body?.tree ? JSON.stringify(req.body.tree) : null]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/flows/:id', requireSubscription, async (req, res, next) => {
  try {
    const row = await one(
      `UPDATE flows
          SET name = COALESCE($3, name),
              steps = COALESCE($4, steps),
              tree = COALESCE($5, tree),
              updated_at = now()
        WHERE id = $1 AND account_id = $2
    RETURNING id, name, steps, tree, updated_at`,
      [req.params.id, account(req),
       req.body?.name ?? null,
       req.body?.steps ? JSON.stringify(req.body.steps) : null,
       req.body?.tree ? JSON.stringify(req.body.tree) : null]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.delete('/flows/:id', requireSubscription, async (req, res, next) => {
  try {
    await query('DELETE FROM flows WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/triggers', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'advanced' ? 'advanced' : 'simple';
    const rows = await many(
      `SELECT t.id, t.keyword, t.flow_id AS "flowId", t.is_default AS "isDefault", f.name AS "flowName"
         FROM triggers t LEFT JOIN flows f ON f.id = t.flow_id
        WHERE t.account_id = $1 AND t.kind = $2
        ORDER BY t.is_default DESC, t.created_at`,
      [account(req), kind]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/triggers', requireSubscription, async (req, res, next) => {
  try {
    const kind = req.body?.kind === 'advanced' ? 'advanced' : 'simple';
    const keyword = String(req.body?.keyword || '').trim();
    if (!keyword) return res.status(400).json({ error: 'validation', message: 'Escribe una palabra clave.' });

    const row = await one(
      `INSERT INTO triggers (account_id, kind, keyword, flow_id, is_default)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, kind, lower(keyword)) DO NOTHING
       RETURNING id, keyword, flow_id AS "flowId", is_default AS "isDefault"`,
      [account(req), kind, keyword, req.body?.flowId || null, Boolean(req.body?.isDefault)]
    );
    if (!row) {
      return res.status(409).json({ error: 'duplicate', message: 'Ya existe un disparador con esa palabra clave.' });
    }
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/triggers/:id/default', requireSubscription, async (req, res, next) => {
  try {
    await transaction(async (client) => {
      const current = await client.query(
        'SELECT kind FROM triggers WHERE id = $1 AND account_id = $2',
        [req.params.id, account(req)]
      );
      if (!current.rows[0]) return;
      await client.query(
        'UPDATE triggers SET is_default = false WHERE account_id = $1 AND kind = $2',
        [account(req), current.rows[0].kind]
      );
      await client.query('UPDATE triggers SET is_default = true WHERE id = $1', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/triggers/:id', requireSubscription, async (req, res, next) => {
  try {
    await query('DELETE FROM triggers WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Pagos y acceso
   ========================================================================== */

router.get('/payments', async (req, res, next) => {
  try {
    const [settings, rules, quick] = await Promise.all([
      one('SELECT pay_message_ok, pay_message_invalid, pay_post_flow_id FROM bot_settings WHERE account_id = $1', [account(req)]),
      many('SELECT id, amount, context, message, files, currency, tolerance FROM access_rules WHERE account_id = $1 ORDER BY created_at', [account(req)]),
      many('SELECT id, keyword, reply FROM quick_replies WHERE account_id = $1 ORDER BY id', [account(req)]),
    ]);
    res.json({
      messageOk: settings?.pay_message_ok || '',
      messageInvalid: settings?.pay_message_invalid || '',
      postFlowId: settings?.pay_post_flow_id || null,
      rules,
      quickReplies: quick,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/payments', requireSubscription, async (req, res, next) => {
  try {
    const { messageOk = '', messageInvalid = '', postFlowId = null, rules = [], quickReplies = [] } = req.body || {};

    const incomplete = rules.find((r) => !String(r.amount || '').trim() || !String(r.context || '').trim() || !String(r.message || '').trim());
    if (incomplete) {
      return res.status(400).json({ error: 'validation', message: 'Hay reglas de acceso incompletas.' });
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE bot_settings SET pay_message_ok = $2, pay_message_invalid = $3,
                pay_post_flow_id = $4, updated_at = now()
          WHERE account_id = $1`,
        [account(req), String(messageOk), String(messageInvalid), postFlowId || null]
      );
      await client.query('DELETE FROM access_rules WHERE account_id = $1', [account(req)]);
      for (const rule of rules) {
        await client.query(
          `INSERT INTO access_rules (account_id, amount, context, message, files, currency, tolerance)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [account(req), String(rule.amount), String(rule.context), String(rule.message),
           JSON.stringify(rule.files || []), String(rule.currency || 'MXN'), Number(rule.tolerance) || 0]
        );
      }
      await client.query('DELETE FROM quick_replies WHERE account_id = $1', [account(req)]);
      for (const qr of quickReplies) {
        if (!String(qr.keyword || '').trim()) continue;
        await client.query(
          'INSERT INTO quick_replies (account_id, keyword, reply) VALUES ($1, $2, $3)',
          [account(req), String(qr.keyword), String(qr.reply || '')]
        );
      }
    });

    await log(account(req), 'Configuración de pagos y acceso guardada', 'ok');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Comprobantes de pago recibidos, para la cola de revisión manual del panel. */
router.get('/receipts', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT r.id, r.amount, r.currency, r.reference, r.bank, r.status, r.reason,
              r.confidence, r.created_at AS "at",
              c.id AS "contactId", c.name, c.phone
         FROM payment_receipts r JOIN contacts c ON c.id = r.contact_id
        WHERE r.account_id = $1
          AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC LIMIT 100`,
      [account(req), req.query.status || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** Aprobación manual: entrega el producto de la regla indicada. */
router.post('/receipts/:id/approve', requireSubscription, async (req, res, next) => {
  try {
    const result = await receipts.approveManually({
      accountId: account(req),
      receiptId: req.params.id,
      ruleId: req.body?.ruleId || null,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Contactos, conversaciones y métricas
   ========================================================================== */

router.get('/contacts', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 10));
    const filters = ['account_id = $1'];
    const params = [account(req)];

    if (req.query.status) { params.push(req.query.status); filters.push(`status = $${params.length}`); }
    if (req.query.phone) { params.push(`%${String(req.query.phone).replace(/\D/g, '')}%`); filters.push(`regexp_replace(phone, '\\D', '', 'g') LIKE $${params.length}`); }
    if (req.query.from) { params.push(req.query.from); filters.push(`last_message_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); filters.push(`last_message_at < ($${params.length}::date + interval '1 day')`); }

    const where = filters.join(' AND ');
    const total = (await one(`SELECT count(*)::int AS n FROM contacts WHERE ${where}`, params)).n;

    params.push(perPage, (page - 1) * perPage);
    const rows = await many(
      `SELECT id, name, phone, status, source, ad_name AS "adName", amount, currency,
              last_message_at AS "lastContact"
         FROM contacts WHERE ${where}
         ORDER BY last_message_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ rows, total, page, perPage });
  } catch (err) {
    next(err);
  }
});

/** Exportación CSV, sin el límite de 100 filas por página de /contacts. */
router.get('/contacts/export.csv', async (req, res, next) => {
  try {
    const filtro = req.query.status
      ? { sql: 'AND status = $2', params: [req.query.status] }
      : { sql: '', params: [] };

    const rows = await many(
      `SELECT name, phone, status, source, amount, currency, last_message_at
         FROM contacts WHERE account_id = $1 ${filtro.sql}
        ORDER BY last_message_at DESC`,
      [account(req), ...filtro.params]
    );

    const escapar = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [
      ['Nombre', 'Teléfono', 'Estado', 'Origen', 'Monto', 'Moneda', 'Último contacto'],
      ...rows.map((r) => [r.name, r.phone, r.status, r.source, r.amount, r.currency,
                          new Date(r.last_message_at).toISOString().slice(0, 10)]),
    ].map((f) => f.map(escapar).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="elorai-contactos-${new Date().toISOString().slice(0, 10)}.csv"`);
    // El BOM hace que Excel no destroce los acentos
    res.send('﻿' + csv);
  } catch (err) {
    next(err);
  }
});

router.post('/contacts/:id/paid', requireSubscription, async (req, res, next) => {
  try {
    const row = await one(
      `UPDATE contacts SET status = 'paid', paid_at = now()
        WHERE id = $1 AND account_id = $2 AND status <> 'paid'
    RETURNING id, name, phone, amount, currency`,
      [req.params.id, account(req)]
    );
    if (!row) return res.status(404).json({ error: 'not_found', message: 'El contacto no existe o ya estaba pagado.' });
    await log(account(req), `Contacto ${row.phone} marcado como pagado manualmente`, 'ok');
    // Ventas cerradas a mano también cuentan para Conversions API
    await capi.recordPurchase({ accountId: account(req), contactId: row.id, value: row.amount, currency: row.currency });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Alta manual de un contacto desde Chat en Vivo, para cuando el negocio
 * necesita escribirle primero a alguien (el botón "+"). Si el teléfono ya
 * existe se devuelve ese mismo contacto en vez de fallar — abrir el chat de
 * alguien que ya conocíamos no debería ser un error.
 */
router.post('/contacts', requireSubscription, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const phone = String(req.body?.phone || '').replace(/\D/g, '');

    // Igual que valida el número de WhatsApp de la propia cuenta en el
    // onboarding: entre 7 y 15 dígitos cubre cualquier país sin atarse a uno.
    if (phone.length < 7 || phone.length > 15) {
      return res.status(400).json({ error: 'validation', message: 'Escribe un teléfono válido, con el código de país incluido.' });
    }

    const row = await one(
      `INSERT INTO contacts (account_id, phone, name, source)
       VALUES ($1, $2, $3, 'manual')
       ON CONFLICT (account_id, phone) DO UPDATE SET
         name = CASE WHEN contacts.name = '' THEN EXCLUDED.name ELSE contacts.name END
       RETURNING id, name, phone, status, ad_name AS "adName", ai_enabled AS "aiEnabled",
                 last_message_at AS "lastAt"`,
      [account(req), phone, name]
    );

    await log(account(req), `Contacto agregado a mano: ${row.phone}`, 'ok');
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.get('/conversations', async (req, res, next) => {
  try {
    const scope = req.query.scope === 'history' ? 'history' : 'live';
    const perPage = Math.min(50, Number(req.query.perPage) || 20);
    const page = Math.max(1, Number(req.query.page) || 1);

    // "En vivo" = con actividad en las últimas 24 h, que es la ventana en la
    // que se puede responder sin plantilla aprobada por Meta.
    const window = scope === 'live'
      ? "AND last_message_at > now() - interval '24 hours'"
      : "AND last_message_at <= now() - interval '24 hours'";

    const rows = await many(
      // last_inbound_at decide si el chat sigue dentro de la ventana de 24 h
      // de Meta: fuera de ella el texto libre no se entrega y hay que usar
      // una plantilla, así que el panel necesita saberlo para avisar antes.
      `SELECT c.id, c.name, c.phone, c.status, c.ad_name AS "adName", c.ai_enabled AS "aiEnabled",
              c.last_message_at AS "lastAt", c.last_inbound_at AS "lastInboundAt",
              (SELECT body FROM messages m WHERE m.contact_id = c.id ORDER BY created_at DESC LIMIT 1) AS preview
         FROM contacts c
        WHERE c.account_id = $1 ${window}
        ORDER BY c.last_message_at DESC
        LIMIT $2 OFFSET $3`,
      [account(req), perPage, (page - 1) * perPage]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const rows = await many(
      // `media_url` es la ruta interna en disco y NO se expone: el navegador
      // solo recibe si hay adjunto y de qué tipo, y lo pide por
      // /api/messages/:id/media, que valida la cuenta.
      `SELECT m.id, m.direction, m.body, m.created_at AS "at",
              m.media_type AS "mediaType", m.media_name AS "mediaName",
              (m.media_url IS NOT NULL) AS "hasMedia"
         FROM messages m
         JOIN contacts c ON c.id = m.contact_id AND c.account_id = $2
        WHERE m.contact_id = $1
        ORDER BY m.created_at
        LIMIT 500`,
      [req.params.id, account(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.put('/conversations/:id/ai', requireSubscription, async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await query(
      // Reactivar la IA levanta también la marca de automatización detenida:
      // si no, el switch quedaría encendido sin que el bot volviera a responder.
      `UPDATE contacts
          SET ai_enabled = $3,
              automation_off = CASE WHEN $3 THEN false ELSE automation_off END
        WHERE id = $1 AND account_id = $2`,
      [req.params.id, account(req), enabled]
    );
    res.json({ ok: true, enabled });
  } catch (err) {
    next(err);
  }
});

/**
 * Sirve el adjunto de un mensaje (lo que envió el cliente por WhatsApp).
 *
 * La ruta en disco nunca viaja al navegador: se pide por id de mensaje y aquí
 * se comprueba que ese mensaje pertenece a la cuenta de quien pregunta. Sin
 * ese JOIN, cualquiera con sesión podría leer los archivos de otro negocio
 * cambiando el id en la URL.
 */
router.get('/messages/:id/media', async (req, res, next) => {
  try {
    const row = await one(
      `SELECT m.media_url, m.media_mime, m.media_name, m.media_type
         FROM messages m
        WHERE m.id = $1 AND m.account_id = $2`,
      [req.params.id, account(req)]
    );
    if (!row?.media_url) return res.status(404).json({ error: 'not_found' });

    const buffer = await storage.read(row.media_url);

    res.setHeader('Content-Type', row.media_mime || 'application/octet-stream');
    // Privado: es contenido de un cliente, no debe quedar en cachés compartidas.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Los PDF se descargan con su nombre; imagen/audio/video se ven en línea.
    if (row.media_type === 'pdf') {
      const safe = String(row.media_name || 'documento.pdf').replace(/[^\w.\- ]/g, '_');
      res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
    }
    res.send(buffer);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'file_missing' });
    next(err);
  }
});

/* ==========================================================================
   Plantillas de WhatsApp

   Meta las identifica por su NOMBRE dentro de la WABA de la cuenta, así que
   aquí no se crean plantillas: se registran las que el negocio ya aprobó en
   Meta Business Manager, para poder elegirlas y rellenarlas desde el panel.
   ========================================================================== */

router.get('/templates', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT id, name, language, category, body, variables, var_labels AS "varLabels"
         FROM wa_templates WHERE account_id = $1 ORDER BY name`,
      [account(req)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/templates', requireSubscription, async (req, res, next) => {
  try {
    // Meta exige minúsculas, dígitos y guiones bajos: si no coincide exacto
    // con lo aprobado allí, el envío falla con un error poco descriptivo.
    const name = String(req.body?.name || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,512}$/.test(name)) {
      return res.status(400).json({
        error: 'validation',
        message: 'El nombre debe coincidir con el de Meta: solo minúsculas, números y guiones bajos.',
      });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'validation', message: 'Falta el texto de la plantilla.' });

    const language = String(req.body?.language || 'es').trim() || 'es';
    const category = String(req.body?.category || 'UTILITY').trim().toUpperCase();
    const varLabels = Array.isArray(req.body?.varLabels) ? req.body.varLabels.map((s) => String(s).slice(0, 80)) : [];
    // El número de variables se deduce del propio texto, no se confía en el
    // cliente: si no cuadra, Meta rechaza el envío entero.
    const variables = new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;

    const row = await one(
      `INSERT INTO wa_templates (account_id, name, language, category, body, variables, var_labels)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (account_id, name, language) DO UPDATE SET
         category = EXCLUDED.category, body = EXCLUDED.body,
         variables = EXCLUDED.variables, var_labels = EXCLUDED.var_labels
       RETURNING id, name, language, category, body, variables, var_labels AS "varLabels"`,
      [account(req), name, language, category, body, variables, JSON.stringify(varLabels)]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requireSubscription, async (req, res, next) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM wa_templates WHERE id = $1 AND account_id = $2',
      [req.params.id, account(req)]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* --- Recordatorios automáticos de la Agenda ------------------------------- */
router.get('/templates/reminder', async (req, res, next) => {
  try {
    const row = await one(
      `SELECT reminder_enabled AS "enabled", reminder_hours AS "hours",
              reminder_template_id AS "templateId"
         FROM bot_settings WHERE account_id = $1`,
      [account(req)]
    );
    res.json(row || { enabled: false, hours: 24, templateId: null });
  } catch (err) { next(err); }
});

router.put('/templates/reminder', requireSubscription, async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const hours = Math.min(168, Math.max(1, Number(req.body?.hours) || 24));
    const templateId = req.body?.templateId || null;

    // Activar sin plantilla dejaría el recordatorio encendido pero mudo: es
    // preferible rechazarlo aquí que dejar al negocio creyendo que avisa.
    if (enabled && !templateId) {
      return res.status(400).json({
        error: 'validation',
        message: 'Elige la plantilla que se enviará como recordatorio.',
      });
    }
    if (templateId) {
      const tpl = await one('SELECT id FROM wa_templates WHERE id = $1 AND account_id = $2',
        [templateId, account(req)]);
      if (!tpl) return res.status(404).json({ error: 'not_found', message: 'Esa plantilla no existe.' });
    }

    await query(
      `UPDATE bot_settings
          SET reminder_enabled = $2, reminder_hours = $3, reminder_template_id = $4, updated_at = now()
        WHERE account_id = $1`,
      [account(req), enabled, hours, templateId]
    );
    await log(account(req), enabled
      ? `Recordatorios de cita activados (${hours} h antes)`
      : 'Recordatorios de cita desactivados', 'ok');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Envía una plantilla a un contacto — la vía válida fuera de las 24 h. */
router.post('/conversations/:id/template', requireSubscription, async (req, res, next) => {
  try {
    const tpl = await one(
      'SELECT name, language, body, variables FROM wa_templates WHERE id = $1 AND account_id = $2',
      [req.body?.templateId, account(req)]
    );
    if (!tpl) return res.status(404).json({ error: 'not_found', message: 'Esa plantilla no existe.' });

    const values = Array.isArray(req.body?.values) ? req.body.values.map((v) => String(v).trim()) : [];
    if (values.length !== tpl.variables || values.some((v) => !v)) {
      return res.status(400).json({
        error: 'validation',
        message: `Esta plantilla necesita ${tpl.variables} dato(s), todos completos.`,
      });
    }

    const result = await engine.sendTemplateTo({
      accountId: account(req), contactId: req.params.id, template: tpl, values,
    });
    if (result.error) return res.status(404).json({ error: result.error });

    res.status(202).json({ ok: true, queued: result.queued });
  } catch (err) { next(err); }
});

/** Envío manual desde Chat en Vivo. Entra por la misma cola que el bot. */
router.post('/conversations/:id/messages', requireSubscription, async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    const mediaName = req.body?.mediaName || null;

    if (!body && !mediaName) {
      return res.status(400).json({ error: 'validation', message: 'El mensaje está vacío.' });
    }

    const result = await engine.sendManual({
      accountId: account(req), contactId: req.params.id, body, mediaName,
    });

    if (result.error) return res.status(404).json({ error: result.error });

    res.status(202).json({
      ok: true,
      queued: result.queued,
      // Meta rechaza texto libre pasadas 24 h desde el último mensaje del
      // contacto: se avisa antes de que el envío falle sin explicación.
      outsideWindow: result.outsideWindow,
      warning: result.outsideWindow
        ? 'Han pasado más de 24 h desde el último mensaje del contacto. Meta solo permite plantillas aprobadas.'
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Detiene flujos, remarketing e IA para un contacto y cancela lo encolado. */
router.post('/conversations/:id/stop-automation', requireSubscription, async (req, res, next) => {
  try {
    await engine.stopAutomation({ accountId: account(req), contactId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Resumen para las tarjetas y gráficos del dashboard. */
router.get('/stats', async (req, res, next) => {
  try {
    const id = account(req);
    const [totals, daily, byHour] = await Promise.all([
      one(
        // Los alias van entre comillas: sin ellas PostgreSQL los devuelve en
        // minúsculas y el panel recibiría "contactstoday" en vez de "contactsToday".
        `SELECT
           count(*) FILTER (WHERE first_seen_at > now() - interval '30 days')::int AS "contacts30",
           count(*) FILTER (WHERE status = 'pending')::int                          AS "pending",
           count(*) FILTER (WHERE status = 'paid'
                            AND paid_at > now() - interval '30 days')::int          AS "sales30",
           count(*) FILTER (WHERE first_seen_at::date = current_date)::int          AS "contactsToday",
           count(*) FILTER (WHERE status = 'pending'
                            AND last_message_at::date = current_date)::int          AS "pendingToday",
           count(*) FILTER (WHERE status = 'paid'
                            AND paid_at::date = current_date)::int                  AS "salesToday",
           COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0)                  AS "revenueTotal",
           COALESCE(sum(amount) FILTER (WHERE status = 'paid'
                            AND paid_at > now() - interval '30 days'), 0)           AS "revenue30",
           COALESCE(sum(amount) FILTER (WHERE status = 'paid'
                            AND paid_at::date = current_date), 0)                   AS "revenueToday"
         FROM contacts WHERE account_id = $1`,
        [id]
      ),
      many(
        `SELECT d::date AS date,
                count(c.id) FILTER (WHERE c.first_seen_at::date = d::date)::int AS contacts,
                count(c.id) FILTER (WHERE c.paid_at::date = d::date)::int       AS sales,
                COALESCE(sum(c.amount) FILTER (WHERE c.paid_at::date = d::date), 0) AS revenue
           FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
           LEFT JOIN contacts c ON c.account_id = $1
          GROUP BY d ORDER BY d`,
        [id]
      ),
      many(
        `SELECT extract(hour FROM first_seen_at)::int AS hour, count(*)::int AS contacts
           FROM contacts WHERE account_id = $1
          GROUP BY 1 ORDER BY 1`,
        [id]
      ),
    ]);

    const conversion = totals.contacts30 ? (totals.sales30 / totals.contacts30) * 100 : 0;
    res.json({ totals: { ...totals, conversion }, daily, byHour });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Métricas de anuncios (Bloque E)
   ========================================================================== */

router.get('/ads', async (req, res, next) => {
  try {
    const desde = req.query.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const hasta = req.query.to || new Date().toISOString().slice(0, 10);

    // El gasto viene de Meta; las ventas, de nuestros contactos. Se cruzan por ad_id.
    const rows = await many(
      `WITH gasto AS (
         SELECT ad_id, max(ad_name) AS ad_name, max(campaign_name) AS campaign_name,
                sum(spend) AS spend, max(currency) AS currency
           FROM ad_metrics
          WHERE account_id = $1 AND date BETWEEN $2::date AND $3::date
          GROUP BY ad_id
       ),
       ventas AS (
         SELECT ad_id,
                count(*)                                        AS convos,
                count(*) FILTER (WHERE status = 'paid')         AS sales,
                COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0) AS revenue
           FROM contacts
          WHERE account_id = $1 AND ad_id IS NOT NULL
            AND first_seen_at BETWEEN $2::date AND ($3::date + interval '1 day')
          GROUP BY ad_id
       )
       SELECT COALESCE(g.ad_id, v.ad_id)              AS "adId",
              COALESCE(g.ad_name, 'Anuncio')          AS name,
              COALESCE(g.campaign_name, '')           AS campaign,
              COALESCE(g.spend, 0)                    AS spend,
              COALESCE(v.convos, 0)                   AS convos,
              COALESCE(v.sales, 0)                    AS sales,
              COALESCE(v.revenue, 0)                  AS revenue,
              COALESCE(g.currency, 'USD')             AS currency
         FROM gasto g FULL OUTER JOIN ventas v ON v.ad_id = g.ad_id
        ORDER BY 4 DESC`,
      [account(req), desde, hasta]
    );

    // Los derivados se calculan aquí y no en SQL: es más legible y son baratos
    const detalle = rows.map((r) => ({
      ...r,
      costPerConvo: r.convos ? r.spend / r.convos : 0,
      costPerSale: r.sales ? r.spend / r.sales : 0,
      roi: r.spend ? ((r.revenue - r.spend) / r.spend) * 100 : 0,
    }));

    const totales = detalle.reduce((acc, r) => ({
      spend: acc.spend + Number(r.spend),
      convos: acc.convos + Number(r.convos),
      sales: acc.sales + Number(r.sales),
      revenue: acc.revenue + Number(r.revenue),
    }), { spend: 0, convos: 0, sales: 0, revenue: 0 });

    res.json({
      rows: detalle,
      totals: {
        ...totales,
        roi: totales.spend ? ((totales.revenue - totales.spend) / totales.spend) * 100 : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Fuerza una sincronización desde el botón del panel. */
router.post('/ads/sync', requireSubscription, async (req, res, next) => {
  try {
    res.json(await adsync.syncAccount({ accountId: account(req) }));
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Terminal de actividad
   ========================================================================== */

router.get('/activity', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT level, message, created_at AS "at" FROM activity_log
        WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [account(req)]
    );
    res.json(rows.reverse());
  } catch (err) {
    next(err);
  }
});

router.delete('/activity', async (req, res, next) => {
  try {
    await query('DELETE FROM activity_log WHERE account_id = $1', [account(req)]);
    await log(account(req), 'Registro limpiado por el usuario', 'info');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Archivos
   ========================================================================== */

router.get('/media', async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT id, name, file_type AS "type", size_bytes AS "size", created_at AS "at"
         FROM media_files WHERE account_id = $1 ORDER BY created_at DESC`,
      [account(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/media', requireSubscription, upload.array('files', 10), async (req, res, next) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'validation', message: 'No llegó ningún archivo.' });
    }

    const saved = [];
    const rejected = [];

    for (const file of files) {
      try {
        saved.push(await media.addFile({
          accountId: account(req),
          buffer: file.buffer,
          mimeType: file.mimetype,
          originalName: file.originalname,
        }));
      } catch (err) {
        rejected.push({ name: file.originalname, reason: err.message });
      }
    }

    await log(account(req), `${saved.length} archivo(s) subidos`, 'ok');
    res.status(201).json({ saved, rejected });
  } catch (err) {
    next(err);
  }
});

router.delete('/media/:id', requireSubscription, async (req, res, next) => {
  try {
    const ok = await media.removeFile({ accountId: account(req), mediaFileId: req.params.id });
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   Agenda — profesionales, clientes, servicios, bloqueos y reservas
   ========================================================================== */

const APPT_STATUSES = new Set(['reservado', 'confirmado', 'asiste', 'no_asistio', 'pendiente', 'en_espera', 'cancelada']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_APPT_MINUTES = 24 * 60;         // una cita no puede durar más de un día
const MAX_BLOCK_DAYS = 180;               // un bloqueo (vacaciones, licencia…) hasta 6 meses
const MAX_RANGE_DAYS = 400;               // tope de rango consultable en /agenda/events
const NAME_MAX = 120;
const LABEL_MAX = 200;
const EMAIL_MAX = 200;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function notFound(message = 'No encontrado.') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function parseDate(value, field) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw badRequest(`Fecha inválida en "${field}".`);
  return d;
}

/** Valida que :id venga como UUID antes de tocar la base — evita 500 por "22P02". */
function requireUuidParam(req) {
  if (!UUID_RE.test(req.params.id || '')) throw notFound();
}

const trunc = (v, max) => String(v ?? '').trim().slice(0, max);

/** ¿La fila con ese id pertenece a esta cuenta? Lanza 404 si no (o si no existe). */
async function assertOwned(client, table, id, accountId, label) {
  if (!id) return;
  if (!UUID_RE.test(id)) throw badRequest(`"${label}" no es válido.`);
  const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!rows[0]) throw notFound(`${label} no encontrado.`);
}

/** Fila en conflicto (cita u otro bloqueo) para el mismo profesional en ese rango, o null. */
async function findConflict(client, { accountId, professionalId, startsAt, endsAt, excludeAppointmentId, excludeBlockId }) {
  const appt = await client.query(
    `SELECT a.id, a.starts_at, a.ends_at, c.name AS client_name
       FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE a.account_id = $1 AND a.professional_id = $2
        AND a.id <> COALESCE($5, '00000000-0000-0000-0000-000000000000'::uuid)
        AND a.starts_at < $4 AND a.ends_at > $3
      LIMIT 1`,
    [accountId, professionalId, startsAt, endsAt, excludeAppointmentId || null]
  );
  if (appt.rows[0]) {
    const r = appt.rows[0];
    return { kind: 'appointment', message: `Ya hay una reserva de ${r.client_name} en ese horario.` };
  }

  const block = await client.query(
    `SELECT id, label FROM schedule_blocks
      WHERE account_id = $1 AND professional_id = $2
        AND id <> COALESCE($5, '00000000-0000-0000-0000-000000000000'::uuid)
        AND starts_at < $4 AND ends_at > $3
      LIMIT 1`,
    [accountId, professionalId, startsAt, endsAt, excludeBlockId || null]
  );
  if (block.rows[0]) {
    return { kind: 'block', message: `Ese horario está bloqueado (${block.rows[0].label || 'sin motivo'}).` };
  }

  return null;
}

/* --- Profesionales -------------------------------------------------------- */

router.get('/agenda/professionals', async (req, res, next) => {
  try {
    let rows = await many(
      'SELECT id, name, active FROM professionals WHERE account_id = $1 ORDER BY created_at',
      [account(req)]
    );
    if (!rows.length) {
      const created = await one(
        'INSERT INTO professionals (account_id, name) VALUES ($1, $2) RETURNING id, name, active',
        [account(req), req.user.name || 'Profesional']
      );
      rows = [created];
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/agenda/professionals', requireSubscription, async (req, res, next) => {
  try {
    const name = trunc(req.body?.name, NAME_MAX);
    if (!name) return res.status(400).json({ error: 'validation', message: 'El profesional necesita un nombre.' });
    const row = await one(
      'INSERT INTO professionals (account_id, name) VALUES ($1, $2) RETURNING id, name, active',
      [account(req), name]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/agenda/professionals/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const name = req.body?.name !== undefined ? trunc(req.body.name, NAME_MAX) || null : null;
    const row = await one(
      `UPDATE professionals SET name = COALESCE($3, name), active = COALESCE($4, active)
        WHERE id = $1 AND account_id = $2 RETURNING id, name, active`,
      [req.params.id, account(req), name, req.body?.active ?? null]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'validation', message: err.message });
    next(err);
  }
});

/* --- Servicios -------------------------------------------------------------- */

router.get('/agenda/services', async (req, res, next) => {
  try {
    res.json(await many(
      'SELECT id, name, duration_min, active FROM services WHERE account_id = $1 ORDER BY created_at',
      [account(req)]
    ));
  } catch (err) {
    next(err);
  }
});

router.post('/agenda/services', requireSubscription, async (req, res, next) => {
  try {
    const name = trunc(req.body?.name, NAME_MAX);
    const durationMin = Number(req.body?.durationMin) || 30;
    if (!name) return res.status(400).json({ error: 'validation', message: 'El servicio necesita un nombre.' });
    const row = await one(
      'INSERT INTO services (account_id, name, duration_min) VALUES ($1, $2, $3) RETURNING id, name, duration_min, active',
      [account(req), name, Math.max(5, Math.min(durationMin, 480))]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/agenda/services/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const name = req.body?.name !== undefined ? trunc(req.body.name, NAME_MAX) || null : null;
    const durationMin = req.body?.durationMin !== undefined
      ? Math.max(5, Math.min(Number(req.body.durationMin) || 30, 480))
      : null;
    const row = await one(
      `UPDATE services SET name = COALESCE($3, name), duration_min = COALESCE($4, duration_min), active = COALESCE($5, active)
        WHERE id = $1 AND account_id = $2 RETURNING id, name, duration_min, active`,
      [req.params.id, account(req), name, durationMin, req.body?.active ?? null]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'validation', message: err.message });
    next(err);
  }
});

router.delete('/agenda/services/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const { rowCount } = await query('DELETE FROM services WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'not_found' });
    next(err);
  }
});

/* --- Clientes ----------------------------------------------------------------
   El buscador del modal "Nueva Reserva" y "+ Nuevo cliente" cuelgan de aquí. */

// Escapa % y _ (comodines de LIKE/ILIKE) para que buscar "50%" no traiga todos los clientes.
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

router.get('/agenda/clients', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const LIMIT = 20;
    const rows = q
      ? await many(
          `SELECT id, name, phone, email FROM clients
            WHERE account_id = $1 AND (name ILIKE $2 ESCAPE '\\' OR phone ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\')
            ORDER BY name LIMIT $3`,
          [account(req), `%${escapeLike(q)}%`, LIMIT + 1]
        )
      : await many('SELECT id, name, phone, email FROM clients WHERE account_id = $1 ORDER BY name LIMIT $2', [account(req), LIMIT + 1]);
    const hasMore = rows.length > LIMIT;
    res.json({ clients: rows.slice(0, LIMIT), hasMore });
  } catch (err) {
    next(err);
  }
});

router.post('/agenda/clients', requireSubscription, async (req, res, next) => {
  try {
    const name = trunc(req.body?.name, NAME_MAX);
    const phone = trunc(req.body?.phone, 30).replace(/[^\d+]/g, '');
    const email = trunc(req.body?.email, EMAIL_MAX);
    if (!name) return res.status(400).json({ error: 'validation', message: 'El cliente necesita un nombre.' });
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'validation', message: 'El email no tiene un formato válido.' });
    }

    const row = await one(
      'INSERT INTO clients (account_id, name, phone, email) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, email',
      [account(req), name, phone, email]
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'Ya existe un cliente con ese teléfono.' });
    }
    next(err);
  }
});

/* --- Eventos de la semana/día (citas + bloqueos) ----------------------------- */

router.get('/agenda/events', async (req, res, next) => {
  try {
    if (!req.query.from || !req.query.to) throw badRequest('Faltan "from" y "to".');
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    if (to <= from) throw badRequest('"to" debe ser posterior a "from".');
    if ((to - from) / 86400000 > MAX_RANGE_DAYS) {
      throw badRequest(`El rango consultado no puede superar ${MAX_RANGE_DAYS} días.`);
    }
    const professionalId = req.query.professionalId && UUID_RE.test(req.query.professionalId) ? req.query.professionalId : null;
    const status = req.query.status && APPT_STATUSES.has(req.query.status) ? req.query.status : null;

    const appointments = await many(
      `SELECT a.id, a.status, a.starts_at, a.ends_at, a.professional_id, a.source,
              c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
              s.id AS service_id, s.name AS service_name
         FROM appointments a
         JOIN clients c ON c.id = a.client_id
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.account_id = $1 AND a.starts_at < $3 AND a.ends_at > $2
          AND ($4::uuid IS NULL OR a.professional_id = $4)
          AND ($5::text IS NULL OR a.status = $5)
        ORDER BY a.starts_at`,
      [account(req), from, to, professionalId, status]
    );

    const blocks = await many(
      `SELECT b.id, b.label, b.starts_at, b.ends_at, b.professional_id
         FROM schedule_blocks b
        WHERE b.account_id = $1 AND b.starts_at < $3 AND b.ends_at > $2
          AND ($4::uuid IS NULL OR b.professional_id = $4)
        ORDER BY b.starts_at`,
      [account(req), from, to, professionalId]
    );

    res.json({ appointments, blocks });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'validation', message: err.message });
    next(err);
  }
});

/* --- Reservas ----------------------------------------------------------------- */

function assertDuration(startsAt, endsAt) {
  if (endsAt <= startsAt) throw badRequest('La hora de fin debe ser posterior a la de inicio.');
  const minutes = (endsAt - startsAt) / 60000;
  if (minutes > MAX_APPT_MINUTES) {
    throw badRequest(`Una reserva no puede durar más de ${MAX_APPT_MINUTES / 60} horas.`);
  }
}

router.post('/agenda/appointments', requireSubscription, async (req, res, next) => {
  try {
    const professionalId = String(req.body?.professionalId || '');
    const clientId = String(req.body?.clientId || '');
    const serviceId = req.body?.serviceId || null;
    const status = APPT_STATUSES.has(req.body?.status) ? req.body.status : 'reservado';
    const startsAt = parseDate(req.body?.startsAt, 'startsAt');
    const endsAt = parseDate(req.body?.endsAt, 'endsAt');
    const repeatWeeks = Math.min(Math.max(Number(req.body?.repeatWeeks) || 1, 1), 12);

    if (!professionalId || !clientId) {
      return res.status(400).json({ error: 'validation', message: 'Falta el profesional o el cliente.' });
    }
    assertDuration(startsAt, endsAt);

    const occurrences = Array.from({ length: repeatWeeks }, (_, i) => ({
      startsAt: new Date(startsAt.getTime() + i * 7 * 86400000),
      endsAt: new Date(endsAt.getTime() + i * 7 * 86400000),
    }));

    const created = await transaction(async (client) => {
      await assertOwned(client, 'professionals', professionalId, account(req), 'Profesional');
      await assertOwned(client, 'clients', clientId, account(req), 'Cliente');
      if (serviceId) await assertOwned(client, 'services', serviceId, account(req), 'Servicio');

      const rows = [];
      for (const occ of occurrences) {
        const conflict = await findConflict(client, {
          accountId: account(req), professionalId, startsAt: occ.startsAt, endsAt: occ.endsAt,
        });
        if (conflict) {
          const e = new Error(conflict.message);
          e.status = 409;
          throw e;
        }
        const { rows: [row] } = await client.query(
          `INSERT INTO appointments (account_id, professional_id, client_id, service_id, status, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, status, starts_at, ends_at, professional_id, client_id, service_id`,
          [account(req), professionalId, clientId, serviceId, status, occ.startsAt, occ.endsAt]
        );
        rows.push(row);
      }
      return rows;
    });

    await log(account(req), `${created.length > 1 ? `${created.length} reservas creadas` : 'Reserva creada'}`);
    res.status(201).json({ appointments: created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.status === 409 ? 'conflict' : 'validation', message: err.message });
    next(err);
  }
});

router.put('/agenda/appointments/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const current = await one(
      'SELECT * FROM appointments WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]
    );
    if (!current) return res.status(404).json({ error: 'not_found' });

    const professionalId = req.body?.professionalId ?? current.professional_id;
    const startsAt = req.body?.startsAt ? parseDate(req.body.startsAt, 'startsAt') : current.starts_at;
    const endsAt = req.body?.endsAt ? parseDate(req.body.endsAt, 'endsAt') : current.ends_at;
    const status = req.body?.status && APPT_STATUSES.has(req.body.status) ? req.body.status : current.status;
    const clientId = req.body?.clientId ?? current.client_id;
    const serviceId = req.body?.serviceId !== undefined ? req.body.serviceId : current.service_id;

    assertDuration(new Date(startsAt), new Date(endsAt));

    const timeChanged = professionalId !== current.professional_id
      || new Date(startsAt).getTime() !== new Date(current.starts_at).getTime()
      || new Date(endsAt).getTime() !== new Date(current.ends_at).getTime();
    const clientChanged = clientId !== current.client_id;
    const serviceChanged = serviceId !== current.service_id;

    const row = await transaction(async (client) => {
      if (professionalId !== current.professional_id) {
        await assertOwned(client, 'professionals', professionalId, account(req), 'Profesional');
      }
      if (clientChanged) await assertOwned(client, 'clients', clientId, account(req), 'Cliente');
      if (serviceChanged && serviceId) await assertOwned(client, 'services', serviceId, account(req), 'Servicio');

      if (timeChanged) {
        const conflict = await findConflict(client, {
          accountId: account(req), professionalId, startsAt, endsAt, excludeAppointmentId: current.id,
        });
        if (conflict) { const e = new Error(conflict.message); e.status = 409; throw e; }
      }
      const { rows: [updated] } = await client.query(
        `UPDATE appointments
            SET professional_id = $3, client_id = $4, service_id = $5, status = $6,
                starts_at = $7, ends_at = $8, updated_at = now()
          WHERE id = $1 AND account_id = $2
      RETURNING id, status, starts_at, ends_at, professional_id, client_id, service_id`,
        [current.id, account(req), professionalId, clientId, serviceId, status, startsAt, endsAt]
      );
      return updated;
    });

    res.json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.status === 409 ? 'conflict' : 'validation', message: err.message });
    next(err);
  }
});

router.delete('/agenda/appointments/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const { rowCount } = await query('DELETE FROM appointments WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'not_found' });
    next(err);
  }
});

/* --- Bloqueos de horas -------------------------------------------------------- */

router.post('/agenda/blocks', requireSubscription, async (req, res, next) => {
  try {
    const professionalId = String(req.body?.professionalId || '');
    const label = trunc(req.body?.label, LABEL_MAX);
    const startsAt = parseDate(req.body?.startsAt, 'startsAt');
    const endsAt = parseDate(req.body?.endsAt, 'endsAt');
    if (!professionalId) return res.status(400).json({ error: 'validation', message: 'Falta el profesional.' });
    if (endsAt <= startsAt) {
      return res.status(400).json({ error: 'validation', message: 'La hora de fin debe ser posterior a la de inicio.' });
    }
    if ((endsAt - startsAt) / 86400000 > MAX_BLOCK_DAYS) {
      return res.status(400).json({ error: 'validation', message: `Un bloqueo no puede durar más de ${MAX_BLOCK_DAYS} días.` });
    }

    const row = await transaction(async (client) => {
      await assertOwned(client, 'professionals', professionalId, account(req), 'Profesional');

      // Ya hay una reserva en ese rango: bloquear encima la dejaría "atrapada" sin avisar a nadie.
      const clash = await client.query(
        `SELECT a.id, a.starts_at, c.name AS client_name
           FROM appointments a JOIN clients c ON c.id = a.client_id
          WHERE a.account_id = $1 AND a.professional_id = $2 AND a.starts_at < $4 AND a.ends_at > $3
          ORDER BY a.starts_at LIMIT 5`,
        [account(req), professionalId, startsAt, endsAt]
      );
      if (clash.rows.length) {
        const names = [...new Set(clash.rows.map((r) => r.client_name))].join(', ');
        const e = new Error(
          clash.rows.length > 1
            ? `Ese rango ya tiene ${clash.rows.length} reserva(s) (${names}). Reprográmalas o cancélalas antes de bloquear.`
            : `Ese rango ya tiene una reserva de ${names}. Reprográmala o cancélala antes de bloquear.`
        );
        e.status = 409;
        throw e;
      }

      // Evita apilar el mismo bloqueo dos veces por doble clic / reintento.
      const dup = await client.query(
        `SELECT 1 FROM schedule_blocks
          WHERE account_id = $1 AND professional_id = $2 AND label = $3 AND starts_at = $4 AND ends_at = $5
          LIMIT 1`,
        [account(req), professionalId, label, startsAt, endsAt]
      );
      if (dup.rows[0]) {
        const e = new Error('Ya existe un bloqueo idéntico en ese horario.');
        e.status = 409;
        throw e;
      }

      const { rows: [created] } = await client.query(
        `INSERT INTO schedule_blocks (account_id, professional_id, label, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, label, starts_at, ends_at, professional_id`,
        [account(req), professionalId, label, startsAt, endsAt]
      );
      return created;
    });

    await log(account(req), `Horario bloqueado · ${label || 'sin motivo'}`);
    res.status(201).json(row);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.status === 409 ? 'conflict' : 'validation', message: err.message });
    next(err);
  }
});

router.delete('/agenda/blocks/:id', requireSubscription, async (req, res, next) => {
  try {
    requireUuidParam(req);
    const { rowCount } = await query('DELETE FROM schedule_blocks WHERE id = $1 AND account_id = $2', [req.params.id, account(req)]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: 'not_found' });
    next(err);
  }
});

export default router;
