-- Stock Opname v0.13
-- Adds category-level stock-adjustment mapping and dedicated stock-opname accounts.

ALTER TABLE coa_template_item_categories
  ADD COLUMN IF NOT EXISTS stock_adjustment_account_code TEXT;

ALTER TABLE item_category_account_mappings
  ADD COLUMN IF NOT EXISTS stock_adjustment_account_id UUID REFERENCES chart_of_accounts(id);

ALTER TABLE item_account_overrides
  ADD COLUMN IF NOT EXISTS stock_adjustment_account_id UUID REFERENCES chart_of_accounts(id);

UPDATE coa_templates
   SET version=3,
       description='COA generik F&B v3: restaurant, cafe, bakery, cloud kitchen, catering, multi-outlet dan central kitchen; termasuk pemakaian, transfer dan stock opname persediaan.',
       updated_at=NOW()
 WHERE code='AK_FNB_STANDARD_V1';

INSERT INTO coa_template_accounts(template_id,code,name,account_type,normal_balance,report_group,report_subgroup,sort_order)
SELECT t.id,v.code,v.name,'COGS','DEBIT','Harga Pokok Penjualan','Stock Opname',v.sort_order
FROM coa_templates t
CROSS JOIN (VALUES
  ('5102-00-001','Stock Opname Bahan Baku',14101),
  ('5102-00-002','Stock Opname Bahan Pendukung',14102),
  ('5102-00-003','Stock Opname Bahan Setengah Jadi',14103),
  ('5102-00-004','Stock Opname Barang Jadi',14104),
  ('5102-00-005','Stock Opname Packaging',14105),
  ('5102-00-099','Selisih Persediaan Lainnya',14199)
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
   SET stock_adjustment_account_code = CASE c.category_code
     WHEN 'BAHAN_BAKU' THEN '5102-00-001'
     WHEN 'BAHAN_PENDUKUNG' THEN '5102-00-002'
     WHEN 'SETENGAH_JADI' THEN '5102-00-003'
     WHEN 'MAKANAN' THEN '5102-00-004'
     WHEN 'MINUMAN' THEN '5102-00-004'
     WHEN 'PACKAGING' THEN '5102-00-005'
     ELSE '5102-00-099'
   END
  FROM coa_templates t
 WHERE c.template_id=t.id
   AND t.code='AK_FNB_STANDARD_V1';

INSERT INTO chart_of_accounts(workspace_id,company_id,code,name,account_type,normal_balance,allow_manual_posting,report_group,report_subgroup)
SELECT c.workspace_id,c.id,a.code,a.name,a.account_type,a.normal_balance,a.allow_manual_posting,a.report_group,a.report_subgroup
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  JOIN coa_template_accounts a ON a.template_id=t.id AND a.code LIKE '5102-%'
 GROUP BY c.workspace_id,c.id,a.code,a.name,a.account_type,a.normal_balance,a.allow_manual_posting,a.report_group,a.report_subgroup
ON CONFLICT(company_id,code) DO NOTHING;

UPDATE item_category_account_mappings m
   SET stock_adjustment_account_id=coa.id,
       updated_at=NOW()
  FROM companies c
  JOIN company_coa_template_applications app ON app.company_id=c.id
  JOIN coa_templates t ON t.id=app.template_id AND t.code='AK_FNB_STANDARD_V1'
  JOIN item_categories ic ON ic.workspace_id=c.workspace_id
  JOIN coa_template_item_categories tm ON tm.template_id=t.id AND tm.category_code=ic.code
  JOIN chart_of_accounts coa ON coa.company_id=c.id AND coa.code=tm.stock_adjustment_account_code
 WHERE m.company_id=c.id
   AND m.category_id=ic.id
   AND m.stock_adjustment_account_id IS NULL
   AND tm.stock_adjustment_account_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_opname_company_date
ON transaction_headers(company_id,transaction_date)
WHERE transaction_type='STOCK_OPNAME';
