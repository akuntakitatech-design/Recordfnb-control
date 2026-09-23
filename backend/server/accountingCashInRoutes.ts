import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canReviewJournal } from './access.js';
import { directCashIn } from './cashInEngine.js';

export const accountingCashInRouter = Router();
accountingCashInRouter.use(requireAuth);

function text(value:unknown) { return String(value ?? '').trim(); }

accountingCashInRouter.get('/pending', async (req,res) => {
  const companyId=text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error:'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  if (!(await canReviewJournal(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'ACCOUNTING_REVIEW_ROLE_REQUIRED' });

  const result=await query(
    `SELECT t.id,t.transaction_number,t.transaction_date,t.reference_number,t.cash_in_type,t.source_name,t.notes,t.grand_total::text,
            t.location_id,l.name location_name,fa.name financial_account_name,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            JSON_ARRAYAGG(JSON_OBJECT(
              'id',tl.id,'line_no',tl.line_no,'description',tl.description,'amount',CAST(tl.line_total AS CHAR),
              'location_id',tl.location_id,'location_name',ll.name,'cost_center_id',tl.cost_center_id,'cost_center_name',cc.name
            ) ORDER BY tl.line_no) AS \`lines\`
       FROM transaction_headers t
       JOIN transaction_lines tl ON tl.transaction_id=t.id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN locations ll ON ll.id=tl.location_id
       LEFT JOIN cost_centers cc ON cc.id=tl.cost_center_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
      WHERE t.company_id=$1 AND t.transaction_type='CASH_IN'
        AND t.workflow_status='FINANCE_VERIFIED' AND t.accounting_status='NEEDS_ACCOUNT_DIRECTION'
      GROUP BY t.id,l.name,fa.name
      ORDER BY t.transaction_date,t.created_at`,[companyId],
  );
  res.json(result.rows);
});

accountingCashInRouter.post('/:transactionId/direct', async (req,res) => {
  const transactionId=text(req.params.transactionId);
  const tx=await query<{ company_id:string }>(
    `SELECT company_id FROM transaction_headers WHERE id=$1 AND transaction_type='CASH_IN'`,[transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error:'CASH_IN_NOT_FOUND' });
  if (!(await canReviewJournal(req.sessionUser!.id,tx.rows[0].company_id))) return res.status(403).json({ error:'ACCOUNTING_REVIEW_ROLE_REQUIRED' });
  const assignments=Array.isArray(req.body?.assignments) ? req.body.assignments.map((x:any)=>({ lineId:text(x.lineId),accountId:text(x.accountId) })) : [];
  if (!assignments.length || assignments.some((x:any)=>!x.lineId || !x.accountId)) return res.status(400).json({ error:'ACCOUNT_ASSIGNMENTS_REQUIRED' });
  try {
    const result=await directCashIn(transactionId,req.sessionUser!.id,assignments);
    res.json({ ok:true,...result });
  } catch (error) {
    console.error('Direct cash in accounts failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'DIRECT_CASH_IN_ACCOUNTS_FAILED' });
  }
});
