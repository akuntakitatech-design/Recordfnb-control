import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { calculateDocument, type DocumentDiscount, type TransactionLineInput } from '../shared/transactionMath.js';

export const transactionRouter = Router();
transactionRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function nullable(value: unknown) { const v = text(value); return v || null; }
function upper(value: unknown) { return text(value).toUpperCase(); }

const prefixes: Record<string, string> = {
  PURCHASE_INVOICE: 'PB', CASH_OUT: 'KK', CASH_IN: 'KM', STOCK_USAGE: 'PBK',
  STOCK_TRANSFER: 'TRF', STOCK_ADJUSTMENT: 'ADJ', GENERAL_JOURNAL: 'JU',
};

async function nextDocumentNumber(client: any, companyId: string, type: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,$2,$3,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, type, year],
  );
  const prefix = prefixes[type] || type.slice(0, 3).toUpperCase();
  return `${prefix}-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

transactionRouter.get('/recent', async (req, res) => {
  const companyId = text(req.query.companyId);
  const result = await query(
    `SELECT t.id,t.transaction_type,t.transaction_number,t.transaction_date,t.workflow_status,
            t.accounting_status,t.grand_total,t.partner_id,bp.name partner_name,l.name location_name,
            fa.name financial_account_name,t.created_at
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
      WHERE ($1='' OR t.company_id=$1::uuid)
      ORDER BY t.created_at DESC LIMIT 50`, [companyId],
  );
  res.json(result.rows);
});

transactionRouter.post('/drafts', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const transactionType = upper(req.body?.transactionType);
  const transactionDate = text(req.body?.transactionDate);
  const locationId = nullable(req.body?.locationId);
  const partnerId = nullable(req.body?.partnerId);
  const financialAccountId = nullable(req.body?.financialAccountId);
  const referenceNumber = nullable(req.body?.referenceNumber);
  const notes = nullable(req.body?.notes);
  const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!companyId || !transactionType || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) return res.status(400).json({ error: 'TRANSACTION_HEADER_REQUIRED' });
  if (!rawLines.length) return res.status(400).json({ error: 'TRANSACTION_LINES_REQUIRED' });
  if ((transactionType === 'CASH_OUT' || transactionType === 'CASH_IN') && !financialAccountId) return res.status(400).json({ error: 'FINANCIAL_ACCOUNT_REQUIRED' });

  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const workspaceId = company.rows[0].workspace_id;

  if (financialAccountId) {
    const fa = await query('SELECT id FROM financial_accounts WHERE id=$1 AND company_id=$2', [financialAccountId, companyId]);
    if (!fa.rowCount) return res.status(400).json({ error: 'INVALID_FINANCIAL_ACCOUNT' });
  }

  const taxIds = [...new Set(rawLines.map((line: any) => nullable(line.taxCodeId)).filter(Boolean))] as string[];
  const taxMap = new Map<string, { rate: string; default_inclusive: boolean }>();
  if (taxIds.length) {
    const taxes = await query<{ id: string; rate: string; default_inclusive: boolean }>(
      `SELECT id,rate::text,default_inclusive FROM tax_codes WHERE id=ANY($1::uuid[]) AND workspace_id=$2`,
      [taxIds, workspaceId],
    );
    taxes.rows.forEach(t => taxMap.set(t.id, t));
  }

  const ddType = req.body?.documentDiscountType === 'PERCENT' || req.body?.documentDiscountType === 'AMOUNT'
    ? req.body.documentDiscountType : null;
  const documentDiscount: DocumentDiscount = ddType ? { type: ddType, value: req.body?.documentDiscountValue ?? 0 } : null;

  let calculated;
  try {
    const mathLines: TransactionLineInput[] = rawLines.map((line: any, index: number) => {
      const taxCodeId = nullable(line.taxCodeId);
      const tax = taxCodeId ? taxMap.get(taxCodeId) : undefined;
      if (taxCodeId && !tax) throw new Error(`INVALID_TAX_CODE_LINE_${index + 1}`);
      return {
        id: String(index + 1), quantity: line.quantity ?? 1, unitPrice: line.unitPrice ?? 0,
        discountType: line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null,
        discountValue: line.discountValue ?? 0, taxRate: tax?.rate ?? 0,
        taxIncluded: typeof line.taxIncluded === 'boolean' ? line.taxIncluded : Boolean(tax?.default_inclusive),
      };
    });
    calculated = calculateDocument(mathLines, documentDiscount);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'INVALID_TRANSACTION_CALCULATION' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber = await nextDocumentNumber(client, companyId, transactionType, transactionDate);
    const header = await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,transaction_date,partner_id,
         reference_number,notes,document_discount_type,document_discount_value,gross_amount,line_discount_amount,
         document_discount_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
       RETURNING id,transaction_number,transaction_type,transaction_date,grand_total,workflow_status,accounting_status`,
      [workspaceId, companyId, locationId, financialAccountId, transactionType, transactionNumber, transactionDate, partnerId,
       referenceNumber, notes, ddType, req.body?.documentDiscountValue ?? 0, calculated.grossAmount,
       calculated.lineDiscountAmount, calculated.documentDiscountAmount, calculated.dppAmount, calculated.taxAmount,
       calculated.grandTotal, req.sessionUser!.id],
    );
    const transactionId = header.rows[0].id;

    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      const calc = calculated.lines[index];
      const lineType = upper(line.lineType || 'ITEM');
      if (!['ITEM','ACCOUNT','SERVICE','MEMO'].includes(lineType)) throw new Error(`INVALID_LINE_TYPE_${index + 1}`);
      const itemId = nullable(line.itemId);
      const accountId = nullable(line.accountId);
      if (lineType === 'ITEM' && !itemId) throw new Error(`ITEM_REQUIRED_LINE_${index + 1}`);
      if (lineType === 'ACCOUNT' && !accountId) throw new Error(`ACCOUNT_REQUIRED_LINE_${index + 1}`);
      const discountType = line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null;
      const discountPercent = discountType === 'PERCENT' ? Number(line.discountValue || 0) : 0;
      await client.query(
        `INSERT INTO transaction_lines(
          transaction_id,line_no,line_type,item_id,account_id,description,quantity,unit_id,unit_price,gross_amount,
          discount_type,discount_percent,discount_amount,document_discount_alloc,tax_code_id,tax_rate,tax_included,
          dpp_amount,tax_amount,line_total,location_id,cost_center_id,department_code,project_code)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [transactionId, index + 1, lineType, itemId, accountId, nullable(line.description), line.quantity ?? 1,
         nullable(line.unitId), line.unitPrice ?? 0, calc.grossAmount, discountType, discountPercent,
         calc.lineDiscountAmount, calc.documentDiscountAlloc, nullable(line.taxCodeId), calc.taxRate, calc.taxIncluded,
         calc.dppAmount, calc.taxAmount, calc.lineTotal, nullable(line.locationId) || locationId,
         nullable(line.costCenterId), nullable(line.departmentCode), nullable(line.projectCode)],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CREATE_DRAFT',$4::jsonb)`,
      [workspaceId, req.sessionUser!.id, transactionId, JSON.stringify({ transactionNumber, transactionType, financialAccountId, totals: calculated })],
    );
    await client.query('COMMIT');
    res.status(201).json({ ...header.rows[0], totals: calculated });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create transaction failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_TRANSACTION_FAILED' });
  } finally {
    client.release();
  }
});
