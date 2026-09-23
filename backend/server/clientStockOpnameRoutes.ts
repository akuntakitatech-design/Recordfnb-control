import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { previewStockOpname, verifyStockOpname } from './stockOpnameEngine.js';
import { clientSalesRouter } from './clientSalesRoutes.js';

export const clientStockOpnameRouter = Router();
clientStockOpnameRouter.use(requireAuth);

const text = (value: unknown) => String(value ?? '').trim();
const nullable = (value: unknown) => { const valueText = text(value); return valueText || null; };

async function nextNumber(client: any, companyId: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'STOCK_OPNAME',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, year],
  );
  return `SO-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

clientStockOpnameRouter.get('/stock-opname-items', async (req, res) => {
  const companyId = text(req.query.companyId);
  const locationId = text(req.query.locationId);
  if (!companyId || !locationId) return res.status(400).json({ error: 'COMPANY_LOCATION_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId)) || !(await canAccessLocation(req.sessionUser!.id, locationId))) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const location = await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [locationId, companyId]);
  if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });

  const result = await query(
    `SELECT i.id item_id,i.code,i.name,i.category_id,c.name category_name,
            i.base_unit_id,u.code base_unit_code,u.name base_unit_name,
            COALESCE(ib.quantity_on_hand,0)::text quantity_on_hand,
            COALESCE(ib.average_cost,0)::text average_cost,
            (COALESCE(io.inventory_account_id,cm.inventory_account_id) IS NOT NULL
             AND COALESCE(io.stock_adjustment_account_id,cm.stock_adjustment_account_id) IS NOT NULL) setup_ready
       FROM companies co
       JOIN items i ON i.workspace_id=co.workspace_id AND i.status='ACTIVE' AND i.track_stock
       LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN inventory_balances ib ON ib.company_id=co.id AND ib.location_id=$2 AND ib.item_id=i.id
       LEFT JOIN item_account_overrides io ON io.company_id=co.id AND io.item_id=i.id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=co.id AND cm.category_id=i.category_id
      WHERE co.id=$1
      ORDER BY c.name,i.name`,
    [companyId, locationId],
  );
  res.json(result.rows);
});

clientStockOpnameRouter.get('/stock-opnames', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id, companyId))) {
    return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  }
  const result = await query(
    `SELECT t.id,t.company_id,t.location_id,t.transaction_number,t.transaction_date,t.notes,
            t.grand_total::text,t.workflow_status,t.accounting_status,l.name location_name,
            COUNT(tl.id)::int line_count,
            CAST(SUM(CASE WHEN COALESCE(CAST(JSON_VALUE(tl.metadata,'$.differenceBase') AS DECIMAL(20,6)),0) <> 0 THEN 1 ELSE 0 END) AS SIGNED) adjusted_line_count
       FROM transaction_headers t
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN transaction_lines tl ON tl.transaction_id=t.id
      WHERE t.transaction_type='STOCK_OPNAME'
        AND ($1='' OR t.company_id=$1::uuid)
        AND (
          EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS(
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=t.company_id)
               AND (wm.location_id IS NULL OR wm.location_id=t.location_id)
          )
        )
      GROUP BY t.id,l.name
      ORDER BY t.transaction_date DESC,t.created_at DESC
      LIMIT 100`,
    [companyId, req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientStockOpnameRouter.post('/stock-opnames', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const locationId = text(req.body?.locationId);
  const transactionDate = text(req.body?.transactionDate);
  const notes = nullable(req.body?.notes);
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!companyId || !locationId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || !rawLines.length) {
    return res.status(400).json({ error: 'STOCK_OPNAME_REQUIRED_FIELDS' });
  }
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  if (!(await canAccessLocation(req.sessionUser!.id, locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });

  const company = await query<{ workspace_id: string }>(`SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`, [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const location = await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [locationId, companyId]);
  if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber = await nextNumber(client, companyId, transactionDate);
    const header = await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,transaction_type,transaction_number,transaction_date,
         notes,payment_status,gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,'STOCK_OPNAME',$4,$5,$6,'N/A',0,0,0,0,$7,$7)
       RETURNING id,transaction_number,transaction_date,workflow_status,accounting_status`,
      [company.rows[0].workspace_id, companyId, locationId, transactionNumber, transactionDate, notes, req.sessionUser!.id],
    );
    const transactionId = header.rows[0].id;
    const usedItems = new Set<string>();

    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const itemId = text(line.itemId);
      const unitId = text(line.unitId);
      const description = nullable(line.description);
      const physicalQuantity = Number(line.physicalQuantity);
      if (!itemId || !unitId || !Number.isFinite(physicalQuantity) || physicalQuantity < 0) {
        throw new Error(`INVALID_STOCK_OPNAME_LINE_${index + 1}`);
      }
      if (usedItems.has(itemId)) throw new Error(`DUPLICATE_ITEM_LINE_${index + 1}`);
      usedItems.add(itemId);

      const item = await client.query<{ base_unit_id: string }>(
        `SELECT base_unit_id FROM items
          WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE' AND track_stock`,
        [itemId, company.rows[0].workspace_id],
      );
      if (!item.rowCount) throw new Error(`INVALID_ITEM_LINE_${index + 1}`);
      if (unitId !== item.rows[0].base_unit_id) {
        const conversion = await client.query(
          `SELECT 1 FROM unit_conversions
            WHERE workspace_id=$1 AND from_unit_id=$2 AND to_unit_id=$3
              AND (item_id=$4 OR item_id IS NULL) LIMIT 1`,
          [company.rows[0].workspace_id, unitId, item.rows[0].base_unit_id, itemId],
        );
        if (!conversion.rowCount) throw new Error(`INVALID_UNIT_LINE_${index + 1}`);
      }

      const balance = await client.query<{ quantity_on_hand: string }>(
        `SELECT quantity_on_hand::text FROM inventory_balances
          WHERE company_id=$1 AND location_id=$2 AND item_id=$3`,
        [companyId, locationId, itemId],
      );
      const snapshot = balance.rows[0]?.quantity_on_hand || '0';
      await client.query(
        `INSERT INTO transaction_lines(
           transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,
           gross_amount,dpp_amount,tax_amount,line_total,location_id,metadata)
         VALUES($1,$2,'ITEM',$3,$4,$5,$6,0,0,0,0,0,$7,$8::jsonb)`,
        [transactionId, index + 1, itemId, description, physicalQuantity, unitId, locationId,
         JSON.stringify({ systemQuantitySnapshot: snapshot })],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_STOCK_OPNAME',$4::jsonb)`,
      [company.rows[0].workspace_id, req.sessionUser!.id, transactionId,
       JSON.stringify({ transactionNumber, locationId, lineCount: rawLines.length })],
    );
    await client.query('COMMIT');
    res.status(201).json(header.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create stock opname failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_STOCK_OPNAME_FAILED' });
  } finally {
    client.release();
  }
});

clientStockOpnameRouter.get('/stock-opnames/:transactionId/preview', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await query<{ company_id: string; location_id: string | null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='STOCK_OPNAME'`,
    [transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'STOCK_OPNAME_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!tx.rows[0].location_id || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try { res.json(await previewStockOpname(transactionId)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'PREVIEW_STOCK_OPNAME_FAILED' }); }
});

clientStockOpnameRouter.post('/stock-opnames/:transactionId/verify', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await query<{ company_id: string; location_id: string | null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='STOCK_OPNAME'`,
    [transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'STOCK_OPNAME_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!tx.rows[0].location_id || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try {
    const preview = await previewStockOpname(transactionId);
    if (preview.stale.length) return res.status(409).json({ error: 'STOCK_OPNAME_BALANCE_CHANGED', stale: preview.stale });
    const result = await verifyStockOpname(transactionId, req.sessionUser!.id);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Verify stock opname failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'VERIFY_STOCK_OPNAME_FAILED' });
  }
});

clientStockOpnameRouter.use(clientSalesRouter);
