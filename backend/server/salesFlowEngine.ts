/**
 * salesFlowEngine.ts — Phase 2: POS -> Cash Drawer -> Rekonsiliasi -> Finance Verification -> Settlement.
 *
 * Prinsip:
 *  - Engine POS existing (salesImportEngine) tetap dipakai untuk membentuk SALES_INVOICE + jurnal + stok.
 *  - Rekonsiliasi per outlet + tanggal bisnis, per metode pembayaran: POS vs Aktual (Cash Drawer).
 *  - Finance tidak memilih akun. Akun berasal dari master metode pembayaran (Kas/Bank tujuan atau clearing Accounting).
 *  - Kas & Bank TIDAK punya ledger baru: baris sales_reconciliation_lines (CASH/BANK_DIRECT) & transaksi SALES_SETTLEMENT
 *    dibaca langsung oleh MUTATIONS di cashBankRoutes.
 *  - Selisih kas: SALES_DIFFERENCE -> akun CASH_DRAWER_VARIANCE. Selisih settlement -> SETTLEMENT_VARIANCE. MDR -> akun biaya metode.
 *  - Reopen hanya Accounting: transaksi lama di-VOID/di-reverse (tidak dihapus), lalu wajib verifikasi ulang.
 */
import Decimal from 'decimal.js';
import { pool, type PoolClient } from './db.js';
import { previewSalesBatchWithClient, verifySalesBatchWithClient, type SalesIssue, type SalesShortage } from './salesImportEngine.js';
import { assertPeriodAllows } from './periodGuard.js';
import { loadPosCodes } from './posPaymentCodes.js';

const ENGINE_VERSION = 'phase2-0.2';
const money = (v: unknown) => new Decimal((v as any) || 0);
const EPS = new Decimal(0.5);
type Exec = PoolClient | typeof pool;

export const REASONS: Record<string, string> = {
  SALAH_INPUT: 'Salah input', UANG_KURANG: 'Uang kurang', UANG_LEBIH: 'Uang lebih', SALAH_METODE_POS: 'Transaksi POS salah metode pembayaran',
  BELUM_TERCATAT: 'Transaksi belum tercatat', REFUND_CANCEL: 'Refund / cancel', ADJUSTMENT: 'Adjustment', LAINNYA: 'Alasan lain',
};
export const STATUS_LABEL: Record<string, string> = {
  BELUM_ADA_DATA: 'Belum ada data', MENUNGGU_POS: 'Menunggu POS', MENUNGGU_CASH_DRAWER: 'Menunggu Cash Drawer', ADA_SELISIH: 'Ada Selisih',
  SELISIH_DISELESAIKAN: 'Selisih Diselesaikan', COCOK: 'Cocok', FINANCE_VERIFIED: 'Finance Verified', MENUNGGU_SETTLEMENT: 'Menunggu Settlement', SETTLED: 'Settled',
};

export type LocationMethod = {
  id: string; name: string; code: string; pos_payment_code: string; method_type: string; evidence_policy: string; destination_behavior: string;
  financial_account_id: string | null; financial_account_name: string | null; reconcile_required: boolean; clearing_account_id: string | null;
  fee_account_id: string | null; coa_account_id: string | null; sort_order: number;
};

export async function loadLocationMethods(exec: Exec, locationId: string) {
  const r = await exec.query<LocationMethod>(
    `SELECT pm.id,pm.name,pm.code,pml.pos_payment_code,pm.method_type,pm.evidence_policy,pm.destination_behavior,pm.financial_account_id,
            fa.name financial_account_name,pm.reconcile_required,pm.clearing_account_id,pm.fee_account_id,fa.coa_account_id,pm.sort_order
       FROM payment_method_locations pml
       JOIN payment_methods pm ON pm.id=pml.payment_method_id AND pm.status='ACTIVE'
       LEFT JOIN financial_accounts fa ON fa.id=pm.financial_account_id
      WHERE pml.location_id=$1
      ORDER BY pm.sort_order,pm.name`,
    [locationId],
  );
  return r.rows;
}

async function loadLocation(exec: Exec, companyId: string, locationId: string) {
  const r = await exec.query<{ id: string; name: string; workspace_id: string; company_id: string }>(
    `SELECT l.id,l.name,c.workspace_id,l.company_id FROM locations l JOIN companies c ON c.id=l.company_id WHERE l.id=$1 AND l.company_id=$2`,
    [locationId, companyId],
  );
  if (!r.rowCount) throw new Error('LOCATION_OUTSIDE_COMPANY');
  return r.rows[0];
}

export async function nextNumber(exec: Exec, companyId: string, type: string, prefix: string, date: string, pad = 5) {
  const year = Number(String(date).slice(0, 4));
  const r = await exec.query<{ last_number: number }>(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number) VALUES($1,$2,$3,1)
     ON CONFLICT(company_id,transaction_type,sequence_year) DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,
    [companyId, type, year],
  );
  return `${prefix}-${year}-${String(r.rows[0].last_number).padStart(pad, '0')}`;
}

export type ReconLine = {
  payment_method_id: string | null; method_name: string; pos_payment_code: string; destination_behavior: string | null;
  destination_label: string; financial_account_id: string | null; evidence_policy: string;
  pos_amount: string; actual_amount: string; difference: string; evidence_required: boolean; evidence_missing: boolean;
  configured: boolean; resolution: null | { id: string; reason_code: string; reason_label: string; notes: string | null; created_at: string; created_by_name: string | null; valid: boolean; attachment_count: number };
  resolution_needed: boolean;
  settlement_status?: string; settled_amount?: string; fee_amount?: string; line_id?: string;
};

function destinationLabel(m: { destination_behavior: string | null; financial_account_name?: string | null; name?: string }) {
  if (m.destination_behavior === 'SETTLEMENT') return 'Menunggu settlement';
  if (m.destination_behavior === 'CASH_DIRECT' || m.destination_behavior === 'BANK_DIRECT') return m.financial_account_name || 'Kas/Bank belum dipilih';
  return '—';
}

