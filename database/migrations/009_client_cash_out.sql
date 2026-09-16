-- Client Cash / Bank Out v0.9
-- Client records the business event; accounting decides the COA for operational expenses.

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS cash_out_type TEXT,
  ADD COLUMN IF NOT EXISTS payee_name TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='transaction_headers_cash_out_type_check'
  ) THEN
    ALTER TABLE transaction_headers
      ADD CONSTRAINT transaction_headers_cash_out_type_check
      CHECK (cash_out_type IS NULL OR cash_out_type IN ('DEBT_PAYMENT','OPERATIONAL_EXPENSE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cash_out_company_date
ON transaction_headers(company_id,transaction_date)
WHERE transaction_type='CASH_OUT';

CREATE INDEX IF NOT EXISTS idx_cash_out_accounting_queue
ON transaction_headers(company_id,accounting_status,transaction_date)
WHERE transaction_type='CASH_OUT' AND cash_out_type='OPERATIONAL_EXPENSE';

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_allocation_source_target_type
ON transaction_allocations(source_transaction_id,target_transaction_id,allocation_type)
WHERE target_transaction_id IS NOT NULL;
