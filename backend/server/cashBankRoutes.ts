/**
 * cashBankRoutes.ts — satu pintu untuk halaman Kas & Bank.
 *
 * Semua angka dibaca dari transaction_headers yang SUDAH ADA (CASH_OUT, CASH_IN, PURCHASE_INVOICE tunai) ditambah
 * CASH_TRANSFER (pindah uang antar kas/bank, kolom baru transfer_to_financial_account_id). Tidak ada tabel mutasi baru:
 * buku mutasi dan saldo adalah turunan (view) dari transaksi, sehingga data lama otomatis ikut terhitung.
 */
import { Router } from 'express';
import * as XLSX from 'xlsx';
import Decimal from 'decimal.js';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { verifyTransactionAndGenerateJournal } from './journalEngine.js';
import { recalcInvoicePaymentStatus } from './cashOutEngine.js';
import { assertPeriodAllows } from './periodGuard.js';

export const cashBankRouter = Router();
cashBankRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function nullable(value: unknown) { const v = text(value); return v || null; }
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = (v: any) => Number(v || 0);

/** Status transaksi yang dianggap batal (tidak ikut saldo). */
const EXCLUDED = `('CANCELLED','VOID')`;

/**
 * Sumber mutasi kas/bank (UNION) — $1 = company_id.
 * Kolom: transaction_id, transaction_number, transaction_date, created_at, transaction_type, kind, sort_no,
 *        financial_account_id, amount_in, amount_out, counterparty, description, category_name, location_id,
 *        workflow_status, accounting_status, reference_number, partner_id
 */
const MUTATIONS = `
  SELECT t.id transaction_id,t.transaction_number,t.transaction_date,t.created_at,t.transaction_type,
         CASE WHEN t.cash_out_type='DEBT_PAYMENT' THEN 'Bayar Hutang' ELSE 'Pengeluaran Operasional' END kind,0 sort_no,
         t.financial_account_id,0 amount_in,t.grand_total amount_out,
         COALESCE(bp.name,t.payee_name) counterparty,
         COALESCE(t.notes,(SELECT tl.description FROM transaction_lines tl WHERE tl.transaction_id=t.id ORDER BY tl.line_no LIMIT 1)) description,
         (SELECT ec.name FROM transaction_lines tl JOIN expense_categories ec ON ec.id=tl.expense_category_id WHERE tl.transaction_id=t.id ORDER BY tl.line_no LIMIT 1) category_name,
         t.location_id,t.workflow_status,t.accounting_status,t.reference_number,t.partner_id
    FROM transaction_headers t LEFT JOIN business_partners bp ON bp.id=t.partner_id
   WHERE t.company_id=$1 AND t.transaction_type='CASH_OUT' AND t.financial_account_id IS NOT NULL AND t.workflow_status NOT IN ${EXCLUDED}
  UNION ALL
  SELECT t.id,t.transaction_number,t.transaction_date,t.created_at,t.transaction_type,'Uang Masuk',0,
         t.financial_account_id,t.grand_total,0,t.source_name,
         COALESCE(t.notes,(SELECT tl.description FROM transaction_lines tl WHERE tl.transaction_id=t.id ORDER BY tl.line_no LIMIT 1)),NULL,
         t.location_id,t.workflow_status,t.accounting_status,t.reference_number,t.partner_id
    FROM transaction_headers t
   WHERE t.company_id=$1 AND t.transaction_type='CASH_IN' AND t.financial_account_id IS NOT NULL AND t.workflow_status NOT IN ${EXCLUDED}
  UNION ALL
  SELECT t.id,t.transaction_number,t.transaction_date,t.created_at,t.transaction_type,'Pembelian Tunai',0,
         t.financial_account_id,0,t.grand_total,bp.name,
         COALESCE(t.notes,CONCAT('Pembelian tunai ',COALESCE(t.reference_number,t.transaction_number))),NULL,
         t.location_id,t.workflow_status,t.accounting_status,t.reference_number,t.partner_id
    FROM transaction_headers t LEFT JOIN business_partners bp ON bp.id=t.partner_id
   WHERE t.company_id=$1 AND t.transaction_type='PURCHASE_INVOICE' AND t.payment_type='CASH' AND t.financial_account_id IS NOT NULL AND t.workflow_status NOT IN ${EXCLUDED}
  UNION ALL
  SELECT t.id,t.transaction_number,t.transaction_date,t.created_at,t.transaction_type,'Transfer Keluar',0,
         t.financial_account_id,0,t.grand_total,(SELECT fa2.name FROM financial_accounts fa2 WHERE fa2.id=t.transfer_to_financial_account_id),
         COALESCE(t.notes,CONCAT('Pindah uang ',t.transaction_number)),NULL,
         t.location_id,t.workflow_status,t.accounting_status,t.reference_number,NULL
    FROM transaction_headers t
   WHERE t.company_id=$1 AND t.transaction_type='CASH_TRANSFER' AND t.financial_account_id IS NOT NULL AND t.workflow_status NOT IN ${EXCLUDED}
  UNION ALL
  SELECT t.id,t.transaction_number,t.transaction_date,t.created_at,t.transaction_type,'Transfer Masuk',1,
         t.transfer_to_financial_account_id,t.grand_total,0,(SELECT fa1.name FROM financial_accounts fa1 WHERE fa1.id=t.financial_account_id),
         COALESCE(t.notes,CONCAT('Pindah uang ',t.transaction_number)),NULL,
         t.location_id,t.workflow_status,t.accounting_status,t.reference_number,NULL
    FROM transaction_headers t
   WHERE t.company_id=$1 AND t.transaction_type='CASH_TRANSFER' AND t.transfer_to_financial_account_id IS NOT NULL AND t.workflow_status NOT IN ${EXCLUDED}
`;

