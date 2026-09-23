import { Router } from 'express';
import Decimal from 'decimal.js';
import type { PoolClient } from './db.js';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import {
  canAccessCompany,
  canAccessLocation,
  canCreateTransaction,
  canVerifyTransaction,
  canWriteOperationalWorkspaceMaster,
} from './access.js';
import { previewProduction, verifyProduction } from './productionEngine.js';
import { productionRequirement, productionYield } from '../shared/bomMath.js';

export const clientBomProductionRouter = Router();
clientBomProductionRouter.use(requireAuth);

const text = (value: unknown) => String(value ?? '').trim();
const nullable = (value: unknown) => {
  const valueText = text(value);
  return valueText || null;
};
const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : NaN;
};

async function canOverride(userId: string, companyId: string) {
  const result = await query(
    `SELECT 1 FROM users u WHERE u.id=$1 AND u.status='ACTIVE' AND u.is_system_admin
     UNION ALL
     SELECT 1 FROM companies c
       JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id
       JOIN roles r ON r.id=wm.role_id
      WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=c.id)
        AND r.code=ANY($3::text[])
     LIMIT 1`,
    [userId, companyId, ['AK_SUPER_ADMIN', 'AK_ACCOUNTING_REVIEWER', 'AK_ACCOUNTING_STAFF', 'CLIENT_FINANCE_MANAGER']],
  );
  return Boolean(result.rowCount);
}

