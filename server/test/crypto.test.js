import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, mask, sign, unsign } from '../src/lib/crypto.js';

test('encrypt/decrypt hacen ida y vuelta', () => {
  const secreto = 'EAAG1234567890abcdefwxyz';
  const cifrado = encrypt(secreto);
  assert.notEqual(cifrado, secreto);
  assert.match(cifrado, /^v1\./);
  assert.equal(decrypt(cifrado), secreto);
});

test('encrypt de vacío/nulo no revienta', () => {
  assert.equal(encrypt(''), null);
  assert.equal(encrypt(null), null);
  assert.equal(encrypt(undefined), null);
});

test('decrypt tolera datos corruptos o de formato viejo', () => {
  assert.equal(decrypt(''), '');
  assert.equal(decrypt(null), '');
  assert.equal(decrypt('esto-no-es-un-valor-cifrado'), '');
  assert.equal(decrypt('v1.solo.tres.partes.de.mas'), '');
});

test('mask oculta el centro de una credencial larga', () => {
  assert.equal(mask('EAAG1234567890wxyz'), 'EAAG••••••••wxyz');
});

test('mask no expone nada de una credencial corta', () => {
  assert.equal(mask('short'), '••••••••');
  assert.equal(mask(''), '');
});

test('sign/unsign hacen ida y vuelta con el mismo secreto', () => {
  const firmado = sign('sesion-123', 'secreto-de-prueba');
  assert.equal(unsign(firmado, 'secreto-de-prueba'), 'sesion-123');
});

test('unsign rechaza una firma alterada', () => {
  const firmado = sign('sesion-123', 'secreto-de-prueba');
  const alterado = firmado.slice(0, -1) + (firmado.at(-1) === 'a' ? 'b' : 'a');
  assert.equal(unsign(alterado, 'secreto-de-prueba'), null);
});

test('unsign rechaza un secreto distinto', () => {
  const firmado = sign('sesion-123', 'secreto-de-prueba');
  assert.equal(unsign(firmado, 'otro-secreto'), null);
});
