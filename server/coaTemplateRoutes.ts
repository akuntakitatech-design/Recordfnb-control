import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canWriteCompanyMaster } from './access.js';

export const coaTemplateRouter = Router();
coaTemplateRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function nullable(value: unknown) { const v = text(value); return v || null; }

async function requireCompanyRead(userId: string, companyId: string) {
  return Boolean(companyId && await canAccessCompany(userId, companyId));
}

async function requireCompanyWrite(userId: string, companyId: string) {
  return Boolean(companyId && await canWriteCompanyMaster(userId, companyId));
}

coaTemplateRouter.get('/templates', async (_req, res) => {
  const result = await query(
    `SELECT t.id,t.code,t.name,t.industry,t.version,t.description,t.is_system,t.status,
            COUNT(a.id)::int account_count
       FROM coa_templates t
       LEFT JOIN coa_template_accounts a ON a.template_id=t.id
      WHERE t.status='ACTIVE'
      GROUP BY t.id
      ORDER BY t.is_system DESC,t.name`,
  );
  res.json(result.rows);
});

coaTemplateRouter.get('/templates/:templateId/accounts', async (req, res) => {
  const templateId = text(req.params.templateId);
  const result = await query(
    `SELECT id,code,name,account_type,normal_balance,report_group,report_subgroup,allow_manual_posting,sort_order
       FROM coa_template_accounts
      WHERE template_id=$1
      ORDER BY sort_order,code`,
    [templateId],
  );
  res.json(result.rows);
});

