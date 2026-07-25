/**
 * Respuestas con inteligencia artificial.
 *
 * Cada cuenta usa su propia API Key y elige su modelo, así que aquí no hay
 * credencial global. Se soportan los dos formatos de API más extendidos.
 */

import { many, one } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

/** Cuántos mensajes previos se envían como contexto. */
const HISTORY_LIMIT = 12;
/** Tope de la respuesta: WhatsApp corta feo los mensajes muy largos. */
const MAX_TOKENS = 500;

const PROVIDERS = {
  anthropic: {
    matches: (model) => model.startsWith('claude'),
    url: 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    body: ({ model, system, messages }) => ({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    extract: (data) => data?.content?.[0]?.text || '',
  },
  openai: {
    matches: (model) => model.startsWith('gpt') || model.startsWith('o1'),
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'content-type': 'application/json' }),
    body: ({ model, system, messages }) => ({
      model,
      max_completion_tokens: MAX_TOKENS,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    extract: (data) => data?.choices?.[0]?.message?.content || '',
  },
};

function providerFor(model) {
  return Object.values(PROVIDERS).find((p) => p.matches(model)) || PROVIDERS.anthropic;
}

/** Configuración de IA de una cuenta, con la clave descifrada. */
export async function aiConfig(accountId) {
  const row = await one(
    `SELECT ai_enabled, ai_model, ai_key_enc, ai_delay_seconds, ai_prompt
       FROM bot_settings WHERE account_id = $1`,
    [accountId]
  );
  if (!row) return null;
  return {
    enabled: row.ai_enabled,
    model: row.ai_model,
    apiKey: decrypt(row.ai_key_enc),
    delaySeconds: row.ai_delay_seconds,
    prompt: row.ai_prompt,
  };
}

/**
 * Genera una respuesta para un contacto.
 * Devuelve el texto, o null si la IA no está lista o el proveedor falla — en
 * ese caso el bot calla, que es mejor que responder cualquier cosa.
 */
export async function reply({ accountId, contactId, config }) {
  const cfg = config || (await aiConfig(accountId));

  if (!cfg?.enabled || !cfg.apiKey || !String(cfg.prompt || '').trim()) return null;

  const history = await many(
    `SELECT direction, body FROM messages
      WHERE contact_id = $1 AND body <> ''
      ORDER BY created_at DESC LIMIT $2`,
    [contactId, HISTORY_LIMIT]
  );

  const messages = history
    .reverse()
    .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));

  // La API exige que la conversación empiece por el usuario
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return null;

  const provider = providerFor(cfg.model);

  // Instrucciones de canal añadidas al prompt del cliente: WhatsApp no es un
  // chat de escritorio y el modelo tiende a escribir de más.
  const system = `${cfg.prompt}

REGLAS DEL CANAL (WhatsApp):
- Responde en español, en 3 líneas como máximo.
- Sin markdown: WhatsApp no lo renderiza.
- Una sola pregunta por mensaje.
- Si no sabes algo, dilo y ofrece pasar con una persona. No inventes.`;

  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      headers: provider.headers(cfg.apiKey),
      body: JSON.stringify(provider.body({ model: cfg.model, system, messages })),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[ia] ${cfg.model} devolvió ${res.status}: ${detail.slice(0, 300)}`);
      return null;
    }

    const text = provider.extract(await res.json()).trim();
    return text || null;
  } catch (err) {
    console.error(`[ia] fallo al generar respuesta: ${err.message}`);
    return null;
  }
}