async function requireCompany(req: any, res: any, companyId: string) {
  if (!companyId) { res.status(400).json({ error: 'COMPANY_REQUIRED' }); return false; }
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) { res.status(403).json({ error: 'FORBIDDEN_COMPANY' }); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Saldo per rekening + total Kas / Bank
// ---------------------------------------------------------------------------
async function loadAccountsWithBalance(companyId: string) {
  const result = await query(
    `SELECT fa.id,fa.code,fa.name,fa.account_kind,fa.location_id,l.name location_name,coa.code coa_code,coa.name coa_name,
            COALESCE(SUM(m.amount_in),0)::text total_in,COALESCE(SUM(m.amount_out),0)::text total_out,
            (COALESCE(SUM(m.amount_in),0)-COALESCE(SUM(m.amount_out),0))::text balance,
            COUNT(CASE WHEN m.workflow_status='DRAFT' THEN 1 END) draft_count,
            COUNT(m.transaction_id) mutation_count,
            (SELECT r.status FROM cash_bank_reconciliations r WHERE r.financial_account_id=fa.id ORDER BY r.reconciliation_date DESC,r.created_at DESC LIMIT 1) last_reconciliation_status,
            (SELECT r.reconciliation_date::text FROM cash_bank_reconciliations r WHERE r.financial_account_id=fa.id ORDER BY r.reconciliation_date DESC,r.created_at DESC LIMIT 1) last_reconciliation_date
       FROM financial_accounts fa
       LEFT JOIN locations l ON l.id=fa.location_id
       JOIN chart_of_accounts coa ON coa.id=fa.coa_account_id
       LEFT JOIN (${MUTATIONS}) m ON m.financial_account_id=fa.id
      WHERE fa.company_id=$1 AND fa.status='ACTIVE' AND fa.account_kind IN ('CASH','BANK','EWALLET')
      GROUP BY fa.id,fa.code,fa.name,fa.account_kind,fa.location_id,l.name,coa.code,coa.name
      ORDER BY FIELD(fa.account_kind,'CASH','BANK','EWALLET'),fa.name`,
    [companyId],
  );
  const accounts = result.rows.map(r => ({ ...r, draft_count: num(r.draft_count), mutation_count: num(r.mutation_count) }));
  const sum = (kind?: string) => accounts.filter(a => !kind || a.account_kind === kind).reduce((s, a) => s.add(a.balance || 0), new Decimal(0));
  return {
    accounts,
    totals: { cash: sum('CASH').toFixed(4), bank: sum('BANK').toFixed(4), ewallet: sum('EWALLET').toFixed(4), total: sum().toFixed(4) },
  };
}

cashBankRouter.get('/accounts', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!(await requireCompany(req, res, companyId))) return;
  res.json(await loadAccountsWithBalance(companyId));
});

// ---------------------------------------------------------------------------
// Buku mutasi + saldo berjalan
// ---------------------------------------------------------------------------
type LedgerRow = Record<string, any>;

