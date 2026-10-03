import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canPostJournal, canReviewJournal } from './access.js';

export const accountingPeriodRouter = Router();
accountingPeriodRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
const STATUSES = new Set(['OPEN', 'SOFT_CLOSED', 'HARD_CLOSED']);

accountingPeriodRouter.get('/', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  const result = await query(
    `SELECT p.id,p.company_id,p.period_start::text,p.period_end::text,p.status,p.soft_closed_at,p.hard_closed_at,
            (SELECT COUNT(*)::int FROM journal_headers j WHERE j.company_id=p.company_id AND j.journal_date BETWEEN p.period_start AND p.period_end AND j.status='POSTED') posted_journals,
            (SELECT COUNT(*)::int FROM journal_headers j WHERE j.company_id=p.company_id AND j.journal_date BETWEEN p.period_start AND p.period_end AND j.status IN ('DRAFT','READY')) open_journals,
            (SELECT COUNT(*)::int FROM transaction_headers t WHERE t.company_id=p.company_id AND t.transaction_date BETWEEN p.period_start AND p.period_end AND t.workflow_status='DRAFT') draft_transactions
       FROM accounting_periods p
      WHERE p.company_id=$1
      ORDER BY p.period_start DESC`,
    [companyId],
  );
  res.json(result.rows);
});

/** Buat periode bulanan: body { companyId, month:'YYYY-MM' } atau { companyId, periodStart, periodEnd }. */
accountingPeriodRouter.post('/', async (req, res) => {
  const companyId = text(req.body?.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canReviewJournal(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'ACCOUNTING_REVIEW_ROLE_REQUIRED' });

  let periodStart = text(req.body?.periodStart);
  let periodEnd = text(req.body?.periodEnd);
  const month = text(req.body?.month);
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    periodStart = `${month}-01`;
    periodEnd = `${month}-${String(last).padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
    return res.status(400).json({ error: 'INVALID_PERIOD_RANGE' });
  }
  const company = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!company.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });

  const overlap = await query(
    `SELECT id FROM accounting_periods WHERE company_id=$1 AND period_start<=$3::date AND period_end>=$2::date LIMIT 1`,
    [companyId, periodStart, periodEnd],
  );
  if (overlap.rowCount) return res.status(409).json({ error: 'ACCOUNTING_PERIOD_OVERLAP' });

  const result = await query(
    `INSERT INTO accounting_periods(workspace_id,company_id,period_start,period_end,status)
     VALUES($1,$2,$3,$4,'OPEN') RETURNING id,company_id,period_start,period_end,status`,
    [company.rows[0].workspace_id, companyId, periodStart, periodEnd],
  );
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'ACCOUNTING_PERIOD',$3,'CREATE',$4::jsonb)`,
    [company.rows[0].workspace_id, req.sessionUser!.id, result.rows[0].id, JSON.stringify({ periodStart, periodEnd })],
  );
  res.status(201).json(result.rows[0]);
});

/** Ubah status: OPEN -> SOFT_CLOSED -> HARD_CLOSED (dan buka kembali SOFT_CLOSED -> OPEN). HARD_CLOSED hanya oleh poster jurnal. */
accountingPeriodRouter.patch('/:periodId/status', async (req, res) => {
  const periodId = text(req.params.periodId);
  const status = text(req.body?.status).toUpperCase();
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'INVALID_PERIOD_STATUS' });
  const period = await query<{ id: string; workspace_id: string; company_id: string; status: string; period_start: string; period_end: string }>(
    `SELECT id,workspace_id,company_id,status,period_start::text,period_end::text FROM accounting_periods WHERE id=$1`, [periodId],
  );
  if (!period.rowCount) return res.status(404).json({ error: 'ACCOUNTING_PERIOD_NOT_FOUND' });
  const p = period.rows[0];
  if (!(await canReviewJournal(req.sessionUser!.id, p.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEW_ROLE_REQUIRED' });
  if (status === 'HARD_CLOSED' && !(await canPostJournal(req.sessionUser!.id, p.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEWER_REQUIRED' });
  if (p.status === 'HARD_CLOSED') return res.status(409).json({ error: 'ACCOUNTING_PERIOD_HARD_CLOSED' });
  if (status === p.status) return res.json({ ok: true, status });

  if (status === 'HARD_CLOSED') {
    // Tidak boleh ada jurnal DRAFT/READY di dalam periode yang akan dikunci permanen.
    const pending = await query<{ n: number }>(
      `SELECT COUNT(*)::int n FROM journal_headers WHERE company_id=$1 AND journal_date BETWEEN $2::date AND $3::date AND status IN ('DRAFT','READY')`,
      [p.company_id, p.period_start, p.period_end],
    );
    if (pending.rows[0].n > 0) return res.status(409).json({ error: 'PERIOD_HAS_UNPOSTED_JOURNALS' });
  }

  await query(
    `UPDATE accounting_periods
        SET status=$1,
            soft_closed_at=CASE WHEN $1='SOFT_CLOSED' THEN NOW() WHEN $1='OPEN' THEN NULL ELSE soft_closed_at END,
            hard_closed_at=CASE WHEN $1='HARD_CLOSED' THEN NOW() ELSE hard_closed_at END
      WHERE id=$2`,
    [status, periodId],
  );
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data)
     VALUES($1,$2,'ACCOUNTING_PERIOD',$3,'CHANGE_STATUS',$4::jsonb,$5::jsonb)`,
    [p.workspace_id, req.sessionUser!.id, periodId, JSON.stringify({ status: p.status }), JSON.stringify({ status })],
  );
  res.json({ ok: true, status });
});
