import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dentroDeFranja } from '../src/services/remarketing.js';

test('franja normal: dentro del horario', () => {
  const a = new Date('2026-07-25T18:00:00Z');   // 12:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '09:00', fin: '21:00', timezone: 'America/Mexico_City', ahora: a }), true);
});

test('franja normal: fuera del horario', () => {
  const a = new Date('2026-07-25T13:00:00Z');   // 07:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '09:00', fin: '21:00', timezone: 'America/Mexico_City', ahora: a }), false);
});

test('franja que cruza medianoche: dentro (después de la medianoche)', () => {
  const a = new Date('2026-07-25T07:00:00Z');   // 01:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '22:00', fin: '02:00', timezone: 'America/Mexico_City', ahora: a }), true);
});

test('franja que cruza medianoche: dentro (antes de la medianoche)', () => {
  const a = new Date('2026-07-26T05:30:00Z');   // 23:30 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '22:00', fin: '02:00', timezone: 'America/Mexico_City', ahora: a }), true);
});

test('franja que cruza medianoche: fuera', () => {
  const a = new Date('2026-07-25T15:00:00Z');   // 09:00 en Ciudad de México
  assert.equal(dentroDeFranja({
    inicio: '22:00', fin: '02:00', timezone: 'America/Mexico_City', ahora: a }), false);
});

test('respeta la zona horaria de la cuenta, no la del servidor', () => {
  // Mismo instante, dos cuentas en zonas distintas: una está en horario y la otra no.
  const instante = new Date('2026-07-25T12:00:00Z'); // 07:00 CDMX · 14:00 Madrid
  assert.equal(dentroDeFranja({
    inicio: '09:00', fin: '21:00', timezone: 'America/Mexico_City', ahora: instante }), false);
  assert.equal(dentroDeFranja({
    inicio: '09:00', fin: '21:00', timezone: 'Europe/Madrid', ahora: instante }), true);
});
