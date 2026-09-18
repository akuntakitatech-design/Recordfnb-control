import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveBomQuantity,
  movingAverageAfterProduction,
  productionRequirement,
  productionYield,
} from '../shared/bomMath.js';

test('BOM effective quantity includes waste percentage', () => {
  assert.equal(effectiveBomQuantity(0.2, 5).toFixed(6), '0.210000');
});

test('production requirement multiplies effective quantity by batch count', () => {
  assert.equal(productionRequirement(2.5, 10, 4).toFixed(6), '11.000000');
});

test('production yield compares actual and standard output', () => {
  assert.equal(productionYield(9.5, 10).toFixed(2), '95.00');
});

test('production output recomputes moving average from prior stock plus production cost', () => {
  assert.equal(movingAverageAfterProduction(10, 50000, 5, 300000).toFixed(4), '53333.3333');
});