async function loadLedger(companyId: string, accountId: string, from: string, to: string) {
  const result = await query<LedgerRow>(
    `SELECT m.transaction_id,m.transaction_number,m.transaction_date::text,m.created_at,m.transaction_type,m.kind,m.sort_no,
            m.financial_account_id,fa.name financial_account_name,fa.account_kind,
            m.amount_in::text,m.amount_out::text,m.counterparty,m.description,m.category_name,
            m.location_id,l.name location_name,m.workflow_status,m.accounting_status,m.reference_number,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=m.transaction_id) attachment_count
       FROM (${MUTATIONS}) m
       JOIN financial_accounts fa ON fa.id=m.financial_account_id
       LEFT JOIN locations l ON l.id=m.location_id
      WHERE ($2='' OR m.financial_account_id=$2) AND ($3='' OR m.transaction_date<=$3::date)
      ORDER BY m.transaction_date,m.created_at,m.transaction_number,m.sort_no`,
    [companyId, accountId, to],
  );
  // Saldo berjalan: per rekening bila satu rekening dipilih; gabungan (total Kas & Bank) bila "Semua".
  let running = new Decimal(0);
  let opening = new Decimal(0);
  const rows: LedgerRow[] = [];
  for (const r of result.rows) {
    running = running.add(r.amount_in || 0).sub(r.amount_out || 0);
    if (from && r.transaction_date < from) { opening = running; continue; }
    rows.push({ ...r, id: `${r.transaction_id}:${r.sort_no}`, balance: running.toFixed(4) });
  }
  const totalIn = rows.reduce((s, r) => s.add(r.amount_in || 0), new Decimal(0));
  const totalOut = rows.reduce((s, r) => s.add(r.amount_out || 0), new Decimal(0));
  return { opening_balance: opening.toFixed(4), closing_balance: running.toFixed(4), total_in: totalIn.toFixed(4), total_out: totalOut.toFixed(4), rows };
}

function readLedgerFilter(req: any) {
  const companyId = text(req.query.companyId);
  const accountId = text(req.query.accountId);
  const from = text(req.query.from);
  const to = text(req.query.to);
  return { companyId, accountId, from: isDate(from) ? from : '', to: isDate(to) ? to : '' };
}

cashBankRouter.get('/ledger', async (req, res) => {
  const f = readLedgerFilter(req);
  if (!(await requireCompany(req, res, f.companyId))) return;
  res.json(await loadLedger(f.companyId, f.accountId, f.from, f.to));
});

