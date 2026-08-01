/**
 * Proveedores de WhatsApp.
 *
 * Todo lo que envía un mensaje —la cola, el motor, el remarketing, la agenda—
 * habla con un proveedor, nunca con una implementación concreta. Un proveedor
 * es siempre este objeto:
 *
 *   {
 *     name,            'cloud' | 'app'
 *     ready,           ¿se puede enviar ahora mismo?
 *     reason,          si no, por qué (texto para el panel)
 *     capabilities,    qué sabe hacer este canal
 *     sendText, sendMedia, sendTemplate, markAsRead,
 *     beforeSend, afterSend   ganchos de ritmo y registro
 *   }
 *
 * El motivo de existir de esta capa es concreto: WhatsApp cambia. Cloud API
 * sube de versión, Baileys se rompe cuando Meta toca el protocolo de WhatsApp
 * Web, y algún día habrá una tercera opción. Con esta frontera, cambiar de
 * implementación es escribir un archivo nuevo en esta carpeta y añadir una
 * línea al mapa de abajo — no tocar la plataforma entera.
 *
 * Regla para quien añada uno: si un canal no sabe hacer algo (Modo App no
 * tiene plantillas, por ejemplo), lo declara en `capabilities` y lanza un
 * error claro; nunca finge que funcionó.
 */

import { one } from '../../db/pool.js';
import * as appProvider from './app.js';
import * as cloudProvider from './cloud.js';

const REGISTRY = {
  cloud: cloudProvider,
  app: appProvider,
};

export const PROVIDERS = Object.keys(REGISTRY);

/** Canal configurado por la cuenta. Ante la duda, Cloud API. */
export async function channelOf(accountId) {
  const row = await one('SELECT wa_channel FROM bot_settings WHERE account_id = $1', [accountId]);
  return REGISTRY[row?.wa_channel] ? row.wa_channel : 'cloud';
}

/**
 * Devuelve el proveedor listo para usar de una cuenta.
 *
 * `ready: false` no es un error: significa "todavía no se puede enviar por
 * aquí", y quien llama decide si reintentar (la cola) o avisar (el panel).
 */
export async function forAccount(accountId) {
  const channel = await channelOf(accountId);
  return REGISTRY[channel].build(accountId);
}

/** Proveedor concreto por nombre. Lo usan las pantallas de configuración. */
export async function byName(name, accountId) {
  const provider = REGISTRY[name];
  if (!provider) throw new Error(`Proveedor de WhatsApp desconocido: ${name}`);
  return provider.build(accountId);
}
