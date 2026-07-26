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
import { requireAuth, requireSubscription } from '../middleware/auth.js';
import * as adsync from '../services/adsync.js';
import * as capi from '../services/capi.js';
import * as engine from '../services/engine.js';
import * as media from '../services/media.js';
import * as receipts from '../services/receipts.js';
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
    const subscription = await billing.getStatus(account(req));
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
      bypass: config.bypassEmails.includes(req.user.email.toLowerCase()),
    });
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
   Bloqueo por país
   ========================================================================== */

router.get('/countries', async (req, res, next) => {
  try {
    const rows = await many(
      'SELECT country_code AS code, dial_prefix AS dial FROM blocked_countries WHERE account_id = $1',
      [account(req)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.put('/countries', requireSubscription, async (req, res, next) => {
  try {
    const list = Array.isArray(req.body?.blocked) ? req.body.blocked : [];
    await transaction(async (client) => {
      await client.query('DELETE FROM blocked_countries WHERE account_id = $1', [account(req)]);
      for (const item of list) {
        if (!item?.code) continue;
        await client.query(
          `INSERT INTO blocked_countries (account_id, country_code, dial_prefix)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [account(req), String(item.code), String(item.dial || '')]
        );
      }
    });
    await log(account(req), `Lista de países bloqueados actualizada (${list.length})`, 'info');
    res.json({ ok: true, blocked: list.length });
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
      `SELECT c.id, c.name, c.phone, c.status, c.ad_name AS "adName", c.ai_enabled AS "aiEnabled",
              c.last_message_at AS "lastAt",
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
      `SELECT m.id, m.direction, m.body, m.media_url AS "mediaUrl", m.created_at AS "at"
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

export default router;
