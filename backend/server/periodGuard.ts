/**
 * periodGuard.ts — penjaga periode akuntansi (tabel accounting_periods, sudah ada di skema).
 *
 *  - OPEN        : semua boleh.
 *  - SOFT_CLOSED : Finance tidak boleh menambah/membatalkan transaksi; Accounting masih boleh review & posting.
 *  - HARD_CLOSED : tidak boleh diedit secara normal (input, verifikasi, posting). Koreksi hanya lewat
 *                  Adjustment (jurnal manual di periode OPEN) atau Reversal (jurnal pembalik di periode OPEN).
 */
import { pool, type PoolClient } from './db.js';

type Executor = PoolClient | typeof pool;

export type PeriodMode = 'FINANCE' | 'ACCOUNTING';

export async function periodStatusFor(executor: Executor | null, companyId: string, date: string) {
  const q = executor ?? pool;
  const result = await q.query<{ status: string; period_start: string; period_end: string }>(
    `SELECT status,period_start::text,period_end::text FROM accounting_periods
      WHERE company_id=$1 AND $2::date BETWEEN period_start AND period_end
      ORDER BY CASE status WHEN 'HARD_CLOSED' THEN 0 WHEN 'SOFT_CLOSED' THEN 1 ELSE 2 END
      LIMIT 1`,
    [companyId, date],
  );
  return result.rows[0] || null;
}

/** Melempar Error(kode) bila periode tidak mengizinkan aksi. */
export async function assertPeriodAllows(executor: Executor | null, companyId: string, date: string | Date, mode: PeriodMode) {
  const iso = date instanceof Date ? date.toISOString().slice(0, 10) : String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
  const period = await periodStatusFor(executor, companyId, iso);
  if (!period) return;
  if (period.status === 'HARD_CLOSED') throw new Error('ACCOUNTING_PERIOD_HARD_CLOSED');
  if (period.status === 'SOFT_CLOSED' && mode === 'FINANCE') throw new Error('ACCOUNTING_PERIOD_SOFT_CLOSED');
}
