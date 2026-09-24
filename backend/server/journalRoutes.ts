import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canPostJournal, canReviewJournal } from './access.js';
import { assertPeriodAllows, periodStatusFor } from './periodGuard.js';

export const journalRouter = Router();
journalRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }

journalRouter.get('/recent', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id, companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });

  const result = await query(
    `SELECT j.id,j.journal_number,j.journal_date,j.journal_type,j.status,j.description,j.engine_version,
            j.reviewed_at,j.posted_at,j.source_transaction_id,t.transaction_number source_transaction_number,t.transaction_type,
            COALESCE(SUM(jl.debit),0)::text total_debit,COALESCE(SUM(jl.credit),0)::text total_credit,
            (SELECT p.status FROM accounting_periods p WHERE p.company_id=j.company_id AND j.journal_date BETWEEN p.period_start AND p.period_end ORDER BY CASE p.status WHEN 'HARD_CLOSED' THEN 0 WHEN 'SOFT_CLOSED' THEN 1 ELSE 2 END LIMIT 1) period_status
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
              t.transaction_number source_transaction_number,t.transaction_type,
              (SELECT p.status FROM accounting_periods p WHERE p.company_id=j.company_id AND j.journal_date BETWEEN p.period_start AND p.period_end ORDER BY CASE p.status WHEN 'HARD_CLOSED' THEN 0 WHEN 'SOFT_CLOSED' THEN 1 ELSE 2 END LIMIT 1) period_status
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
  const header = await query<{ company_id: string; status: string; workspace_id: string; source_transaction_id: string | null; journal_date: string }>(
    'SELECT company_id,status,workspace_id,source_transaction_id,journal_date::text FROM journal_headers WHERE id=$1', [journalId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  const journal = header.rows[0];
  if (!(await canReviewJournal(req.sessionUser!.id, journal.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEW_ROLE_REQUIRED' });
  if (journal.status !== 'DRAFT') return res.status(400).json({ error: 'JOURNAL_STATUS_MUST_BE_DRAFT' });
  try { await assertPeriodAllows(null, journal.company_id, journal.journal_date, 'ACCOUNTING'); }
  catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'ACCOUNTING_PERIOD_CLOSED' }); }

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
  const header = await query<{ company_id: string; status: string; workspace_id: string; source_transaction_id: string | null; journal_date: string; journal_type: string }>(
    `SELECT company_id,status,workspace_id,source_transaction_id,journal_date::text,journal_type FROM journal_headers WHERE id=$1`, [journalId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  const journal = header.rows[0];
  if (!(await canPostJournal(req.sessionUser!.id, journal.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEWER_REQUIRED' });
  if (journal.status !== 'READY') return res.status(400).json({ error: 'JOURNAL_STATUS_MUST_BE_READY' });

  const period = await periodStatusFor(null, journal.company_id, journal.journal_date);
  if (period?.status === 'HARD_CLOSED') return res.status(409).json({ error: 'ACCOUNTING_PERIOD_HARD_CLOSED' });

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
  // Jurnal pembalik yang diposting menandai jurnal asalnya sebagai REVERSED.
  if (journal.journal_type === 'REVERSAL') {
    const link = await query<{ metadata: any }>(`SELECT metadata FROM journal_lines WHERE journal_id=$1 ORDER BY line_no LIMIT 1`, [journalId]);
    const originalId = link.rows[0]?.metadata?.reversalOfJournalId;
    if (originalId) {
      await query(`UPDATE journal_headers SET status='REVERSED' WHERE id=$1 AND status='POSTED'`, [originalId]);
      await query(
        `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
         VALUES($1,$2,'JOURNAL',$3,'REVERSED',$4::jsonb)`,
        [journal.workspace_id, req.sessionUser!.id, originalId, JSON.stringify({ reversalJournalId: journalId })],
      );
    }
  }
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'JOURNAL',$3,'POST',$4::jsonb)`,
    [journal.workspace_id, req.sessionUser!.id, journalId, JSON.stringify({ status: 'POSTED', postedAt: new Date().toISOString() })],
  );
  res.json({ ok: true, status: 'POSTED' });
});

/**
 * Reversal: membuat jurnal pembalik (debit<->kredit) dari jurnal POSTED, bertanggal di periode terbuka.
 * Jurnal asal tidak diubah sampai jurnal pembalik diposting (lalu status asal -> REVERSED).
 * Ini adalah jalur koreksi untuk periode HARD_CLOSED.
 */
