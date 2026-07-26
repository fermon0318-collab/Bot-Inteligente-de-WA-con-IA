/**
 * Sincronización con la Marketing API de Meta.
 *
 * Se piden métricas por día y por anuncio. Meta limita las peticiones, así que
 * se sincroniza una vez por hora, no cada vez que alguien abre el panel.
 */

import { many, one, query } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export async function syncAccount({ accountId, days = 30 }) {
  const cfg = await one(
    'SELECT ads_account_id, ads_token_enc FROM bot_settings WHERE account_id = $1',
    [accountId]
  );
  const token = decrypt(cfg?.ads_token_enc);
  if (!cfg?.ads_account_id || !token) return { skipped: 'sin_credenciales' };

  const desde = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const hasta = new Date().toISOString().slice(0, 10);

  const url = new URL(`${GRAPH}/${cfg.ads_account_id}/insights`);
  url.searchParams.set('level', 'ad');
  url.searchParams.set('fields',
    'ad_id,ad_name,campaign_id,campaign_name,adset_name,spend,impressions,clicks,account_currency');
  url.searchParams.set('time_range', JSON.stringify({ since: desde, until: hasta }));
  url.searchParams.set('time_increment', '1');   // desglose diario
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token);

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const data = await res.json();

  if (!res.ok) {
    await query(
      `INSERT INTO activity_log (account_id, level, message) VALUES ($1, 'err', $2)`,
      [accountId, `No se pudieron traer métricas de Meta: ${data?.error?.message || res.status}`]);
    return { error: data?.error?.message };
  }

  let filas = 0;
  for (const fila of data.data || []) {
    await query(
      `INSERT INTO ad_metrics (account_id, date, ad_id, ad_name, campaign_id, campaign_name,
                               adset_name, spend, impressions, clicks, currency, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (account_id, date, ad_id) DO UPDATE SET
         ad_name = EXCLUDED.ad_name, campaign_name = EXCLUDED.campaign_name,
         adset_name = EXCLUDED.adset_name, spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
         synced_at = now()`,
      [accountId, fila.date_start, fila.ad_id, fila.ad_name || '', fila.campaign_id || null,
       fila.campaign_name || '', fila.adset_name || '', Number(fila.spend) || 0,
       Number(fila.impressions) || 0, Number(fila.clicks) || 0, fila.account_currency || 'USD']
    );
    filas++;
  }

  return { synced: filas };
}

/** Sincroniza todas las cuentas que tengan credenciales. */
export async function syncAll() {
  const cuentas = await many(
    `SELECT account_id FROM bot_settings
      WHERE ads_account_id <> '' AND ads_token_enc IS NOT NULL`
  );
  for (const c of cuentas) {
    try { await syncAccount({ accountId: c.account_id }); }
    catch (err) { console.error(`[ads] cuenta ${c.account_id}:`, err.message); }
  }
  return cuentas.length;
}

export function startWorker({ intervalMs = 3600_000 } = {}) {
  const timer = setInterval(() => {
    syncAll().catch((err) => console.error('[ads]', err.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
