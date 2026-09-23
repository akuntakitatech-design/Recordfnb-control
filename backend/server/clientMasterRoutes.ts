import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canWriteOperationalWorkspaceMaster } from './access.js';

export const clientMasterRouter = Router();
clientMasterRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function upper(value: unknown) { return text(value).toUpperCase(); }
function nullable(value: unknown) { const v = text(value); return v || null; }
function bool(value: unknown, fallback: boolean) { return typeof value === 'boolean' ? value : fallback; }

clientMasterRouter.post('/items', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const categoryId = text(req.body?.categoryId);
  const baseUnitId = text(req.body?.baseUnitId);

  if (!workspaceId || !code || !name || !categoryId || !baseUnitId) {
    return res.status(400).json({ error: 'ITEM_REQUIRED_FIELDS' });
  }
  if (!(await canWriteOperationalWorkspaceMaster(req.sessionUser!.id, workspaceId))) {
    return res.status(403).json({ error: 'FORBIDDEN_OPERATIONAL_MASTER' });
  }

  const [category, unit] = await Promise.all([
    query('SELECT id FROM item_categories WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\'', [categoryId, workspaceId]),
    query('SELECT id FROM units WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\'', [baseUnitId, workspaceId]),
  ]);
  if (!category.rowCount) return res.status(400).json({ error: 'CATEGORY_OUTSIDE_WORKSPACE' });
  if (!unit.rowCount) return res.status(400).json({ error: 'UNIT_OUTSIDE_WORKSPACE' });

  const result = await query(
    `INSERT INTO items(
       workspace_id,code,name,category_id,base_unit_id,track_stock,can_purchase,can_sell,can_produce,can_use_in_recipe,valuation_method
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'MOVING_AVERAGE')
     RETURNING id,workspace_id,code,name,category_id,base_unit_id,track_stock,can_purchase,can_sell,can_produce,can_use_in_recipe,valuation_method,status`,
    [
      workspaceId, code, name, categoryId, baseUnitId,
      bool(req.body?.trackStock, true), bool(req.body?.canPurchase, true), bool(req.body?.canSell, false),
      bool(req.body?.canProduce, false), bool(req.body?.canUseInRecipe, true),
    ],
  );

  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'ITEM',$3,'CLIENT_CREATE_OPERATIONAL_MASTER',$4::jsonb)`,
    [workspaceId, req.sessionUser!.id, result.rows[0].id, JSON.stringify({ code, name, categoryId, baseUnitId })],
  );

  res.status(201).json(result.rows[0]);
});

clientMasterRouter.post('/partners', async (req, res) => {
  const workspaceId = text(req.body?.workspaceId);
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const partnerType = upper(req.body?.partnerType || 'SUPPLIER');
  const paymentTermDays = Number(req.body?.paymentTermDays ?? 0);

  if (!workspaceId || !code || !name) return res.status(400).json({ error: 'WORKSPACE_CODE_NAME_REQUIRED' });
  if (!(await canWriteOperationalWorkspaceMaster(req.sessionUser!.id, workspaceId))) {
    return res.status(403).json({ error: 'FORBIDDEN_OPERATIONAL_MASTER' });
  }
  if (!['SUPPLIER','CUSTOMER','BOTH','MERCHANT','OTHER'].includes(partnerType)) {
    return res.status(400).json({ error: 'INVALID_PARTNER_TYPE' });
  }
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0) {
    return res.status(400).json({ error: 'INVALID_PAYMENT_TERM' });
  }

  const result = await query(
    `INSERT INTO business_partners(workspace_id,code,name,partner_type,tax_number,phone,email,address,payment_term_days)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id,workspace_id,code,name,partner_type,payment_term_days,status`,
    [
      workspaceId, code, name, partnerType, nullable(req.body?.taxNumber), nullable(req.body?.phone),
      nullable(req.body?.email), nullable(req.body?.address), paymentTermDays,
    ],
  );

  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'BUSINESS_PARTNER',$3,'CLIENT_CREATE_OPERATIONAL_MASTER',$4::jsonb)`,
    [workspaceId, req.sessionUser!.id, result.rows[0].id, JSON.stringify({ code, name, partnerType, paymentTermDays })],
  );

  res.status(201).json(result.rows[0]);
});
