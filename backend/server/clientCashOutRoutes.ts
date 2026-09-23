import { Router } from 'express';
import { pool, query } from './db.js';
import { requireAuth } from './auth.js';
import { canAccessCompany, canAccessLocation, canCreateTransaction, canVerifyTransaction } from './access.js';
import { verifyClientCashOut } from './cashOutEngine.js';

export const clientCashOutRouter = Router();
clientCashOutRouter.use(requireAuth);

function text(value:unknown) { return String(value ?? '').trim(); }
function nullable(value:unknown) { const v=text(value); return v || null; }
function upper(value:unknown) { return text(value).toUpperCase(); }

async function nextCashOutNumber(client:any,companyId:string,date:string) {
  const year=Number(date.slice(0,4));
  const result=await client.query(
    `INSERT INTO document_sequences(company_id,transaction_type,sequence_year,last_number)
     VALUES($1,'CASH_OUT',$2,1)
     ON CONFLICT(company_id,transaction_type,sequence_year)
     DO UPDATE SET last_number=document_sequences.last_number+1
     RETURNING last_number`,[companyId,year],
  );
  return `KK-${year}-${String(result.rows[0].last_number).padStart(5,'0')}`;
}

clientCashOutRouter.get('/financial-accounts', async (req,res) => {
  const companyId=text(req.query.companyId);
  if (!companyId) return res.status(400).json({ error:'COMPANY_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  const result=await query(
    `SELECT fa.id,fa.company_id,fa.location_id,fa.code,fa.name,fa.account_kind,l.name location_name
       FROM financial_accounts fa
       LEFT JOIN locations l ON l.id=fa.location_id
      WHERE fa.company_id=$1 AND fa.status='ACTIVE' AND fa.account_kind IN ('CASH','BANK','EWALLET')
        AND (EXISTS (SELECT 1 FROM users u WHERE u.id=$2 AND u.is_system_admin AND u.status='ACTIVE')
          OR EXISTS (
            SELECT 1 FROM workspace_memberships wm
             WHERE wm.user_id=$2 AND wm.workspace_id=fa.workspace_id AND wm.status='ACTIVE'
               AND (wm.company_id IS NULL OR wm.company_id=fa.company_id)
               AND (wm.location_id IS NULL OR fa.location_id IS NULL OR wm.location_id=fa.location_id)
          ))
      ORDER BY fa.account_kind,fa.name`,[companyId,req.sessionUser!.id],
  );
  res.json(result.rows);
});

clientCashOutRouter.get('/open-payables', async (req,res) => {
  const companyId=text(req.query.companyId);
  const supplierId=text(req.query.supplierId);
  if (!companyId || !supplierId) return res.status(400).json({ error:'COMPANY_SUPPLIER_REQUIRED' });
  if (!(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  const result=await query(
    `SELECT i.id,i.transaction_number,i.transaction_date,i.reference_number,i.due_date,i.grand_total::text,
            (i.grand_total-COALESCE(SUM(CASE WHEN p.workflow_status IN ('FINANCE_VERIFIED','POSTED') THEN a.amount ELSE 0 END),0))::text outstanding
       FROM transaction_headers i
       LEFT JOIN transaction_allocations a ON a.target_transaction_id=i.id AND a.allocation_type='AP_PAYMENT'
       LEFT JOIN transaction_headers p ON p.id=a.source_transaction_id
      WHERE i.company_id=$1 AND i.partner_id=$2 AND i.transaction_type='PURCHASE_INVOICE'
        AND i.payment_type='CREDIT' AND i.workflow_status IN ('FINANCE_VERIFIED','POSTED')
      GROUP BY i.id,i.grand_total
      HAVING i.grand_total-COALESCE(SUM(CASE WHEN p.workflow_status IN ('FINANCE_VERIFIED','POSTED') THEN a.amount ELSE 0 END),0) > 0.0001
      ORDER BY i.due_date NULLS LAST,i.transaction_date,i.transaction_number`,[companyId,supplierId],
  );
  res.json(result.rows);
});

clientCashOutRouter.get('/cash-outs', async (req,res) => {
  const companyId=text(req.query.companyId);
  if (companyId && !(await canAccessCompany(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN_COMPANY' });
  const result=await query(
    `SELECT t.id,t.company_id,t.location_id,t.transaction_number,t.transaction_date,t.reference_number,t.cash_out_type,
            t.payee_name,t.grand_total::text,t.workflow_status,t.accounting_status,t.partner_id,
            bp.name supplier_name,l.name location_name,fa.name financial_account_name,
            (SELECT COUNT(*)::int FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            t.created_at
       FROM transaction_headers t
       LEFT JOIN business_partners bp ON bp.id=t.partner_id
       LEFT JOIN locations l ON l.id=t.location_id
       LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id
      WHERE t.transaction_type='CASH_OUT'
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

clientCashOutRouter.post('/cash-outs', async (req,res) => {
  const companyId=text(req.body?.companyId);
  const locationId=text(req.body?.locationId);
  const transactionDate=text(req.body?.transactionDate);
  const financialAccountId=text(req.body?.financialAccountId);
  const cashOutType=upper(req.body?.cashOutType);
  const referenceNumber=nullable(req.body?.referenceNumber);
  const notes=nullable(req.body?.notes);
  const payeeName=nullable(req.body?.payeeName);
  const partnerId=nullable(req.body?.partnerId);
  const rawLines=Array.isArray(req.body?.lines) ? req.body.lines : [];
  const rawAllocations=Array.isArray(req.body?.allocations) ? req.body.allocations : [];

  if (!companyId || !locationId || !financialAccountId || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    return res.status(400).json({ error:'CASH_OUT_HEADER_REQUIRED' });
  }
  if (!['DEBT_PAYMENT','OPERATIONAL_EXPENSE'].includes(cashOutType)) return res.status(400).json({ error:'INVALID_CASH_OUT_TYPE' });
  if (!(await canCreateTransaction(req.sessionUser!.id,companyId))) return res.status(403).json({ error:'FORBIDDEN' });

  const company=await query<{ workspace_id:string }>(`SELECT workspace_id FROM companies WHERE id=$1 AND status='ACTIVE'`,[companyId]);
  if (!company.rowCount) return res.status(404).json({ error:'COMPANY_NOT_FOUND' });
  const workspaceId=company.rows[0].workspace_id;

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

  if (cashOutType === 'DEBT_PAYMENT') {
    if (!partnerId || !rawAllocations.length) return res.status(400).json({ error:'DEBT_PAYMENT_SUPPLIER_ALLOCATION_REQUIRED' });
    const supplier=await query(`SELECT id,name FROM business_partners WHERE id=$1 AND workspace_id=$2 AND status='ACTIVE' AND partner_type IN ('SUPPLIER','BOTH')`,[partnerId,workspaceId]);
    if (!supplier.rowCount) return res.status(400).json({ error:'SUPPLIER_REQUIRED' });
  } else if (!rawLines.length) {
    return res.status(400).json({ error:'OPERATIONAL_EXPENSE_LINES_REQUIRED' });
  }

  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const transactionNumber=await nextCashOutNumber(client,companyId,transactionDate);
    let total=0;

    if (cashOutType === 'DEBT_PAYMENT') {
      const targetIds=[...new Set(rawAllocations.map((x:any)=>text(x.invoiceId)).filter(Boolean))] as string[];
      if (!targetIds.length || targetIds.length !== rawAllocations.length) throw new Error('INVALID_PAYMENT_ALLOCATION');
      const invoices=await client.query<{ id:string;transaction_number:string;grand_total:string;partner_id:string|null }>(
        `SELECT id,transaction_number,grand_total::text,partner_id FROM transaction_headers
          WHERE id=ANY($1::uuid[]) AND company_id=$2 AND transaction_type='PURCHASE_INVOICE'
            AND payment_type='CREDIT' AND workflow_status IN ('FINANCE_VERIFIED','POSTED') FOR UPDATE`,[targetIds,companyId],
      );
      if (invoices.rowCount !== targetIds.length) throw new Error('INVALID_PAYABLE_INVOICE');
      const invoiceMap=new Map(invoices.rows.map(x=>[x.id,x]));
      for (const allocation of rawAllocations) {
        const invoiceId=text(allocation.invoiceId);
        const value=Number(allocation.amount || 0);
        const invoice=invoiceMap.get(invoiceId);
        if (!invoice || invoice.partner_id !== partnerId) throw new Error('PAYMENT_SUPPLIER_MISMATCH');
        if (!Number.isFinite(value) || value<=0) throw new Error('PAYMENT_ALLOCATION_MUST_BE_POSITIVE');
        const paid=await client.query<{ paid:string }>(
          `SELECT COALESCE(SUM(a.amount),0)::text paid FROM transaction_allocations a
            JOIN transaction_headers p ON p.id=a.source_transaction_id
           WHERE a.target_transaction_id=$1 AND a.allocation_type='AP_PAYMENT'
             AND p.workflow_status IN ('FINANCE_VERIFIED','POSTED')`,[invoiceId],
        );
        const outstanding=Number(invoice.grand_total)-Number(paid.rows[0]?.paid || 0);
        if (value>outstanding+0.0001) throw new Error(`PAYMENT_EXCEEDS_OUTSTANDING_${invoice.transaction_number}`);
        total+=value;
      }
    } else {
      for (const line of rawLines) {
        const value=Number(line.amount || 0);
        if (!text(line.description)) throw new Error('EXPENSE_DESCRIPTION_REQUIRED');
        if (!Number.isFinite(value) || value<=0) throw new Error('POSITIVE_EXPENSE_AMOUNT_REQUIRED');
        const costCenterId=nullable(line.costCenterId);
        if (costCenterId) {
          const cc=await client.query(`SELECT id FROM cost_centers WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`,[costCenterId,companyId]);
          if (!cc.rowCount) throw new Error('COST_CENTER_OUTSIDE_COMPANY');
        }
        total+=value;
      }
    }
    if (total<=0) throw new Error('POSITIVE_CASH_OUT_TOTAL_REQUIRED');

    const header=await client.query(
      `INSERT INTO transaction_headers(
         workspace_id,company_id,location_id,financial_account_id,transaction_type,transaction_number,transaction_date,
         partner_id,reference_number,payment_type,payment_status,notes,cash_out_type,payee_name,
         gross_amount,dpp_amount,tax_amount,grand_total,created_by,updated_by)
       VALUES($1,$2,$3,$4,'CASH_OUT',$5,$6,$7,$8,'CASH','PAID',$9,$10,$11,$12,$12,0,$12,$13,$13)
       RETURNING id,transaction_number,transaction_date,cash_out_type,grand_total,workflow_status,accounting_status`,
      [workspaceId,companyId,locationId,financialAccountId,transactionNumber,transactionDate,partnerId,referenceNumber,notes,cashOutType,payeeName,total,req.sessionUser!.id],
    );
    const transactionId=header.rows[0].id;

    if (cashOutType === 'DEBT_PAYMENT') {
      let lineNo=1;
      for (const allocation of rawAllocations) {
        const invoiceId=text(allocation.invoiceId);
        const value=Number(allocation.amount || 0);
        const invoiceNo=(await client.query<{ transaction_number:string }>('SELECT transaction_number FROM transaction_headers WHERE id=$1',[invoiceId])).rows[0].transaction_number;
        await client.query(
          `INSERT INTO transaction_allocations(workspace_id,source_transaction_id,target_transaction_id,allocation_type,amount,notes)
           VALUES($1,$2,$3,'AP_PAYMENT',$4,$5)`,[workspaceId,transactionId,invoiceId,value,`Pembayaran ${invoiceNo}`],
        );
        await client.query(
          `INSERT INTO transaction_lines(transaction_id,line_no,line_type,description,quantity,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id)
           VALUES($1,$2,'MEMO',$3,1,$4,$4,$4,0,$4,$5)`,[transactionId,lineNo++,`Bayar hutang ${invoiceNo}`,value,locationId],
        );
      }
    } else {
      for (let index=0;index<rawLines.length;index+=1) {
        const line=rawLines[index];
        const value=Number(line.amount || 0);
        await client.query(
          `INSERT INTO transaction_lines(transaction_id,line_no,line_type,description,quantity,unit_price,gross_amount,dpp_amount,tax_amount,line_total,location_id,cost_center_id)
           VALUES($1,$2,'MEMO',$3,1,$4,$4,$4,0,$4,$5,$6)`,
          [transactionId,index+1,text(line.description),value,locationId,nullable(line.costCenterId)],
        );
      }
    }

    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'CLIENT_CREATE_CASH_OUT',$4::jsonb)`,
      [workspaceId,req.sessionUser!.id,transactionId,JSON.stringify({ transactionNumber,cashOutType,total,partnerId,payeeName })],
    );
    await client.query('COMMIT');
    res.status(201).json(header.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create client cash out failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'CREATE_CASH_OUT_FAILED' });
  } finally { client.release(); }
});

clientCashOutRouter.post('/cash-outs/:transactionId/verify', async (req,res) => {
  const transactionId=text(req.params.transactionId);
  const tx=await query<{ company_id:string;location_id:string|null }>(`SELECT company_id,location_id FROM transaction_headers WHERE id=$1 AND transaction_type='CASH_OUT'`,[transactionId]);
  if (!tx.rowCount) return res.status(404).json({ error:'CASH_OUT_NOT_FOUND' });
  if (!(await canVerifyTransaction(req.sessionUser!.id,tx.rows[0].company_id))) return res.status(403).json({ error:'FINANCE_VERIFY_ROLE_REQUIRED' });
  if (tx.rows[0].location_id && !(await canAccessLocation(req.sessionUser!.id,tx.rows[0].location_id!))) return res.status(403).json({ error:'LOCATION_FORBIDDEN' });
  try {
    const result=await verifyClientCashOut(transactionId,req.sessionUser!.id);
    res.json({ ok:true,...result });
  } catch (error) {
    console.error('Verify cash out failed:',error);
    res.status(400).json({ error:error instanceof Error ? error.message : 'VERIFY_CASH_OUT_FAILED' });
  }
});
