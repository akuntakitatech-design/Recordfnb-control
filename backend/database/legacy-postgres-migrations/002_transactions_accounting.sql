CREATE TABLE IF NOT EXISTS transaction_headers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  transaction_type TEXT NOT NULL,
  transaction_number TEXT NOT NULL,
  transaction_date DATE NOT NULL,
  partner_id UUID REFERENCES business_partners(id),
  reference_number TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  exchange_rate NUMERIC(20,8) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  workflow_status TEXT NOT NULL DEFAULT 'DRAFT',
  operational_status TEXT NOT NULL DEFAULT 'DRAFT',
  accounting_status TEXT NOT NULL DEFAULT 'NOT_READY',
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  due_date DATE,
  notes TEXT,
  document_discount_type TEXT CHECK (document_discount_type IN ('PERCENT','AMOUNT')),
  document_discount_value NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (document_discount_value >= 0),
  gross_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  line_discount_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  document_discount_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  dpp_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  grand_total NUMERIC(20,4) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, transaction_type, transaction_number)
);

CREATE TABLE IF NOT EXISTS transaction_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transaction_headers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  line_type TEXT NOT NULL CHECK (line_type IN ('ITEM','ACCOUNT','SERVICE','MEMO')),
  item_id UUID REFERENCES items(id),
  account_id UUID REFERENCES chart_of_accounts(id),
  description TEXT,
  quantity NUMERIC(20,6) NOT NULL DEFAULT 1,
  unit_id UUID REFERENCES units(id),
  unit_price NUMERIC(20,4) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  discount_type TEXT CHECK (discount_type IN ('PERCENT','AMOUNT')),
  discount_percent NUMERIC(9,6) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0),
  discount_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  document_discount_alloc NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (document_discount_alloc >= 0),
  tax_code_id UUID REFERENCES tax_codes(id),
  tax_rate NUMERIC(9,6) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  tax_included BOOLEAN NOT NULL DEFAULT FALSE,
  dpp_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(20,4) NOT NULL DEFAULT 0,
  location_id UUID REFERENCES locations(id),
  cost_center_id UUID REFERENCES cost_centers(id),
  department_code TEXT,
  project_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(transaction_id, line_no),
  CHECK (
    (line_type = 'ITEM' AND item_id IS NOT NULL) OR
    (line_type = 'ACCOUNT' AND account_id IS NOT NULL) OR
    (line_type IN ('SERVICE','MEMO'))
  )
);

CREATE TABLE IF NOT EXISTS transaction_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_transaction_id UUID NOT NULL REFERENCES transaction_headers(id) ON DELETE CASCADE,
  target_transaction_id UUID REFERENCES transaction_headers(id) ON DELETE CASCADE,
  allocation_type TEXT NOT NULL,
  amount NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS journal_headers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  journal_number TEXT NOT NULL,
  journal_date DATE NOT NULL,
  journal_type TEXT NOT NULL,
  source_transaction_id UUID REFERENCES transaction_headers(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','POSTED','REVERSED','VOID')),
  description TEXT,
  posted_by UUID REFERENCES users(id),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, journal_number)
);

CREATE TABLE IF NOT EXISTS journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES journal_headers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  debit NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  location_id UUID REFERENCES locations(id),
  cost_center_id UUID REFERENCES cost_centers(id),
  partner_id UUID REFERENCES business_partners(id),
  channel_id UUID REFERENCES channels(id),
  item_id UUID REFERENCES items(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(journal_id, line_no),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SOFT_CLOSED','HARD_CLOSED')),
  soft_closed_at TIMESTAMPTZ,
  hard_closed_at TIMESTAMPTZ,
  UNIQUE(company_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_transactions_workspace_date ON transaction_headers(workspace_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_company_type ON transaction_headers(company_id, transaction_type, transaction_date);
CREATE INDEX IF NOT EXISTS idx_transaction_lines_tx ON transaction_lines(transaction_id);
CREATE INDEX IF NOT EXISTS idx_journal_headers_company_date ON journal_headers(company_id, journal_date);
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
