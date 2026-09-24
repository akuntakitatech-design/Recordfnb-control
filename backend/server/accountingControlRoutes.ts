/**
 * accountingControlRoutes.ts — ringkasan Accounting Control Center.
 * Membagi transaksi Finance Verified menjadi: AUTO_OK (jurnal otomatis terbentuk & seimbang),
 * NEEDS_REVIEW (butuh keputusan Accounting: arah akun / mapping kategori belum ada),
 * ERROR (jurnal tidak terbentuk/tidak seimbang, akun nonaktif, atau periode HARD_CLOSED menghalangi posting).
 */
import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany } from './access.js';

export const accountingControlRouter = Router();
accountingControlRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }

const KIND: Record<string, string> = {
  CASH_OUT: 'Kas Keluar', CASH_IN: 'Kas Masuk', CASH_TRANSFER: 'Transfer Kas/Bank', PURCHASE_INVOICE: 'Invoice Pembelian',
  STOCK_USAGE: 'Pemakaian Barang', STOCK_TRANSFER: 'Transfer Barang', STOCK_OPNAME: 'Stock Opname', PRODUCTION: 'Produksi', SALES: 'Penjualan',
};

export function stageOf(workflowStatus: string, accountingStatus: string) {
  if (workflowStatus === 'DRAFT') return 'DRAFT';
  if (accountingStatus === 'POSTED' || workflowStatus === 'POSTED') return 'POSTED';
  if (accountingStatus === 'READY_TO_POST') return 'READY_TO_POST';
  if (accountingStatus === 'NEEDS_ACCOUNT_DIRECTION') return 'NEEDS_ACCOUNT_DIRECTION';
  if (accountingStatus === 'ACCOUNTING_REVIEW') return 'ACCOUNTING_REVIEW';
  return 'FINANCE_VERIFIED';
}

accountingControlRouter.get('/overview', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const result = await query(
    `SELECT t.id,t.transaction_type,t.transaction_number,t.transaction_date::text,t.grand_total::text,t.workflow_status,t.accounting_status,
            t.cash_out_type,t.cash_in_type,t.payment_type,COALESCE(bp.name,t.payee_name,t.source_name) counterparty,
            fa.name financial_account_name,l.name location_name,t.verified_at,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            j.id journal_id,j.journal_number,j.status journal_status,
            (SELECT COALESCE(SUM(jl.debit),0)::text FROM journal_lines jl WHERE jl.journal_id=j.id) journal_debit,
            (SELECT COALESCE(SUM(jl.credit),0)::text FROM journal_lines jl WHERE jl.journal_id=j.id) journal_credit,
            (SELECT COUNT(*)::int FROM journal_lines jl JOIN chart_of_accounts coa ON coa.id=jl.account_id WHERE jl.journal_id=j.id AND coa.status<>'ACTIVE') inactive_accounts,
            (SELECT p.status FROM accounting_periods p WHERE p.company_id=t.company_id AND t.transaction_date BETWEEN p.period_start AND p.period_end
              ORDER BY CASE p.status WHEN 'HARD_CLOSED' THEN 0 WHEN 'SOFT_CLOSED' THEN 1 ELSE 2 END LIMIT 1) period_status,
            (SELECT COUNT(*)::int FROM transaction_lines tl WHERE tl.transaction_id=t.id AND tl.expense_category_id IS NULL AND tl.account_id IS NULL) unmapped_lines,
            (SELECT GROUP_CONCAT(DISTINCT ec.name ORDER BY ec.name SEPARATOR ', ') FROM transaction_lines tl JOIN expense_categories ec ON ec.id=tl.expense_category_id WHERE tl.transaction_id=t.id) categories
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN journal_headers j ON j.source_transaction_id=t.id AND j.status<>'VOID'
      WHERE t.company_id=$1 AND t.workflow_status IN ('FINANCE_VERIFIED','POSTED')
      ORDER BY t.transaction_date DESC,t.created_at DESC
      LIMIT 300`,
    [companyId],
  );

  const rows = result.rows.map(r => {
    const stage = stageOf(r.workflow_status, r.accounting_status);
    let bucket: 'AUTO_OK' | 'NEEDS_REVIEW' | 'ERROR' | 'POSTED' = 'AUTO_OK';
    let issue = '';
    const debit = Number(r.journal_debit || 0);
    const credit = Number(r.journal_credit || 0);
    if (stage === 'POSTED') bucket = 'POSTED';
    else if (!r.journal_id && r.accounting_status === 'NEEDS_ACCOUNT_DIRECTION') { bucket = 'NEEDS_REVIEW'; issue = r.transaction_type === 'CASH_IN' ? 'Akun sumber dana belum ditentukan' : 'Kategori belum dipetakan ke akun — perlu arah akun'; }
    else if (!r.journal_id) { bucket = 'ERROR'; issue = 'Finance Verified tetapi jurnal belum terbentuk (engine gagal)'; }
    else if (debit <= 0 || Math.abs(debit - credit) > 0.0001) { bucket = 'ERROR'; issue = `Jurnal tidak seimbang (D ${debit} / K ${credit})`; }
    else if (Number(r.inactive_accounts || 0) > 0) { bucket = 'ERROR'; issue = 'Jurnal memakai akun nonaktif'; }
    else if (r.period_status === 'HARD_CLOSED' && r.journal_status !== 'POSTED') { bucket = 'ERROR'; issue = 'Periode HARD CLOSED — jurnal belum posted; koreksi lewat adjustment/reversal'; }
    return { ...r, kind: KIND[r.transaction_type] || r.transaction_type, stage, bucket, issue };
  });

  const counts = { auto_ok: 0, needs_review: 0, error: 0, posted: 0 };
  rows.forEach(r => {
    if (r.bucket === 'AUTO_OK') counts.auto_ok += 1;
    else if (r.bucket === 'NEEDS_REVIEW') counts.needs_review += 1;
    else if (r.bucket === 'ERROR') counts.error += 1;
    else counts.posted += 1;
  });
  const drafts = await query<{ n: number }>(
    `SELECT COUNT(*)::int n FROM transaction_headers WHERE company_id=$1 AND workflow_status='DRAFT' AND transaction_type IN ('CASH_OUT','CASH_IN','CASH_TRANSFER','PURCHASE_INVOICE')`,
    [companyId],
  );
  res.json({ counts: { ...counts, draft: drafts.rows[0]?.n || 0 }, rows });
});
