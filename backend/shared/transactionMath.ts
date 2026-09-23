import Decimal from 'decimal.js';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export type DiscountType = 'PERCENT' | 'AMOUNT' | null;

export type TransactionLineInput = {
  id?: string;
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  discountType?: DiscountType;
  discountValue?: Decimal.Value;
  taxRate?: Decimal.Value;
  taxIncluded?: boolean;
};

export type DocumentDiscount = {
  type: Exclude<DiscountType, null>;
  value: Decimal.Value;
} | null;

export type CalculatedLine = {
  id?: string;
  grossAmount: string;
  lineDiscountAmount: string;
  documentDiscountAlloc: string;
  dppAmount: string;
  taxAmount: string;
  lineTotal: string;
  taxRate: string;
  taxIncluded: boolean;
};

export type CalculatedDocument = {
  lines: CalculatedLine[];
  grossAmount: string;
  lineDiscountAmount: string;
  documentDiscountAmount: string;
  dppAmount: string;
  taxAmount: string;
  grandTotal: string;
};

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

function money(value: Decimal.Value) {
  return new Decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

function asString(value: Decimal.Value) {
  return money(value).toFixed(4);
}

function calculateLineDiscount(gross: Decimal, type: DiscountType, value: Decimal) {
  if (!type || value.isZero()) return ZERO;
  if (value.isNegative()) throw new Error('DISCOUNT_CANNOT_BE_NEGATIVE');

  if (type === 'PERCENT') {
    if (value.greaterThan(HUNDRED)) throw new Error('DISCOUNT_PERCENT_EXCEEDS_100');
    return money(gross.mul(value).div(HUNDRED));
  }

  if (value.greaterThan(gross)) throw new Error('DISCOUNT_AMOUNT_EXCEEDS_GROSS');
  return money(value);
}

export function calculateDocument(lines: TransactionLineInput[], documentDiscount: DocumentDiscount = null): CalculatedDocument {
  if (!lines.length) {
    return {
      lines: [], grossAmount: '0.0000', lineDiscountAmount: '0.0000', documentDiscountAmount: '0.0000',
      dppAmount: '0.0000', taxAmount: '0.0000', grandTotal: '0.0000',
    };
  }

  const prepared = lines.map(line => {
    const quantity = new Decimal(line.quantity || 0);
    const unitPrice = new Decimal(line.unitPrice || 0);
    const taxRate = new Decimal(line.taxRate || 0);
    const discountValue = new Decimal(line.discountValue || 0);

    if (quantity.isNegative()) throw new Error('QUANTITY_CANNOT_BE_NEGATIVE');
    if (unitPrice.isNegative()) throw new Error('PRICE_CANNOT_BE_NEGATIVE');
    if (taxRate.isNegative()) throw new Error('TAX_RATE_CANNOT_BE_NEGATIVE');

    const gross = money(quantity.mul(unitPrice));
    const lineDiscount = calculateLineDiscount(gross, line.discountType || null, discountValue);
    const afterLineDiscount = money(gross.minus(lineDiscount));

    return { line, taxRate, gross, lineDiscount, afterLineDiscount };
  });

  const documentDiscountBase = prepared.reduce((sum, line) => sum.plus(line.afterLineDiscount), ZERO);
  let requestedDocumentDiscount = ZERO;

  if (documentDiscount) {
    const value = new Decimal(documentDiscount.value || 0);
    if (value.isNegative()) throw new Error('DOCUMENT_DISCOUNT_CANNOT_BE_NEGATIVE');

    if (documentDiscount.type === 'PERCENT') {
      if (value.greaterThan(HUNDRED)) throw new Error('DOCUMENT_DISCOUNT_PERCENT_EXCEEDS_100');
      requestedDocumentDiscount = money(documentDiscountBase.mul(value).div(HUNDRED));
    } else {
      requestedDocumentDiscount = money(value);
    }

    if (requestedDocumentDiscount.greaterThan(documentDiscountBase)) {
      throw new Error('DOCUMENT_DISCOUNT_EXCEEDS_BASE');
    }
  }

  let allocatedSoFar = ZERO;
  const resultLines = prepared.map((preparedLine, index) => {
    let documentDiscountAlloc = ZERO;

    if (!requestedDocumentDiscount.isZero() && !documentDiscountBase.isZero()) {
      if (index === prepared.length - 1) {
        documentDiscountAlloc = money(requestedDocumentDiscount.minus(allocatedSoFar));
      } else {
        documentDiscountAlloc = money(
          requestedDocumentDiscount.mul(preparedLine.afterLineDiscount).div(documentDiscountBase),
        );
        allocatedSoFar = allocatedSoFar.plus(documentDiscountAlloc);
      }
    }

    const net = money(preparedLine.afterLineDiscount.minus(documentDiscountAlloc));
    let dpp = net;
    let tax = ZERO;
    let total = net;

    if (!preparedLine.taxRate.isZero()) {
      if (preparedLine.line.taxIncluded) {
        dpp = money(net.div(new Decimal(1).plus(preparedLine.taxRate.div(HUNDRED))));
        tax = money(net.minus(dpp));
        total = net;
      } else {
        dpp = net;
        tax = money(dpp.mul(preparedLine.taxRate).div(HUNDRED));
        total = money(dpp.plus(tax));
      }
    }

    return {
      id: preparedLine.line.id,
      grossAmount: asString(preparedLine.gross),
      lineDiscountAmount: asString(preparedLine.lineDiscount),
      documentDiscountAlloc: asString(documentDiscountAlloc),
      dppAmount: asString(dpp),
      taxAmount: asString(tax),
      lineTotal: asString(total),
      taxRate: preparedLine.taxRate.toFixed(6),
      taxIncluded: Boolean(preparedLine.line.taxIncluded),
    };
  });

  const grossAmount = prepared.reduce((sum, line) => sum.plus(line.gross), ZERO);
  const lineDiscountAmount = prepared.reduce((sum, line) => sum.plus(line.lineDiscount), ZERO);
  const dppAmount = resultLines.reduce((sum, line) => sum.plus(line.dppAmount), ZERO);
  const taxAmount = resultLines.reduce((sum, line) => sum.plus(line.taxAmount), ZERO);
  const grandTotal = resultLines.reduce((sum, line) => sum.plus(line.lineTotal), ZERO);

  return {
    lines: resultLines,
    grossAmount: asString(grossAmount),
    lineDiscountAmount: asString(lineDiscountAmount),
    documentDiscountAmount: asString(requestedDocumentDiscount),
    dppAmount: asString(dppAmount),
    taxAmount: asString(taxAmount),
    grandTotal: asString(grandTotal),
  };
}
