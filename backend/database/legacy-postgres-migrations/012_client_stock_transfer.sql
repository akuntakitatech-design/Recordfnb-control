-- Client Stock Transfer v0.12
-- One source document moves inventory between two locations in the same company.

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS transfer_to_location_id UUID REFERENCES locations(id);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_company_date
ON transaction_headers(company_id, transaction_date)
WHERE transaction_type = 'STOCK_TRANSFER';

CREATE INDEX IF NOT EXISTS idx_stock_transfer_destination
ON transaction_headers(transfer_to_location_id, transaction_date)
WHERE transaction_type = 'STOCK_TRANSFER';
