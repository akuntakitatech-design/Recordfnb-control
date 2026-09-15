import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

export const masterRouter = Router();
masterRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function upper(value: unknown) { return text(value).toUpperCase(); }
function bool(value: unknown, fallback: boolean) { return typeof value === 'boolean' ? value : fallback; }

masterRouter.get('/units', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT u.id,u.workspace_id,u.code,u.name,u.decimal_precision,u.status,w.name workspace_name
       FROM units u JOIN workspaces w ON w.id=u.workspace_id
      WHERE ($1='' OR u.workspace_id=$1::uuid)
      ORDER BY w.name,u.name`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.post('/units', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const decimalPrecision = Number(req.body?.decimalPrecision ?? 3);
  if (!workspaceId || !code || !name) return res.status(400).json({ error: 'WORKSPACE_CODE_NAME_REQUIRED' });
  if (!Number.isInteger(decimalPrecision) || decimalPrecision < 0 || decimalPrecision > 6) return res.status(400).json({ error: 'INVALID_DECIMAL_PRECISION' });
  const result = await query(
    `INSERT INTO units(workspace_id,code,name,decimal_precision) VALUES($1,$2,$3,$4)
     RETURNING id,workspace_id,code,name,decimal_precision,status`,
    [workspaceId, code, name, decimalPrecision],
  );
  res.status(201).json(result.rows[0]);
});

masterRouter.get('/item-categories', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT c.id,c.workspace_id,c.parent_id,c.code,c.name,c.category_type,c.status,
            p.name parent_name,w.name workspace_name
       FROM item_categories c
       JOIN workspaces w ON w.id=c.workspace_id
       LEFT JOIN item_categories p ON p.id=c.parent_id
      WHERE ($1='' OR c.workspace_id=$1::uuid)
      ORDER BY w.name,c.category_type,c.name`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.post('/item-categories', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const parentId = text(req.body?.parentId) || null;
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const categoryType = upper(req.body?.categoryType || 'RAW_MATERIAL');
  if (!workspaceId || !code || !name) return res.status(400).json({ error: 'WORKSPACE_CODE_NAME_REQUIRED' });
  const result = await query(
    `INSERT INTO item_categories(workspace_id,parent_id,code,name,category_type)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id,workspace_id,parent_id,code,name,category_type,status`,
    [workspaceId, parentId, code, name, categoryType],
  );
  res.status(201).json(result.rows[0]);
});

masterRouter.get('/items', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT i.id,i.workspace_id,i.code,i.name,i.category_id,i.base_unit_id,i.track_stock,
            i.can_purchase,i.can_sell,i.can_produce,i.can_use_in_recipe,i.valuation_method,i.status,
            c.name category_name,c.category_type,u.code unit_code,u.name unit_name,w.name workspace_name
       FROM items i
       JOIN item_categories c ON c.id=i.category_id
       JOIN units u ON u.id=i.base_unit_id
       JOIN workspaces w ON w.id=i.workspace_id
      WHERE ($1='' OR i.workspace_id=$1::uuid)
      ORDER BY w.name,c.name,i.name`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.post('/items', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const categoryId = text(req.body?.categoryId);
  const baseUnitId = text(req.body?.baseUnitId);
  const valuationMethod = upper(req.body?.valuationMethod || 'MOVING_AVERAGE');
  if (!workspaceId || !code || !name || !categoryId || !baseUnitId) return res.status(400).json({ error: 'ITEM_REQUIRED_FIELDS' });
  const result = await query(
    `INSERT INTO items(workspace_id,code,name,category_id,base_unit_id,track_stock,can_purchase,can_sell,can_produce,can_use_in_recipe,valuation_method)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id,workspace_id,code,name,category_id,base_unit_id,track_stock,can_purchase,can_sell,can_produce,can_use_in_recipe,valuation_method,status`,
    [workspaceId, code, name, categoryId, baseUnitId,
      bool(req.body?.trackStock, true), bool(req.body?.canPurchase, true), bool(req.body?.canSell, false),
      bool(req.body?.canProduce, false), bool(req.body?.canUseInRecipe, true), valuationMethod],
  );
  res.status(201).json(result.rows[0]);
});

masterRouter.get('/unit-conversions', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT uc.id,uc.workspace_id,uc.item_id,uc.from_unit_id,uc.to_unit_id,uc.multiplier,
            i.name item_name,fu.code from_unit_code,tu.code to_unit_code,w.name workspace_name
       FROM unit_conversions uc
       JOIN workspaces w ON w.id=uc.workspace_id
       LEFT JOIN items i ON i.id=uc.item_id
       JOIN units fu ON fu.id=uc.from_unit_id
       JOIN units tu ON tu.id=uc.to_unit_id
      WHERE ($1='' OR uc.workspace_id=$1::uuid)
      ORDER BY w.name,COALESCE(i.name,''),fu.code,tu.code`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.post('/unit-conversions', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const itemId = text(req.body?.itemId) || null;
  const fromUnitId = text(req.body?.fromUnitId);
  const toUnitId = text(req.body?.toUnitId);
  const multiplier = Number(req.body?.multiplier);
  if (!workspaceId || !fromUnitId || !toUnitId || !Number.isFinite(multiplier) || multiplier <= 0) return res.status(400).json({ error: 'INVALID_CONVERSION' });
  if (fromUnitId === toUnitId) return res.status(400).json({ error: 'CONVERSION_UNITS_MUST_DIFFER' });
  const result = await query(
    `INSERT INTO unit_conversions(workspace_id,item_id,from_unit_id,to_unit_id,multiplier)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id,workspace_id,item_id,from_unit_id,to_unit_id,multiplier`,
    [workspaceId, itemId, fromUnitId, toUnitId, multiplier],
  );
  res.status(201).json(result.rows[0]);
});

masterRouter.get('/cost-centers', async (req, res) => {
  const companyId = text(req.query.companyId);
  const result = await query(
    `SELECT id,company_id,code,name,status FROM cost_centers
      WHERE ($1='' OR company_id=$1::uuid) ORDER BY name`, [companyId],
  );
  res.json(result.rows);
});

masterRouter.get('/tax-codes', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT id,workspace_id,code,name,tax_type,rate,default_inclusive,status
       FROM tax_codes
      WHERE ($1='' OR workspace_id=$1::uuid)
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY code,effective_from DESC`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.get('/partners', async (req, res) => {
  const workspaceId = text(req.query.workspaceId);
  const result = await query(
    `SELECT id,workspace_id,code,name,partner_type,payment_term_days,status
       FROM business_partners
      WHERE ($1='' OR workspace_id=$1::uuid) ORDER BY name`, [workspaceId],
  );
  res.json(result.rows);
});

masterRouter.get('/accounts', async (req, res) => {
  const companyId = text(req.query.companyId);
  const result = await query(
    `SELECT id,company_id,code,name,account_type,normal_balance,status
       FROM chart_of_accounts
      WHERE ($1='' OR company_id=$1::uuid) ORDER BY code`, [companyId],
  );
  res.json(result.rows);
});
