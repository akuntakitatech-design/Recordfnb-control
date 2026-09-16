import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { previewSalesBatch, verifySalesBatch } from './salesImportEngine.js';

export const clientSalesRouter = Router();
clientSalesRouter.use(requireAuth);

const text = (value: unknown) => String(value ?? '').trim();
const upper = (value: unknown) => text(value).toUpperCase();
const nullable = (value: unknown) => text(value) || null;
const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : NaN;
};

async function canOverride(userId: string, companyId: string) {
  const result = await query(
    `SELECT 1 FROM users u WHERE u.id=$1 AND u.status='ACTIVE' AND u.is_system_admin
     UNION ALL
     SELECT 1
       FROM companies c
       JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id
       JOIN roles r ON r.id=wm.role_id
      WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=c.id)
        AND r.code=ANY($3::text[])
     LIMIT 1`,
    [userId,companyId,['AK_SUPER_ADMIN','AK_ACCOUNTING_REVIEWER','AK_ACCOUNTING_STAFF','CLIENT_FINANCE_MANAGER']],
  );
  return Boolean(result.rowCount);
}

async function nextBatchNumber(client: any, companyId: string, date: string) {
  const year = Number(date.slice(0,4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'SALES_IMPORT_BATCH',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId,year],
  );
  return `POS-${year}-${String(result.rows[0].last_number).padStart(5,'0')}`;
}

clientSalesRouter.get('/sales-context', async (req,res) => {
  const companyId = text(req.query.companyId);
  const locationId = text(req.query.locationId);
  if (!companyId || !locationId) return res.status(400).json({ error:'COMPANY_LOCATION_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  if (!(await canAccessLocation(req.sessionUser!.id,locationId))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });
  const location = await query('SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status=\'ACTIVE\'', [locationId,companyId]);
  if (!location.rowCount) return res.status(400).json({ error:'LOCATION_OUTSIDE_COMPANY' });

  const company = await query<{ workspace_id:string }>('SELECT workspace_id FROM companies WHERE id=$1 AND status=\'ACTIVE\'', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error:'COMPANY_NOT_FOUND' });
  const [items,mappings] = await Promise.all([
    query(
      `SELECT i.id,i.code,i.name,i.base_unit_id,u.code unit_code,i.track_stock,i.can_sell,c.name category_name
         FROM items i
         JOIN units u ON u.id=i.base_unit_id
         JOIN item_categories c ON c.id=i.category_id
        WHERE i.workspace_id=$1 AND i.status='ACTIVE' AND i.can_sell
        ORDER BY c.name,i.name`,
      [company.rows[0].workspace_id],
    ),
    query(
      `SELECT payment_code,label FROM sales_payment_mappings WHERE company_id=$1 ORDER BY payment_code`,
      [companyId],
    ),
  ]);
  res.json({ items:items.rows, paymentMappings:mappings.rows, expectedPaymentMappings:6 });
});

clientSalesRouter.get('/sales-batches', async (req,res) => {
  const companyId = text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  const requestedPage = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 25)));
  const offset = (requestedPage - 1) * pageSize;

  const accessSql = `(
    EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
    OR EXISTS(
      SELECT 1 FROM workspace_memberships wm
       WHERE wm.user_id=$2 AND wm.workspace_id=b.workspace_id AND wm.status='ACTIVE'
         AND (wm.company_id IS NULL OR wm.company_id=b.company_id)
         AND (wm.location_id IS NULL OR wm.location_id=b.location_id)
    )
  )`;
  const [rows,total] = await Promise.all([
    query(
      `SELECT b.id,b.company_id,b.location_id,b.batch_number,b.source_type,b.source_name,b.status,b.row_count,b.invoice_count,
              b.total_sales::text,b.total_payments::text,b.created_at,b.verified_at,l.name location_name
         FROM sales_import_batches b
         JOIN locations l ON l.id=b.location_id
        WHERE ($1='' OR b.company_id=$1::uuid)
          AND ${accessSql}
        ORDER BY b.created_at DESC
        LIMIT $3 OFFSET $4`,
      [companyId,req.sessionUser!.id,pageSize,offset],
    ),
    query<{ count:number }>(
      `SELECT COUNT(*)::int count
         FROM sales_import_batches b
        WHERE ($1='' OR b.company_id=$1::uuid)
          AND ${accessSql}`,
      [companyId,req.sessionUser!.id],
    ),
  ]);
  const count = total.rows[0]?.count || 0;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(requestedPage,pages);
  res.json({ rows:rows.rows, total:count, page, pageSize, pages });
});