// ---------------------------------------------------------------------------
// Export Excel (nominal numeric, mengikuti filter aktif)
// ---------------------------------------------------------------------------
function xlsxBuffer(sheets: Array<{ name: string; header: string[]; rows: any[][]; numericCols: number[]; widths?: number[] }>) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([s.header, ...s.rows]);
    const ref = ws['!ref'];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      for (let R = 1; R <= range.e.r; R += 1) {
        for (const C of s.numericCols) {
          const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
          if (cell && typeof cell.v === 'number') { cell.t = 'n'; cell.z = '#,##0.00'; }
        }
      }
    }
    ws['!cols'] = s.header.map((h, i) => ({ wch: s.widths?.[i] || Math.max(12, h.length + 2) }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function sendXlsx(res: any, fileName: string, buffer: Buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

const statusLabel: Record<string, string> = { DRAFT: 'Draft', FINANCE_VERIFIED: 'Finance Verified', POSTED: 'Posted', CANCELLED: 'Dibatalkan' };

cashBankRouter.get('/export/ledger', async (req, res) => {
  const f = readLedgerFilter(req);
  if (!(await requireCompany(req, res, f.companyId))) return;
  const ledger = await loadLedger(f.companyId, f.accountId, f.from, f.to);
  const rows: any[][] = ledger.rows.map(r => [
    r.transaction_date, r.transaction_number, r.financial_account_name, r.kind, r.description || '', r.counterparty || '',
    r.location_name || '', num(r.amount_in), num(r.amount_out), num(r.balance), statusLabel[r.workflow_status] || r.workflow_status,
  ]);
  if (f.from) rows.unshift([f.from, '', f.accountId ? '' : 'Semua Kas & Bank', 'Saldo Awal', '', '', '', 0, 0, num(ledger.opening_balance), '']);
  const buffer = xlsxBuffer([{
    name: 'Buku Mutasi',
    header: ['Tanggal', 'No Transaksi', 'Kas/Bank', 'Jenis', 'Keterangan', 'Supplier/Penerima', 'Outlet', 'Masuk', 'Keluar', 'Saldo', 'Status'],
    rows, numericCols: [7, 8, 9], widths: [12, 16, 22, 20, 36, 26, 18, 16, 16, 18, 16],
  }]);
  sendXlsx(res, `kas-bank-mutasi-${f.from || 'awal'}-${f.to || 'akhir'}.xlsx`, buffer);
});

// ---------------------------------------------------------------------------
// Tagihan supplier (hutang dari invoice pembelian kredit) + histori pembayaran
// ---------------------------------------------------------------------------
const PAID_VERIFIED = `COALESCE((SELECT SUM(a.amount) FROM transaction_allocations a JOIN transaction_headers p ON p.id=a.source_transaction_id
   WHERE a.target_transaction_id=i.id AND a.allocation_type='AP_PAYMENT' AND p.workflow_status IN ('FINANCE_VERIFIED','POSTED')),0)`;
const PAID_PENDING = `COALESCE((SELECT SUM(a.amount) FROM transaction_allocations a JOIN transaction_headers p ON p.id=a.source_transaction_id
   WHERE a.target_transaction_id=i.id AND a.allocation_type='AP_PAYMENT' AND p.workflow_status='DRAFT'),0)`;

async function loadPayables(companyId: string, scope: string) {
  const result = await query(
    `SELECT i.id,i.transaction_number,i.transaction_date::text,i.reference_number,i.due_date::text,i.grand_total::text,
            i.workflow_status,i.payment_status,i.partner_id,bp.name supplier_name,l.name location_name,
            ${PAID_VERIFIED}::text paid_verified,${PAID_PENDING}::text paid_pending,
            (i.grand_total-${PAID_VERIFIED}-${PAID_PENDING})::text remaining,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=i.id) attachment_count
       FROM transaction_headers i
       LEFT JOIN business_partners bp ON bp.id=i.partner_id
       LEFT JOIN locations l ON l.id=i.location_id
      WHERE i.company_id=$1 AND i.transaction_type='PURCHASE_INVOICE' AND i.payment_type='CREDIT' AND i.workflow_status NOT IN ${EXCLUDED}
      ORDER BY (i.due_date IS NULL),i.due_date,i.transaction_date,i.transaction_number`,
    [companyId],
  );
  const today = new Date().toISOString().slice(0, 10);
  const rows = result.rows.map(r => {
    const remaining = new Decimal(r.remaining || 0);
    const paid = new Decimal(r.paid_verified || 0).add(r.paid_pending || 0);
    let status: string;
    if (remaining.lte(0.0001)) status = 'LUNAS';
    else if (paid.gt(0)) status = 'DIBAYAR_SEBAGIAN';
    else status = 'BELUM_DIBAYAR';
    const overdue = status !== 'LUNAS' && Boolean(r.due_date) && r.due_date < today;
    const payable = r.workflow_status !== 'DRAFT' && status !== 'LUNAS';
    return { ...r, status, overdue, payable, remaining: remaining.toFixed(4), paid_total: paid.toFixed(4) };
  });
  return scope === 'OPEN' ? rows.filter(r => r.status !== 'LUNAS') : rows;
}

cashBankRouter.get('/payables', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!(await requireCompany(req, res, companyId))) return;
  res.json(await loadPayables(companyId, text(req.query.scope).toUpperCase() || 'ALL'));
});

const payableStatusLabel: Record<string, string> = { LUNAS: 'Lunas', DIBAYAR_SEBAGIAN: 'Dibayar Sebagian', BELUM_DIBAYAR: 'Belum Dibayar' };

cashBankRouter.get('/export/payables', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!(await requireCompany(req, res, companyId))) return;
  const rows = await loadPayables(companyId, text(req.query.scope).toUpperCase() || 'ALL');
  const buffer = xlsxBuffer([{
    name: 'Tagihan Supplier',
    header: ['Supplier', 'No Pembelian', 'No Invoice Supplier', 'Tanggal Invoice', 'Jatuh Tempo', 'Outlet', 'Total Invoice', 'Sudah Dibayar', 'Menunggu Verifikasi', 'Sisa Hutang', 'Status', 'Status Dokumen'],
    rows: rows.map(r => [r.supplier_name || '', r.transaction_number, r.reference_number || '', r.transaction_date, r.due_date || '', r.location_name || '',
      num(r.grand_total), num(r.paid_verified), num(r.paid_pending), num(r.remaining), payableStatusLabel[r.status] || r.status, statusLabel[r.workflow_status] || r.workflow_status]),
    numericCols: [6, 7, 8, 9], widths: [26, 16, 20, 14, 14, 18, 18, 18, 20, 18, 18, 16],
  }]);
  sendXlsx(res, `tagihan-supplier-${new Date().toISOString().slice(0, 10)}.xlsx`, buffer);
});