/** Hitung rekonsiliasi POS vs Cash Drawer untuk satu outlet + tanggal. Tidak menulis apa pun. */
export async function computeReconciliation(exec: Exec, companyId: string, locationId: string, date: string) {
  const location = await loadLocation(exec, companyId, locationId);
  const headerRes = await exec.query(
    `SELECT sr.*,sr.business_date::text business_date,u.full_name verified_by_name FROM sales_reconciliations sr LEFT JOIN users u ON u.id=sr.verified_by
      WHERE sr.location_id=$1 AND sr.business_date=$2::date`, [locationId, date]);
  const header = headerRes.rows[0] || null;
  const methods = await loadLocationMethods(exec, locationId);

  // ---- Batch POS yang memuat tanggal ini
  const batchRes = await exec.query<{ id: string; batch_number: string; status: string; min_date: string; max_date: string; row_count: number; total_sales: string }>(
    `SELECT b.id,b.batch_number,b.status,MIN(r.sale_date)::text min_date,MAX(r.sale_date)::text max_date,b.row_count,b.total_sales::text total_sales
       FROM sales_import_batches b JOIN sales_import_rows r ON r.batch_id=b.id
      WHERE b.location_id=$1 AND b.company_id=$2 AND b.status IN ('DRAFT','FINANCE_VERIFIED')
        AND EXISTS(SELECT 1 FROM sales_import_rows r2 WHERE r2.batch_id=b.id AND r2.sale_date=$3::date)
      GROUP BY b.id,b.batch_number,b.status,b.row_count,b.total_sales
      ORDER BY b.created_at`,
    [locationId, companyId, date],
  );
  const batches = batchRes.rows;
  const draftBatches = batches.filter(b => b.status === 'DRAFT');
  const issues: SalesIssue[] = [];
  const shortages: SalesShortage[] = [];
  const invoices: Array<{ invoiceNumber: string; net: string; payments: Record<string, string>; batchNumber: string }> = [];
  const pos = new Map<string, Decimal>();
  let posCompliment = new Decimal(0);
  let posTotal = new Decimal(0);
  // Kode non-rekonsiliasi (mis. COMPLIMENT) tetap tercatat di penjualan, tetapi dikeluarkan dari rekonsiliasi & Kas/Bank.
  const excluded = new Set((await loadPosCodes(exec as any)).filter(c => !c.include_in_reconciliation).map(c => c.code));
  for (const b of draftBatches) {
    if (String(b.min_date).slice(0, 10) !== String(b.max_date).slice(0, 10)) {
      issues.push({ code: 'MULTI_DATE_BATCH', message: `Batch ${b.batch_number} berisi beberapa tanggal. Import ulang per tanggal atau hubungi Accounting.` });
    }
    const preview = await previewSalesBatchWithClient(exec as PoolClient, b.id);
    issues.push(...preview.issues);
    shortages.push(...preview.shortages);
    for (const inv of preview.invoices.filter(i => String(i.saleDate).slice(0, 10) === date)) {
      invoices.push({ invoiceNumber: inv.invoiceNumber, net: inv.net, payments: inv.payments, batchNumber: b.batch_number });
      posTotal = posTotal.add(inv.net);
      for (const [code, value] of Object.entries(inv.payments)) {
        if (excluded.has(code)) { posCompliment = posCompliment.add(value); continue; }
        pos.set(code, (pos.get(code) || new Decimal(0)).add(value));
      }
    }
  }

  // ---- Cash Drawer (semua shift dijumlah)
  const drawerRes = await exec.query(
    `SELECT d.id,d.shift_label,d.status,d.notes,d.business_date::text business_date,d.created_at,d.updated_at,cu.full_name created_by_name,uu.full_name updated_by_name
       FROM cash_drawers d LEFT JOIN users cu ON cu.id=d.created_by LEFT JOIN users uu ON uu.id=d.updated_by
      WHERE d.location_id=$1 AND d.business_date=$2::date ORDER BY d.shift_label`, [locationId, date]);
  const drawers = drawerRes.rows;
  const lineRes = drawers.length ? await exec.query(
    `SELECT dl.id,dl.cash_drawer_id,dl.payment_method_id,dl.actual_amount::text actual_amount,
            (SELECT COUNT(*) FROM attachments a WHERE a.entity_type='CASH_DRAWER_LINE' AND a.entity_id=dl.id) evidence_count,
            (SELECT a.id FROM attachments a WHERE a.entity_type='CASH_DRAWER_LINE' AND a.entity_id=dl.id ORDER BY a.uploaded_at DESC LIMIT 1) evidence_id
       FROM cash_drawer_lines dl WHERE dl.cash_drawer_id=ANY($1::uuid[])`, [drawers.map(d => d.id)]) : { rows: [] as any[] };
  const drawerLines = lineRes.rows.map(l => ({ ...l, evidence_count: Number(l.evidence_count || 0) }));
  for (const d of drawers) d.lines = drawerLines.filter(l => l.cash_drawer_id === d.id);

  // ---- Penyelesaian selisih aktif
  const resRes = header ? await exec.query(
    `SELECT r.id,r.payment_method_id,r.pos_payment_code,r.difference::text difference,r.reason_code,r.notes,r.status,r.created_at,u.full_name created_by_name,
            (SELECT COUNT(*) FROM attachments a WHERE a.entity_type='SALES_RECON_RESOLUTION' AND a.entity_id=r.id) attachment_count
       FROM sales_reconciliation_resolutions r LEFT JOIN users u ON u.id=r.created_by
      WHERE r.reconciliation_id=$1 ORDER BY r.created_at DESC`, [header.id]) : { rows: [] as any[] };
  const resolutions = resRes.rows;

  // ---- Baris per metode
  const lines: ReconLine[] = [];
  const usedCodes = new Set<string>();
  for (const m of methods) {
    usedCodes.add(m.pos_payment_code);
    const posAmount = pos.get(m.pos_payment_code) || new Decimal(0);
    const methodLines = drawerLines.filter(l => l.payment_method_id === m.id);
    const actual = methodLines.reduce((s, l) => s.add(l.actual_amount), new Decimal(0));
    const diff = actual.sub(posAmount);
    const evidenceRequired = m.evidence_policy === 'REQUIRED' && actual.gt(0);
    const evidenceMissing = evidenceRequired && methodLines.some(l => money(l.actual_amount).gt(0) && !l.evidence_count);
    const active = resolutions.find(r => r.status === 'ACTIVE' && r.payment_method_id === m.id);
    const resolutionValid = Boolean(active) && money(active.difference).sub(diff).abs().lte(EPS);
    lines.push({
      payment_method_id: m.id, method_name: m.name, pos_payment_code: m.pos_payment_code, destination_behavior: m.destination_behavior,
      destination_label: destinationLabel(m), financial_account_id: m.financial_account_id, evidence_policy: m.evidence_policy,
      pos_amount: posAmount.toFixed(4), actual_amount: actual.toFixed(4), difference: diff.toFixed(4),
      evidence_required: evidenceRequired, evidence_missing: evidenceMissing, configured: true,
      resolution: active ? { id: active.id, reason_code: active.reason_code, reason_label: REASONS[active.reason_code] || active.reason_code, notes: active.notes, created_at: active.created_at, created_by_name: active.created_by_name, valid: resolutionValid, attachment_count: Number(active.attachment_count || 0) } : null,
      resolution_needed: diff.abs().gt(EPS) && !resolutionValid,
    });
  }
  for (const [code, amount] of pos.entries()) {
    if (usedCodes.has(code) || amount.lte(0)) continue;
    lines.push({
      payment_method_id: null, method_name: `${code} (belum dikonfigurasi)`, pos_payment_code: code, destination_behavior: null, destination_label: '—',
      financial_account_id: null, evidence_policy: 'OPTIONAL', pos_amount: amount.toFixed(4), actual_amount: '0.0000', difference: amount.neg().toFixed(4),
      evidence_required: false, evidence_missing: false, configured: false, resolution: null, resolution_needed: true,
    });
  }

  // ---- Snapshot setelah verifikasi (sumber kebenaran pasca-verifikasi)
  let snapshot: any[] = [];
  if (header?.status === 'VERIFIED') {
    // Batch POS sudah FINANCE_VERIFIED -> invoice & total penjualan dibaca dari SALES_INVOICE hasil verifikasi ini (bukan draft).
    const inv = await exec.query(
      `SELECT t.reference_number,t.grand_total::text net,b.batch_number,
              (SELECT GROUP_CONCAT(CONCAT(JSON_VALUE(jl.metadata,'$.paymentCode'),'=',jl.debit) SEPARATOR ';') FROM journal_headers jh JOIN journal_lines jl ON jl.journal_id=jh.id
                WHERE jh.source_transaction_id=t.id AND jh.status<>'VOID' AND JSON_VALUE(jl.metadata,'$.paymentCode') IS NOT NULL AND jl.debit>0) pays
         FROM transaction_headers t LEFT JOIN sales_import_batches b ON b.id=t.sales_import_batch_id
        WHERE t.company_id=$1 AND t.location_id=$2 AND t.transaction_type='SALES_INVOICE' AND t.source_module='SALES_VERIFICATION' AND t.source_reference_id=$3
          AND t.workflow_status NOT IN ('VOID','CANCELLED') ORDER BY t.reference_number`, [companyId, locationId, header.id]);
    for (const r of inv.rows) {
      const payments: Record<string, string> = {};
      for (const part of String(r.pays || '').split(';').filter(Boolean)) {
        const [rawCode, value] = part.split('=');
        const code = String(rawCode || '').replace(/"/g, '');
        if (!code) continue;
        payments[code] = money(payments[code] || 0).add(value || 0).toFixed(4);
        if (excluded.has(code)) posCompliment = posCompliment.add(value || 0);
      }
      invoices.push({ invoiceNumber: r.reference_number, net: r.net, payments, batchNumber: r.batch_number || '' });
      posTotal = posTotal.add(r.net);
    }
    const s = await exec.query(
      `SELECT id,payment_method_id,pos_payment_code,method_name,destination_behavior,financial_account_id,pos_amount::text pos_amount,actual_amount::text actual_amount,
              difference::text difference,settled_amount::text settled_amount,fee_amount::text fee_amount,settlement_difference::text settlement_difference,settlement_status
         FROM sales_reconciliation_lines WHERE reconciliation_id=$1 AND line_status='ACTIVE' ORDER BY method_name`, [header.id]);
    snapshot = s.rows;
    for (const l of lines) {
      const snap = snapshot.find(x => x.payment_method_id === l.payment_method_id);
      if (snap) Object.assign(l, { pos_amount: snap.pos_amount, actual_amount: snap.actual_amount, difference: snap.difference, settlement_status: snap.settlement_status, settled_amount: snap.settled_amount, fee_amount: snap.fee_amount, line_id: snap.id, resolution_needed: false });
    }
  }

  const hasPos = draftBatches.length > 0 || batches.length > 0;
  const hasDrawer = drawers.length > 0;
  const blockers: string[] = [];
  let status: string;
  if (header?.status === 'VERIFIED') {
    const settle = snapshot.filter(x => x.settlement_status !== 'NOT_REQUIRED');
    status = settle.some(x => x.settlement_status === 'OUTSTANDING' || x.settlement_status === 'PARTIAL') ? 'MENUNGGU_SETTLEMENT' : settle.length ? 'SETTLED' : 'FINANCE_VERIFIED';
  } else {
    if (!draftBatches.length) blockers.push(batches.length ? 'Data POS tanggal ini sudah diverifikasi lewat alur lama.' : 'Data POS belum diimport Finance.');
    if (!hasDrawer) blockers.push('Cash Drawer outlet belum diisi.');
    if (!methods.length) blockers.push('Metode pembayaran outlet belum dikonfigurasi.');
    if (lines.some(l => !l.configured)) blockers.push('Ada metode pembayaran POS yang belum dikonfigurasi untuk outlet ini.');
    if (lines.some(l => l.configured && l.resolution_needed)) blockers.push('Masih ada selisih yang belum diselesaikan.');
    if (lines.some(l => l.evidence_missing)) blockers.push('Bukti foto wajib belum lengkap.');
    issues.forEach(i => blockers.push(i.message));
    if (!draftBatches.length && !hasDrawer) status = 'BELUM_ADA_DATA';
    else if (!draftBatches.length) status = 'MENUNGGU_POS';
    else if (!hasDrawer) status = 'MENUNGGU_CASH_DRAWER';
    else if (lines.some(l => l.resolution_needed)) status = 'ADA_SELISIH';
    else if (lines.some(l => money(l.difference).abs().gt(EPS))) status = 'SELISIH_DISELESAIKAN';
    else status = 'COCOK';
  }
  const sum = (k: 'pos_amount' | 'actual_amount' | 'difference') => lines.reduce((s, l) => s.add(l[k]), new Decimal(0)).toFixed(4);
  return {
    location: { id: location.id, name: location.name }, companyId, date, header, status, status_label: STATUS_LABEL[status],
    can_verify: !header || header.status !== 'VERIFIED' ? blockers.length === 0 && ['COCOK', 'SELISIH_DISELESAIKAN'].includes(status) : false,
    blockers, issues, shortages, lines, drawers, batches, invoices, resolutions,
    totals: { pos: sum('pos_amount'), actual: sum('actual_amount'), difference: sum('difference'), pos_sales: posTotal.toFixed(4), compliment: posCompliment.toFixed(4) },
    _internal: { workspaceId: location.workspace_id, methods, draftBatches },
  };
}

export function publicRecon(r: Awaited<ReturnType<typeof computeReconciliation>>) {
  const { _internal, ...rest } = r;
  return rest;
}

async function ensureHeader(client: PoolClient, workspaceId: string, companyId: string, locationId: string, date: string, userId: string) {
  await client.query(
    `INSERT INTO sales_reconciliations(workspace_id,company_id,location_id,business_date,created_by) VALUES($1,$2,$3,$4::date,$5)
     ON CONFLICT(location_id,business_date) DO NOTHING`, [workspaceId, companyId, locationId, date, userId]);
  const r = await client.query(`SELECT id,status FROM sales_reconciliations WHERE location_id=$1 AND business_date=$2::date FOR UPDATE`, [locationId, date]);
  return r.rows[0] as { id: string; status: string };
}

export async function resolveDifference(companyId: string, locationId: string, date: string, paymentMethodId: string, reasonCode: string, notes: string, userId: string) {
  if (!REASONS[reasonCode]) throw new Error('INVALID_RESOLUTION_REASON');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recon = await computeReconciliation(client, companyId, locationId, date);
    const line = recon.lines.find(l => l.payment_method_id === paymentMethodId);
    if (!line) throw new Error('PAYMENT_METHOD_NOT_IN_RECONCILIATION');
    if (money(line.difference).abs().lte(EPS)) throw new Error('NO_DIFFERENCE_TO_RESOLVE');
    const header = await ensureHeader(client, recon._internal.workspaceId, companyId, locationId, date, userId);
    if (header.status === 'VERIFIED') throw new Error('RECONCILIATION_ALREADY_VERIFIED');
    await client.query(`UPDATE sales_reconciliation_resolutions SET status='SUPERSEDED' WHERE reconciliation_id=$1 AND payment_method_id=$2 AND status='ACTIVE'`, [header.id, paymentMethodId]);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO sales_reconciliation_resolutions(reconciliation_id,payment_method_id,pos_payment_code,pos_amount,actual_amount,difference,reason_code,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [header.id, paymentMethodId, line.pos_payment_code, line.pos_amount, line.actual_amount, line.difference, reasonCode, notes || null, userId]);
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'SALES_RECONCILIATION',$3,'RESOLVE_DIFFERENCE',$4::jsonb)`,
      [recon._internal.workspaceId, userId, header.id, JSON.stringify({ paymentMethodId, method: line.method_name, pos: line.pos_amount, actual: line.actual_amount, difference: line.difference, reasonCode, notes })]);
    await client.query('COMMIT');
    return { id: ins.rows[0].id, reconciliationId: header.id };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

export const VARIANCE_ROLES = {
  CASH_DRAWER_VARIANCE: 'Selisih Kas (Cash Drawer)',
  SETTLEMENT_VARIANCE: 'Selisih Settlement',
} as const;
export type VarianceRole = keyof typeof VARIANCE_ROLES;

/** Akun selisih terpisah (important_accounts). Tidak ada fallback ke CASH_BANK_VARIANCE. */
async function varianceAccount(exec: Exec, companyId: string, role: VarianceRole) {
  const r = await exec.query<{ account_id: string }>(
    `SELECT ia.account_id FROM important_accounts ia JOIN chart_of_accounts coa ON coa.id=ia.account_id AND coa.status='ACTIVE'
      WHERE ia.company_id=$1 AND ia.role_code=$2 LIMIT 1`, [companyId, role]);
  return r.rows[0]?.account_id || null;
}

/**
 * Tiga perlakuan accounting yang WAJIB terpisah:
 *   MDR/Admin Fee (payment_methods.fee_account_id, akun beban)  ≠  CASH_DRAWER_VARIANCE  ≠  SETTLEMENT_VARIANCE.
 * Dipakai oleh master Payment Method, master akun selisih, dan endpoint important-accounts generik (COA standar).
 */
export const FEE_ACCOUNT_TYPES = ['EXPENSE', 'OTHER_EXPENSE'] as const;
export const VARIANCE_ACCOUNT_TYPES = ['EXPENSE', 'OTHER_EXPENSE', 'OTHER_INCOME'] as const;

async function accountRow(exec: Exec, companyId: string, accountId: string) {
  const r = await exec.query<{ account_type: string; normal_balance: string }>(
    `SELECT account_type,normal_balance FROM chart_of_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [accountId, companyId]);
  return r.rows[0] || null;
}

