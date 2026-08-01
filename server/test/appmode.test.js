import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jidFor, normalizeIncoming } from '../src/wa/app/session.js';

/* --------------------------------------------------------------------------
   La traducción de mensajes es la pieza que permite que flujos, disparadores,
   IA, comprobantes y agenda funcionen igual en los dos canales sin que el
   motor sepa por cuál llegó el mensaje. Si esto se rompe, se rompe todo lo
   demás en silencio.
   -------------------------------------------------------------------------- */

const clave = { id: 'ABC123', remoteJid: '5215512345678@s.whatsapp.net', fromMe: false };

test('jidFor limpia cualquier formato de teléfono', () => {
  assert.equal(jidFor('+521 55 1234 5678'), '5215512345678@s.whatsapp.net');
  assert.equal(jidFor('5215512345678'), '5215512345678@s.whatsapp.net');
  assert.equal(jidFor('(521) 55-1234-5678'), '5215512345678@s.whatsapp.net');
});

test('normalizeIncoming traduce texto simple', () => {
  const m = normalizeIncoming({ key: clave, message: { conversation: 'Hola, ¿tienen cita mañana?' } });
  assert.equal(m.type, 'text');
  assert.equal(m.from, '5215512345678');
  assert.equal(m.id, 'ABC123');
  assert.equal(m.text.body, 'Hola, ¿tienen cita mañana?');
});

test('normalizeIncoming traduce texto extendido (respuestas y enlaces)', () => {
  const m = normalizeIncoming({
    key: clave,
    message: { extendedTextMessage: { text: 'Te reenvío esto' } },
  });
  assert.equal(m.type, 'text');
  assert.equal(m.text.body, 'Te reenvío esto');
});

test('normalizeIncoming traduce una imagen con pie de foto', () => {
  const m = normalizeIncoming({
    key: clave,
    message: { imageMessage: { caption: 'Mi comprobante', mimetype: 'image/jpeg' } },
  });
  assert.equal(m.type, 'image');
  assert.equal(m.image.caption, 'Mi comprobante');
  assert.equal(m.image.mime_type, 'image/jpeg');
});

test('normalizeIncoming traduce un documento conservando el nombre', () => {
  const m = normalizeIncoming({
    key: clave,
    message: { documentMessage: { fileName: 'transferencia.pdf', mimetype: 'application/pdf' } },
  });
  assert.equal(m.type, 'document');
  assert.equal(m.document.filename, 'transferencia.pdf');
});

test('normalizeIncoming traduce la respuesta a un botón', () => {
  const m = normalizeIncoming({
    key: clave,
    message: { buttonsResponseMessage: { selectedDisplayText: 'Agendar cita' } },
  });
  assert.equal(m.type, 'button');
  assert.equal(m.button.text, 'Agendar cita');
});

test('normalizeIncoming devuelve null para lo que no sabe traducir', () => {
  assert.equal(normalizeIncoming({ key: clave, message: { protocolMessage: {} } }), null);
  assert.equal(normalizeIncoming({ key: clave, message: {} }), null);
  assert.equal(normalizeIncoming(null), null);
});

test('normalizeIncoming quita el sufijo de dispositivo del JID', () => {
  // Sin esto, el motor —que arma el teléfono borrando lo que no son dígitos—
  // convertiría "5215512345678:12" en "+521551234567812" y crearía un contacto
  // duplicado por cada dispositivo del cliente.
  const m = normalizeIncoming({
    key: { ...clave, remoteJid: '5215512345678:12@s.whatsapp.net' },
    message: { conversation: 'hola' },
  });
  assert.equal(m.from, '5215512345678');
});