async function nextProductionNumber(client: PoolClient, companyId: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query<{ last_number: number }>(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'PRODUCTION',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, year],
  );
  return `PRD-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

async function toBaseQuantity(
  client: PoolClient,
  workspaceId: string,
  itemId: string,
  unitId: string,
  baseUnitId: string,
  quantity: Decimal,
) {
  if (unitId === baseUnitId) return quantity;
  const result = await client.query<{ multiplier: string }>(
    `SELECT multiplier::text FROM unit_conversions
      WHERE workspace_id=$1 AND from_unit_id=$2 AND to_unit_id=$3
        AND (item_id=$4 OR item_id IS NULL)
      ORDER BY (item_id IS NOT NULL) DESC LIMIT 1`,
    [workspaceId, unitId, baseUnitId, itemId],
  );
  if (!result.rowCount) throw new Error('UNIT_CONVERSION_REQUIRED');
  return quantity.mul(result.rows[0].multiplier);
}

clientBomProductionRouter.get('/bom-context', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const company = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,
    [companyId],
  );
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });

  const [items, units] = await Promise.all([
    query(
      `SELECT i.id,i.code,i.name,i.category_id,c.name category_name,c.category_type,
              i.base_unit_id,u.code base_unit_code,i.track_stock,i.can_sell,i.can_produce,i.can_use_in_recipe
         FROM items i
         JOIN item_categories c ON c.id=i.category_id
         JOIN units u ON u.id=i.base_unit_id
        WHERE i.workspace_id=$1 AND i.status='ACTIVE'
        ORDER BY c.name,i.name`,
      [company.rows[0].workspace_id],
    ),
    query(
      `SELECT id,code,name,decimal_precision FROM units
        WHERE workspace_id=$1 AND status='ACTIVE' ORDER BY code`,
      [company.rows[0].workspace_id],
    ),
  ]);

  res.json({ workspaceId: company.rows[0].workspace_id, items: items.rows, units: units.rows });
});

clientBomProductionRouter.get('/boms', async (req, res) => {
  const companyId = text(req.query.companyId);
  const bomType = text(req.query.bomType).toUpperCase();
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  if (bomType && !['MENU', 'PRODUCTION'].includes(bomType)) return res.status(400).json({ error: 'INVALID_BOM_TYPE' });

  const headers = await query(
    `SELECT b.id,b.workspace_id,b.company_id,b.bom_type,b.output_item_id,b.output_quantity::text,b.output_unit_id,
            b.version,b.status,b.notes,b.updated_at,i.code output_item_code,i.name output_item_name,u.code output_unit_code
       FROM bom_headers b
       JOIN items i ON i.id=b.output_item_id
       JOIN units u ON u.id=b.output_unit_id
      WHERE b.company_id=$1 AND ($2='' OR b.bom_type=$2)
      ORDER BY b.bom_type,i.name`,
    [companyId, bomType],
  );

  const ids = headers.rows.map((row: { id: string }) => row.id);
  if (!ids.length) return res.json([]);

  const lines = await query(
    `SELECT bl.id,bl.bom_id,bl.line_no,bl.component_item_id,bl.quantity::text,bl.unit_id,bl.waste_percent::text,bl.notes,
            i.code component_code,i.name component_name,u.code unit_code
       FROM bom_lines bl
       JOIN items i ON i.id=bl.component_item_id
       JOIN units u ON u.id=bl.unit_id
      WHERE bl.bom_id=ANY($1::uuid[])
      ORDER BY bl.bom_id,bl.line_no`,
    [ids],
  );

  const byBom = new Map<string, unknown[]>();
  for (const line of lines.rows as Array<{ bom_id: string } & Record<string, unknown>>) {
    const current = byBom.get(line.bom_id) || [];
    current.push(line);
    byBom.set(line.bom_id, current);
  }
  res.json((headers.rows as Array<{ id: string } & Record<string, unknown>>).map(row => ({ ...row, lines: byBom.get(row.id) || [] })));
});

clientBomProductionRouter.post('/boms', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const bomType = text(req.body?.bomType).toUpperCase();
  const outputItemId = text(req.body?.outputItemId);
  const outputUnitId = text(req.body?.outputUnitId);
  const notes = nullable(req.body?.notes);
  const outputQuantity = num(req.body?.outputQuantity);
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!companyId || !['MENU', 'PRODUCTION'].includes(bomType) || !outputItemId || !outputUnitId || !Number.isFinite(outputQuantity) || outputQuantity <= 0 || !rawLines.length) {
    return res.status(400).json({ error: 'BOM_REQUIRED_FIELDS' });
  }

  const company = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,
    [companyId],
  );
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  if (!(await canWriteOperationalWorkspaceMaster(req.sessionUser!.id, company.rows[0].workspace_id))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const output = await client.query<{ base_unit_id: string; can_sell: boolean; can_produce: boolean; track_stock: boolean }>(
      `SELECT base_unit_id,can_sell,can_produce,track_stock
         FROM items WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE'`,
      [outputItemId, company.rows[0].workspace_id],
    );
    if (!output.rowCount) throw new Error('INVALID_BOM_OUTPUT_ITEM');
    if (bomType === 'MENU' && !output.rows[0].can_sell) throw new Error('MENU_OUTPUT_MUST_BE_SELLABLE');
    if (bomType === 'PRODUCTION' && (!output.rows[0].can_produce || !output.rows[0].track_stock)) {
      throw new Error('PRODUCTION_OUTPUT_MUST_BE_STOCK_PRODUCIBLE');
    }
    await toBaseQuantity(client, company.rows[0].workspace_id, outputItemId, outputUnitId, output.rows[0].base_unit_id, new Decimal(outputQuantity));

    const normalized: Array<{ componentItemId: string; unitId: string; quantity: number; wastePercent: number; notes: string | null }> = [];
    const used = new Set<string>();
    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const componentItemId = text(line.componentItemId);
      const unitId = text(line.unitId);
      const quantity = num(line.quantity);
      const wastePercent = num(line.wastePercent || 0);
      if (!componentItemId || !unitId || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(wastePercent) || wastePercent < 0 || wastePercent > 100) {
        throw new Error(`INVALID_BOM_LINE_${index + 1}`);
      }
      if (componentItemId === outputItemId) throw new Error(`BOM_OUTPUT_CANNOT_BE_COMPONENT_LINE_${index + 1}`);
      if (used.has(componentItemId)) throw new Error(`DUPLICATE_BOM_COMPONENT_LINE_${index + 1}`);
      used.add(componentItemId);

      const component = await client.query<{ base_unit_id: string; can_use_in_recipe: boolean; track_stock: boolean }>(
        `SELECT base_unit_id,can_use_in_recipe,track_stock
           FROM items WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE'`,
        [componentItemId, company.rows[0].workspace_id],
      );
      if (!component.rowCount || !component.rows[0].can_use_in_recipe || !component.rows[0].track_stock) {
        throw new Error(`INVALID_BOM_COMPONENT_LINE_${index + 1}`);
      }
      await toBaseQuantity(client, company.rows[0].workspace_id, componentItemId, unitId, component.rows[0].base_unit_id, new Decimal(quantity));
      normalized.push({ componentItemId, unitId, quantity, wastePercent, notes: nullable(line.notes) });
    }

    const header = await client.query<{ id: string; version: number }>(
      `INSERT INTO bom_headers(workspace_id,company_id,bom_type,output_item_id,output_quantity,output_unit_id,notes,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT(company_id,bom_type,output_item_id)
       DO UPDATE SET output_quantity=EXCLUDED.output_quantity,output_unit_id=EXCLUDED.output_unit_id,notes=EXCLUDED.notes,
                     status='ACTIVE',version=bom_headers.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW()
       RETURNING id,version`,
      [company.rows[0].workspace_id, companyId, bomType, outputItemId, outputQuantity, outputUnitId, notes, req.sessionUser!.id],
    );

    await client.query(`DELETE FROM bom_lines WHERE bom_id=$1`, [header.rows[0].id]);
    for (let index = 0; index < normalized.length; index += 1) {
      const line = normalized[index];
      await client.query(
        `INSERT INTO bom_lines(bom_id,line_no,component_item_id,quantity,unit_id,waste_percent,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [header.rows[0].id, index + 1, line.componentItemId, line.quantity, line.unitId, line.wastePercent, line.notes],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'BOM',$3,'UPSERT_BOM',$4::jsonb)`,
      [company.rows[0].workspace_id, req.sessionUser!.id, header.rows[0].id, JSON.stringify({ companyId, bomType, outputItemId, version: header.rows[0].version, lineCount: normalized.length })],
    );
    await client.query('COMMIT');
    res.status(201).json({ id: header.rows[0].id, version: header.rows[0].version });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Save BOM failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'SAVE_BOM_FAILED' });
  } finally {
    client.release();
  }
});