/** null = valid; selain itu kode error. MDR boleh akun beban (EXPENSE/OTHER_EXPENSE) atau kontra-pendapatan bersaldo normal debit. */
export async function validateFeeAccount(exec: Exec, companyId: string, accountId: string) {
  const a = await accountRow(exec, companyId, accountId);
  if (!a) return 'INVALID_MAPPING_ACCOUNT';
  const contraRevenue = a.account_type === 'REVENUE' && a.normal_balance === 'DEBIT';
  if (!(FEE_ACCOUNT_TYPES as readonly string[]).includes(a.account_type) && !contraRevenue) return 'FEE_ACCOUNT_MUST_BE_EXPENSE';
  const v = await exec.query(`SELECT 1 FROM important_accounts WHERE company_id=$1 AND role_code IN ('CASH_DRAWER_VARIANCE','SETTLEMENT_VARIANCE') AND account_id=$2`, [companyId, accountId]);
  if (v.rowCount) return 'FEE_ACCOUNT_CANNOT_BE_VARIANCE';
  return null;
}

/** Clearing settlement = akun aset (piutang/clearing), bukan beban/selisih. */
export async function validateClearingAccount(exec: Exec, companyId: string, accountId: string) {
  const a = await accountRow(exec, companyId, accountId);
  if (!a) return 'INVALID_MAPPING_ACCOUNT';
  if (a.account_type !== 'ASSET') return 'CLEARING_ACCOUNT_MUST_BE_ASSET';
  return null;
}

