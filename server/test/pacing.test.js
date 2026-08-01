import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GAP_SECONDS, MAX_PER_MINUTE, MIN_GAP_SECONDS,
  bodyHash, randomGapMs, sanitizeLimits,
} from '../src/wa/app/pacing.js';

test('bodyHash ignora mayúsculas y espacios sobrantes', () => {
  assert.equal(bodyHash('Hola  MUNDO '), bodyHash('hola mundo'));
  assert.equal(bodyHash('Hola\n\nmundo'), bodyHash('hola mundo'));
  assert.notEqual(bodyHash('hola mundo'), bodyHash('hola mundos'));
});

test('bodyHash tolera valores vacíos', () => {
  assert.equal(bodyHash(''), bodyHash(null));
  assert.equal(typeof bodyHash(undefined), 'string');
});

test('randomGapMs se queda dentro del rango pedido', () => {
  for (let i = 0; i < 200; i++) {
    const ms = randomGapMs(5, 15);
    assert.ok(ms >= 5000 && ms <= 15000, `fuera de rango: ${ms}`);
  }
});

test('randomGapMs nunca baja del suelo del producto', () => {
  // Da igual lo que pida quien llame: 1 segundo entre mensajes es justo el
  // patrón que hace que WhatsApp restrinja la cuenta.
  assert.ok(randomGapMs(1, 2) >= MIN_GAP_SECONDS * 1000);
  assert.ok(randomGapMs(0, 0) >= MIN_GAP_SECONDS * 1000);
  assert.ok(randomGapMs(-10, -5) >= MIN_GAP_SECONDS * 1000);
});

test('randomGapMs varía entre llamadas', () => {
  // El azar es parte de la protección: un intervalo exacto repetido cien veces
  // delata la automatización más que el propio volumen.
  const valores = new Set(Array.from({ length: 50 }, () => randomGapMs(5, 15)));
  assert.ok(valores.size > 5, 'los intervalos deberían variar');
});

test('randomGapMs con rango invertido no explota', () => {
  const ms = randomGapMs(20, 10);
  assert.ok(ms >= 20000 && ms <= MAX_GAP_SECONDS * 1000);
});

test('sanitizeLimits recorta lo que pondría en riesgo el número', () => {
  const limites = sanitizeLimits({
    minGapSeconds: 1, maxGapSeconds: 2, perMinuteLimit: 500, dailyLimit: 100000,
  });
  assert.equal(limites.minGapSeconds, MIN_GAP_SECONDS);
  assert.equal(limites.perMinuteLimit, MAX_PER_MINUTE);
  assert.equal(limites.dailyLimit, 5000);
  assert.ok(limites.maxGapSeconds >= limites.minGapSeconds);
});

test('sanitizeLimits respeta que el cliente quiera ir más despacio', () => {
  const limites = sanitizeLimits({
    minGapSeconds: 30, maxGapSeconds: 90, perMinuteLimit: 5, dailyLimit: 100,
  });
  assert.deepEqual(limites, {
    minGapSeconds: 30, maxGapSeconds: 90, perMinuteLimit: 5, dailyLimit: 100,
  });
});

test('sanitizeLimits sin datos devuelve los valores por defecto seguros', () => {
  const limites = sanitizeLimits();
  assert.equal(limites.minGapSeconds, 5);
  assert.equal(limites.maxGapSeconds, 15);
  assert.equal(limites.perMinuteLimit, 20);
  assert.equal(limites.dailyLimit, 500);
});

test('sanitizeLimits nunca deja el máximo por debajo del mínimo', () => {
  const limites = sanitizeLimits({ minGapSeconds: 40, maxGapSeconds: 10 });
  assert.ok(limites.maxGapSeconds >= limites.minGapSeconds);
});
