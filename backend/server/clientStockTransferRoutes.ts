import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { previewStockTransfer, verifyStockTransfer } from './stockTransferEngine.js';

export const clientStockTransferRouter = Router();
clientStockTransferRouter.use(requireAuth);

const text = (value: unknown) => String(value ?? '').trim();
const nullable = (value: unknown) => {
  const result = text(value);
  return result || null;
};

async function nextNumber(client: any, companyId: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'STOCK_TRANSFER',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, year],
  );
  return `TB-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

async function canOverride(userId: string, companyId: string) {
  const result = await query(
    `SELECT 1
       FROM users u
      WHERE u.id=$1 AND u.status='ACTIVE' AND u.is_system_admin
     UNION ALL
     SELECT 1
       FROM companies c
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

clientStockTransferRouter.get('/stock-transfer-items', async (req, res) => {
  const companyId = text(req.query.companyId);
  const fromLocationId = text(req.query.fromLocationId);
  const toLocationId = text(req.query.toLocationId);
  if (!companyId || !fromLocationId || !toLocationId) return res.status(400).json({ error: 'TRANSFER_LOCATIONS_REQUIRED' });
  if (fromLocationId === toLocationId) return res.status(400).json({ error: 'TRANSFER_LOCATIONS_MUST_DIFFER' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  if (!(await canAccessLocation(req.sessionUser!.id, fromLocationId)) || !(await canAccessLocation(req.sessionUser!.id, toLocationId))) {
    return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }

  const locations = await query(
    `SELECT id FROM locations WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
    [companyId, [fromLocationId, toLocationId]],
  );
  if (locations.rowCount !== 2) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });

  const result = await query(
    `SELECT i.id item_id,i.code,i.name,i.category_id,c.name category_name,
            i.base_unit_id,u.code base_unit_code,u.name base_unit_name,
            COALESCE(src.quantity_on_hand,0)::text source_quantity,
            COALESCE(dst.quantity_on_hand,0)::text destination_quantity,
            (COALESCE(io.inventory_account_id,cm.inventory_account_id) IS NOT NULL) setup_ready
       FROM companies co
       JOIN items i ON i.workspace_id=co.workspace_id AND i.status='ACTIVE' AND i.track_stock
       LEFT JOIN item_categories c ON c.id=i.category_id
       LEFT JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN inventory_balances src ON src.company_id=co.id AND src.location_id=$2 AND src.item_id=i.id
       LEFT JOIN inventory_balances dst ON dst.company_id=co.id AND dst.location_id=$3 AND dst.item_id=i.id
       LEFT JOIN item_account_overrides io ON io.company_id=co.id AND io.item_id=i.id
       LEFT JOIN item_category_account_mappings cm ON cm.company_id=co.id AND cm.category_id=i.category_id
      WHERE co.id=$1
      ORDER BY c.name,i.name`,
    [companyId, fromLocationId, toLocationId],
  );
  res.json(result.rows);
});

clientStockTransferRouter.get('/stock-transfers', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id, companyId))) {
    return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  }

  const result = await query(
    `SELECT t.id,t.company_id,t.location_id,t.transfer_to_location_id,t.transaction_number,
            t.transaction_date,t.notes,t.grand_total::text,t.workflow_status,t.accounting_status,
            t.negative_stock_override,src.name source_location_name,dst.name destination_location_name,
            COUNT(tl.id)::int line_count
       FROM transaction_headers t
       LEFT JOIN locations src ON src.id=t.location_id
       LEFT JOIN locations dst ON dst.id=t.transfer_to_location_id
       LEFT JOIN transaction_lines tl ON tl.transaction_id=t.id
      WHERE t.transaction_type='STOCK_TRANSFER'
        AND ($1='' OR t.company_id=$1::uuid)
        AND (
          EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS(
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=t.company_id)
               AND (wm.location_id IS NULL OR (wm.location_id=t.location_id AND wm.location_id=t.transfer_to_location_id))
          )
        )
      GROUP BY t.id,src.name,dst.name
      ORDER BY t.transaction_date DESC,t.created_at DESC
      LIMIT 100`,
    [companyId, req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientStockTransferRouter.post('/stock-transfers', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const fromLocationId = text(req.body?.fromLocationId);
  const toLocationId = text(req.body?.toLocationId);
  const transactionDate = text(req.body?.transactionDate);
  const notes = nullable(req.body?.notes);
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!companyId || !fromLocationId || !toLocationId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || !rawLines.length) {
    return res.status(400).json({ error: 'STOCK_TRANSFER_REQUIRED_FIELDS' });
  }
  if (fromLocationId === toLocationId) return res.status(400).json({ error: 'TRANSFER_LOCATIONS_MUST_DIFFER' });
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  if (!(await canAccessLocation(req.sessionUser!.id, fromLocationId)) || !(await canAccessLocation(req.sessionUser!.id, toLocationId))) {
    return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }

  const company = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,
    [companyId],
  );
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });

  const locations = await query(
    `SELECT id FROM locations WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE'`,
    [companyId, [fromLocationId, toLocationId]],
  );
  if (locations.rowCount !== 2) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber = await nextNumber(client, companyId, transactionDate);
    const header = await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,transfer_to_location_id,transaction_type,
         transaction_number,transaction_date,notes,payment_status,gross_amount,dpp_amount,
         tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,'STOCK_TRANSFER',$5,$6,$7,'N/A',0,0,0,0,$8,$8)
       RETURNING id,transaction_number,transaction_date,workflow_status,accounting_status`,
      [company.rows[0].workspace_id, companyId, fromLocationId, toLocationId,
       transactionNumber, transactionDate, notes, req.sessionUser!.id],
    );
    const transactionId = header.rows[0].id;

    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const itemId = text(line.itemId);
      const unitId = text(line.unitId);
      const description = nullable(line.description);
      const quantity = Number(line.quantity);
      if (!itemId || !unitId || !Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`INVALID_STOCK_TRANSFER_LINE_${index + 1}`);
      }

      const item = await client.query<{ base_unit_id: string }>(
        `SELECT base_unit_id
           FROM items
          WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE' AND track_stock`,
        [itemId, company.rows[0].workspace_id],
      );
      if (!item.rowCount) throw new Error(`INVALID_ITEM_LINE_${index + 1}`);

      if (unitId !== item.rows[0].base_unit_id) {
        const conversion = await client.query(
          `SELECT 1
             FROM unit_conversions
            WHERE workspace_id=$1 AND from_unit_id=$2 AND to_unit_id=$3
              AND (item_id=$4 OR item_id IS NULL)
            LIMIT 1`,
          [company.rows[0].workspace_id, unitId, item.rows[0].base_unit_id, itemId],
        );
        if (!conversion.rowCount) throw new Error(`INVALID_UNIT_LINE_${index + 1}`);
      }

      await client.query(
        `INSERT INTO transaction_lines(
           transaction_id,line_no,line_type,item_id,description,quantity,unit_id,
           unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id)
         VALUES($1,$2,'ITEM',$3,$4,$5,$6,0,0,0,0,0,$7)`,
        [transactionId, index + 1, itemId, description, quantity, unitId, fromLocationId],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_STOCK_TRANSFER',$4::jsonb)`,
      [company.rows[0].workspace_id, req.sessionUser!.id, transactionId,
       JSON.stringify({ transactionNumber, fromLocationId, toLocationId, lineCount: rawLines.length })],
    );

    await client.query('COMMIT');
    res.status(201).json(header.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create stock transfer failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_STOCK_TRANSFER_FAILED' });
  } finally {
    client.release();
  }
});

