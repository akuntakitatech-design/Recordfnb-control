ALTER TABLE transaction_headers
ADD COLUMN IF NOT EXISTS negative_stock_override BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_inventory_usage_company_date
ON transaction_headers(company_id, transaction_date)
WHERE transaction_type = 'STOCK_USAGE';
