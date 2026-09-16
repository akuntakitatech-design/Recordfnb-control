import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, hasUnrestrictedLocationAccess } from './access.js';
import { calculateDocument, type DocumentDiscount, type TransactionLineInput } from '../shared/transactionMath.js';

export const clientTransactionRouter = Router();
clientTransactionRouter.use(requireAuth);

const uploadRoot = process.env.UPLOAD_DIR || '/data/uploads';
const allowedMimeTypes = new Set(['application/pdf','image/jpeg','image/png','image/webp']);
const maxAttachmentBytes = 5 * 1024 * 1024;

function text(value: unknown) { return String(value ?? '').trim(); }
function nullable(value: unknown) { const v = text(value); return v || null; }
function upper(value: unknown) { return text(value).toUpperCase(); }

async function nextPurchaseNumber(client: any, companyId: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'PURCHASE_INVOICE',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, year],
  );
  return `PB-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

function addDays(dateText: string, days: number) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function requireTransactionAccess(userId: string, transactionId: string) {
  const result = await query<{ workspace_id: string; company_id: string; location_id: string | null }>(
    `SELECT workspace_id,company_id,location_id FROM transaction_headers WHERE id=$1`, [transactionId],
  );
  if (!result.rowCount) return null;
  const tx = result.rows[0];
  if (!(await canAccessCompany(userId, tx.company_id))) return null;
  if (tx.location_id && !(await canAccessLocation(userId, tx.location_id))) return null;
  return tx;
}

clientTransactionRouter.get('/purchase-invoices', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id, companyId))) {
    return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  }
  const result = await query(
    `SELECT t.id,t.company_id,t.location_id,t.transaction_number,t.transaction_date,t.reference_number,
            t.payment_type,t.payment_status,t.due_date,t.grand_total,t.workflow_status,t.accounting_status,
            bp.name supplier_name,l.name location_name,fa.name financial_account_name,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            t.created_at
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
      WHERE t.transaction_type='PURCHASE_INVOICE'
        AND ($1='' OR t.company_id=$1::uuid)
        AND (EXISTS (SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS (
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=t.company_id)
               AND (wm.location_id IS NULL OR wm.location_id=t.location_id)
          ))
      ORDER BY t.transaction_date DESC,t.created_at DESC
      LIMIT 100`,
    [companyId, req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientTransactionRouter.post('/purchase-invoices', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const locationId = text(req.body?.locationId);
  const partnerId = text(req.body?.partnerId);
  const transactionDate = text(req.body?.transactionDate);
  const referenceNumber = nullable(req.body?.referenceNumber);
  const paymentType = upper(req.body?.paymentType || 'CREDIT');
  const financialAccountId = nullable(req.body?.financialAccountId);
  const requestedDueDate = nullable(req.body?.dueDate);
  const notes = nullable(req.body?.notes);
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!companyId || !locationId || !partnerId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    return res.status(400).json({ error: 'PURCHASE_HEADER_REQUIRED' });
  }
  if (!['CASH','CREDIT'].includes(paymentType)) return res.status(400).json({ error: 'INVALID_PAYMENT_TYPE' });
  if (paymentType === 'CASH' && !financialAccountId) return res.status(400).json({ error: 'CASH_BANK_REQUIRED' });
  if (!rawLines.length) return res.status(400).json({ error: 'PURCHASE_LINES_REQUIRED' });
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });

  const company = await query<{ workspace_id: string }>(
    `SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`, [companyId],
  );
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const workspaceId = company.rows[0].workspace_id;

  const location = await query(
    `SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [locationId, companyId],
  );
  if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
  if (!(await canAccessLocation(req.sessionUser!.id, locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });

  const supplier = await query<{ payment_term_days: number }>(
    `SELECT payment_term_days FROM business_partners
      WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE' AND partner_type IN ('SUPPLIER','BOTH')`,
    [partnerId, workspaceId],
  );
  if (!supplier.rowCount) return res.status(400).json({ error: 'SUPPLIER_REQUIRED' });

  let dueDate: string | null = null;
  if (paymentType === 'CREDIT') {
    dueDate = requestedDueDate || addDays(transactionDate, Number(supplier.rows[0].payment_term_days || 0));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'INVALID_DUE_DATE' });
    if (dueDate < transactionDate) return res.status(400).json({ error: 'DUE_DATE_BEFORE_INVOICE_DATE' });
  }

  if (paymentType === 'CASH' && financialAccountId) {
    const fa = await query<{ location_id: string | null }>(
      `SELECT location_id FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,
      [financialAccountId, companyId],
    );
    if (!fa.rowCount) return res.status(400).json({ error: 'INVALID_FINANCIAL_ACCOUNT' });
    if (fa.rows[0].location_id && !(await canAccessLocation(req.sessionUser!.id, fa.rows[0].location_id!))) {
      return res.status(403).json({ error: 'FINANCIAL_ACCOUNT_FORBIDDEN' });
    }
  }

  if (referenceNumber) {
    const duplicate = await query(
      `SELECT id FROM transaction_headers
        WHERE company_id=$1 AND partner_id=$2 AND transaction_type='PURCHASE_INVOICE'
          AND reference_number=$3 AND workflow_status<>'CANCELLED'
        LIMIT 1`,
      [companyId, partnerId, referenceNumber],
    );
    if (duplicate.rowCount) return res.status(409).json({ error: 'SUPPLIER_INVOICE_REFERENCE_ALREADY_EXISTS' });
  }

  const itemIds = [...new Set(rawLines.map((line: any) => text(line.itemId)).filter(Boolean))] as string[];
  const items = await query<{ id: string; base_unit_id: string }>(
    `SELECT id,base_unit_id FROM items
      WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND status='ACTIVE' AND can_purchase=TRUE`,
    [itemIds, workspaceId],
  );
  const itemMap = new Map(items.rows.map(row => [row.id, row]));
  if (itemMap.size !== itemIds.length) return res.status(400).json({ error: 'INVALID_PURCHASE_ITEM' });

  const unitIds = [...new Set(rawLines.map((line: any) => nullable(line.unitId)).filter(Boolean))] as string[];
  if (unitIds.length) {
    const units = await query<{ id: string }>(
      `SELECT id FROM units WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND status='ACTIVE'`, [unitIds, workspaceId],
    );
    if (units.rowCount !== unitIds.length) return res.status(400).json({ error: 'INVALID_PURCHASE_UNIT' });
  }

  const taxIds = [...new Set(rawLines.map((line: any) => nullable(line.taxCodeId)).filter(Boolean))] as string[];
  const taxMap = new Map<string, { rate: string; default_inclusive: boolean }>();
  if (taxIds.length) {
    const taxes = await query<{ id: string; rate: string; default_inclusive: boolean }>(
      `SELECT id,rate::text,default_inclusive FROM tax_codes
        WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND status='ACTIVE'`,
      [taxIds, workspaceId],
    );
    taxes.rows.forEach(row => taxMap.set(row.id, row));
    if (taxMap.size !== taxIds.length) return res.status(400).json({ error: 'INVALID_TAX_CODE' });
  }

  const ddType = req.body?.documentDiscountType === 'PERCENT' || req.body?.documentDiscountType === 'AMOUNT'
    ? req.body.documentDiscountType : null;
  const documentDiscount: DocumentDiscount = ddType
    ? { type: ddType, value: Number(req.body?.documentDiscountValue || 0) }
    : null;

  let calculated;
  try {
    const mathLines: TransactionLineInput[] = rawLines.map((line: any, index: number) => {
      const itemId = text(line.itemId);
      if (!itemId || !itemMap.has(itemId)) throw new Error(`ITEM_REQUIRED_LINE_${index + 1}`);
      const qty = Number(line.quantity || 0);
      const price = Number(line.unitPrice || 0);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`POSITIVE_QTY_REQUIRED_LINE_${index + 1}`);
      if (!Number.isFinite(price) || price < 0) throw new Error(`INVALID_PRICE_LINE_${index + 1}`);
      const taxCodeId = nullable(line.taxCodeId);
      const tax = taxCodeId ? taxMap.get(taxCodeId) : undefined;
      return {
        id: String(index + 1),
        quantity: qty,
        unitPrice: price,
        discountType: line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null,
        discountValue: Number(line.discountValue || 0),
        taxRate: tax?.rate || 0,
        taxIncluded: typeof line.taxIncluded === 'boolean' ? line.taxIncluded : Boolean(tax?.default_inclusive),
      };
    });
    calculated = calculateDocument(mathLines, documentDiscount);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'INVALID_PURCHASE_CALCULATION' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber = await nextPurchaseNumber(client, companyId, transactionDate);
    const header = await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,transaction_date,
         partner_id,reference_number,payment_type,payment_status,due_date,notes,
         document_discount_type,document_discount_value,gross_amount,line_discount_amount,document_discount_amount,
         dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,'PURCHASE_INVOICE',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING id,transaction_number,transaction_date,payment_type,payment_status,due_date,grand_total,workflow_status,accounting_status`,
      [
        workspaceId, companyId, locationId, paymentType === 'CASH' ? financialAccountId : null,
        transactionNumber, transactionDate, partnerId, referenceNumber, paymentType,
        paymentType === 'CASH' ? 'PAID' : 'UNPAID', dueDate, notes,
        ddType, Number(req.body?.documentDiscountValue || 0), calculated.grossAmount, calculated.lineDiscountAmount,
        calculated.documentDiscountAmount, calculated.dppAmount, calculated.taxAmount, calculated.grandTotal,
        req.sessionUser!.id,
      ],
    );
    const transactionId = header.rows[0].id;

    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const calc = calculated.lines[index];
      const itemId = text(line.itemId);
      const item = itemMap.get(itemId)!;
      const unitId = nullable(line.unitId) || item.base_unit_id;
      const discountType = line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null;
      const discountPercent = discountType === 'PERCENT' ? Number(line.discountValue || 0) : 0;
      await client.query(
        `INSERT INTO transaction_lines(
           transaction_id,line_no,line_type,item_id,description,quantity,unit_id,unit_price,gross_amount,
           discount_type,discount_percent,discount_amount,document_discount_alloc,tax_code_id,tax_rate,tax_included,
           dpp_amount,tax_amount,line_total,location_id)
         VALUES($1,$2,'ITEM',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          transactionId, index + 1, itemId, nullable(line.description), line.quantity, unitId, line.unitPrice,
          calc.grossAmount, discountType, discountPercent, calc.lineDiscountAmount, calc.documentDiscountAlloc,
          nullable(line.taxCodeId), calc.taxRate, calc.taxIncluded, calc.dppAmount, calc.taxAmount, calc.lineTotal, locationId,
        ],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_PURCHASE_INVOICE',$4::jsonb)`,
      [workspaceId, req.sessionUser!.id, transactionId, JSON.stringify({ transactionNumber, paymentType, supplierId: partnerId, totals: calculated })],
    );
    await client.query('COMMIT');
    res.status(201).json({ ...header.rows[0], totals: calculated });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create client purchase invoice failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_PURCHASE_INVOICE_FAILED' });
  } finally {
    client.release();
  }
});

