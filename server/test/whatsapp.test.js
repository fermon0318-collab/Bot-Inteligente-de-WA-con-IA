import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaKindFor } from '../src/services/whatsapp.js';

test('mediaKindFor clasifica por el tipo MIME', () => {
  assert.equal(mediaKindFor('image/jpeg'), 'image');
  assert.equal(mediaKindFor('image/png'), 'image');
  assert.equal(mediaKindFor('video/mp4'), 'video');
  assert.equal(mediaKindFor('audio/ogg'), 'audio');
});

test('mediaKindFor cae a document para lo que no reconoce', () => {
  assert.equal(mediaKindFor('application/pdf'), 'document');
  assert.equal(mediaKindFor(''), 'document');
  assert.equal(mediaKindFor(), 'document');
});
