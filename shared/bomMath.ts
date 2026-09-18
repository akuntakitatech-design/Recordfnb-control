import Decimal from 'decimal.js';

type DecimalInput = string | number | Decimal;

const dec = (value: DecimalInput) => new Decimal(value || 0);

export function effectiveBomQuantity(quantity: DecimalInput, wastePercent: DecimalInput) {
  const qty = dec(quantity);
  const waste = dec(wastePercent);
  if (qty.lte(0)) throw new Error('BOM_QUANTITY_MUST_BE_POSITIVE');
  if (waste.lt(0) || waste.gt(100)) throw new Error('BOM_WASTE_OUT_OF_RANGE');
  return qty.mul(new Decimal(1).add(waste.div(100)));
}

export function productionRequirement(quantity: DecimalInput, wastePercent: DecimalInput, batchCount: DecimalInput) {
  const batches = dec(batchCount);
  if (batches.lte(0)) throw new Error('BATCH_COUNT_MUST_BE_POSITIVE');
  return effectiveBomQuantity(quantity, wastePercent).mul(batches);
}

export function productionYield(actualOutput: DecimalInput, standardOutput: DecimalInput) {
  const actual = dec(actualOutput);
  const standard = dec(standardOutput);
  if (actual.lt(0)) throw new Error('ACTUAL_OUTPUT_CANNOT_BE_NEGATIVE');
  if (standard.lte(0)) return new Decimal(0);
  return actual.div(standard).mul(100);
}

export function movingAverageAfterProduction(
  beforeQuantity: DecimalInput,
  beforeAverageCost: DecimalInput,
  producedQuantity: DecimalInput,
  productionCost: DecimalInput,
) {
  const beforeQty = dec(beforeQuantity);
  const beforeAvg = dec(beforeAverageCost);
  const producedQty = dec(producedQuantity);
  const cost = dec(productionCost);
  if (producedQty.lte(0)) throw new Error('PRODUCED_QUANTITY_MUST_BE_POSITIVE');
  if (cost.lt(0)) throw new Error('PRODUCTION_COST_CANNOT_BE_NEGATIVE');
  const afterQty = beforeQty.add(producedQty);
  if (afterQty.lte(0)) return new Decimal(0);
  return beforeQty.mul(beforeAvg).add(cost).div(afterQty);
}
