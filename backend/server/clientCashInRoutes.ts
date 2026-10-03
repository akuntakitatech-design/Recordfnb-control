import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { verifyClientCashIn } from './cashInEngine.js';
import { assertPeriodAllows } from './periodGuard.js';

export const clientCashInRouter = Router();
clientCashInRouter.use(requireAuth);

function text(value:unknown) { return String(value ?? '').trim(); }
function nullable(value:unknown) { const v=text(value); return v || null; }
function upper(value:unknown) { return text(value).toUpperCase(); }

async function nextCashInNumber(client:any,companyId:string,date:string) {
  const year=Number(date.slice(0,4));
  const result=await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'CASH_IN',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,[companyId,year],
  );
  return `KM-${year}-${String(result.rows[0].last_number).padStart(5,'0')}`;
}

clientCashInRouter.get('/cash-ins', async (req,res) => {
  const companyId=text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  const result=await query(
    `SELECT t.id,t.company_id,t.location_id,t.transaction_number,t.transaction_date,t.reference_number,t.cash_in_type,
            t.source_name,t.grand_total::text,t.workflow_status,t.accounting_status,
            l.name location_name,fa.name financial_account_name,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            t.created_at
       FROM transaction_headers t
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
      WHERE t.transaction_type='CASH_IN'
        AND ($1='' OR t.company_id=$1::uuid)
        AND (EXISTS (SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS (
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=t.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=t.company_id)
               AND (wm.location_id IS NULL OR wm.location_id=t.location_id)
          ))
      ORDER BY t.transaction_date DESC,t.created_at DESC
      LIMIT 100`,[companyId,req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientCashInRouter.post('/cash-ins', async (req,res) => {
  const companyId=text(req.body?.companyId);
  const locationId=text(req.body?.locationId);
  const transactionDate=text(req.body?.transactionDate);
  const financialAccountId=text(req.body?.financialAccountId);
  const cashInType=upper(req.body?.cashInType);
  const referenceNumber=nullable(req.body?.referenceNumber);
  const sourceName=nullable(req.body?.sourceName);
  const notes=nullable(req.body?.notes);
  const rawLines=Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!companyId || !locationId || !financialAccountId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    return res.status(400).json({ error:'CASH_IN_HEADER_REQUIRED' });
  }
  if (!['BUSINESS_RECEIPT','OTHER_RECEIPT'].includes(cashInType)) return res.status(400).json({ error:'INVALID_CASH_IN_TYPE' });
  if (!rawLines.length) return res.status(400).json({ error:'CASH_IN_LINES_REQUIRED' });
  if (!(await canCreateTransaction(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN' });

  const company=await query<{ workspace_id:string }>(`SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,[companyId]);
  if (!company.rowCount) return res.status(404).json({ error:'COMPANY_NOT_FOUND' });
  const workspaceId=company.rows[0].workspace_id;

  try { await assertPeriodAllows(null,companyId,transactionDate,'FINANCE'); }
  catch (error) { return res.status(409).json({ error:error instanceof Error ? error.message : 'ACCOUNTING_PERIOD_CLOSED' }); }

  const location=await query(`SELECT id FROM locations WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,[locationId,companyId]);
  if (!location.rowCount) return res.status(400).json({ error:'LOCATION_OUTSIDE_COMPANY' });
  if (!(await canAccessLocation(req.sessionUser!.id,locationId))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });

  const financial=await query<{ location_id:string|null }>(
    `SELECT location_id FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE' AND account_kind IN ('CASH','BANK','EWALLET')`,
    [financialAccountId,companyId],
  );
  if (!financial.rowCount) return res.status(400).json({ error:'INVALID_FINANCIAL_ACCOUNT' });
  if (financial.rows[0].location_id && !(await canAccessLocation(req.sessionUser!.id,financial.rows[0].location_id!))) {
    return res.status(403).json({ error:'FINANCIAL_ACCOUNT_FORBIDDEN' });
  }

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let total=0;
    for (const line of rawLines) {
      const description=text(line.description);
      const value=Number(line.amount || 0);
      if (!description) throw new Error('RECEIPT_DESCRIPTION_REQUIRED');
      if (!Number.isFinite(value) || value<=0) throw new Error('POSITIVE_RECEIPT_AMOUNT_REQUIRED');
      const costCenterId=nullable(line.costCenterId);
      if (costCenterId) {
        const cc=await client.query(`SELECT id FROM cost_centers WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,[costCenterId,companyId]);
        if (!cc.rowCount) throw new Error('COST_CENTER_OUTSIDE_COMPANY');
      }
      total+=value;
    }
    if (total<=0) throw new Error('POSITIVE_CASH_IN_TOTAL_REQUIRED');

    const transactionNumber=await nextCashInNumber(client,companyId,transactionDate);
    const header=await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,transaction_date,
         reference_number,payment_type,payment_status,notes,cash_in_type,source_name,
         gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,'CASH_IN',$5,$6,$7,'CASH','PAID',$8,$9,$10,$11,$11,0,$11,$12,$12)
       RETURNING id,transaction_number,transaction_date,cash_in_type,grand_total,workflow_status,accounting_status`,
      [workspaceId,companyId,locationId,financialAccountId,transactionNumber,transactionDate,referenceNumber,notes,cashInType,sourceName,total,req.sessionUser!.id],
    );
    const transactionId=header.rows[0].id;

    for (let index=0;index<rawLines.length;index+=1) {
      const line=rawLines[index];
      const value=Number(line.amount || 0);
      await client.query(
        `INSERT INTO transaction_lines(transaction_id,line_no,line_type,description,quantity,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,cost_center_id)
         VALUES($1,$2,'MEMO',$3,1,$4,$4,$4,0,$4,$5,$6)`,
        [transactionId,index+1,text(line.description),value,locationId,nullable(line.costCenterId)],
      );
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_CASH_IN',$4::jsonb)`,
      [workspaceId,req.sessionUser!.id,transactionId,JSON.stringify({ transactionNumber,cashInType,total,sourceName })],
    );
    await client.query('COMMIT');
    res.status(201).json(header.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create client cash in failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'CREATE_CASH_IN_FAILED' });
  } finally { client.release(); }
});

clientCashInRouter.post('/cash-ins/:transactionId/verify', async (req,res) => {
  const transactionId=text(req.params.transactionId);
  const tx=await query<{ company_id:string;location_id:string|null }>(
    `SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='CASH_IN'`,[transactionId],
  );
  if (!tx.rowCount) return res.status(404).json({ error:'CASH_IN_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id,tx.rows[0].company_id))) return res.status(403).json({ error:'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (tx.rows[0].location_id && !(await canAccessLocation(req.sessionUser!.id,tx.rows[0].location_id!))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });
  try {
    const result=await verifyClientCashIn(transactionId,req.sessionUser!.id);
    res.json({ ok:true,...result });
  } catch (error) {
    console.error('Verify cash in failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'VERIFY_CASH_IN_FAILED' });
  }
});