clientBomProductionRouter.delete('/boms/:bomId', async (req, res) => {
  const bomId = text(req.params.bomId);
  const bom = await query<{ workspace_id: string }>(`SELECT workspace_id FROM bom_headers WHERE id=$1`, [bomId]);
  if (!bom.rowCount) return res.status(404).json({ error: 'BOM_NOT_FOUND' });
  if (!(await canWriteOperationalWorkspaceMaster(req.sessionUser!.id, bom.rows[0].workspace_id))) return res.status(403).json({ error: 'FORBIDDEN' });

  await query(`UPDATE bom_headers SET status='INACTIVE',updated_by=$1,updated_at=NOW() WHERE id=$2`, [req.sessionUser!.id, bomId]);
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'BOM',$3,'DEACTIVATE_BOM',$4::jsonb)`,
    [bom.rows[0].workspace_id, req.sessionUser!.id, bomId, JSON.stringify({ status: 'INACTIVE' })],
  );
  res.json({ ok: true });
});

clientBomProductionRouter.get('/productions', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const result = await query(
    `SELECT t.id,t.transaction_number,t.transaction_date,t.location_id,l.name location_name,t.notes,t.workflow_status,t.accounting_status,
            t.grand_total::text,t.negative_stock_override,pd.batch_count::text,pd.standard_output::text,pd.actual_output::text,pd.yield_percent::text,
            b.output_item_id,i.code output_item_code,i.name output_item_name,u.code output_unit_code
       FROM transaction_headers t
       JOIN production_details pd ON pd.transaction_id=t.id
       JOIN bom_headers b ON b.id=pd.bom_id
       JOIN items i ON i.id=b.output_item_id
       JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN locations l ON l.id=t.location_id
      WHERE t.transaction_type='PRODUCTION' AND t.company_id=$1
        AND (EXISTS(SELECT 1 FROM users us WHERE us.id=$2 AND us.is_system_admin AND us.status='ACTIVE')
          OR EXISTS(SELECT 1 FROM workspace_memberships wm WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
            AND (wm.company_id IS NULL OR wm.company_id=t.company_id) AND (wm.location_id IS NULL OR wm.location_id=t.location_id)))
      ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 100`,
    [companyId, req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientBomProductionRouter.post('/productions', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const locationId = text(req.body?.locationId);
  const bomId = text(req.body?.bomId);
  const transactionDate = text(req.body?.transactionDate);
  const notes = nullable(req.body?.notes);
  const batchCount = num(req.body?.batchCount);
  const actualOutput = num(req.body?.actualOutput);

  if (!companyId || !locationId || !bomId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || !Number.isFinite(batchCount) || batchCount <= 0 || !Number.isFinite(actualOutput) || actualOutput <= 0) {
    return res.status(400).json({ error: 'PRODUCTION_REQUIRED_FIELDS' });
  }
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  if (!(await canAccessLocation(req.sessionUser!.id, locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });

  const company = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,
    [companyId],
  );
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const location = await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [locationId, companyId]);
  if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bom = await client.query<{ id: string; output_item_id: string; output_quantity: string; output_unit_id: string; base_unit_id: string; output_item_name: string }>(
      `SELECT b.id,b.output_item_id,b.output_quantity::text,b.output_unit_id,i.base_unit_id,i.name output_item_name
         FROM bom_headers b JOIN items i ON i.id=b.output_item_id
        WHERE b.id=$1 AND b.company_id=$2 AND b.bom_type='PRODUCTION' AND b.status='ACTIVE' FOR SHARE`,
      [bomId, companyId],
    );
    if (!bom.rowCount) throw new Error('ACTIVE_PRODUCTION_BOM_REQUIRED');

    const bomLines = await client.query<{ id: string; component_item_id: string; quantity: string; unit_id: string; waste_percent: string; base_unit_id: string; component_name: string }>(
      `SELECT bl.id,bl.component_item_id,bl.quantity::text,bl.unit_id,bl.waste_percent::text,i.base_unit_id,i.name component_name
         FROM bom_lines bl JOIN items i ON i.id=bl.component_item_id
        WHERE bl.bom_id=$1 ORDER BY bl.line_no`,
      [bomId],
    );
    if (!bomLines.rowCount) throw new Error('PRODUCTION_BOM_LINES_REQUIRED');

    const outputStandardEntered = new Decimal(bom.rows[0].output_quantity).mul(batchCount);
    const standardBase = await toBaseQuantity(client, company.rows[0].workspace_id, bom.rows[0].output_item_id, bom.rows[0].output_unit_id, bom.rows[0].base_unit_id, outputStandardEntered);
    const actualBase = await toBaseQuantity(client, company.rows[0].workspace_id, bom.rows[0].output_item_id, bom.rows[0].output_unit_id, bom.rows[0].base_unit_id, new Decimal(actualOutput));
    const yieldPct = productionYield(actualBase, standardBase);
    const transactionNumber = await nextProductionNumber(client, companyId, transactionDate);

    const header = await client.query<{ id: string; transaction_number: string; workflow_status: string; accounting_status: string }>(
      `INSERT INTO transaction_headers(workspace_id,company_id,location_id,transaction_type,transaction_number,transaction_date,notes,payment_status,gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,'PRODUCTION',$4,$5,$6,'N/A',0,0,0,0,$7,$7)
       RETURNING id,transaction_number,workflow_status,accounting_status`,
      [company.rows[0].workspace_id, companyId, locationId, transactionNumber, transactionDate, notes, req.sessionUser!.id],
    );

    await client.query(
      `INSERT INTO transaction_lines(transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,metadata)
       VALUES($1,1,'ITEM',$2,$3,$4,$5,0,0,0,0,0,$6,$7::jsonb)`,
      [header.rows[0].id, bom.rows[0].output_item_id, `Hasil produksi ${bom.rows[0].output_item_name}`, actualOutput, bom.rows[0].output_unit_id, locationId, JSON.stringify({ productionRole: 'OUTPUT', baseQuantity: actualBase.toFixed(6), bomId, batchCount, standardOutputBase: standardBase.toFixed(6), yieldPercent: yieldPct.toFixed(6) })],
    );

    for (let index = 0; index < bomLines.rows.length; index += 1) {
      const line = bomLines.rows[index];
      const required = productionRequirement(line.quantity, line.waste_percent, batchCount);
      const base = await toBaseQuantity(client, company.rows[0].workspace_id, line.component_item_id, line.unit_id, line.base_unit_id, required);
      await client.query(
        `INSERT INTO transaction_lines(transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,metadata)
         VALUES($1,$2,'ITEM',$3,$4,$5,$6,0,0,0,0,0,$7,$8::jsonb)`,
        [header.rows[0].id, index + 2, line.component_item_id, `Bahan produksi ${line.component_name}`, required.toFixed(6), line.unit_id, locationId, JSON.stringify({ productionRole: 'INPUT', baseQuantity: base.toFixed(6), bomId, bomLineId: line.id, batchCount, quantityPerBatch: line.quantity, wastePercent: line.waste_percent })],
      );
    }

    await client.query(
      `INSERT INTO production_details(transaction_id,bom_id,batch_count,standard_output,actual_output,yield_percent)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [header.rows[0].id, bomId, batchCount, standardBase.toFixed(6), actualBase.toFixed(6), yieldPct.toFixed(6)],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_PRODUCTION',$4::jsonb)`,
      [company.rows[0].workspace_id, req.sessionUser!.id, header.rows[0].id, JSON.stringify({ transactionNumber, bomId, batchCount, standardOutput: standardBase.toFixed(6), actualOutput: actualBase.toFixed(6), yieldPercent: yieldPct.toFixed(6), lineCount: bomLines.rows.length + 1 })],
    );
    await client.query('COMMIT');
    res.status(201).json({ ...header.rows[0], standardOutput: standardBase.toFixed(6), actualOutput: actualBase.toFixed(6), yieldPercent: yieldPct.toFixed(6) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create production failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_PRODUCTION_FAILED' });
  } finally {
    client.release();
  }
});