async function loadSupplierPayments(companyId: string, from: string, to: string) {
  const result = await query(
    `SELECT t.id,t.transaction_number,t.transaction_date::text,t.reference_number,t.notes,t.grand_total::text,t.workflow_status,t.accounting_status,
            bp.name supplier_name,fa.name financial_account_name,l.name location_name,
            (SELECT GROUP_CONCAT(CONCAT(i.transaction_number,' (',FORMAT(a.amount,0,'id_ID'),')') ORDER BY i.transaction_number SEPARATOR ', ')
               FROM transaction_allocations a JOIN transaction_headers i ON i.id=a.target_transaction_id
              WHERE a.source_transaction_id=t.id AND a.allocation_type='AP_PAYMENT') invoices,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            j.journal_number,j.status journal_status
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN journal_headers j ON j.source_transaction_id=t.id AND j.status<>'VOID'
      WHERE t.company_id=$1 AND t.transaction_type='CASH_OUT' AND t.cash_out_type='DEBT_PAYMENT'
        AND ($2='' OR t.transaction_date>=$2::date) AND ($3='' OR t.transaction_date<=$3::date)
      ORDER BY t.transaction_date DESC,t.created_at DESC`,
    [companyId, from, to],
  );
  return result.rows;
}

cashBankRouter.get('/supplier-payments', async (req, res) => {
  const f = readLedgerFilter(req);
  if (!(await requireCompany(req, res, f.companyId))) return;
  res.json(await loadSupplierPayments(f.companyId, f.from, f.to));
});

cashBankRouter.get('/export/supplier-payments', async (req, res) => {
  const f = readLedgerFilter(req);
  if (!(await requireCompany(req, res, f.companyId))) return;
  const rows = await loadSupplierPayments(f.companyId, f.from, f.to);
  const buffer = xlsxBuffer([{
    name: 'Histori Pembayaran',
    header: ['Tanggal', 'No Pembayaran', 'Supplier', 'Invoice Dibayar', 'Kas/Bank', 'Outlet', 'Nominal', 'Status', 'Jurnal', 'Catatan'],
    rows: rows.map(r => [r.transaction_date, r.transaction_number, r.supplier_name || '', r.invoices || '', r.financial_account_name || '', r.location_name || '',
      num(r.grand_total), statusLabel[r.workflow_status] || r.workflow_status, r.journal_number || '', r.notes || '']),
    numericCols: [6], widths: [12, 16, 26, 40, 22, 18, 18, 16, 16, 30],
  }]);
  sendXlsx(res, `histori-pembayaran-supplier-${f.from || 'awal'}-${f.to || 'akhir'}.xlsx`, buffer);
});