/** Akun Selisih Kas & Selisih Settlement harus berbeda satu sama lain dan tidak boleh akun MDR/Admin Fee metode mana pun. */
export async function validateVarianceAccount(exec: Exec, companyId: string, role: VarianceRole, accountId: string) {
  const a = await accountRow(exec, companyId, accountId);
  if (!a) return 'INVALID_MAPPING_ACCOUNT';
  if (!(VARIANCE_ACCOUNT_TYPES as readonly string[]).includes(a.account_type)) return 'VARIANCE_ACCOUNT_MUST_BE_PROFIT_LOSS';
  const other: VarianceRole = role === 'CASH_DRAWER_VARIANCE' ? 'SETTLEMENT_VARIANCE' : 'CASH_DRAWER_VARIANCE';
  const o = await exec.query(`SELECT 1 FROM important_accounts WHERE company_id=$1 AND role_code=$2 AND account_id=$3`, [companyId, other, accountId]);
  if (o.rowCount) return 'VARIANCE_ACCOUNTS_MUST_DIFFER';
  const f = await exec.query(`SELECT 1 FROM payment_methods WHERE company_id=$1 AND fee_account_id=$2 AND status='ACTIVE'`, [companyId, accountId]);
  if (f.rowCount) return 'VARIANCE_ACCOUNT_IS_MDR_ACCOUNT';
  return null;
}

function methodAccount(m: LocationMethod) {
  return m.destination_behavior === 'SETTLEMENT' ? m.clearing_account_id : m.coa_account_id;
}

