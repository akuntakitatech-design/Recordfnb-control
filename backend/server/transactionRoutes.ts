import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessLocation, canCreateTransaction, canVerifyTransaction, hasUnrestrictedLocationAccess } from './access.js';
import { verifyTransactionAndGenerateJournal } from './journalEngine.js';
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

const supportedDraftTypes = new Set(['PURCHASE_INVOICE','CASH_OUT','CASH_IN','STOCK_USAGE']);

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
            fa.name financial_account_name,t.created_at,j.id journal_id,j.status journal_status,j.journal_number
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
       LEFT JOIN journal_headers j ON j.source_transaction_id=t.id AND j.status<>'VOID'
      WHERE ($1='' OR t.company_id=$1::uuid)
        AND (EXISTS (SELECT 1 FROM users x WHERE x.id=$2 AND x.is_system_admin AND x.status='ACTIVE')
          OR EXISTS (
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=t.company_id)
               AND (wm.location_id IS NULL OR wm.location_id=t.location_id)
          ))
      ORDER BY t.created_at DESC LIMIT 50`, [companyId, req.sessionUser!.id],
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
  if (!supportedDraftTypes.has(transactionType)) return res.status(400).json({ error: 'TRANSACTION_TYPE_NOT_SUPPORTED_YET' });
  if (!rawLines.length) return res.status(400).json({ error: 'TRANSACTION_LINES_REQUIRED' });
  if ((transactionType === 'CASH_OUT' || transactionType === 'CASH_IN') && !financialAccountId) return res.status(400).json({ error: 'FINANCIAL_ACCOUNT_REQUIRED' });
  if ((transactionType === 'PURCHASE_INVOICE' || transactionType === 'STOCK_USAGE') && !locationId) return res.status(400).json({ error: 'STOCK_LOCATION_REQUIRED' });
  if (transactionType === 'STOCK_USAGE' && (req.body?.documentDiscountType || rawLines.some((line: any) => line.taxCodeId))) {
    return res.status(400).json({ error: 'STOCK_USAGE_DISCOUNT_TAX_NOT_ALLOWED' });
  }
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });

  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1 AND status=\'ACTIVE\'', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const workspaceId = company.rows[0].workspace_id;

  const unrestrictedLocation = await hasUnrestrictedLocationAccess(req.sessionUser!.id, companyId);
  if (!locationId && !unrestrictedLocation) return res.status(400).json({ error: 'LOCATION_REQUIRED_FOR_USER_SCOPE' });
  if (locationId) {
    const location = await query('SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status=\'ACTIVE\'', [locationId, companyId]);
    if (!location.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
    if (!(await canAccessLocation(req.sessionUser!.id, locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }

  const lineLocationIds = [...new Set(rawLines.map((line: any) => nullable(line.locationId)).filter(Boolean))] as string[];
  for (const lineLocationId of lineLocationIds) {
    const location = await query('SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status=\'ACTIVE\'', [lineLocationId, companyId]);
    if (!location.rowCount) return res.status(400).json({ error: 'LINE_LOCATION_OUTSIDE_COMPANY' });
    if (!(await canAccessLocation(req.sessionUser!.id, lineLocationId))) return res.status(403).json({ error: 'LINE_LOCATION_FORBIDDEN' });
  }

  if (partnerId) {
    const partner = await query('SELECT id FROM business_partners WHERE id=$1 AND workspace_id=$2', [partnerId, workspaceId]);
    if (!partner.rowCount) return res.status(400).json({ error: 'PARTNER_OUTSIDE_WORKSPACE' });
  }

  if (financialAccountId) {
    const fa = await query('SELECT id,location_id FROM financial_accounts WHERE id=$1 AND company_id=$2', [financialAccountId, companyId]);
    if (!fa.rowCount) return res.status(400).json({ error: 'INVALID_FINANCIAL_ACCOUNT' });
    const accountLocationId = fa.rows[0].location_id as string | null;
    if (accountLocationId && !(await canAccessLocation(req.sessionUser!.id, accountLocationId))) {
      return res.status(403).json({ error: 'FINANCIAL_ACCOUNT_FORBIDDEN' });
    }
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
        id: String(index + 1), quantity: line.quantity ?? 1,
        unitPrice: transactionType === 'STOCK_USAGE' ? 0 : (line.unitPrice ?? 0),
        discountType: transactionType === 'STOCK_USAGE' ? null : (line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null),
        discountValue: transactionType === 'STOCK_USAGE' ? 0 : (line.discountValue ?? 0),
        taxRate: transactionType === 'STOCK_USAGE' ? 0 : (tax?.rate ?? 0),
        taxIncluded: transactionType === 'STOCK_USAGE' ? false : (typeof line.taxIncluded === 'boolean' ? line.taxIncluded : Boolean(tax?.default_inclusive)),
      };
    });
    calculated = calculateDocument(mathLines, transactionType === 'STOCK_USAGE' ? null : documentDiscount);
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
       referenceNumber, notes, transactionType === 'STOCK_USAGE' ? null : ddType,
       transactionType === 'STOCK_USAGE' ? 0 : (req.body?.documentDiscountValue ?? 0), calculated.grossAmount,
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
      if (transactionType === 'STOCK_USAGE' && lineType !== 'ITEM') throw new Error(`STOCK_USAGE_ITEM_ONLY_LINE_${index + 1}`);
      if (itemId) {
        const item = await client.query('SELECT id FROM items WHERE id=$1 AND workspace_id=$2', [itemId, workspaceId]);
        if (!item.rowCount) throw new Error(`ITEM_OUTSIDE_WORKSPACE_LINE_${index + 1}`);
      }
      if (accountId) {
        const account = await client.query('SELECT id FROM chart_of_accounts WHERE id=$1 AND company_id=$2', [accountId, companyId]);
        if (!account.rowCount) throw new Error(`ACCOUNT_OUTSIDE_COMPANY_LINE_${index + 1}`);
      }
      const discountType = transactionType === 'STOCK_USAGE' ? null : (line.discountType === 'PERCENT' || line.discountType === 'AMOUNT' ? line.discountType : null);
      const discountPercent = discountType === 'PERCENT' ? Number(line.discountValue || 0) : 0;
      await client.query(
        `INSERT INTO transaction_lines(
          transaction_id,line_no,line_type,item_id,account_id,description,quantity,unit_id,unit_price,gross_amount,
          discount_type,discount_percent,discount_amount,document_discount_alloc,tax_code_id,tax_rate,tax_included,
          dpp_amount,tax_amount,line_total,location_id,cost_center_id,department_code,project_code)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [transactionId, index + 1, lineType, itemId, accountId, nullable(line.description), line.quantity ?? 1,
         nullable(line.unitId), transactionType === 'STOCK_USAGE' ? 0 : (line.unitPrice ?? 0), calc.grossAmount, discountType, discountPercent,
         calc.lineDiscountAmount, calc.documentDiscountAlloc, transactionType === 'STOCK_USAGE' ? null : nullable(line.taxCodeId),
         calc.taxRate, calc.taxIncluded, calc.dppAmount, calc.taxAmount, calc.lineTotal,
         nullable(line.locationId) || locationId, nullable(line.costCenterId), nullable(line.departmentCode), nullable(line.projectCode)],
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

transactionRouter.post('/:transactionId/verify', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const transaction = await query<{ company_id: string; location_id: string | null }>(
    'SELECT company_id,location_id FROM transaction_headers WHERE id=$1', [transactionId],
  );
  if (!transaction.rowCount) return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
  const tx = transaction.rows[0];
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (tx.location_id && !(await canAccessLocation(req.sessionUser!.id, tx.location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });

  try {
    const journal = await verifyTransactionAndGenerateJournal(transactionId, req.sessionUser!.id);
    res.json({ ok: true, journal });
  } catch (error) {
    console.error('Verify transaction failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'VERIFY_TRANSACTION_FAILED' });
  }
});
