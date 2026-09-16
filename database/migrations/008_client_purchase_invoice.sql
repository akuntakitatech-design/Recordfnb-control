-- Client Purchase Invoice v0.8
-- Keeps the client-facing document operational while preserving accounting controls behind the scenes.

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS payment_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transaction_headers_payment_type_check'
  ) THEN
    ALTER TABLE transaction_headers
      ADD CONSTRAINT transaction_headers_payment_type_check
      CHECK (payment_type IS NULL OR payment_type IN ('CASH','CREDIT'));
  END IF;
END $$;

-- Historical purchase invoices in the generic engine behaved as credit purchases.
UPDATE transaction_headers
   SET payment_type='CREDIT'
 WHERE transaction_type='PURCHASE_INVOICE'
   AND payment_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_due_date
ON transaction_headers(company_id,due_date)
WHERE transaction_type='PURCHASE_INVOICE' AND payment_status<>'PAID';

CREATE INDEX IF NOT EXISTS idx_purchase_invoice_supplier_reference
ON transaction_headers(company_id,partner_id,reference_number)
WHERE transaction_type='PURCHASE_INVOICE';