/** Verifikasi Penjualan per outlet + tanggal (atomik). */
export async function verifyReconciliation(companyId: string, locationId: string, date: string, userId: string, allowBelowZero = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pre = await computeReconciliation(client, companyId, locationId, date);
    const header = await ensureHeader(client, pre._internal.workspaceId, companyId, locationId, date, userId);
    if (header.status === 'VERIFIED') throw new Error('RECONCILIATION_ALREADY_VERIFIED');
    const roundRes = await client.query<{ verification_round: number }>(`SELECT verification_round FROM sales_reconciliations WHERE id=$1`, [header.id]);
    const round = Number(roundRes.rows[0]?.verification_round || 0) + 1;
    const recon = await computeReconciliation(client, companyId, locationId, date);
    const blockingShortage = recon.shortages.length > 0 && !allowBelowZero;
    if (!recon.can_verify) throw new Error(`RECONCILIATION_NOT_READY:${recon.blockers[0] || recon.status}`);
    if (blockingShortage) throw new Error('INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED');
    await assertPeriodAllows(client, companyId, date, 'FINANCE');
    const { workspaceId, methods, draftBatches } = recon._internal;

    let invoiceCount = 0;
    for (const b of draftBatches) {
      const r = await verifySalesBatchWithClient(client, b.id, userId, allowBelowZero, { module: 'SALES_VERIFICATION', referenceId: header.id });
      invoiceCount += r.transactionCount || 0;
    }
    const prevNumber = (await client.query<{ reconciliation_number: string | null }>(`SELECT reconciliation_number FROM sales_reconciliations WHERE id=$1`, [header.id])).rows[0]?.reconciliation_number;
    const number = prevNumber ? `${prevNumber.replace(/-R\d+$/, '')}-R${round}` : await nextNumber(client, companyId, 'SALES_RECONCILIATION', 'RS', date);

    // ---- Selisih -> SALES_DIFFERENCE (penyesuaian akun metode ke nilai aktual; sisa bersih ke CASH_DRAWER_VARIANCE / Selisih Kas)
    const diffLines = recon.lines.filter(l => l.configured && money(l.difference).abs().gt(EPS));
    let differenceTxId: string | null = null;
    if (diffLines.length) {
      const variance = await varianceAccount(client, companyId, 'CASH_DRAWER_VARIANCE');
      const net = diffLines.reduce((s, l) => s.add(l.difference), new Decimal(0));
      const gross = Decimal.max(diffLines.filter(l => money(l.difference).gt(0)).reduce((s, l) => s.add(l.difference), new Decimal(0)),
        diffLines.filter(l => money(l.difference).lt(0)).reduce((s, l) => s.add(money(l.difference).abs()), new Decimal(0)));
      const accounts = diffLines.map(l => methodAccount(methods.find(m => m.id === l.payment_method_id)!));
      const mappingOk = accounts.every(Boolean) && (net.abs().lte(EPS) || Boolean(variance));
      const txNumber = await nextNumber(client, companyId, 'SALES_DIFFERENCE', 'SP', date);
      const tx = await client.query<{ id: string }>(
        `INSERT INTO transaction_headers(workspace_id,company_id,location_id,transaction_type,transaction_number,transaction_date,reference_number,
           workflow_status,operational_status,accounting_status,payment_status,gross_amount,dpp_amount,grand_total,notes,created_by,updated_by,verified_by,verified_at,
           source_module,source_reference_id,source_name)
         VALUES($1,$2,$3,'SALES_DIFFERENCE',$4,$5::date,$6,'FINANCE_VERIFIED','FINANCE_VERIFIED',$7,'PAID',$8,$8,$8,$9,$10,$10,$10,NOW(),'SALES_VERIFICATION',$11,'Selisih penjualan')
         RETURNING id`,
        [workspaceId, companyId, locationId, txNumber, date, number, mappingOk ? 'ACCOUNTING_REVIEW' : 'NEEDS_ACCOUNT_DIRECTION', gross.toFixed(4),
         `Selisih POS vs aktual ${recon.location.name} ${date}: ${diffLines.map(l => `${l.method_name} ${money(l.difference).toFixed(0)}`).join(', ')}`, userId, header.id]);
      differenceTxId = tx.rows[0].id;
      let lineNo = 1;
      for (const [i, l] of diffLines.entries()) {
        const res = recon.lines.find(x => x.payment_method_id === l.payment_method_id)?.resolution;
        await client.query(
          `INSERT INTO transaction_lines(transaction_id,line_no,line_type,account_id,description,quantity,unit_price,gross_amount,dpp_amount,line_total,location_id,metadata)
           VALUES($1,$2,'MEMO',$3,$4,1,$5,$5,$5,$5,$6,$7::jsonb)`,
          [differenceTxId, lineNo++, accounts[i], `${l.method_name}: ${res?.reason_label || 'Selisih'}${res?.notes ? ` — ${res.notes}` : ''}`, l.difference, locationId,
           JSON.stringify({ paymentMethodId: l.payment_method_id, pos: l.pos_amount, actual: l.actual_amount, reasonCode: res?.reason_code })]);
      }
      if (mappingOk) {
        const j = await client.query<{ id: string }>(
          `INSERT INTO journal_headers(workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
           VALUES($1,$2,$3,$4::date,'AUTO_SALES_DIFFERENCE',$5,'DRAFT',$6,$7) RETURNING id`,
          [workspaceId, companyId, `AJ-${txNumber}`, date, differenceTxId, `Selisih penjualan ${recon.location.name} ${date}`, ENGINE_VERSION]);
        let jl = 1;
        const addLine = async (account: string, debit: Decimal, credit: Decimal, desc: string) => client.query(
          `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
          [j.rows[0].id, jl++, account, debit.toFixed(4), credit.toFixed(4), desc, locationId]);
        for (const [i, l] of diffLines.entries()) {
          const d = money(l.difference);
          await addLine(accounts[i]!, d.gt(0) ? d : new Decimal(0), d.lt(0) ? d.abs() : new Decimal(0), `Selisih ${l.method_name}`);
        }
        if (net.abs().gt(EPS)) await addLine(variance!, net.lt(0) ? net.abs() : new Decimal(0), net.gt(0) ? net : new Decimal(0), net.lt(0) ? 'Kekurangan penjualan' : 'Kelebihan penjualan');
      }
    }

    // ---- Snapshot per metode + register settlement
    for (const l of recon.lines.filter(x => x.configured)) {
      const settlement = l.destination_behavior === 'SETTLEMENT' && money(l.actual_amount).gt(0) ? 'OUTSTANDING' : 'NOT_REQUIRED';
      await client.query(
        `INSERT INTO sales_reconciliation_lines(reconciliation_id,company_id,location_id,business_date,payment_method_id,pos_payment_code,method_name,destination_behavior,
           financial_account_id,pos_amount,actual_amount,difference,settlement_status,verification_round,line_status)
         VALUES($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ACTIVE')`,
        [header.id, companyId, locationId, date, l.payment_method_id, l.pos_payment_code, l.method_name, l.destination_behavior,
         l.destination_behavior === 'SETTLEMENT' ? null : l.financial_account_id, l.pos_amount, l.actual_amount, l.difference, settlement, round]);
    }
    await client.query(
      `UPDATE sales_reconciliations SET status='VERIFIED',reconciliation_number=$1,pos_total=$2,actual_total=$3,difference_total=$4,difference_transaction_id=$5,
              verified_by=$6,verified_at=NOW(),updated_at=NOW(),verification_round=$8 WHERE id=$7`,
      [number, recon.totals.pos, recon.totals.actual, recon.totals.difference, differenceTxId, userId, header.id, round]);
    await client.query(`UPDATE cash_drawers SET status='LOCKED',locked_at=NOW(),reconciliation_id=$1 WHERE location_id=$2 AND business_date=$3::date`, [header.id, locationId, date]);
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'SALES_RECONCILIATION',$3,'FINANCE_VERIFY_SALES',$4::jsonb)`,
      [workspaceId, userId, header.id, JSON.stringify({ number, round, date, locationId, invoiceCount, totals: recon.totals, differenceTxId, allowBelowZero })]);
    await client.query('COMMIT');
    return { reconciliationId: header.id, reconciliationNumber: number, invoiceCount, differenceTransactionId: differenceTxId };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// ---------------------------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------------------------
export async function outstandingSettlements(exec: Exec, companyId: string, filter: { paymentMethodId?: string; locationId?: string }) {
  const r = await exec.query(
    `SELECT srl.id,srl.reconciliation_id,sr.reconciliation_number,srl.business_date::text business_date,srl.location_id,l.name location_name,srl.payment_method_id,
            srl.method_name,srl.pos_payment_code,srl.actual_amount::text expected_amount,srl.settled_amount::text settled_amount,srl.fee_amount::text fee_amount,
            (srl.actual_amount-srl.settled_amount)::text remaining,srl.settlement_status,pm.financial_account_id default_financial_account_id
       FROM sales_reconciliation_lines srl JOIN sales_reconciliations sr ON sr.id=srl.reconciliation_id JOIN locations l ON l.id=srl.location_id
       JOIN payment_methods pm ON pm.id=srl.payment_method_id
      WHERE srl.company_id=$1 AND srl.line_status='ACTIVE' AND srl.settlement_status IN ('OUTSTANDING','PARTIAL')
        AND ($2='' OR srl.payment_method_id=$2) AND ($3='' OR srl.location_id=$3)
      ORDER BY srl.method_name,srl.business_date,l.name`,
    [companyId, filter.paymentMethodId || '', filter.locationId || '']);
  return r.rows;
}

async function settlementModule(exec: Exec, code: string) {
  const def = (await loadPosCodes(exec as any, true)).find(c => c.code === code);
  return def && def.settlement_module && def.settlement_module !== 'NONE' ? def.settlement_module : 'CHANNEL_SETTLEMENT';
}

export type SettlementInput = {
  companyId: string; financialAccountId: string; settlementDate: string; reference: string; notes: string;
  netAmount: number; feeAmount: number; acceptDifference: boolean; allocations: Array<{ lineId: string; grossAmount: number }>;
};

export async function recordSettlement(input: SettlementInput, userId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!input.allocations.length) throw new Error('SETTLEMENT_ALLOCATION_REQUIRED');
    const net = money(input.netAmount); const fee = money(input.feeAmount);
    if (net.lt(0) || fee.lt(0) || net.add(fee).lte(0)) throw new Error('SETTLEMENT_AMOUNT_INVALID');
    const lines: any[] = [];
    for (const a of input.allocations) {
      const r = await client.query(
        `SELECT srl.*,srl.business_date::text business_date FROM sales_reconciliation_lines srl WHERE srl.id=$1 AND srl.company_id=$2 AND srl.line_status='ACTIVE' FOR UPDATE`, [a.lineId, input.companyId]);
      const line = r.rows[0];
      if (!line || !['OUTSTANDING', 'PARTIAL'].includes(line.settlement_status)) throw new Error('SETTLEMENT_LINE_NOT_OUTSTANDING');
      const gross = money(a.grossAmount);
      const remaining = money(line.actual_amount).sub(line.settled_amount);
      if (gross.lte(0) || gross.gt(remaining.add(EPS))) throw new Error(`SETTLEMENT_EXCEEDS_OUTSTANDING_${line.method_name}_${line.business_date}`);
      lines.push({ ...line, gross, remaining });
      // Validasi struktural lebih dulu (sebelum cek selisih) agar pesan error jelas.
      if (new Set(lines.map(l => l.payment_method_id)).size > 1) throw new Error('SETTLEMENT_SINGLE_METHOD_REQUIRED');
      if (new Set(lines.map(l => l.location_id)).size > 1) throw new Error('SETTLEMENT_SINGLE_OUTLET_REQUIRED');
    }
    const sumGross = lines.reduce((s, l) => s.add(l.gross), new Decimal(0));
    const difference = sumGross.sub(net).sub(fee); // >0: bank menerima lebih kecil dari seharusnya
    if (difference.abs().gt(EPS) && !input.acceptDifference) throw new Error(`SETTLEMENT_DIFFERENCE_CONFIRMATION_REQUIRED:${difference.toFixed(0)}`);
    await assertPeriodAllows(client, input.companyId, input.settlementDate, 'FINANCE');

    const fa = await client.query(`SELECT id,coa_account_id,name,account_kind FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE' AND account_kind IN ('BANK','EWALLET','CASH')`, [input.financialAccountId, input.companyId]);
    if (!fa.rowCount) throw new Error('SETTLEMENT_BANK_ACCOUNT_REQUIRED');
    const pm = await client.query(`SELECT pm.*,c.workspace_id FROM payment_methods pm JOIN companies c ON c.id=pm.company_id WHERE pm.id=$1`, [lines[0].payment_method_id]);
    const method = pm.rows[0];
    const variance = await varianceAccount(client, input.companyId, 'SETTLEMENT_VARIANCE');
    const mappingOk = Boolean(method.clearing_account_id) && (fee.lte(0) || Boolean(method.fee_account_id)) && (difference.abs().lte(EPS) || Boolean(variance))
      && !(fee.gt(0) && method.fee_account_id && method.fee_account_id === variance); // MDR tidak boleh jatuh ke akun Selisih Settlement
    const module = await settlementModule(client, lines[0].pos_payment_code);
    const txNumber = await nextNumber(client, input.companyId, 'SALES_SETTLEMENT', 'ST', input.settlementDate);
    const tx = await client.query<{ id: string }>(
      `INSERT INTO transaction_headers(workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,transaction_date,reference_number,
         workflow_status,operational_status,accounting_status,payment_status,gross_amount,dpp_amount,grand_total,notes,created_by,updated_by,verified_by,verified_at,
         source_module,source_reference_id,source_name)
       VALUES($1,$2,$3,$4,'SALES_SETTLEMENT',$5,$6::date,$7,'FINANCE_VERIFIED','FINANCE_VERIFIED',$8,'PAID',$9,$9,$10,$11,$12,$12,$12,NOW(),$13,$14,$15)
       RETURNING id`,
      [method.workspace_id, input.companyId, lines[0].location_id, input.financialAccountId, txNumber, input.settlementDate, input.reference || null,
       mappingOk ? 'ACCOUNTING_REVIEW' : 'NEEDS_ACCOUNT_DIRECTION', sumGross.toFixed(4), net.toFixed(4),
       input.notes || `Settlement ${method.name} ${lines.map(l => l.business_date).join(', ')}`, userId, module, method.id, `Settlement ${method.name}`]);
    const txId = tx.rows[0].id;
    let lineNo = 1;
    const addTxLine = (desc: string, amount: Decimal, meta: object) => client.query(
      `INSERT INTO transaction_lines(transaction_id,line_no,line_type,description,quantity,unit_price,gross_amount,dpp_amount,line_total,location_id,metadata)
       VALUES($1,$2,'MEMO',$3,1,$4,$4,$4,$4,$5,$6::jsonb)`, [txId, lineNo++, desc, amount.toFixed(4), lines[0].location_id, JSON.stringify(meta)]);
    await addTxLine(`Penjualan ${method.name} diterima`, sumGross, { kind: 'GROSS', dates: lines.map(l => l.business_date) });
    if (fee.gt(0)) await addTxLine('MDR / biaya admin', fee, { kind: 'FEE' });
    if (difference.abs().gt(EPS)) await addTxLine('Selisih settlement', difference, { kind: 'DIFFERENCE' });

    if (mappingOk) {
      const j = await client.query<{ id: string }>(
        `INSERT INTO journal_headers(workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
         VALUES($1,$2,$3,$4::date,'AUTO_SALES_SETTLEMENT',$5,'DRAFT',$6,$7) RETURNING id`,
        [method.workspace_id, input.companyId, `AJ-${txNumber}`, input.settlementDate, txId, `Settlement ${method.name}`, ENGINE_VERSION]);
      let jl = 1;
      const add = (account: string, debit: Decimal, credit: Decimal, desc: string) => client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'{}')`,
        [j.rows[0].id, jl++, account, debit.toFixed(4), credit.toFixed(4), desc, lines[0].location_id]);
      if (net.gt(0)) await add(fa.rows[0].coa_account_id, net, new Decimal(0), `Penerimaan settlement ${method.name}`);
      if (fee.gt(0)) await add(method.fee_account_id, fee, new Decimal(0), `MDR/admin ${method.name}`);
      if (difference.gt(EPS)) await add(variance!, difference, new Decimal(0), 'Selisih settlement (kurang)');
      if (difference.lt(EPS.neg())) await add(variance!, new Decimal(0), difference.abs(), 'Selisih settlement (lebih)');
      await add(method.clearing_account_id, new Decimal(0), sumGross, `Pelunasan clearing ${method.name}`);
    }

    // ---- Alokasi & status outstanding (fee/selisih dibagi proporsional ke baris)
    for (const l of lines) {
      const share = sumGross.gt(0) ? l.gross.div(sumGross) : new Decimal(0);
      const settled = money(l.settled_amount).add(l.gross);
      const done = money(l.actual_amount).sub(settled).abs().lte(EPS);
      await client.query(
        `INSERT INTO sales_settlement_allocations(settlement_transaction_id,reconciliation_line_id,gross_amount,fee_amount,difference_amount,previous_status,status)
         VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')`,
        [txId, l.id, l.gross.toFixed(4), fee.mul(share).toFixed(4), difference.mul(share).toFixed(4), l.settlement_status]);
      await client.query(
        `UPDATE sales_reconciliation_lines SET settled_amount=$1,fee_amount=fee_amount+$2,settlement_difference=settlement_difference+$3,settlement_status=$4,updated_at=NOW() WHERE id=$5`,
        [settled.toFixed(4), fee.mul(share).toFixed(4), difference.mul(share).toFixed(4), done ? 'SETTLED' : 'PARTIAL', l.id]);
    }
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'TRANSACTION',$3,'RECORD_SALES_SETTLEMENT',$4::jsonb)`,
      [method.workspace_id, userId, txId, JSON.stringify({ txNumber, method: method.name, gross: sumGross.toFixed(4), net: net.toFixed(4), fee: fee.toFixed(4), difference: difference.toFixed(4), allocations: input.allocations })]);
    await client.query('COMMIT');
    return { id: txId, transactionNumber: txNumber, gross: sumGross.toFixed(4), net: net.toFixed(4), fee: fee.toFixed(4), difference: difference.toFixed(4), accountingStatus: mappingOk ? 'ACCOUNTING_REVIEW' : 'NEEDS_ACCOUNT_DIRECTION' };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// ---------------------------------------------------------------------------------------------
// Koreksi terkontrol (Accounting Control): batal settlement & reopen verifikasi. Tidak ada histori yang dihapus.
// ---------------------------------------------------------------------------------------------
/** VOID jurnal yang belum POSTED; jurnal POSTED dibalik lewat jurnal REVERSAL (READY). */
async function neutralizeJournals(client: PoolClient, transactionId: string, userId: string, reason: string) {
  const js = await client.query<{ id: string; workspace_id: string; company_id: string; journal_number: string; journal_date: string; status: string }>(
    `SELECT id,workspace_id,company_id,journal_number,journal_date::text journal_date,status FROM journal_headers WHERE source_transaction_id=$1 AND status<>'VOID'`, [transactionId]);
  const out: Array<{ journalId: string; action: 'VOID' | 'REVERSAL'; reversalId?: string }> = [];
  for (const j of js.rows) {
    if (j.status !== 'POSTED') {
      await client.query(`UPDATE journal_headers SET status='VOID' WHERE id=$1`, [j.id]);
      out.push({ journalId: j.id, action: 'VOID' });
      continue;
    }
    const date = String(j.journal_date).slice(0, 10);
    const seq = await client.query<{ last_number: number }>(
      `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number) VALUES($1,'JOURNAL_REVERSAL',$2,1)
       ON CONFLICT(company_id,transaction_type,sequence_year) DO UPDATE SET last_number=document_sequences.last_number+1 RETURNING last_number`,
      [j.company_id, Number(date.slice(0, 4))]);
    const number = `RV-${date.slice(0, 4)}-${String(seq.rows[0].last_number).padStart(5, '0')}`;
    const created = await client.query<{ id: string }>(
      `INSERT INTO journal_headers(workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version,reviewed_by,reviewed_at)
       VALUES($1,$2,$3,$4::date,'REVERSAL',NULL,'READY',$5,$6,$7,NOW()) RETURNING id`,
      [j.workspace_id, j.company_id, number, date, `Reversal ${j.journal_number} — ${reason}`, ENGINE_VERSION, userId]);
    const lines = await client.query(`SELECT account_id,debit::text debit,credit::text credit,description,location_id,item_id FROM journal_lines WHERE journal_id=$1 ORDER BY line_no`, [j.id]);
    let n = 1;
    for (const l of lines.rows) {
      await client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,item_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [created.rows[0].id, n++, l.account_id, l.credit, l.debit, `Reversal: ${l.description || j.journal_number}`, l.location_id, l.item_id,
         JSON.stringify({ reversalOfJournalId: j.id, reversalOfJournalNumber: j.journal_number, reason })]);
    }
    out.push({ journalId: j.id, action: 'REVERSAL', reversalId: created.rows[0].id });
  }
  return out;
}

/** Kembalikan stok SALE_OUT dari transaksi penjualan (movement ADJUSTMENT_IN, moving average dipulihkan). */
async function restoreSaleStock(client: PoolClient, transactionId: string, userId: string) {
  const mv = await client.query(
    `SELECT workspace_id,company_id,location_id,item_id,source_transaction_line_id,quantity::text quantity,unit_cost::text unit_cost
       FROM inventory_movements WHERE source_transaction_id=$1 AND movement_type='SALE_OUT'`, [transactionId]);
  for (const m of mv.rows) {
    const bal = await client.query<{ quantity_on_hand: string; average_cost: string }>(
      `SELECT quantity_on_hand::text,average_cost::text FROM inventory_balances WHERE company_id=$1 AND location_id=$2 AND item_id=$3 FOR UPDATE`,
      [m.company_id, m.location_id, m.item_id]);
    const before = money(bal.rows[0]?.quantity_on_hand); const avg = money(bal.rows[0]?.average_cost);
    const qty = money(m.quantity); const cost = money(m.unit_cost);
    const after = before.add(qty);
    const newAvg = before.gt(0) && after.gt(0) ? before.mul(avg).add(qty.mul(cost)).div(after) : cost;
    await client.query(`UPDATE inventory_balances SET quantity_on_hand=$1,average_cost=$2,updated_at=NOW() WHERE company_id=$3 AND location_id=$4 AND item_id=$5`,
      [after.toFixed(6), newAvg.toFixed(6), m.company_id, m.location_id, m.item_id]);
    await client.query(
      `INSERT INTO inventory_movements(workspace_id,company_id,location_id,item_id,source_transaction_id,source_transaction_line_id,
         movement_type,quantity,unit_cost,movement_value,quantity_after,average_cost_after,created_by)
       VALUES($1,$2,$3,$4,$5,$6,'ADJUSTMENT_IN',$7,$8,$9,$10,$11,$12)`,
      [m.workspace_id, m.company_id, m.location_id, m.item_id, transactionId, m.source_transaction_line_id, qty.toFixed(6), cost.toFixed(6),
       qty.mul(cost).toFixed(4), after.toFixed(6), newAvg.toFixed(6), userId]);
  }
  return mv.rowCount || 0;
}

/** Batal settlement (Accounting): transaksi CANCELLED, jurnal VOID/REVERSAL, alokasi REVERSED, outstanding dipulihkan. */
export async function cancelSettlement(companyId: string, settlementId: string, reason: string, userId: string) {
  if (!reason.trim()) throw new Error('CANCEL_REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(`SELECT id,workspace_id,transaction_number,transaction_date::text transaction_date,workflow_status FROM transaction_headers
      WHERE id=$1 AND company_id=$2 AND transaction_type='SALES_SETTLEMENT' FOR UPDATE`, [settlementId, companyId]);
    const tx = t.rows[0];
    if (!tx) throw new Error('SETTLEMENT_NOT_FOUND');
    if (['CANCELLED', 'VOID'].includes(tx.workflow_status)) throw new Error('SETTLEMENT_ALREADY_CANCELLED');
    await assertPeriodAllows(client, companyId, tx.transaction_date, 'ACCOUNTING');
    const allocs = await client.query(`SELECT id,reconciliation_line_id,gross_amount::text gross_amount,fee_amount::text fee_amount,difference_amount::text difference_amount
      FROM sales_settlement_allocations WHERE settlement_transaction_id=$1 AND status='ACTIVE'`, [settlementId]);
    for (const a of allocs.rows) {
      const l = (await client.query(`SELECT settled_amount::text settled_amount,line_status FROM sales_reconciliation_lines WHERE id=$1 FOR UPDATE`, [a.reconciliation_line_id])).rows[0];
      const settled = Decimal.max(money(l.settled_amount).sub(a.gross_amount), 0);
      await client.query(
        `UPDATE sales_reconciliation_lines SET settled_amount=$1,fee_amount=GREATEST(fee_amount-$2,0),settlement_difference=settlement_difference-$3,
                settlement_status=$4,updated_at=NOW() WHERE id=$5`,
        [settled.toFixed(4), a.fee_amount, a.difference_amount, settled.gt(EPS) ? 'PARTIAL' : 'OUTSTANDING', a.reconciliation_line_id]);
      await client.query(`UPDATE sales_settlement_allocations SET status='REVERSED',reversed_at=NOW() WHERE id=$1`, [a.id]);
    }
    const journals = await neutralizeJournals(client, settlementId, userId, `Batal settlement ${tx.transaction_number}: ${reason}`);
    await client.query(`UPDATE transaction_headers SET workflow_status='CANCELLED',operational_status='CANCELLED',updated_by=$1,updated_at=NOW() WHERE id=$2`, [userId, settlementId]);
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,'TRANSACTION',$3,'CANCEL_SALES_SETTLEMENT',$4::jsonb,$5::jsonb)`,
      [tx.workspace_id, userId, settlementId, JSON.stringify({ workflowStatus: tx.workflow_status, allocations: allocs.rows }), JSON.stringify({ reason, journals })]);
    await client.query('COMMIT');
    return { id: settlementId, transactionNumber: tx.transaction_number, reversedAllocations: allocs.rowCount, journals };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/**
 * Reopen Verifikasi Penjualan (Accounting Control). Diblokir bila masih ada settlement aktif — batalkan settlement dulu.
 * Efek: SALES_INVOICE & SALES_DIFFERENCE di-VOID (jurnal VOID/REVERSAL, stok dikembalikan), batch POS kembali DRAFT,
 * snapshot Kas/Bank di-VOID, Cash Drawer dibuka. Status REOPENED -> wajib Verifikasi Penjualan ulang.
 */
