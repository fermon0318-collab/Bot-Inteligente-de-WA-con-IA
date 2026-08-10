/**
 * Disparadores y ejecución de flujos.
 *
 * Flujo simple: lista de pasos (texto / archivo / pausa) que se encolan de una
 * vez, acumulando las pausas en la hora de envío.
 *
 * Flujo avanzado: árbol. Se recorre hasta topar con un nodo de condición, ahí
 * se guarda la posición y se espera al siguiente mensaje del contacto para
 * elegir rama. Sin ese estado en base, un reinicio del proceso dejaría
 * conversaciones colgadas a medias.
 */

import { many, one, query } from '../db/pool.js';
import { enqueue } from './outbox.js';

/* ==========================================================================
   Disparadores
   ========================================================================== */

/** Quita acentos y signos para que "informacion" case con "¿Información?". */
export function normalize(text) {
  // El valor por defecto de un parámetro solo actúa sobre `undefined`, no
  // sobre `null` — sin el `??` aquí, normalize(null) devolvía la cadena
  // literal "null" en vez de una cadena vacía.
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Busca el disparador que corresponde a un mensaje.
 *
 * Se prueba de la frase más específica a la más general: si "quiero precio" y
 * "precio" están definidos, gana el primero. Sin coincidencias se usa el
 * predeterminado, y si tampoco hay, devuelve null para que responda la IA.
 */
export async function matchTrigger(accountId, text) {
  const rows = await many(
    `SELECT t.id, t.keyword, t.is_default, t.kind, f.id AS flow_id, f.kind AS flow_kind
       FROM triggers t
       LEFT JOIN flows f ON f.id = t.flow_id
      WHERE t.account_id = $1`,
    [accountId]
  );
  if (!rows.length) return null;

  const haystack = normalize(text);

  const matches = rows
    .filter((t) => t.keyword && haystack.includes(normalize(t.keyword)))
    // Más palabras = más específico, y a igualdad gana la cadena más larga
    .sort((a, b) => {
      const wa = normalize(a.keyword).split(' ').length;
      const wb = normalize(b.keyword).split(' ').length;
      return wb - wa || b.keyword.length - a.keyword.length;
    });

  return matches[0] || rows.find((t) => t.is_default) || null;
}

/* ==========================================================================
   Flujos simples
   ========================================================================== */

async function runSimpleFlow({ accountId, contactId, flow }) {
  const steps = Array.isArray(flow.steps) ? flow.steps : [];
  let delay = 0;
  let queued = 0;

  for (const step of steps) {
    if (step.type === 'delay') {
      delay += Math.max(0, Number(step.value) || 0);
      continue;
    }
    if (!String(step.value || '').trim()) continue;

    await enqueue({
      accountId, contactId,
      kind: step.type === 'file' ? 'media' : 'text',
      body: step.type === 'file' ? '' : String(step.value),
      mediaName: step.type === 'file' ? String(step.value) : null,
      origin: 'flow',
      delaySeconds: delay,
    });
    queued++;
    // Separación mínima para que los mensajes lleguen en orden legible
    delay += 2;
  }

  return { queued, waiting: false };
}

/* ==========================================================================
   Flujos avanzados
   ========================================================================== */

const childrenOf = (node) => (Array.isArray(node?.children) ? node.children : []);

/** Devuelve el nodo que está en `path` dentro del árbol. */
function nodeAt(tree, path) {
  let node = tree;
  for (const index of path) {
    node = childrenOf(node)[index];
    if (!node) return null;
  }
  return node;
}

/**
 * Recorre el árbol desde `path` encolando lo que encuentre.
 *
 * Se detiene al llegar a un nodo de condición: ahí hace falta que hable el
 * contacto. Devuelve la ruta donde quedó esperando, o null si terminó.
 */
async function walk({ accountId, contactId, tree, path, delay = 0 }) {
  let current = [...path];
  let queued = 0;
  let wait = delay;

  // Cota de seguridad: un árbol mal formado no debe colgar el proceso
  for (let guard = 0; guard < 100; guard++) {
    const node = nodeAt(tree, current);
    if (!node) break;

    if (node.kind === 'condition' && childrenOf(node).length) {
      return { queued, waitingAt: current };
    }

    if (node.kind === 'delay') {
      wait += Math.max(0, Number(node.seconds ?? node.text) || 0);
    } else if (node.kind === 'message' && node.text) {
      await enqueue({ accountId, contactId, kind: 'text', body: String(node.text), origin: 'flow', delaySeconds: wait });
      queued++;
      wait += 2;
    } else if (node.kind === 'action') {
      queued += await runAction({ accountId, contactId, node, delay: wait });
    }

    const kids = childrenOf(node);
    if (!kids.length) break;
    current = [...current, 0]; // sin condición, se sigue por la primera rama
  }

  return { queued, waitingAt: null };
}

/** Acciones de un nodo: enviar archivos o etiquetar al contacto. */
async function runAction({ accountId, contactId, node, delay }) {
  const files = Array.isArray(node.files)
    ? node.files
    : String(node.text || '').split('·').map((f) => f.trim()).filter((f) => f.includes('.'));

  let queued = 0;
  for (const name of files) {
    await enqueue({ accountId, contactId, kind: 'media', mediaName: name, origin: 'flow', delaySeconds: delay + queued * 2 });
    queued++;
  }

  if (node.tag) {
    await query(
      `UPDATE contacts SET source = CASE WHEN source = '' THEN $2 ELSE source END WHERE id = $1`,
      [contactId, String(node.tag)]
    );
  }
  return queued;
}

/** Elige la rama de una condición según lo que escribió el contacto. */
function pickBranch(conditionNode, text) {
  const kids = childrenOf(conditionNode);
  const haystack = normalize(text);

  for (let i = 0; i < kids.length; i++) {
    const keywords = Array.isArray(kids[i].match) ? kids[i].match : [];
    if (keywords.some((k) => haystack.includes(normalize(k)))) return i;
  }
  // Rama marcada como salida por defecto, o la última como red de seguridad
  const fallback = kids.findIndex((k) => k.fallback);
  return fallback >= 0 ? fallback : kids.length - 1;
}

async function runAdvancedFlow({ accountId, contactId, flow }) {
  if (!flow.tree) return { queued: 0, waiting: false };

  // Una conversación nueva cancela la anterior: dos flujos a la vez sobre el
  // mismo contacto producen mensajes intercalados sin sentido.
  await query(
    `UPDATE flow_runs SET status = 'canceled', updated_at = now()
      WHERE contact_id = $1 AND status IN ('running', 'waiting')`,
    [contactId]
  );

  const { queued, waitingAt } = await walk({ accountId, contactId, tree: flow.tree, path: [] });

  await query(
    `INSERT INTO flow_runs (account_id, contact_id, flow_id, node_path, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [accountId, contactId, flow.id, waitingAt || [], waitingAt ? 'waiting' : 'done']
  );

  return { queued, waiting: Boolean(waitingAt) };
}

/**
 * Si el contacto tenía un flujo esperando, continúa por la rama elegida.
 * Devuelve null cuando no había nada pendiente.
 */
export async function resumeFlow({ accountId, contactId, text }) {
  const run = await one(
    `SELECT r.id, r.flow_id, r.node_path, f.tree
       FROM flow_runs r JOIN flows f ON f.id = r.flow_id
      WHERE r.contact_id = $1 AND r.status = 'waiting'
      ORDER BY r.updated_at DESC LIMIT 1`,
    [contactId]
  );
  if (!run?.tree) return null;

  const condition = nodeAt(run.tree, run.node_path);
  if (!condition) {
    await query(`UPDATE flow_runs SET status = 'done', updated_at = now() WHERE id = $1`, [run.id]);
    return null;
  }

  const branch = pickBranch(condition, text);
  const { queued, waitingAt } = await walk({
    accountId, contactId, tree: run.tree, path: [...run.node_path, branch],
  });

  await query(
    `UPDATE flow_runs SET node_path = $2, status = $3, updated_at = now() WHERE id = $1`,
    [run.id, waitingAt || run.node_path, waitingAt ? 'waiting' : 'done']
  );

  return { queued, waiting: Boolean(waitingAt), resumed: true };
}

/* ==========================================================================
   Entrada única
   ========================================================================== */

/** Ejecuta un flujo por id, sea del tipo que sea. */
export async function runFlow({ accountId, contactId, flowId }) {
  const flow = await one(
    'SELECT id, kind, name, steps, tree FROM flows WHERE id = $1 AND account_id = $2',
    [flowId, accountId]
  );
  if (!flow) return { queued: 0, waiting: false, missing: true };

  const result = flow.kind === 'advanced'
    ? await runAdvancedFlow({ accountId, contactId, flow })
    : await runSimpleFlow({ accountId, contactId, flow });

  return { ...result, flowName: flow.name };
}