// ---------------------------------------------------------------------------
// Transfer antar Kas/Bank — satu input, dua mutasi (keluar di sumber, masuk di tujuan), satu reference.
// ---------------------------------------------------------------------------
async function nextTransferNumber(client: any, companyId: string, date: string) {
  const year = Number(date.slice(0, 4));
  const result = await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'CASH_TRANSFER',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`, [companyId, year],
  );
  return `TF-${year}-${String(result.rows[0].last_number).padStart(5, '0')}`;
}

cashBankRouter.post('/transfers', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const transactionDate = text(req.body?.transactionDate);
  const fromAccountId = text(req.body?.fromAccountId);
  const toAccountId = text(req.body?.toAccountId);
  const amount = Number(req.body?.amount || 0);
  const notes = nullable(req.body?.notes);
  const referenceNumber = nullable(req.body?.referenceNumber);
  let locationId = nullable(req.body?.locationId);

  if (!companyId || !fromAccountId || !toAccountId || !isDate(transactionDate)) return res.status(400).json({ error: 'TRANSFER_HEADER_REQUIRED' });
  if (fromAccountId === toAccountId) return res.status(400).json({ error: 'TRANSFER_ACCOUNTS_MUST_DIFFER' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'POSITIVE_TRANSFER_AMOUNT_REQUIRED' });
  if (!(await canCreateTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN' });

  const company = await query<{ workspace_id: string }>(`SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`, [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const workspaceId = company.rows[0].workspace_id;
  try { await assertPeriodAllows(null, companyId, transactionDate, 'FINANCE'); }
  catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'ACCOUNTING_PERIOD_CLOSED' }); }

  const accounts = await query<{ id: string; name: string; location_id: string | null }>(
    `SELECT id,name,location_id FROM financial_accounts WHERE id=ANY($1::uuid[]) AND company_id=$2 AND status='ACTIVE' AND account_kind IN ('CASH','BANK','EWALLET')`,
    [[fromAccountId, toAccountId], companyId],
  );
  const source = accounts.rows.find(a => a.id === fromAccountId);
  const target = accounts.rows.find(a => a.id === toAccountId);
  if (!source || !target) return res.status(400).json({ error: 'INVALID_FINANCIAL_ACCOUNT' });
  for (const acc of [source, target]) {
    if (acc.location_id && !(await canAccessLocation(req.sessionUser!.id, acc.location_id))) return res.status(403).json({ error: 'FINANCIAL_ACCOUNT_FORBIDDEN' });
  }
  if (!locationId) locationId = source.location_id || target.location_id;
  if (locationId) {
    const loc = await query(`SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [locationId, companyId]);
    if (!loc.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
    if (!(await canAccessLocation(req.sessionUser!.id, locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber = await nextTransferNumber(client, companyId, transactionDate);
    const header = await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,financial_account_id,transfer_to_financial_account_id,transaction_type,transaction_number,transaction_date,
         reference_number,payment_type,payment_status,notes,gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,'CASH_TRANSFER',$6,$7,$8,'CASH','PAID',$9,$10,$10,0,$10,$11,$11)
       RETURNING id,transaction_number,transaction_date,grand_total,workflow_status,accounting_status`,
      [workspaceId, companyId, locationId, fromAccountId, toAccountId, transactionNumber, transactionDate, referenceNumber, notes, amount, req.sessionUser!.id],
    );
    const transactionId = header.rows[0].id;
    await client.query(
      `INSERT INTO transaction_lines(transaction_id,line_no,line_type,description,quantity,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,metadata)
       VALUES($1,1,'MEMO',$2,1,$3,$3,$3,0,$3,$4,$5::jsonb)`,
      [transactionId, `Pindah uang ${source.name} → ${target.name}`, amount, locationId, JSON.stringify({ fromAccountId, toAccountId })],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_CASH_TRANSFER',$4::jsonb)`,
      [workspaceId, req.sessionUser!.id, transactionId, JSON.stringify({ transactionNumber, fromAccountId, toAccountId, amount })],
    );
    await client.query('COMMIT');
    res.status(201).json({ ...header.rows[0], from_account_name: source.name, to_account_name: target.name });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create cash transfer failed:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'CREATE_TRANSFER_FAILED' });
  } finally { client.release(); }
});