clientBomProductionRouter.get('/productions/:transactionId/preview', async (req, res) => {
  const id = text(req.params.transactionId);
  const tx = await query<{ company_id: string; location_id: string | null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='PRODUCTION'`,
    [id],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'PRODUCTION_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!tx.rows[0].location_id || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try {
    res.json(await previewProduction(id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'PREVIEW_PRODUCTION_FAILED' });
  }
});

clientBomProductionRouter.post('/productions/:transactionId/verify', async (req, res) => {
  const id = text(req.params.transactionId);
  const allowBelowZero = Boolean(req.body?.allowBelowZero);
  const tx = await query<{ company_id: string; location_id: string | null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='PRODUCTION'`,
    [id],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'PRODUCTION_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!tx.rows[0].location_id || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  if (allowBelowZero && !(await canOverride(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'INVENTORY_OVERRIDE_MANAGER_REQUIRED' });
  try {
    res.json({ ok: true, ...(await verifyProduction(id, req.sessionUser!.id, allowBelowZero)) });
  } catch (error) {
    console.error('Verify production failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'VERIFY_PRODUCTION_FAILED' });
  }
});

clientBomProductionRouter.get('/inventory-control', async (req, res) => {
  const companyId = text(req.query.companyId);
  const locationId = text(req.query.locationId);
  if (!companyId || !locationId) return res.status(400).json({ error: 'COMPANY_LOCATION_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId)) || !(await canAccessLocation(req.sessionUser!.id, locationId))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const result = await query(
    `SELECT i.id item_id,i.code,i.name,c.name category_name,u.code unit_code,
            COALESCE(ib.quantity_on_hand,0)::text quantity_on_hand,COALESCE(ib.average_cost,0)::text average_cost,
            (COALESCE(ib.quantity_on_hand,0)*COALESCE(ib.average_cost,0))::text stock_value,
            (SELECT im.movement_type FROM inventory_movements im
              WHERE im.company_id=co.id AND im.location_id=$2 AND im.item_id=i.id
              ORDER BY im.created_at DESC,im.id DESC LIMIT 1) last_movement_type,
            (SELECT im.created_at FROM inventory_movements im
              WHERE im.company_id=co.id AND im.location_id=$2 AND im.item_id=i.id
              ORDER BY im.created_at DESC,im.id DESC LIMIT 1) last_movement_at,
            CASE WHEN COALESCE(ib.quantity_on_hand,0)<0 THEN 'STOK MINUS'
                 WHEN COALESCE(ib.quantity_on_hand,0)=0 THEN 'HABIS' ELSE 'OK' END status
       FROM companies co
       JOIN items i ON i.workspace_id=co.workspace_id AND i.status='ACTIVE' AND i.track_stock
       JOIN item_categories c ON c.id=i.category_id
       JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN inventory_balances ib ON ib.company_id=co.id AND ib.location_id=$2 AND ib.item_id=i.id
      WHERE co.id=$1 ORDER BY c.name,i.name`,
    [companyId, locationId],
  );
  res.json(result.rows);
});

clientBomProductionRouter.get('/stock-card', async (req, res) => {
  const companyId = text(req.query.companyId);
  const locationId = text(req.query.locationId);
  const itemId = text(req.query.itemId);
  const from = text(req.query.from);
  const to = text(req.query.to);
  if (!companyId || !locationId || !itemId) return res.status(400).json({ error: 'COMPANY_LOCATION_ITEM_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId)) || !(await canAccessLocation(req.sessionUser!.id, locationId))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  let openingQuantity = new Decimal(0);
  if (from) {
    const opening = await query<{ opening_quantity: string }>(
      `SELECT COALESCE(SUM(CASE
          WHEN im.movement_type IN ('PURCHASE_IN','TRANSFER_IN','ADJUSTMENT_IN','PRODUCTION_IN') THEN im.quantity
          ELSE -im.quantity END),0)::text opening_quantity
         FROM inventory_movements im
         JOIN transaction_headers t ON t.id=im.source_transaction_id
        WHERE im.company_id=$1 AND im.location_id=$2 AND im.item_id=$3
          AND t.transaction_date<$4::date`,
      [companyId, locationId, itemId, from],
    );
    openingQuantity = new Decimal(opening.rows[0]?.opening_quantity || 0);
  }

  const result = await query(
    `SELECT im.id,im.movement_type,im.quantity::text,im.unit_cost::text,im.movement_value::text,
            im.quantity_after::text,im.average_cost_after::text,im.created_at,
            t.transaction_number,t.transaction_date::text,t.transaction_type,t.reference_number
       FROM inventory_movements im
       JOIN transaction_headers t ON t.id=im.source_transaction_id
      WHERE im.company_id=$1 AND im.location_id=$2 AND im.item_id=$3
        AND ($4='' OR t.transaction_date>=$4::date)
        AND ($5='' OR t.transaction_date<=$5::date)
      ORDER BY t.transaction_date,im.created_at,im.id`,
    [companyId, locationId, itemId, from, to],
  );

  const inbound = new Set(['PURCHASE_IN', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'PRODUCTION_IN']);
  let running = openingQuantity;
  const rows = (result.rows as Array<Record<string, unknown> & { movement_type: string; quantity: string }>).map(row => {
    const movementQuantity = new Decimal(row.quantity);
    const signed = inbound.has(row.movement_type) ? movementQuantity : movementQuantity.neg();
    running = running.add(signed);
    return { ...row, direction: inbound.has(row.movement_type) ? 'IN' : 'OUT', signed_quantity: signed.toFixed(6), quantity_after: running.toFixed(6) };
  });

  res.json({ openingQuantity: openingQuantity.toFixed(6), rows });
});