clientSalesRouter.post('/sales-batches', async (req,res) => {
  const companyId = text(req.body?.companyId);
  const locationId = text(req.body?.locationId);
  const sourceType = upper(req.body?.sourceType || 'PASTE');
  const sourceName = nullable(req.body?.sourceName);
  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!companyId || !locationId || !['MANUAL','PASTE','CSV'].includes(sourceType) || !rawRows.length) {
    return res.status(400).json({ error:'SALES_BATCH_REQUIRED_FIELDS' });
  }
  if (rawRows.length > 2000) return res.status(400).json({ error:'SALES_BATCH_MAX_2000_ROWS' });
  if (!(await canCreateTransaction(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN' });
  if (!(await canAccessLocation(req.sessionUser!.id,locationId))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });

  const company = await query<{ workspace_id:string }>('SELECT workspace_id FROM companies WHERE id=$1 AND status=\'ACTIVE\'', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error:'COMPANY_NOT_FOUND' });
  const location = await query('SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status=\'ACTIVE\'', [locationId,companyId]);
  if (!location.rowCount) return res.status(400).json({ error:'LOCATION_OUTSIDE_COMPANY' });

  const sellableItems = await query<{ id:string; code:string; name:string }>(
    `SELECT id,code,name FROM items WHERE workspace_id=$1 AND status='ACTIVE' AND can_sell`,
    [company.rows[0].workspace_id],
  );
  const itemById = new Map(sellableItems.rows.map(item => [item.id,item]));
  const itemByCode = new Map(sellableItems.rows.map(item => [item.code.toUpperCase(),item]));
  const itemByName = new Map(sellableItems.rows.map(item => [item.name.trim().toLowerCase(),item]));

  const normalizedRows = rawRows.map((row,index) => {
    const saleDate = text(row.saleDate);
    const invoiceNumber = text(row.invoiceNumber);
    const itemCode = upper(row.itemCode);
    const itemName = text(row.itemName);
    const quantity = num(row.quantity);
    const unitPrice = num(row.unitPrice);
    const discountAmount = num(row.discountAmount);
    const lineTotal = num(row.lineTotal);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate) || !invoiceNumber || !itemName || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(discountAmount) || discountAmount < 0 || !Number.isFinite(lineTotal) || lineTotal < 0) {
      throw new Error(`INVALID_SALES_ROW_${index + 1}`);
    }

    const requestedItemId = text(row.itemId);
    const matched = requestedItemId ? itemById.get(requestedItemId) : (itemByCode.get(itemCode) || itemByName.get(itemName.trim().toLowerCase()));
    if (requestedItemId && !matched) throw new Error(`ITEM_OUTSIDE_WORKSPACE_ROW_${index + 1}`);

    const payments = [row.cash,row.qris,row.transfer,row.compliment,row.gofood,row.grabfood].map(num);
    if (payments.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`INVALID_PAYMENT_ROW_${index + 1}`);

    return {
      row_no:index+1,
      sale_date:saleDate,
      invoice_number:invoiceNumber,
      cashier:nullable(row.cashier),
      sale_type:nullable(row.saleType),
      item_code:itemCode || null,
      item_name:itemName,
      item_id:matched?.id || null,
      quantity,
      unit_price:unitPrice,
      discount_amount:discountAmount,
      line_total:lineTotal,
      payment_cash:payments[0],
      payment_qris:payments[1],
      payment_transfer:payments[2],
      payment_compliment:payments[3],
      payment_gofood:payments[4],
      payment_grabfood:payments[5],
      metadata:{ sourceRow:index+1 },
    };
  });

  const firstDate = normalizedRows[0]?.sale_date;
  if (!firstDate) return res.status(400).json({ error:'VALID_SALE_DATE_REQUIRED' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchNumber = await nextBatchNumber(client,companyId,firstDate);
    const batch = await client.query<{ id:string }>(
      `INSERT INTO sales_import_batches(workspace_id,company_id,location_id,batch_number,source_type,source_name,row_count,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [company.rows[0].workspace_id,companyId,locationId,batchNumber,sourceType,sourceName,normalizedRows.length,req.sessionUser!.id],
    );

    await client.query(
      `INSERT INTO sales_import_rows(
         batch_id,row_no,sale_date,invoice_number,cashier,sale_type,item_code,item_name,item_id,quantity,unit_price,
         discount_amount,line_total,payment_cash,payment_qris,payment_transfer,payment_compliment,payment_gofood,payment_grabfood,metadata)
       SELECT $1::uuid,x.row_no,x.sale_date,x.invoice_number,x.cashier,x.sale_type,x.item_code,x.item_name,x.item_id,
              x.quantity,x.unit_price,x.discount_amount,x.line_total,x.payment_cash,x.payment_qris,x.payment_transfer,
              x.payment_compliment,x.payment_gofood,x.payment_grabfood,x.metadata
         FROM jsonb_to_recordset($2::jsonb) AS x(
           row_no integer,sale_date date,invoice_number text,cashier text,sale_type text,item_code text,item_name text,item_id uuid,
           quantity numeric,unit_price numeric,discount_amount numeric,line_total numeric,payment_cash numeric,payment_qris numeric,
           payment_transfer numeric,payment_compliment numeric,payment_gofood numeric,payment_grabfood numeric,metadata jsonb
         )`,
      [batch.rows[0].id,JSON.stringify(normalizedRows)],
    );

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'SALES_IMPORT_BATCH',$3,'CLIENT_CREATE_SALES_BATCH',$4::jsonb)`,
      [company.rows[0].workspace_id,req.sessionUser!.id,batch.rows[0].id,JSON.stringify({ batchNumber, sourceType, sourceName, rowCount:normalizedRows.length, insertMode:'BULK' })],
    );
    await client.query('COMMIT');
    res.status(201).json({ id:batch.rows[0].id,batchNumber });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create sales batch failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'CREATE_SALES_BATCH_FAILED' });
  } finally {
    client.release();
  }
});

