import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canPostJournal, canReviewJournal } from './access.js';

export const journalRouter = Router();
journalRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }

journalRouter.get('/recent', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const result = await query(
    `SELECT j.id,j.journal_number,j.journal_date,j.journal_type,j.status,j.description,j.engine_version,
            j.reviewed_at,j.posted_at,t.transaction_number source_transaction_number,t.transaction_type,
            COALESCE(SUM(jl.debit),0)::text total_debit,COALESCE(SUM(jl.credit),0)::text total_credit
       FROM journal_headers j
       LEFT JOIN transaction_headers t ON t.id=j.source_transaction_id
       LEFT JOIN journal_lines jl ON jl.journal_id=j.id
      WHERE j.company_id=$1
      GROUP BY j.id,t.transaction_number,t.transaction_type
      ORDER BY j.journal_date DESC,j.created_at DESC
      LIMIT 100`,
    [companyId],
  );
  res.json(result.rows);
});

journalRouter.get('/:journalId', async (req, res) => {
  const journalId = text(req.params.journalId);
  const header = await query<{ company_id: string }>('SELECT company_id FROM journal_headers WHERE id=$1', [journalId]);
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  if (!(await canAccessCompany(req.sessionUser!.id, header.rows[0].company_id))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const [journal, lines] = await Promise.all([
    query(
      `SELECT j.id,j.workspace_id,j.company_id,j.journal_number,j.journal_date,j.journal_type,j.status,j.description,
              j.source_transaction_id,j.engine_version,j.reviewed_at,j.posted_at,
              t.transaction_number source_transaction_number,t.transaction_type
         FROM journal_headers j
         LEFT JOIN transaction_headers t ON t.id=j.source_transaction_id
        WHERE j.id=$1`, [journalId],
    ),
    query(
      `SELECT jl.id,jl.line_no,jl.account_id,coa.code account_code,coa.name account_name,
              jl.debit::text,jl.credit::text,jl.description,jl.location_id,l.name location_name,
              jl.cost_center_id,cc.name cost_center_name,jl.partner_id,bp.name partner_name,
              jl.item_id,i.name item_name,jl.source_transaction_line_id,jl.metadata
         FROM journal_lines jl
         JOIN chart_of_accounts coa ON coa.id=jl.account_id
         LEFT JOIN locations l ON l.id=jl.location_id
         LEFT JOIN cost_centers cc ON cc.id=jl.cost_center_id
         LEFT JOIN business_partners bp ON bp.id=jl.partner_id
         LEFT JOIN items i ON i.id=jl.item_id
        WHERE jl.journal_id=$1
        ORDER BY jl.line_no`, [journalId],
    ),
  ]);
  res.json({ ...journal.rows[0], lines: lines.rows });
});

journalRouter.post('/:journalId/ready', async (req, res) => {
  const journalId = text(req.params.journalId);
  const header = await query<{ company_id: string; status: string; workspace_id: string; source_transaction_id: string | null }>(
    'SELECT company_id,status,workspace_id,source_transaction_id FROM journal_headers WHERE id=$1', [journalId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  const journal = header.rows[0];
  if (!(await canReviewJournal(req.sessionUser!.id, journal.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEW_ROLE_REQUIRED' });
  if (journal.status !== 'DRAFT') return res.status(400).json({ error: 'JOURNAL_STATUS_MUST_BE_DRAFT' });

  await query(
    `UPDATE journal_headers SET status='READY',reviewed_by=$1,reviewed_at=NOW() WHERE id=$2`,
    [req.sessionUser!.id, journalId],
  );
  if (journal.source_transaction_id) {
    await query(`UPDATE transaction_headers SET accounting_status='READY_TO_POST',updated_by=$1,updated_at=NOW() WHERE id=$2`, [req.sessionUser!.id, journal.source_transaction_id]);
  }
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'JOURNAL',$3,'ACCOUNTING_REVIEW_READY',$4::jsonb)`,
    [journal.workspace_id, req.sessionUser!.id, journalId, JSON.stringify({ status: 'READY' })],
  );
  res.json({ ok: true, status: 'READY' });
});

journalRouter.post('/:journalId/post', async (req, res) => {
  const journalId = text(req.params.journalId);
  const header = await query<{ company_id: string; status: string; workspace_id: string; source_transaction_id: string | null; journal_date: string }>(
    `SELECT company_id,status,workspace_id,source_transaction_id,journal_date::text FROM journal_headers WHERE id=$1`, [journalId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  const journal = header.rows[0];
  if (!(await canPostJournal(req.sessionUser!.id, journal.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEWER_REQUIRED' });
  if (journal.status !== 'READY') return res.status(400).json({ error: 'JOURNAL_STATUS_MUST_BE_READY' });

  const closed = await query(
    `SELECT 1 FROM accounting_periods
      WHERE company_id=$1 AND status='HARD_CLOSED' AND $2::date BETWEEN period_start AND period_end
      LIMIT 1`,
    [journal.company_id, journal.journal_date],
  );
  if (closed.rowCount) return res.status(409).json({ error: 'ACCOUNTING_PERIOD_HARD_CLOSED' });

  const totals = await query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(debit),0)::text debit,COALESCE(SUM(credit),0)::text credit FROM journal_lines WHERE journal_id=$1`,
    [journalId],
  );
  if (Number(totals.rows[0]?.debit || 0) <= 0 || totals.rows[0]?.debit !== totals.rows[0]?.credit) {
    return res.status(400).json({ error: 'JOURNAL_NOT_BALANCED' });
  }

  await query(`UPDATE journal_headers SET status='POSTED',posted_by=$1,posted_at=NOW() WHERE id=$2`, [req.sessionUser!.id, journalId]);
  if (journal.source_transaction_id) {
    await query(
      `UPDATE transaction_headers SET accounting_status='POSTED',workflow_status='POSTED',updated_by=$1,updated_at=NOW() WHERE id=$2`,
      [req.sessionUser!.id, journal.source_transaction_id],
    );
  }
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'JOURNAL',$3,'POST',$4::jsonb)`,
    [journal.workspace_id, req.sessionUser!.id, journalId, JSON.stringify({ status: 'POSTED', postedAt: new Date().toISOString() })],
  );
  res.json({ ok: true, status: 'POSTED' });
});
