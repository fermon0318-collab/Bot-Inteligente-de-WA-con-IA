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

// Railway asigna un subdominio público antes de que exista un dominio propio;
// se usa como respaldo para no obligar a fijar PUBLIC_URL a mano en el primer
// despliegue. Fuera de Railway la variable simplemente no existe y no cambia nada.
const railwayDomain = optional('RAILWAY_PUBLIC_DOMAIN', '');
const publicUrlRaw = optional('PUBLIC_URL', '') || (railwayDomain ? `https://${railwayDomain}` : '');
if (!publicUrlRaw) missing.push('PUBLIC_URL — ej. https://elorai.io (o define RAILWAY_PUBLIC_DOMAIN)');

const BILLING_PROVIDER = optional('BILLING_PROVIDER', 'none');

export const config = {
  env: NODE_ENV,
  isProd,
  port: Number(optional('PORT', '3000')),
  host: optional('HOST', '127.0.0.1'),

  /** URL pública del sitio, sin barra final. Se usa para OAuth y Stripe. */
  publicUrl: publicUrlRaw.replace(/\/$/, ''),

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

  // Google y Stripe son opcionales al arrancar: mientras no estén configurados,
  // /auth/google y /api/billing/* responden con un aviso claro en lugar de
  // impedir que el resto del sitio (y el bot) funcione.
  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    get configured() { return Boolean(config.google.clientId && config.google.clientSecret); },
    // Debe coincidir carácter por carácter con la URI autorizada en Google
    get redirectUri() { return `${config.publicUrl}/auth/google/callback`; },
  },

  stripe: {
    secretKey: BILLING_PROVIDER === 'stripe'
      ? required('STRIPE_SECRET_KEY', { hint: 'sk_live_… o sk_test_…' })
      : optional('STRIPE_SECRET_KEY'),
    webhookSecret: BILLING_PROVIDER === 'stripe'
      ? required('STRIPE_WEBHOOK_SECRET', { hint: 'whsec_… del endpoint del webhook' })
      : optional('STRIPE_WEBHOOK_SECRET'),
    priceMonthly: BILLING_PROVIDER === 'stripe'
      ? required('STRIPE_PRICE_MONTHLY', { hint: 'price_… del plan mensual' })
      : optional('STRIPE_PRICE_MONTHLY'),
    priceYearly: BILLING_PROVIDER === 'stripe'
      ? required('STRIPE_PRICE_YEARLY', { hint: 'price_… del plan anual' })
      : optional('STRIPE_PRICE_YEARLY'),
    trialDays: Number(optional('STRIPE_TRIAL_DAYS', '0')),
  },

  wompi: {
    publicKey: BILLING_PROVIDER === 'wompi'
      ? required('WOMPI_PUBLIC_KEY', { hint: 'pub_prod_… o pub_test_…' })
      : optional('WOMPI_PUBLIC_KEY'),
    privateKey: BILLING_PROVIDER === 'wompi'
      ? required('WOMPI_PRIVATE_KEY', { hint: 'prv_prod_… o prv_test_…' })
      : optional('WOMPI_PRIVATE_KEY'),
    integritySecret: BILLING_PROVIDER === 'wompi'
      ? required('WOMPI_INTEGRITY_SECRET', { hint: 'Comercios → Desarrolladores → Secreto de integridad' })
      : optional('WOMPI_INTEGRITY_SECRET'),
    eventsSecret: BILLING_PROVIDER === 'wompi'
      ? required('WOMPI_EVENTS_SECRET', { hint: 'Comercios → Desarrolladores → Secreto de eventos' })
      : optional('WOMPI_EVENTS_SECRET'),
    // En pesos colombianos * 100 (amount_in_cents, como pide la API de Wompi).
    priceMonthlyCop: Number(optional('WOMPI_PRICE_MONTHLY_COP', '0')),
    priceYearlyCop: Number(optional('WOMPI_PRICE_YEARLY_COP', '0')),
    trialDays: Number(optional('WOMPI_TRIAL_DAYS', '7')),
    get sandbox() { return config.wompi.publicKey.startsWith('pub_test_'); },
    get apiBase() {
      return config.wompi.sandbox ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1';
    },
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