cashBankRouter.post('/transfers/:transactionId/verify', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const tx = await query<{ company_id: string; location_id: string | null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='CASH_TRANSFER'`, [transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error: 'TRANSFER_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, tx.rows[0].company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (tx.rows[0].location_id && !(await canAccessLocation(req.sessionUser!.id, tx.rows[0].location_id!))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try {
    const journal = await verifyTransactionAndGenerateJournal(transactionId, req.sessionUser!.id);
    res.json({ ok: true, journalId: journal.id, journal });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'VERIFY_TRANSFER_FAILED';
    res.status(message.startsWith('ACCOUNTING_PERIOD') ? 409 : 400).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Detail transaksi kas (untuk verifikasi Finance & "lihat source" Accounting) + batalkan draft
// ---------------------------------------------------------------------------
cashBankRouter.get('/transactions/:transactionId', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const header = await query(
    `SELECT t.id,t.workspace_id,t.company_id,t.location_id,l.name location_name,t.transaction_type,t.transaction_number,t.transaction_date::text,
            t.reference_number,t.notes,t.grand_total::text,t.workflow_status,t.accounting_status,t.payment_type,t.payment_status,
            t.cash_out_type,t.cash_in_type,t.payee_name,t.source_name,t.partner_id,bp.name partner_name,
            t.financial_account_id,fa.name financial_account_name,fa.account_kind,
            t.transfer_to_financial_account_id,fa2.name transfer_to_financial_account_name,
            t.created_at,cu.full_name created_by_name,t.verified_at,vu.full_name verified_by_name,
            j.id journal_id,j.journal_number,j.status journal_status
       FROM transaction_headers t
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
       LEFT JOIN financial_accounts fa2 ON fa2.id=t.transfer_to_financial_account_id
       LEFT JOIN users cu ON cu.id=t.created_by
       LEFT JOIN users vu ON vu.id=t.verified_by
       LEFT JOIN journal_headers j ON j.source_transaction_id=t.id AND j.status<>'VOID'
      WHERE t.id=$1`, [transactionId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' });
  const tx = header.rows[0];
  if (!(await canAccessCompany(req.sessionUser!.id, tx.company_id))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  const [lines, allocations, attachments] = await Promise.all([
    query(
      `SELECT tl.id,tl.line_no,tl.line_type,tl.description,tl.line_total::text,tl.cost_center_id,cc.name cost_center_name,
              tl.expense_category_id,ec.name expense_category_name,tl.account_id,coa.code account_code,coa.name account_name
         FROM transaction_lines tl
         LEFT JOIN cost_centers cc ON cc.id=tl.cost_center_id
         LEFT JOIN expense_categories ec ON ec.id=tl.expense_category_id
         LEFT JOIN chart_of_accounts coa ON coa.id=tl.account_id
        WHERE tl.transaction_id=$1 ORDER BY tl.line_no`, [transactionId],
    ),
    query(
      `SELECT a.id,a.amount::text,a.target_transaction_id,i.transaction_number invoice_number,i.reference_number invoice_reference,i.grand_total::text invoice_total,i.payment_status
         FROM transaction_allocations a JOIN transaction_headers i ON i.id=a.target_transaction_id
        WHERE a.source_transaction_id=$1 AND a.allocation_type='AP_PAYMENT' ORDER BY i.transaction_number`, [transactionId],
    ),
    query(`SELECT id,file_name,mime_type,file_size,uploaded_at FROM attachments WHERE entity_type='TRANSACTION' AND entity_id=$1 ORDER BY uploaded_at DESC`, [transactionId]),
  ]);
  res.json({ ...tx, lines: lines.rows, allocations: allocations.rows, attachments: attachments.rows });
});

cashBankRouter.post('/transactions/:transactionId/cancel', async (req, res) => {
  const transactionId = text(req.params.transactionId);
  const reason = text(req.body?.reason);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query<{ id: string; workspace_id: string; company_id: string; location_id: string | null; transaction_type: string; workflow_status: string; transaction_date: string; transaction_number: string }>(
      `SELECT id,workspace_id,company_id,location_id,transaction_type,workflow_status,transaction_date::text,transaction_number
         FROM transaction_headers WHERE id=$1 FOR UPDATE`, [transactionId],
    );
    if (!tx.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'TRANSACTION_NOT_FOUND' }); }
    const t = tx.rows[0];
    if (!['CASH_OUT', 'CASH_IN', 'CASH_TRANSFER'].includes(t.transaction_type)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'ONLY_CASH_TRANSACTIONS_CAN_BE_CANCELLED' }); }
    if (!(await canCreateTransaction(req.sessionUser!.id, t.company_id))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'FORBIDDEN' }); }
    if (t.location_id && !(await canAccessLocation(req.sessionUser!.id, t.location_id))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'LOCATION_FORBIDDEN' }); }
    if (t.workflow_status !== 'DRAFT') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'ONLY_DRAFT_CAN_BE_CANCELLED' }); }
    try { await assertPeriodAllows(client, t.company_id, t.transaction_date, 'FINANCE'); }
    catch (error) { await client.query('ROLLBACK'); return res.status(409).json({ error: error instanceof Error ? error.message : 'ACCOUNTING_PERIOD_CLOSED' }); }

    await client.query(
      `UPDATE transaction_headers SET workflow_status='CANCELLED',operational_status='CANCELLED',updated_by=$1,updated_at=NOW() WHERE id=$2`,
      [req.sessionUser!.id, transactionId],
    );
    const allocations = await client.query<{ target_transaction_id: string }>(
      `SELECT target_transaction_id FROM transaction_allocations WHERE source_transaction_id=$1 AND allocation_type='AP_PAYMENT'`, [transactionId],
    );
    for (const a of allocations.rows) await recalcInvoicePaymentStatus(client, a.target_transaction_id);
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CANCEL_DRAFT',$4::jsonb,$5::jsonb)`,
      [t.workspace_id, req.sessionUser!.id, transactionId, JSON.stringify({ workflowStatus: 'DRAFT' }), JSON.stringify({ workflowStatus: 'CANCELLED', reason })],
    );
    await client.query('COMMIT');
    res.json({ ok: true, status: 'CANCELLED', transaction_number: t.transaction_number });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error instanceof Error ? error.message : 'CANCEL_FAILED' });
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// Rekonsiliasi: Kas = saldo sistem vs cash count; Bank = saldo buku vs rekening koran.
// ---------------------------------------------------------------------------
async function systemBalanceAsOf(companyId: string, accountId: string, date: string) {
  const result = await query<{ balance: string }>(
    `SELECT (COALESCE(SUM(m.amount_in),0)-COALESCE(SUM(m.amount_out),0))::text balance
       FROM (${MUTATIONS}) m WHERE m.financial_account_id=$2 AND m.transaction_date<=$3::date`,
    [companyId, accountId, date],
  );
  return new Decimal(result.rows[0]?.balance || 0);
}

