-- Auto Journal Engine v0.7
-- Finance verification, traceable journal lines and moving-average inventory foundation.

ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

ALTER TABLE journal_headers
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engine_version TEXT;

ALTER TABLE journal_lines
  ADD COLUMN IF NOT EXISTS source_transaction_line_id UUID REFERENCES transaction_lines(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_journal_source_transaction
ON journal_headers(source_transaction_id)
WHERE source_transaction_id IS NOT NULL AND status <> 'VOID';

CREATE TABLE IF NOT EXISTS item_account_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  inventory_account_id UUID REFERENCES chart_of_accounts(id),
  cogs_account_id UUID REFERENCES chart_of_accounts(id),
  sales_account_id UUID REFERENCES chart_of_accounts(id),
  usage_account_id UUID REFERENCES chart_of_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,item_id)
);

CREATE TABLE IF NOT EXISTS inventory_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quantity_on_hand NUMERIC(20,6) NOT NULL DEFAULT 0,
  average_cost NUMERIC(20,6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,location_id,item_id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source_transaction_id UUID NOT NULL REFERENCES transaction_headers(id) ON DELETE CASCADE,
  source_transaction_line_id UUID NOT NULL REFERENCES transaction_lines(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('PURCHASE_IN','USAGE_OUT','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT')),
  quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  movement_value NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (movement_value >= 0),
  quantity_after NUMERIC(20,6) NOT NULL,
  average_cost_after NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (average_cost_after >= 0),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_transaction_line_id,movement_type)
);

CREATE INDEX IF NOT EXISTS idx_inventory_balances_company_location
ON inventory_balances(company_id,location_id,item_id);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_item_date
ON inventory_movements(company_id,item_id,created_at);

CREATE INDEX IF NOT EXISTS idx_journal_source_line
ON journal_lines(source_transaction_line_id);

-- Standard COA v2: dedicated consumption accounts make stock usage explicit,
-- while preserving the original MeatNight-based reporting structure.
UPDATE coa_templates
   SET version=2,
       description='COA generik F&B v2: restaurant, cafe, bakery, cloud kitchen, catering, multi-outlet dan central kitchen; termasuk mapping pemakaian bahan untuk auto journal.',
       updated_at=NOW()
 WHERE code='AK_FNB_STANDARD_V1';

INSERT INTO coa_template_accounts(template_id,code,name,account_type,normal_balance,report_group,report_subgroup,sort_order)
SELECT t.id,v.code,v.name,'COGS','DEBIT','Harga Pokok Penjualan','Pemakaian Bahan / Produksi',v.sort_order
FROM coa_templates t
CROSS JOIN (VALUES
  ('5103-00-001','Pemakaian Bahan Baku',13201),
  ('5103-00-002','Pemakaian Bahan Pendukung',13202),
  ('5103-00-003','Pemakaian Bahan Setengah Jadi',13203),
  ('5103-00-004','Pemakaian Packaging',13204)
) AS v(code,name,sort_order)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT(template_id,code) DO UPDATE SET
  name=EXCLUDED.name,
  account_type=EXCLUDED.account_type,
  normal_balance=EXCLUDED.normal_balance,
  report_group=EXCLUDED.report_group,
  report_subgroup=EXCLUDED.report_subgroup,
  sort_order=EXCLUDED.sort_order;

UPDATE coa_template_item_categories c
   SET usage_account_code = CASE c.category_code
     WHEN 'BAHAN_BAKU' THEN '5103-00-001'
     WHEN 'BAHAN_PENDUKUNG' THEN '5103-00-002'
     WHEN 'SETENGAH_JADI' THEN '5103-00-003'
     WHEN 'PACKAGING' THEN '5103-00-004'
     ELSE c.usage_account_code
   END
  FROM coa_templates t
 WHERE c.template_id=t.id
   AND t.code='AK_FNB_STANDARD_V1'
   AND c.category_code IN ('BAHAN_BAKU','BAHAN_PENDUKUNG','SETENGAH_JADI','PACKAGING');

-- Upgrade companies that already used the system F&B template without overwriting user-edited mappings.
INSERT INTO chart_of_accounts(workspace_id,company_id,code,name,account_type,normal_balance,allow_manual_posting,report_group,report_subgroup)
SELECT c.workspace_id,c.id,a.code,a.name,a.account_type,a.normal_balance,a.allow_manual_posting,a.report_group,a.report_subgroup
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  JOIN coa_template_accounts a ON a.template_id=t.id AND a.code LIKE '5103-%'
 GROUP BY c.workspace_id,c.id,a.code,a.name,a.account_type,a.normal_balance,a.allow_manual_posting,a.report_group,a.report_subgroup
ON CONFLICT(company_id,code) DO NOTHING;

UPDATE item_category_account_mappings m
   SET usage_account_id=coa.id,
       updated_at=NOW()
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  JOIN item_categories ic ON ic.workspace_id=c.workspace_id
  JOIN coa_template_item_categories tm ON tm.template_id=t.id AND tm.category_code=ic.code
  JOIN chart_of_accounts coa ON coa.company_id=c.id AND coa.code=tm.usage_account_code
 WHERE m.company_id=c.id
   AND m.category_id=ic.id
   AND m.usage_account_id IS NULL
   AND tm.usage_account_code IS NOT NULL;