journalRouter.post('/:journalId/reverse', async (req, res) => {
  const journalId = text(req.params.journalId);
  const reversalDate = text(req.body?.reversalDate) || new Date().toISOString().slice(0, 10);
  const reason = text(req.body?.reason);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reversalDate)) return res.status(400).json({ error: 'INVALID_REVERSAL_DATE' });
  const header = await query<{ id: string; company_id: string; workspace_id: string; status: string; journal_number: string; journal_date: string }>(
    `SELECT id,company_id,workspace_id,status,journal_number,journal_date::text FROM journal_headers WHERE id=$1`, [journalId],
  );
  if (!header.rowCount) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  const original = header.rows[0];
  if (!(await canReviewJournal(req.sessionUser!.id, original.company_id))) return res.status(403).json({ error: 'ACCOUNTING_REVIEW_ROLE_REQUIRED' });
  if (original.status !== 'POSTED') return res.status(400).json({ error: 'ONLY_POSTED_JOURNAL_CAN_BE_REVERSED' });
  if (reversalDate < original.journal_date) return res.status(400).json({ error: 'REVERSAL_DATE_BEFORE_ORIGINAL' });
  try { await assertPeriodAllows(null, original.company_id, reversalDate, 'ACCOUNTING'); }
  catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : 'ACCOUNTING_PERIOD_CLOSED' }); }

  const existing = await query(
    `SELECT 1 FROM journal_lines jl JOIN journal_headers j ON j.id=jl.journal_id
      WHERE j.journal_type='REVERSAL' AND j.status<>'VOID' AND JSON_VALUE(jl.metadata,'$.reversalOfJournalId')=$1 LIMIT 1`, [journalId],
  );
  if (existing.rowCount) return res.status(409).json({ error: 'JOURNAL_ALREADY_REVERSED' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lines = await client.query<{ account_id: string; debit: string; credit: string; description: string | null; location_id: string | null; cost_center_id: string | null; partner_id: string | null; item_id: string | null }>(
      `SELECT account_id,debit::text,credit::text,description,location_id,cost_center_id,partner_id,item_id FROM journal_lines WHERE journal_id=$1 ORDER BY line_no`, [journalId],
    );
    if (!lines.rowCount) throw new Error('JOURNAL_LINES_REQUIRED');
    const seq = await client.query<{ last_number: number }>(
      `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
       VALUES($1,'JOURNAL_REVERSAL',$2,1)
       ON CONFLICT(company_id,transaction_type,sequence_year)
       DO UPDATE SET last_number=document_sequences.last_number+1
       RETURNING last_number`,
      [original.company_id, Number(reversalDate.slice(0, 4))],
    );
    const journalNumber = `RV-${reversalDate.slice(0, 4)}-${String(seq.rows[0].last_number).padStart(5, '0')}`;
    const created = await client.query<{ id: string }>(
      `INSERT INTO journal_headers(workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version,reviewed_by,reviewed_at)
       VALUES($1,$2,$3,$4,'REVERSAL',NULL,'READY',$5,'reversal-1',$6,NOW()) RETURNING id`,
      [original.workspace_id, original.company_id, journalNumber, reversalDate,
       `Reversal ${original.journal_number}${reason ? ` — ${reason}` : ''}`, req.sessionUser!.id],
    );
    const reversalId = created.rows[0].id;
    for (let i = 0; i < lines.rows.length; i += 1) {
      const line = lines.rows[i];
      await client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,cost_center_id,partner_id,item_id,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [reversalId, i + 1, line.account_id, line.credit, line.debit, `Reversal: ${line.description || original.journal_number}`,
         line.location_id, line.cost_center_id, line.partner_id, line.item_id,
         JSON.stringify({ reversalOfJournalId: journalId, reversalOfJournalNumber: original.journal_number, reason })],
      );
    }
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'JOURNAL',$3,'CREATE_REVERSAL',$4::jsonb)`,
      [original.workspace_id, req.sessionUser!.id, reversalId, JSON.stringify({ reversalOf: journalId, journalNumber, reversalDate, reason })],
    );
    await client.query('COMMIT');
    res.status(201).json({ id: reversalId, journal_number: journalNumber, status: 'READY' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error instanceof Error ? error.message : 'REVERSAL_FAILED' });
  } finally { client.release(); }
});