cashBankRouter.get('/reconciliations', async (req, res) => {
  const companyId = text(req.query.companyId);
  const accountId = text(req.query.accountId);
  if (!(await requireCompany(req, res, companyId))) return;
  const result = await query(
    `SELECT r.id,r.financial_account_id,fa.name financial_account_name,fa.account_kind,r.reconciliation_date::text,
            r.system_balance::text,r.actual_balance::text,r.difference::text,r.status,r.notes,r.created_at,
            cu.full_name created_by_name,r.reconciled_at,ru.full_name reconciled_by_name
       FROM cash_bank_reconciliations r
       JOIN financial_accounts fa ON fa.id=r.financial_account_id
       LEFT JOIN users cu ON cu.id=r.created_by
       LEFT JOIN users ru ON ru.id=r.reconciled_by
      WHERE r.company_id=$1 AND ($2='' OR r.financial_account_id=$2)
      ORDER BY r.reconciliation_date DESC,r.created_at DESC
      LIMIT 200`,
    [companyId, accountId],
  );
  res.json(result.rows);
});

cashBankRouter.post('/reconciliations', async (req, res) => {
  const companyId = text(req.body?.companyId);
  const accountId = text(req.body?.financialAccountId);
  const date = text(req.body?.reconciliationDate);
  const actual = Number(req.body?.actualBalance);
  const notes = nullable(req.body?.notes);
  if (!companyId || !accountId || !isDate(date) || !Number.isFinite(actual)) return res.status(400).json({ error: 'RECONCILIATION_FIELDS_REQUIRED' });
  if (!(await canVerifyTransaction(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  const account = await query<{ id: string; workspace_id: string }>(`SELECT id,workspace_id FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [accountId, companyId]);
  if (!account.rowCount) return res.status(400).json({ error: 'INVALID_FINANCIAL_ACCOUNT' });

  const systemBalance = await systemBalanceAsOf(companyId, accountId, date);
  const difference = new Decimal(actual).sub(systemBalance);
  const reconciled = difference.abs().lt(0.005);
  const result = await query(
    `INSERT INTO cash_bank_reconciliations(workspace_id,company_id,financial_account_id,reconciliation_date,system_balance,actual_balance,difference,status,notes,created_by,reconciled_by,reconciled_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id,financial_account_id,reconciliation_date,system_balance,actual_balance,difference,status,notes`,
    [account.rows[0].workspace_id, companyId, accountId, date, systemBalance.toFixed(4), new Decimal(actual).toFixed(4), difference.toFixed(4),
     reconciled ? 'RECONCILED' : 'BELUM_REKONSILIASI', notes, req.sessionUser!.id, reconciled ? req.sessionUser!.id : null, reconciled ? new Date() : null],
  );
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'RECONCILIATION',$3,'CREATE',$4::jsonb)`,
    [account.rows[0].workspace_id, req.sessionUser!.id, result.rows[0].id, JSON.stringify({ date, systemBalance: systemBalance.toFixed(4), actual, difference: difference.toFixed(4) })],
  );
  res.status(201).json(result.rows[0]);
});

cashBankRouter.post('/reconciliations/:reconciliationId/reconcile', async (req, res) => {
  const id = text(req.params.reconciliationId);
  const notes = nullable(req.body?.notes);
  const row = await query<{ id: string; workspace_id: string; company_id: string; status: string; notes: string | null }>(
    `SELECT id,workspace_id,company_id,status,notes FROM cash_bank_reconciliations WHERE id=$1`, [id],
  );
  if (!row.rowCount) return res.status(404).json({ error: 'RECONCILIATION_NOT_FOUND' });
  const r = row.rows[0];
  if (!(await canVerifyTransaction(req.sessionUser!.id, r.company_id))) return res.status(403).json({ error: 'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (r.status === 'RECONCILED') return res.json({ ok: true, status: 'RECONCILED' });
  await query(
    `UPDATE cash_bank_reconciliations SET status='RECONCILED',reconciled_by=$1,reconciled_at=NOW(),notes=COALESCE($2,notes) WHERE id=$3`,
    [req.sessionUser!.id, notes, id],
  );
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'RECONCILIATION',$3,'RECONCILED',$4::jsonb)`,
    [r.workspace_id, req.sessionUser!.id, id, JSON.stringify({ notes })],
  );
  res.json({ ok: true, status: 'RECONCILED' });
});
