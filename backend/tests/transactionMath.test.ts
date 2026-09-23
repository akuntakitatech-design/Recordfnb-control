import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDocument } from '../shared/transactionMath.js';

test('multi-line supports percent and nominal discount plus tax per item', () => {
  const result = calculateDocument([
    { id: 'tenderloin', quantity: 20, unitPrice: 180000, discountType: 'PERCENT', discountValue: 5, taxRate: 11 },
    { id: 'sirloin', quantity: 10, unitPrice: 165000, discountType: 'AMOUNT', discountValue: 100000, taxRate: 0 },
  ]);

  assert.equal(result.grossAmount, '5250000.0000');
  assert.equal(result.lineDiscountAmount, '280000.0000');
  assert.equal(result.dppAmount, '4970000.0000');
  assert.equal(result.taxAmount, '376200.0000');
  assert.equal(result.grandTotal, '5346200.0000');
  assert.equal(result.lines[0].lineDiscountAmount, '180000.0000');
  assert.equal(result.lines[1].lineDiscountAmount, '100000.0000');
});

test('tax included separates DPP and tax without changing line total', () => {
  const result = calculateDocument([
    { quantity: 1, unitPrice: 111000, taxRate: 11, taxIncluded: true },
  ]);

  assert.equal(result.dppAmount, '100000.0000');
  assert.equal(result.taxAmount, '11000.0000');
  assert.equal(result.grandTotal, '111000.0000');
});

test('document discount is allocated proportionally to transaction lines', () => {
  const result = calculateDocument([
    { id: 'a', quantity: 1, unitPrice: 1000000, taxRate: 11 },
    { id: 'b', quantity: 1, unitPrice: 3000000, taxRate: 11 },
  ], { type: 'AMOUNT', value: 400000 });

  assert.equal(result.documentDiscountAmount, '400000.0000');
  assert.equal(result.lines[0].documentDiscountAlloc, '100000.0000');
  assert.equal(result.lines[1].documentDiscountAlloc, '300000.0000');
  assert.equal(result.dppAmount, '3600000.0000');
  assert.equal(result.taxAmount, '396000.0000');
  assert.equal(result.grandTotal, '3996000.0000');
});

test('invalid discount cannot exceed gross amount', () => {
  assert.throws(
    () => calculateDocument([{ quantity: 1, unitPrice: 100000, discountType: 'AMOUNT', discountValue: 120000 }]),
    /DISCOUNT_AMOUNT_EXCEEDS_GROSS/,
  );
});