clientSalesRouter.get('/sales-batches/:batchId/preview', async (req,res) => {
  const batchId = text(req.params.batchId);
  const batch = await query<{ company_id:string; location_id:string }>('SELECT company_id,location_id FROM sales_import_batches WHERE id=$1', [batchId]);
  if (!batch.rowCount) return res.status(404).json({ error:'SALES_BATCH_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id,batch.rows[0].company_id))) return res.status(403).json({ error:'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!(await canAccessLocation(req.sessionUser!.id,batch.rows[0].location_id))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });
  try { res.json(await previewSalesBatch(batchId)); }
  catch (error) { res.status(400).json({ error:error instanceof Error ? error.message : 'PREVIEW_SALES_BATCH_FAILED' }); }
});

clientSalesRouter.post('/sales-batches/:batchId/verify', async (req,res) => {
  const batchId = text(req.params.batchId);
  const allowBelowZero = Boolean(req.body?.allowBelowZero);
  const batch = await query<{ company_id:string; location_id:string }>('SELECT company_id,location_id FROM sales_import_batches WHERE id=$1', [batchId]);
  if (!batch.rowCount) return res.status(404).json({ error:'SALES_BATCH_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id,batch.rows[0].company_id))) return res.status(403).json({ error:'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (!(await canAccessLocation(req.sessionUser!.id,batch.rows[0].location_id))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });
  if (allowBelowZero && !(await canOverride(req.sessionUser!.id,batch.rows[0].company_id))) {
    return res.status(403).json({ error:'INVENTORY_OVERRIDE_MANAGER_REQUIRED' });
  }
  try { res.json({ ok:true, ...(await verifySalesBatch(batchId,req.sessionUser!.id,allowBelowZero)) }); }
  catch (error) {
    console.error('Verify sales batch failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'VERIFY_SALES_BATCH_FAILED' });
  }
});
