-- Data Penjualan / Import POS v0.14
-- Normalized spreadsheet-first sales intake, payment-account mapping and SALES_OUT inventory movement.

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'PURCHASE_IN','USAGE_OUT','TRANSFER_IN','TRANSFER_OUT',
    'ADJUSTMENT_IN','ADJUSTMENT_OUT','SALE_OUT'
  ));

CREATE TABLE IF NOT EXISTS sales_payment_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_code TEXT NOT NULL CHECK (payment_code IN ('CASH','QRIS','TRANSFER','COMPLIMENT','GOFOOD','GRABFOOD')),
  label TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,payment_code)
);

CREATE TABLE IF NOT EXISTS sales_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'PASTE' CHECK (source_type IN ('MANUAL','PASTE','CSV')),
  source_name TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINANCE_VERIFIED','VOID')),
  row_count INTEGER NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  total_sales NUMERIC(20,4) NOT NULL DEFAULT 0,
  total_payments NUMERIC(20,4) NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  UNIQUE(company_id,batch_number)
);

CREATE TABLE IF NOT EXISTS sales_import_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES sales_import_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL CHECK (row_no > 0),
  sale_date DATE NOT NULL,
  invoice_number TEXT NOT NULL,
  cashier TEXT,
  sale_type TEXT,
  item_code TEXT,
  item_name TEXT NOT NULL,
  item_id UUID REFERENCES items(id),
  quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  payment_cash NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_cash >= 0),
  payment_qris NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_qris >= 0),
  payment_transfer NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_transfer >= 0),
  payment_compliment NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_compliment >= 0),
  payment_gofood NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_gofood >= 0),
  payment_grabfood NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (payment_grabfood >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(batch_id,row_no)
);

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS sales_import_batch_id UUID REFERENCES sales_import_batches(id);

CREATE INDEX IF NOT EXISTS idx_sales_import_batches_company_date
ON sales_import_batches(company_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_import_rows_invoice
ON sales_import_rows(batch_id,sale_date,invoice_number);

CREATE INDEX IF NOT EXISTS idx_sales_transaction_batch
ON transaction_headers(sales_import_batch_id)
WHERE sales_import_batch_id IS NOT NULL;

UPDATE coa_templates
   SET version=4,
       description='COA generik F&B v4: restaurant, cafe, bakery, cloud kitchen, catering, multi-outlet dan central kitchen; termasuk pemakaian, transfer, stock opname, penjualan POS dan settlement channel.',
       updated_at=NOW()
 WHERE code='AK_FNB_STANDARD_V1';

INSERT INTO coa_template_important_accounts(template_id,role_code,label,account_code)
SELECT t.id,'SALES_DISCOUNT','Diskon Penjualan','4201-00-001'
  FROM coa_templates t
 WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT(template_id,role_code) DO UPDATE SET
  label=EXCLUDED.label,
  account_code=EXCLUDED.account_code;

-- Upgrade companies that already use the standard template, without overwriting edited mappings.
INSERT INTO important_accounts(workspace_id,company_id,role_code,account_id)
SELECT c.workspace_id,c.id,'SALES_DISCOUNT',coa.id
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  JOIN chart_of_accounts coa ON coa.company_id=c.id AND coa.code='4201-00-001'
ON CONFLICT(company_id,role_code) DO NOTHING;

INSERT INTO sales_payment_mappings(company_id,payment_code,label,account_id)
SELECT c.id,v.payment_code,v.label,coa.id
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  CROSS JOIN (VALUES
    ('CASH','Cash','1101-00-001'),
    ('QRIS','QRIS','1107-00-001'),
    ('TRANSFER','Transfer','1102-00-001'),
    ('COMPLIMENT','Compliment','6000-00-003'),
    ('GOFOOD','GoFood','1107-00-002'),
    ('GRABFOOD','GrabFood','1107-00-002')
  ) AS v(payment_code,label,account_code)
  JOIN chart_of_accounts coa ON coa.company_id=c.id AND coa.code=v.account_code
ON CONFLICT(company_id,payment_code) DO NOTHING;
