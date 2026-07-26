/**
 * Configuración de Elorai.
 *
 * Se lee una sola vez al arrancar y se valida de golpe: si falta algo, el
 * proceso muere con un mensaje claro en lugar de fallar a mitad de una petición
 * en producción.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Directorio del backend: es donde vive package.json y donde se espera el .env */
export const SERVER_ROOT = join(here, '..');
/** Raíz del repositorio: contiene los archivos estáticos que sirve nginx */
export const ROOT = join(here, '..', '..');

/* --- Carga de .env (sin dependencias) ------------------------------------ */
function loadEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // en producción las variables vienen de systemd
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// El .env vive junto a package.json. En producción las variables llegan por
// systemd y este archivo simplemente no existe.
loadEnvFile(join(SERVER_ROOT, '.env'));

/* --- Lectura con validación ---------------------------------------------- */
const missing = [];

function required(name, { hint } = {}) {
  const value = process.env[name];
  if (!value) {
    missing.push(hint ? `${name} — ${hint}` : name);
    return '';
  }
  return value;
}

const optional = (name, fallback = '') => process.env[name] || fallback;

const NODE_ENV = optional('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

export const config = {
  env: NODE_ENV,
  isProd,
  port: Number(optional('PORT', '3000')),
  host: optional('HOST', '127.0.0.1'),

  /** URL pública del sitio, sin barra final. Se usa para OAuth y Stripe. */
  publicUrl: required('PUBLIC_URL', { hint: 'ej. https://elorai.io' }).replace(/\/$/, ''),

  db: {
    connectionString: required('DATABASE_URL', { hint: 'postgres://usuario:clave@host:5432/elorai' }),
    ssl: optional('DATABASE_SSL', 'false') === 'true' ? { rejectUnauthorized: false } : false,
    max: Number(optional('DATABASE_POOL_MAX', '10')),
  },

  /** Clave para firmar cookies de sesión. `openssl rand -hex 32` */
  sessionSecret: required('SESSION_SECRET', { hint: 'openssl rand -hex 32' }),
  sessionDays: Number(optional('SESSION_DAYS', '30')),

  /** Clave AES-256-GCM para cifrar credenciales de terceros en la base. */
  encryptionKey: required('ENCRYPTION_KEY', { hint: 'openssl rand -hex 32 (64 caracteres hex)' }),

  google: {
    clientId: required('GOOGLE_CLIENT_ID', { hint: 'Google Cloud Console → Credenciales' }),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    // Debe coincidir carácter por carácter con la URI autorizada en Google
    get redirectUri() { return `${config.publicUrl}/auth/google/callback`; },
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY', { hint: 'sk_live_… o sk_test_…' }),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET', { hint: 'whsec_… del endpoint del webhook' }),
    priceMonthly: required('STRIPE_PRICE_MONTHLY', { hint: 'price_… del plan mensual' }),
    priceYearly: required('STRIPE_PRICE_YEARLY', { hint: 'price_… del plan anual' }),
    trialDays: Number(optional('STRIPE_TRIAL_DAYS', '0')),
  },

  /** Correos que entran al panel sin suscripción activa (fundadores, soporte). */
  bypassEmails: optional('BILLING_BYPASS_EMAILS', '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),

  support: {
    email: optional('SUPPORT_EMAIL', ''),
    whatsapp: optional('SUPPORT_WHATSAPP', ''),
  },
};

if (missing.length) {
  console.error('\n✗ Faltan variables de entorno obligatorias:\n');
  for (const item of missing) console.error(`   · ${item}`);
  console.error('\n  Copia .env.example a .env y complétalo.\n');
  process.exit(1);
}

if (config.encryptionKey.length !== 64 || !/^[0-9a-f]+$/i.test(config.encryptionKey)) {
  console.error('\n✗ ENCRYPTION_KEY debe ser 64 caracteres hexadecimales. Genérala con:\n');
  console.error('   openssl rand -hex 32\n');
  process.exit(1);
}

if (isProd && !config.publicUrl.startsWith('https://')) {
  console.error('\n✗ En producción PUBLIC_URL debe usar https:// — las cookies de sesión son Secure.\n');
  process.exit(1);
}