export async function reopenReconciliation(companyId: string, locationId: string, date: string, reason: string, userId: string) {
  if (!reason.trim()) throw new Error('REOPEN_REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const h = await client.query(`SELECT * FROM sales_reconciliations WHERE company_id=$1 AND location_id=$2 AND business_date=$3::date FOR UPDATE`, [companyId, locationId, date]);
    const header = h.rows[0];
    if (!header) throw new Error('RECONCILIATION_NOT_FOUND');
    if (header.status !== 'VERIFIED') throw new Error('REOPEN_ONLY_VERIFIED');
    await assertPeriodAllows(client, companyId, date, 'ACCOUNTING');
    const settled = await client.query(
      `SELECT COUNT(*) n FROM sales_settlement_allocations a JOIN sales_reconciliation_lines l ON l.id=a.reconciliation_line_id
        WHERE l.reconciliation_id=$1 AND l.line_status='ACTIVE' AND a.status='ACTIVE'`, [header.id]);
    if (Number(settled.rows[0]?.n || 0) > 0) throw new Error('REOPEN_BLOCKED_ACTIVE_SETTLEMENT');
    const txs = await client.query<{ id: string; transaction_type: string; transaction_number: string; sales_import_batch_id: string | null }>(
      `SELECT id,transaction_type,transaction_number,sales_import_batch_id FROM transaction_headers
        WHERE company_id=$1 AND source_module='SALES_VERIFICATION' AND source_reference_id=$2 AND workflow_status NOT IN ('CANCELLED','VOID') FOR UPDATE`,
      [companyId, header.id]);
    const voided: any[] = [];
    for (const t of txs.rows) {
      const journals = await neutralizeJournals(client, t.id, userId, `Reopen ${header.reconciliation_number}: ${reason}`);
      const stock = t.transaction_type === 'SALES_INVOICE' ? await restoreSaleStock(client, t.id, userId) : 0;
      await client.query(`UPDATE transaction_headers SET workflow_status='VOID',operational_status='VOID',updated_by=$1,updated_at=NOW() WHERE id=$2`, [userId, t.id]);
      voided.push({ id: t.id, type: t.transaction_type, number: t.transaction_number, journals: journals.length, stockMovements: stock });
    }
    const batchIds = [...new Set(txs.rows.map(t => t.sales_import_batch_id).filter(Boolean))] as string[];
    for (const b of batchIds) await client.query(`UPDATE sales_import_batches SET status='DRAFT',verified_by=NULL,verified_at=NULL WHERE id=$1 AND status='FINANCE_VERIFIED'`, [b]);
    await client.query(`UPDATE sales_reconciliation_lines SET line_status='VOID',voided_at=NOW() WHERE reconciliation_id=$1 AND line_status='ACTIVE'`, [header.id]);
    await client.query(`UPDATE cash_drawers SET status='SUBMITTED',locked_at=NULL WHERE location_id=$1 AND business_date=$2::date`, [locationId, date]);
    await client.query(
      `UPDATE sales_reconciliations SET status='REOPENED',reopened_by=$1,reopened_at=NOW(),reopen_reason=$2,reopen_count=reopen_count+1,difference_transaction_id=NULL,updated_at=NOW() WHERE id=$3`,
      [userId, reason, header.id]);
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,'SALES_RECONCILIATION',$3,'REOPEN_SALES_VERIFICATION',$4::jsonb,$5::jsonb)`,
      [header.workspace_id, userId, header.id,
       JSON.stringify({ status: 'VERIFIED', number: header.reconciliation_number, round: header.verification_round, totals: { pos: header.pos_total, actual: header.actual_total, difference: header.difference_total } }),
       JSON.stringify({ status: 'REOPENED', reason, voided, batches: batchIds })]);
    await client.query('COMMIT');
    return { reconciliationId: header.id, status: 'REOPENED', voided, batches: batchIds.length };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