clientTransactionRouter.get('/:transactionId/attachments', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await requireTransactionAccess(req.sessionUser!.id, transactionId);
  if (!tx) return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
  const result = await query(
    `SELECT id,file_name,mime_type,file_size,uploaded_at
       FROM attachments
      WHERE entity_type='TRANSACTION' AND entity_id=$1
      ORDER BY uploaded_at DESC`,
    [transactionId],
  );
  res.json(result.rows);
});

clientTransactionRouter.post('/:transactionId/attachments', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await requireTransactionAccess(req.sessionUser!.id, transactionId);
  if (!tx) return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
  if (!(await canCreateTransaction(req.sessionUser!.id, tx.company_id))) return res.status(403).json({ error: 'FORBIDDEN' });

  const fileName = path.basename(text(req.body?.fileName));
  const mimeType = text(req.body?.mimeType).toLowerCase();
  const dataBase64 = text(req.body?.dataBase64).replace(/^data:[^;]+;base64,/, '');
  if (!fileName || !allowedMimeTypes.has(mimeType) || !dataBase64) return res.status(400).json({ error: 'INVALID_ATTACHMENT' });

  let buffer: Buffer;
  try { buffer = Buffer.from(dataBase64, 'base64'); }
  catch { return res.status(400).json({ error: 'INVALID_ATTACHMENT_DATA' }); }
  if (!buffer.length || buffer.length > maxAttachmentBytes) return res.status(400).json({ error: 'ATTACHMENT_MAX_5MB' });

  const relativeDir = path.join(tx.workspace_id, transactionId);
  const dir = path.join(uploadRoot, relativeDir);
  await fs.mkdir(dir, { recursive: true });
  const storedName = `${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  const relativePath = path.join(relativeDir, storedName);
  await fs.writeFile(path.join(uploadRoot, relativePath), buffer);

  const result = await query(
    `INSERT INTO attachments(workspace_id,entity_type,entity_id,file_name,storage_path,mime_type,file_size,uploaded_by)
     VALUES($1,'TRANSACTION',$2,$3,$4,$5,$6,$7)
     RETURNING id,file_name,mime_type,file_size,uploaded_at`,
    [tx.workspace_id, transactionId, fileName, relativePath, mimeType, buffer.length, req.sessionUser!.id],
  );
  res.status(201).json(result.rows[0]);
});

clientTransactionRouter.get('/:transactionId/attachments/:attachmentId/file', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const attachmentId = text(req.params.attachmentId);
  const tx = await requireTransactionAccess(req.sessionUser!.id, transactionId);
  if (!tx) return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
  const attachment = await query<{ file_name: string; storage_path: string; mime_type: string | null }>(
    `SELECT file_name,storage_path,mime_type FROM attachments
      WHERE id=$1 AND entity_type='TRANSACTION' AND entity_id=$2`,
    [attachmentId, transactionId],
  );
  if (!attachment.rowCount) return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
  const row = attachment.rows[0];
  const absolute = path.resolve(uploadRoot, row.storage_path);
  const root = path.resolve(uploadRoot) + path.sep;
  if (!absolute.startsWith(root)) return res.status(400).json({ error: 'INVALID_ATTACHMENT_PATH' });
  res.type(row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/"/g, '')}"`);
  res.sendFile(absolute);
});
