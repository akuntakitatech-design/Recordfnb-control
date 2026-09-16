import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canWriteCompanyMaster, canWriteWorkspaceMaster } from './access.js';

export const financeMasterRouter = Router();
financeMasterRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function upper(value: unknown) { return text(value).toUpperCase(); }
function nullable(value: unknown) { const valueText = text(value); return valueText || null; }

financeMasterRouter.get('/financial-accounts', async (req, res) => {
  const companyId = text(req.query.companyId);
  const result = await query(
    `SELECT fa.id,fa.workspace_id,fa.company_id,fa.location_id,fa.code,fa.name,fa.account_kind,fa.coa_account_id,fa.status,
            l.name location_name,coa.code coa_code,coa.name coa_name
       FROM financial_accounts fa
       JOIN companies c ON c.id=fa.company_id
       LEFT JOIN locations l ON l.id=fa.location_id
       JOIN chart_of_accounts coa ON coa.id=fa.coa_account_id
      WHERE ($1='' OR fa.company_id=$1::uuid)
        AND (EXISTS (SELECT 1 FROM users x WHERE x.id=$2 AND x.is_system_admin AND x.status='ACTIVE')
          OR EXISTS (
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=fa.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=fa.company_id)
               AND (wm.location_id IS NULL OR fa.location_id IS NULL OR wm.location_id=fa.location_id)
          ))
      ORDER BY fa.account_kind,fa.name`,
    [companyId, req.sessionUser!.id],
  );
  res.json(result.rows);
});

financeMasterRouter.post('/cost-centers', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const parentId = nullable(req.body?.parentId);
  if (!companyId || !code || !name) return res.status(400).json({ error: 'COMPANY_CODE_NAME_REQUIRED' });
  if (!(await canWriteCompanyMaster(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const result = await query(
    `INSERT INTO cost_centers(workspace_id,company_id,parent_id,code,name)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id,company_id,parent_id,code,name,status`,
    [company.rows[0].workspace_id, companyId, parentId, code, name],
  );
  res.status(201).json(result.rows[0]);
});

financeMasterRouter.post('/partners', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const partnerType = upper(req.body?.partnerType || 'SUPPLIER');
  const paymentTermDays = Number(req.body?.paymentTermDays ?? 0);
  if (!workspaceId || !code || !name) return res.status(400).json({ error: 'WORKSPACE_CODE_NAME_REQUIRED' });
  if (!(await canWriteWorkspaceMaster(req.sessionUser!.id, workspaceId))) return res.status(403).json({ error: 'FORBIDDEN' });
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0) return res.status(400).json({ error: 'INVALID_PAYMENT_TERM' });
  const result = await query(
    `INSERT INTO business_partners(workspace_id,code,name,partner_type,tax_number,phone,email,address,payment_term_days)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,workspace_id,code,name,partner_type,payment_term_days,status`,
    [workspaceId, code, name, partnerType, nullable(req.body?.taxNumber), nullable(req.body?.phone),
     nullable(req.body?.email), nullable(req.body?.address), paymentTermDays],
  );
  res.status(201).json(result.rows[0]);
});

financeMasterRouter.post('/accounts', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const accountType = upper(req.body?.accountType || 'EXPENSE');
  const parentId = nullable(req.body?.parentId);
  const defaultNormal = ['LIABILITY','EQUITY','REVENUE','OTHER_INCOME'].includes(accountType) ? 'CREDIT' : 'DEBIT';
  const normalBalance = upper(req.body?.normalBalance || defaultNormal);
  if (!companyId || !code || !name) return res.status(400).json({ error: 'COMPANY_CODE_NAME_REQUIRED' });
  if (!(await canWriteCompanyMaster(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const result = await query(
    `INSERT INTO chart_of_accounts(workspace_id,company_id,parent_id,code,name,account_type,normal_balance,allow_manual_posting)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,company_id,parent_id,code,name,account_type,normal_balance,status`,
    [company.rows[0].workspace_id, companyId, parentId, code, name, accountType, normalBalance, req.body?.allowManualPosting !== false],
  );
  res.status(201).json(result.rows[0]);
});

financeMasterRouter.post('/tax-codes', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const taxType = upper(req.body?.taxType || 'VAT');
  const rate = Number(req.body?.rate ?? 0);
  const effectiveFrom = text(req.body?.effectiveFrom) || new Date().toISOString().slice(0, 10);
  if (!workspaceId || !code || !name || !Number.isFinite(rate) || rate < 0) return res.status(400).json({ error: 'INVALID_TAX_CODE' });
  if (!(await canWriteWorkspaceMaster(req.sessionUser!.id, workspaceId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const result = await query(
    `INSERT INTO tax_codes(workspace_id,code,name,tax_type,rate,effective_from,effective_to,default_inclusive,input_tax_account_id,output_tax_account_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id,workspace_id,code,name,tax_type,rate,default_inclusive,status`,
    [workspaceId, code, name, taxType, rate, effectiveFrom, nullable(req.body?.effectiveTo), Boolean(req.body?.defaultInclusive),
     nullable(req.body?.inputTaxAccountId), nullable(req.body?.outputTaxAccountId)],
  );
  res.status(201).json(result.rows[0]);
});

financeMasterRouter.post('/financial-accounts', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const accountKind = upper(req.body?.accountKind || 'BANK');
  const coaAccountId = text(req.body?.coaAccountId);
  const locationId = nullable(req.body?.locationId);
  if (!companyId || !code || !name || !coaAccountId) return res.status(400).json({ error: 'FINANCIAL_ACCOUNT_REQUIRED_FIELDS' });
  if (!(await canWriteCompanyMaster(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  if (locationId) {
    const location = await query('SELECT id FROM locations WHERE id=$1 AND company_id=$2', [locationId, companyId]);
    if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
  }
  const coa = await query('SELECT id FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [coaAccountId, companyId]);
  if (!coa.rowCount) return res.status(400).json({ error: 'COA_OUTSIDE_COMPANY' });
  const result = await query(
    `INSERT INTO financial_accounts(workspace_id,company_id,location_id,code,name,account_kind,coa_account_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id,company_id,location_id,code,name,account_kind,coa_account_id,status`,
    [company.rows[0].workspace_id, companyId, locationId, code, name, accountKind, coaAccountId],
  );
  res.status(201).json(result.rows[0]);
});