clientStockTransferRouter.get('/stock-transfers/:transactionId/preview', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await query<{ company_id: string; location_id: string | null; transfer_to_location_id: string | null }>(
    `SELECT company_id,location_id,transfer_to_location_id
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='STOCK_TRANSFER'`,
    [transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'STOCK_TRANSFER_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) {
    return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  }
  if (!tx.rows[0].location_id || !tx.rows[0].transfer_to_location_id) return res.status(400).json({ error: 'TRANSFER_LOCATIONS_REQUIRED' });
  if (!(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id)) || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].transfer_to_location_id))) {
    return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }

  try {
    res.json(await previewStockTransfer(transactionId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'PREVIEW_STOCK_TRANSFER_FAILED' });
  }
});

clientStockTransferRouter.post('/stock-transfers/:transactionId/verify', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const allowBelowZero = Boolean(req.body?.allowBelowZero);
  const tx = await query<{ company_id: string; location_id: string | null; transfer_to_location_id: string | null }>(
    `SELECT company_id,location_id,transfer_to_location_id
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='STOCK_TRANSFER'`,
    [transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'STOCK_TRANSFER_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) {
    return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  }
  if (!tx.rows[0].location_id || !tx.rows[0].transfer_to_location_id) return res.status(400).json({ error: 'TRANSFER_LOCATIONS_REQUIRED' });
  if (!(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id)) || !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].transfer_to_location_id))) {
    return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }
  if (allowBelowZero && !(await canOverride(req.sessionUser!.id, tx.rows[0].company_id))) {
    return res.status(403).json({ error: 'INVENTORY_OVERRIDE_MANAGER_REQUIRED' });
  }

  try {
    const result = await verifyStockTransfer(transactionId, req.sessionUser!.id, allowBelowZero);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Verify stock transfer failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'VERIFY_STOCK_TRANSFER_FAILED' });
  }
});
