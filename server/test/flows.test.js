import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/services/flows.js';

test('normalize quita acentos y signos', () => {
  assert.equal(normalize('¿Cuál es el PRECIO?'), 'cual es el precio');
  assert.equal(normalize('  Información   '), 'informacion');
});

test('normalize tolera entradas vacías', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('normalize hace que frases equivalentes coincidan', () => {
  // Es justo lo que matchTrigger() necesita: que "¿Cuánto Cuesta?" case con "cuanto cuesta"
  assert.equal(normalize('¿Cuánto Cuesta?'), normalize('cuanto cuesta'));
});
