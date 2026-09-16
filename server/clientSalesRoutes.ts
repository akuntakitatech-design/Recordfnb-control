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
  const result = await query(
    `SELECT b.id,b.company_id,b.location_id,b.batch_number,b.source_type,b.source_name,b.status,b.row_count,b.invoice_count,
            b.total_sales::text,b.total_payments::text,b.created_at,b.verified_at,l.name location_name
       FROM sales_import_batches b
       JOIN locations l ON l.id=b.location_id
      WHERE ($1='' OR b.company_id=$1::uuid)
        AND (
          EXISTS(SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS(
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=b.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=b.company_id)
               AND (wm.location_id IS NULL OR wm.location_id=b.location_id)
          )
        )
      ORDER BY b.created_at DESC
      LIMIT 100`,
    [companyId,req.sessionUser!.id],
  );
  res.json(result.rows);
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const firstDate = text(rawRows[0]?.saleDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate)) throw new Error('VALID_SALE_DATE_REQUIRED');
    const batchNumber = await nextBatchNumber(client,companyId,firstDate);
    const batch = await client.query<{ id:string }>(
      `INSERT INTO sales_import_batches(workspace_id,company_id,location_id,batch_number,source_type,source_name,row_count,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [company.rows[0].workspace_id,companyId,locationId,batchNumber,sourceType,sourceName,rawRows.length,req.sessionUser!.id],
    );

    for (let index=0; index<rawRows.length; index+=1) {
      const row = rawRows[index];
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

      let itemId = text(row.itemId) || null;
      if (itemId) {
        const valid = await client.query('SELECT id FROM items WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\'', [itemId,company.rows[0].workspace_id]);
        if (!valid.rowCount) throw new Error(`ITEM_OUTSIDE_WORKSPACE_ROW_${index + 1}`);
      } else {
        const matched = await client.query<{ id:string }>(
          `SELECT id FROM items
            WHERE workspace_id=$1 AND status='ACTIVE' AND can_sell
              AND (($2<>'' AND UPPER(code)=$2) OR LOWER(name)=LOWER($3))
            ORDER BY CASE WHEN $2<>'' AND UPPER(code)=$2 THEN 0 ELSE 1 END
            LIMIT 1`,
          [company.rows[0].workspace_id,itemCode,itemName],
        );
        itemId = matched.rows[0]?.id || null;
      }

      const payments = [row.cash,row.qris,row.transfer,row.compliment,row.gofood,row.grabfood].map(num);
      if (payments.some(value => !Number.isFinite(value) || value < 0)) throw new Error(`INVALID_PAYMENT_ROW_${index + 1}`);

      await client.query(
        `INSERT INTO sales_import_rows(
           batch_id,row_no,sale_date,invoice_number,cashier,sale_type,item_code,item_name,item_id,quantity,unit_price,
           discount_amount,line_total,payment_cash,payment_qris,payment_transfer,payment_compliment,payment_gofood,payment_grabfood,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
        [batch.rows[0].id,index+1,saleDate,invoiceNumber,nullable(row.cashier),nullable(row.saleType),itemCode || null,itemName,itemId,
         quantity,unitPrice,discountAmount,lineTotal,...payments,JSON.stringify({ sourceRow:index+1 })],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'SALES_IMPORT_BATCH',$3,'CLIENT_CREATE_SALES_BATCH',$4::jsonb)`,
      [company.rows[0].workspace_id,req.sessionUser!.id,batch.rows[0].id,JSON.stringify({ batchNumber, sourceType, sourceName, rowCount:rawRows.length })],
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
