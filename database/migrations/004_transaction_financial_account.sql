ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS financial_account_id UUID REFERENCES financial_accounts(id);

CREATE INDEX IF NOT EXISTS idx_transactions_financial_account
ON transaction_headers(financial_account_id, transaction_date);
