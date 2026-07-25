/**
 * Cifrado de credenciales de terceros (token de Meta, API Key de IA…).
 *
 * AES-256-GCM con IV aleatorio por valor. El formato almacenado es
 * `v1.<iv>.<tag>.<ciphertext>` en base64url, de modo que rotar el algoritmo más
 * adelante sea posible sin romper los registros existentes.
 */

import {
  createCipheriv, createDecipheriv, randomBytes,
  createHmac, timingSafeEqual,
} from 'node:crypto';
import { config } from '../config.js';

const KEY = Buffer.from(config.encryptionKey, 'hex');
const b64 = (buf) => buf.toString('base64url');
const unb64 = (str) => Buffer.from(str, 'base64url');

/** Cifra un texto. Devuelve null si el valor está vacío. */
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ciphertext)}`;
}

/** Descifra un valor. Devuelve '' si es nulo o si el formato no es reconocible. */
export function decrypt(stored) {
  if (!stored) return '';
  const parts = String(stored).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, unb64(parts[1]));
    decipher.setAuthTag(unb64(parts[2]));
    return Buffer.concat([decipher.update(unb64(parts[3])), decipher.final()]).toString('utf8');
  } catch {
    // Clave rotada o dato corrupto: mejor tratarlo como ausente que reventar
    return '';
  }
}

/**
 * Enmascara una credencial para mostrarla en el panel sin exponerla.
 * `EAAG1234…wxyz` → `EAAG••••wxyz`
 */
export function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}${'•'.repeat(8)}${value.slice(-4)}`;
}

/* --- Firma HMAC (cookies de sesión) -------------------------------------- */

export function sign(value, secret = config.sessionSecret) {
  const mac = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

/** Verifica una cadena firmada y devuelve el valor original, o null. */
export function unsign(signed, secret = config.sessionSecret) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const value = signed.slice(0, idx);
  const expected = createHmac('sha256', secret).update(value).digest('base64url');
  const a = Buffer.from(signed.slice(idx + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export const randomId = (bytes = 32) => randomBytes(bytes).toString('base64url');
