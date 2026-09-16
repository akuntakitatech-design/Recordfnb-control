-- Client Cash / Bank In v0.10
-- Client records the source of money; Accounting Akuntakita directs the counterpart account.

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS cash_in_type TEXT,
  ADD COLUMN IF NOT EXISTS source_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='transaction_headers_cash_in_type_check'
  ) THEN
    ALTER TABLE transaction_headers
      ADD CONSTRAINT transaction_headers_cash_in_type_check
      CHECK (cash_in_type IS NULL OR cash_in_type IN ('BUSINESS_RECEIPT','OTHER_RECEIPT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cash_in_company_date
ON transaction_headers(company_id,transaction_date)
WHERE transaction_type='CASH_IN';

CREATE INDEX IF NOT EXISTS idx_cash_in_accounting_queue
ON transaction_headers(company_id,accounting_status,transaction_date)
WHERE transaction_type='CASH_IN';