coaTemplateRouter.get('/company/:companyId/mappings', async (req, res) => {
  const companyId = text(req.params.companyId);
  if (!(await requireCompanyRead(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const [company, accounts, important, itemCategories, assetCategories, taxDefaults, application] = await Promise.all([
    query(`SELECT c.id,c.workspace_id,c.code,c.name,w.name workspace_name FROM companies c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1`, [companyId]),
    query(`SELECT id,code,name,account_type,normal_balance,report_group,report_subgroup,status FROM chart_of_accounts WHERE company_id=$1 ORDER BY code`, [companyId]),
    query(`SELECT ia.role_code,ia.account_id,coa.code account_code,coa.name account_name
             FROM important_accounts ia JOIN chart_of_accounts coa ON coa.id=ia.account_id
            WHERE ia.company_id=$1 ORDER BY ia.role_code`, [companyId]),
    query(`SELECT c.id category_id,c.code category_code,c.name category_name,c.category_type,
                  m.inventory_account_id,ai.code inventory_account_code,ai.name inventory_account_name,
                  m.cogs_account_id,ac.code cogs_account_code,ac.name cogs_account_name,
                  m.sales_account_id,asales.code sales_account_code,asales.name sales_account_name,
                  m.usage_account_id,au.code usage_account_code,au.name usage_account_name
             FROM item_categories c
             JOIN companies co ON co.workspace_id=c.workspace_id AND co.id=$1
             LEFT JOIN item_category_account_mappings m ON m.company_id=co.id AND m.category_id=c.id
             LEFT JOIN chart_of_accounts ai ON ai.id=m.inventory_account_id
             LEFT JOIN chart_of_accounts ac ON ac.id=m.cogs_account_id
             LEFT JOIN chart_of_accounts asales ON asales.id=m.sales_account_id
             LEFT JOIN chart_of_accounts au ON au.id=m.usage_account_id
            WHERE c.status='ACTIVE'
            ORDER BY c.name`, [companyId]),
    query(`SELECT c.id category_id,c.code category_code,c.name category_name,
                  m.asset_account_id,aa.code asset_account_code,aa.name asset_account_name,
                  m.accumulated_depreciation_account_id,ad.code accumulated_depreciation_account_code,ad.name accumulated_depreciation_account_name,
                  m.depreciation_expense_account_id,de.code depreciation_expense_account_code,de.name depreciation_expense_account_name
             FROM asset_categories c
             JOIN companies co ON co.workspace_id=c.workspace_id AND co.id=$1
             LEFT JOIN asset_category_account_mappings m ON m.company_id=co.id AND m.asset_category_id=c.id
             LEFT JOIN chart_of_accounts aa ON aa.id=m.asset_account_id
             LEFT JOIN chart_of_accounts ad ON ad.id=m.accumulated_depreciation_account_id
             LEFT JOIN chart_of_accounts de ON de.id=m.depreciation_expense_account_id
            WHERE c.status='ACTIVE'
            ORDER BY c.name`, [companyId]),
    query(`SELECT d.tax_role_code,d.label,d.account_id,coa.code account_code,coa.name account_name
             FROM tax_account_defaults d JOIN chart_of_accounts coa ON coa.id=d.account_id
            WHERE d.company_id=$1 ORDER BY d.tax_role_code`, [companyId]),
    query(`SELECT a.id,a.template_id,t.code template_code,t.name template_name,a.template_version,a.applied_at
             FROM company_coa_template_applications a
             JOIN coa_templates t ON t.id=a.template_id
            WHERE a.company_id=$1 ORDER BY a.applied_at DESC LIMIT 1`, [companyId]),
  ]);

  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  res.json({
    company: company.rows[0],
    accounts: accounts.rows,
    importantAccounts: important.rows,
    itemCategories: itemCategories.rows,
    assetCategories: assetCategories.rows,
    taxDefaults: taxDefaults.rows,
    application: application.rows[0] || null,
  });
});

coaTemplateRouter.post('/templates/:templateId/apply', async (req, res) => {
  const templateId = text(req.params.templateId);
  const companyId = text(req.body?.companyId);
  if (!(await requireCompanyWrite(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY_WRITE' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyResult = await client.query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1 FOR UPDATE', [companyId]);
    if (!companyResult.rowCount) throw new Error('COMPANY_NOT_FOUND');
    const workspaceId = companyResult.rows[0].workspace_id;

    const templateResult = await client.query<{ id: string; version: number; code: string }>(
      `SELECT id,version,code FROM coa_templates WHERE id=$1 AND status='ACTIVE' LIMIT 1`,
      [templateId],
    );
    if (!templateResult.rowCount) throw new Error('COA_TEMPLATE_NOT_FOUND');
    const template = templateResult.rows[0];

    const inserted = await client.query(
      `INSERT INTO chart_of_accounts(workspace_id,company_id,code,name,account_type,normal_balance,allow_manual_posting,report_group,report_subgroup)
       SELECT $1,$2,a.code,a.name,a.account_type,a.normal_balance,a.allow_manual_posting,a.report_group,a.report_subgroup
         FROM coa_template_accounts a
        WHERE a.template_id=$3
       ON CONFLICT(company_id,code) DO NOTHING
       RETURNING id,code`,
      [workspaceId, companyId, templateId],
    );

    const existingCount = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int count FROM chart_of_accounts WHERE company_id=$1`, [companyId],
    );

    // Important accounts: create defaults once, never overwrite user edits when template is re-applied.
    await client.query(
      `INSERT INTO important_accounts(workspace_id,company_id,role_code,account_id)
       SELECT $1,$2,m.role_code,coa.id
         FROM coa_template_important_accounts m
         JOIN chart_of_accounts coa ON coa.company_id=$2 AND coa.code=m.account_code
        WHERE m.template_id=$3
       ON CONFLICT(company_id,role_code) DO NOTHING`,
      [workspaceId, companyId, templateId],
    );

    // Create generic F&B item categories and attach accounting defaults per company.
    await client.query(
      `INSERT INTO item_categories(workspace_id,code,name,category_type)
       SELECT $1,m.category_code,m.category_name,m.category_type
         FROM coa_template_item_categories m
        WHERE m.template_id=$2
       ON CONFLICT(workspace_id,code) DO NOTHING`,
      [workspaceId, templateId],
    );
    await client.query(
      `INSERT INTO item_category_account_mappings(company_id,category_id,inventory_account_id,cogs_account_id,sales_account_id,usage_account_id)
       SELECT $1,c.id,inv.id,cogs.id,sales.id,usage.id
         FROM coa_template_item_categories m
         JOIN item_categories c ON c.workspace_id=$2 AND c.code=m.category_code
         LEFT JOIN chart_of_accounts inv ON inv.company_id=$1 AND inv.code=m.inventory_account_code
         LEFT JOIN chart_of_accounts cogs ON cogs.company_id=$1 AND cogs.code=m.cogs_account_code
         LEFT JOIN chart_of_accounts sales ON sales.company_id=$1 AND sales.code=m.sales_account_code
         LEFT JOIN chart_of_accounts usage ON usage.company_id=$1 AND usage.code=m.usage_account_code
        WHERE m.template_id=$3
       ON CONFLICT(company_id,category_id) DO NOTHING`,
      [companyId, workspaceId, templateId],
    );

    // Asset category mappings follow the MeatNight asset grouping and remain editable per company.
    await client.query(
      `INSERT INTO asset_categories(workspace_id,code,name)
       SELECT $1,m.category_code,m.category_name
         FROM coa_template_asset_categories m
        WHERE m.template_id=$2
       ON CONFLICT(workspace_id,code) DO NOTHING`,
      [workspaceId, templateId],
    );
    await client.query(
      `INSERT INTO asset_category_account_mappings(company_id,asset_category_id,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
       SELECT $1,c.id,asset.id,accum.id,expense.id
         FROM coa_template_asset_categories m
         JOIN asset_categories c ON c.workspace_id=$2 AND c.code=m.category_code
         JOIN chart_of_accounts asset ON asset.company_id=$1 AND asset.code=m.asset_account_code
         JOIN chart_of_accounts accum ON accum.company_id=$1 AND accum.code=m.accumulated_depreciation_account_code
         JOIN chart_of_accounts expense ON expense.company_id=$1 AND expense.code=m.depreciation_expense_account_code
        WHERE m.template_id=$3
       ON CONFLICT(company_id,asset_category_id) DO NOTHING`,
      [companyId, workspaceId, templateId],
    );

    // Tax accounts are deliberately separate from Important Accounts because they belong to the tax master.
    await client.query(
      `INSERT INTO tax_account_defaults(company_id,tax_role_code,label,account_id)
       SELECT $1,m.tax_role_code,m.label,coa.id
         FROM coa_template_tax_accounts m
         JOIN chart_of_accounts coa ON coa.company_id=$1 AND coa.code=m.account_code
        WHERE m.template_id=$2
       ON CONFLICT(company_id,tax_role_code) DO NOTHING`,
      [companyId, templateId],
    );

    await client.query(
      `INSERT INTO company_coa_template_applications(company_id,template_id,template_version,applied_by)
       VALUES($1,$2,$3,$4)`,
      [companyId, templateId, template.version, req.sessionUser!.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'COMPANY',$3,'APPLY_COA_TEMPLATE',$4::jsonb)`,
      [workspaceId, req.sessionUser!.id, companyId, JSON.stringify({ templateCode: template.code, templateVersion: template.version, insertedAccounts: inserted.rowCount })],
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, insertedAccounts: inserted.rowCount, totalAccounts: existingCount.rows[0]?.count ?? 0 });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Apply COA template failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'APPLY_COA_TEMPLATE_FAILED' });
  } finally {
    client.release();
  }
});

coaTemplateRouter.put('/company/:companyId/important/:roleCode', async (req, res) => {
  const companyId = text(req.params.companyId);
  const roleCode = text(req.params.roleCode).toUpperCase();
  const accountId = text(req.body?.accountId);
  if (!(await requireCompanyWrite(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY_WRITE' });
  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const account = await query('SELECT id FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [accountId, companyId]);
  if (!account.rowCount) return res.status(400).json({ error: 'INVALID_ACCOUNT' });
  await query(
    `INSERT INTO important_accounts(workspace_id,company_id,role_code,account_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(company_id,role_code) DO UPDATE SET account_id=EXCLUDED.account_id`,
    [company.rows[0].workspace_id, companyId, roleCode, accountId],
  );
  res.json({ ok: true });
});

coaTemplateRouter.put('/company/:companyId/item-category/:categoryId', async (req, res) => {
  const companyId = text(req.params.companyId);
  const categoryId = text(req.params.categoryId);
  if (!(await requireCompanyWrite(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY_WRITE' });
  const values = [
    nullable(req.body?.inventoryAccountId), nullable(req.body?.cogsAccountId),
    nullable(req.body?.salesAccountId), nullable(req.body?.usageAccountId),
  ];
  for (const accountId of values.filter(Boolean)) {
    const valid = await query('SELECT 1 FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [accountId, companyId]);
    if (!valid.rowCount) return res.status(400).json({ error: 'INVALID_ACCOUNT' });
  }
  await query(
    `INSERT INTO item_category_account_mappings(company_id,category_id,inventory_account_id,cogs_account_id,sales_account_id,usage_account_id)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(company_id,category_id) DO UPDATE SET
       inventory_account_id=EXCLUDED.inventory_account_id,
       cogs_account_id=EXCLUDED.cogs_account_id,
       sales_account_id=EXCLUDED.sales_account_id,
       usage_account_id=EXCLUDED.usage_account_id,
       updated_at=NOW()`,
    [companyId, categoryId, ...values],
  );
  res.json({ ok: true });
});

coaTemplateRouter.put('/company/:companyId/asset-category/:categoryId', async (req, res) => {
  const companyId = text(req.params.companyId);
  const categoryId = text(req.params.categoryId);
  if (!(await requireCompanyWrite(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY_WRITE' });
  const assetAccountId = text(req.body?.assetAccountId);
  const accumulatedDepreciationAccountId = text(req.body?.accumulatedDepreciationAccountId);
  const depreciationExpenseAccountId = text(req.body?.depreciationExpenseAccountId);
  for (const accountId of [assetAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId]) {
    const valid = await query('SELECT 1 FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [accountId, companyId]);
    if (!valid.rowCount) return res.status(400).json({ error: 'INVALID_ACCOUNT' });
  }
  await query(
    `INSERT INTO asset_category_account_mappings(company_id,asset_category_id,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(company_id,asset_category_id) DO UPDATE SET
       asset_account_id=EXCLUDED.asset_account_id,
       accumulated_depreciation_account_id=EXCLUDED.accumulated_depreciation_account_id,
       depreciation_expense_account_id=EXCLUDED.depreciation_expense_account_id,
       updated_at=NOW()`,
    [companyId, categoryId, assetAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId],
  );
  res.json({ ok: true });
});

coaTemplateRouter.put('/company/:companyId/tax/:taxRoleCode', async (req, res) => {
  const companyId = text(req.params.companyId);
  const taxRoleCode = text(req.params.taxRoleCode).toUpperCase();
  const accountId = text(req.body?.accountId);
  const label = text(req.body?.label) || taxRoleCode;
  if (!(await requireCompanyWrite(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY_WRITE' });
  const account = await query('SELECT id FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [accountId, companyId]);
  if (!account.rowCount) return res.status(400).json({ error: 'INVALID_ACCOUNT' });
  await query(
    `INSERT INTO tax_account_defaults(company_id,tax_role_code,label,account_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(company_id,tax_role_code) DO UPDATE SET label=EXCLUDED.label,account_id=EXCLUDED.account_id,updated_at=NOW()`,
    [companyId, taxRoleCode, label, accountId],
  );
  res.json({ ok: true });
});
