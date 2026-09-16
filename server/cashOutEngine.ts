import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const ENGINE_VERSION = '0.9';

type CashOutHeader = {
  id:string; workspace_id:string; company_id:string; location_id:string|null; financial_account_id:string|null;
  transaction_number:string; transaction_date:string; partner_id:string|null; grand_total:string;
  workflow_status:string; accounting_status:string; cash_out_type:string|null; payee_name:string|null;
};

function amount(value:string|number|null|undefined) { return new Decimal(value || 0); }

async function loadHeader(client:PoolClient, transactionId:string) {
  const result = await client.query<CashOutHeader>(
    `SELECT id,workspace_id,company_id,location_id,financial_account_id,transaction_number,transaction_date::text,
            partner_id,grand_total::text,workflow_status,accounting_status,cash_out_type,payee_name
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='CASH_OUT'
      FOR UPDATE`, [transactionId],
  );
  if (!result.rowCount) throw new Error('CASH_OUT_NOT_FOUND');
  return result.rows[0];
}

async function financialCoa(client:PoolClient, tx:CashOutHeader) {
  if (!tx.financial_account_id) throw new Error('FINANCIAL_ACCOUNT_REQUIRED');
  const result = await client.query<{ coa_account_id:string }>(
    `SELECT coa_account_id FROM financial_accounts
      WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [tx.financial_account_id, tx.company_id],
  );
  if (!result.rowCount) throw new Error('INVALID_FINANCIAL_ACCOUNT');
  return result.rows[0].coa_account_id;
}

async function importantAccount(client:PoolClient, companyId:string, roleCode:string) {
  const result = await client.query<{ account_id:string }>(
    `SELECT account_id FROM important_accounts WHERE company_id=$1 AND role_code=$2 LIMIT 1`, [companyId, roleCode],
  );
  if (!result.rowCount) throw new Error(`IMPORTANT_ACCOUNT_${roleCode}_REQUIRED`);
  return result.rows[0].account_id;
}

async function existingJournal(client:PoolClient, transactionId:string) {
  const result = await client.query<{ id:string }>(
    `SELECT id FROM journal_headers WHERE source_transaction_id=$1 AND status<>'VOID' LIMIT 1`, [transactionId],
  );
  return result.rows[0]?.id || null;
}

async function createJournalHeader(client:PoolClient, tx:CashOutHeader) {
  const result = await client.query<{ id:string }>(
    `INSERT INTO journal_headers(
       workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
     VALUES($1,$2,$3,$4,'AUTO_CASH_OUT',$5,'DRAFT',$6,$7)
     RETURNING id`,
    [tx.workspace_id,tx.company_id,`AJ-${tx.transaction_number}`,tx.transaction_date,tx.id,`Auto journal ${tx.transaction_number}`,ENGINE_VERSION],
  );
  return result.rows[0].id;
}

async function markVerified(client:PoolClient, tx:CashOutHeader, userId:string, accountingStatus:string, action:string, extra:Record<string,unknown>={}) {
  await client.query(
    `UPDATE transaction_headers
        SET workflow_status='FINANCE_VERIFIED',operational_status='FINANCE_VERIFIED',accounting_status=$1,
            verified_by=$2,verified_at=COALESCE(verified_at,NOW()),updated_by=$2,updated_at=NOW()
      WHERE id=$3`, [accountingStatus,userId,tx.id],
  );
  await client.query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'TRANSACTION',$3,$4,$5::jsonb)`,
    [tx.workspace_id,userId,tx.id,action,JSON.stringify({ accountingStatus,engineVersion:ENGINE_VERSION,...extra })],
  );
}

async function verifyDebtPayment(client:PoolClient, tx:CashOutHeader, userId:string) {
  if (!tx.partner_id) throw new Error('SUPPLIER_REQUIRED');
  const bankCoa = await financialCoa(client,tx);
  const payableCoa = await importantAccount(client,tx.company_id,'TRADE_PAYABLE');
  const allocations = await client.query<{ id:string; target_transaction_id:string; amount:string; transaction_number:string; grand_total:string; partner_id:string|null; payment_status:string }>(
    `SELECT a.id,a.target_transaction_id,a.amount::text,i.transaction_number,i.grand_total::text,i.partner_id,i.payment_status
       FROM transaction_allocations a
       JOIN transaction_headers i ON i.id=a.target_transaction_id
      WHERE a.source_transaction_id=$1 AND a.allocation_type='AP_PAYMENT'
      ORDER BY i.transaction_date,i.transaction_number
      FOR UPDATE OF i`, [tx.id],
  );
  if (!allocations.rowCount) throw new Error('DEBT_PAYMENT_ALLOCATION_REQUIRED');

  let total = new Decimal(0);
  const validated:Array<{ targetId:string; invoiceNo:string; allocation:Decimal; remaining:Decimal }> = [];
  for (const row of allocations.rows) {
    if (row.partner_id !== tx.partner_id) throw new Error('PAYMENT_SUPPLIER_MISMATCH');
    const otherPaid = await client.query<{ paid:string }>(
      `SELECT COALESCE(SUM(a.amount),0)::text paid
         FROM transaction_allocations a
         JOIN transaction_headers p ON p.id=a.source_transaction_id
        WHERE a.target_transaction_id=$1 AND a.allocation_type='AP_PAYMENT'
          AND p.id<>$2 AND p.workflow_status IN ('FINANCE_VERIFIED','POSTED')`,
      [row.target_transaction_id,tx.id],
    );
    const outstanding = amount(row.grand_total).sub(amount(otherPaid.rows[0]?.paid));
    const allocation = amount(row.amount);
    if (allocation.lte(0)) throw new Error('PAYMENT_ALLOCATION_MUST_BE_POSITIVE');
    if (allocation.gt(outstanding)) throw new Error(`PAYMENT_EXCEEDS_OUTSTANDING_${row.transaction_number}`);
    total = total.add(allocation);
    validated.push({ targetId:row.target_transaction_id,invoiceNo:row.transaction_number,allocation,remaining:outstanding.sub(allocation) });
  }
  if (!total.eq(amount(tx.grand_total))) throw new Error('PAYMENT_ALLOCATION_TOTAL_MISMATCH');

  const journalId = await createJournalHeader(client,tx);
  let lineNo = 1;
  for (const row of validated) {
    await client.query(
      `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,partner_id,metadata)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,$8::jsonb)`,
      [journalId,lineNo++,payableCoa,row.allocation.toFixed(4),`Pembayaran hutang ${row.invoiceNo}`,tx.location_id,tx.partner_id,
       JSON.stringify({ allocationType:'AP_PAYMENT',targetTransactionId:row.targetId,targetTransactionNumber:row.invoiceNo })],
    );
  }
  await client.query(
    `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,partner_id,metadata)
     VALUES($1,$2,$3,0,$4,$5,$6,$7,$8::jsonb)`,
    [journalId,lineNo,bankCoa,total.toFixed(4),`Kas/Bank keluar ${tx.transaction_number}`,tx.location_id,tx.partner_id,JSON.stringify({ cashOutType:'DEBT_PAYMENT' })],
  );

  await markVerified(client,tx,userId,'ACCOUNTING_REVIEW','FINANCE_VERIFY_DEBT_PAYMENT',{ journalId,total:total.toFixed(4) });
  for (const row of validated) {
    await client.query(
      `UPDATE transaction_headers SET payment_status=$1,updated_at=NOW()
        WHERE id=$2`, [row.remaining.lte(0.0001) ? 'PAID' : 'PARTIAL',row.targetId],
    );
  }
  return { journalId,requiresAccountDirection:false };
}

export async function verifyClientCashOut(transactionId:string,userId:string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client,transactionId);
    const journalId = await existingJournal(client,tx.id);
    if (journalId) { await client.query('COMMIT'); return { journalId,requiresAccountDirection:false,existing:true }; }
    if (tx.workflow_status === 'FINANCE_VERIFIED' && tx.cash_out_type === 'OPERATIONAL_EXPENSE') {
      await client.query('COMMIT');
      return { journalId:null,requiresAccountDirection:true,existing:true };
    }
    if (tx.workflow_status !== 'DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);

    if (tx.cash_out_type === 'DEBT_PAYMENT') {
      const result = await verifyDebtPayment(client,tx,userId);
      await client.query('COMMIT');
      return result;
    }
    if (tx.cash_out_type !== 'OPERATIONAL_EXPENSE') throw new Error('CASH_OUT_TYPE_REQUIRED');
    await financialCoa(client,tx);
    const lines = await client.query<{ line_total:string }>(
      `SELECT line_total::text FROM transaction_lines WHERE transaction_id=$1 ORDER BY line_no`, [tx.id],
    );
    if (!lines.rowCount) throw new Error('CASH_OUT_LINES_REQUIRED');
    const total = lines.rows.reduce((sum,row) => sum.add(amount(row.line_total)),new Decimal(0));
    if (!total.eq(amount(tx.grand_total))) throw new Error('CASH_OUT_TOTAL_MISMATCH');
    await markVerified(client,tx,userId,'NEEDS_ACCOUNT_DIRECTION','FINANCE_VERIFY_OPERATIONAL_EXPENSE',{ total:total.toFixed(4) });
    await client.query('COMMIT');
    return { journalId:null,requiresAccountDirection:true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function directOperationalCashOut(transactionId:string,userId:string,assignments:Array<{ lineId:string; accountId:string }>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client,transactionId);
    if (tx.cash_out_type !== 'OPERATIONAL_EXPENSE') throw new Error('OPERATIONAL_EXPENSE_REQUIRED');
    if (tx.workflow_status !== 'FINANCE_VERIFIED' || tx.accounting_status !== 'NEEDS_ACCOUNT_DIRECTION') {
      throw new Error('TRANSACTION_NOT_WAITING_ACCOUNT_DIRECTION');
    }
    if (await existingJournal(client,tx.id)) throw new Error('JOURNAL_ALREADY_EXISTS');

    const sourceLines = await client.query<{ id:string; line_no:number; description:string|null; line_total:string; location_id:string|null; cost_center_id:string|null }>(
      `SELECT id,line_no,description,line_total::text,location_id,cost_center_id
         FROM transaction_lines WHERE transaction_id=$1 ORDER BY line_no FOR UPDATE`, [tx.id],
    );
    if (!sourceLines.rowCount) throw new Error('CASH_OUT_LINES_REQUIRED');
    const assignmentMap = new Map(assignments.map(x => [x.lineId,x.accountId]));
    if (assignmentMap.size !== sourceLines.rowCount) throw new Error('ACCOUNT_DIRECTION_REQUIRED_FOR_ALL_LINES');

    const accountIds = [...new Set(assignments.map(x => x.accountId))];
    const accounts = await client.query<{ id:string }>(
      `SELECT id FROM chart_of_accounts WHERE id=ANY($1::uuid[]) AND company_id=$2 AND status='ACTIVE' AND allow_manual_posting=TRUE`,
      [accountIds,tx.company_id],
    );
    if (accounts.rowCount !== accountIds.length) throw new Error('INVALID_ACCOUNT_DIRECTION');

    const bankCoa = await financialCoa(client,tx);
    const journalId = await createJournalHeader(client,tx);
    let lineNo = 1;
    let total = new Decimal(0);
    for (const line of sourceLines.rows) {
      const accountId = assignmentMap.get(line.id);
      if (!accountId) throw new Error(`ACCOUNT_REQUIRED_LINE_${line.line_no}`);
      const lineAmount = amount(line.line_total);
      if (lineAmount.lte(0)) throw new Error(`POSITIVE_AMOUNT_REQUIRED_LINE_${line.line_no}`);
      total = total.add(lineAmount);
      await client.query(`UPDATE transaction_lines SET line_type='ACCOUNT',account_id=$1 WHERE id=$2`,[accountId,line.id]);
      await client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,cost_center_id,partner_id,source_transaction_line_id,metadata)
         VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10::jsonb)`,
        [journalId,lineNo++,accountId,lineAmount.toFixed(4),line.description || tx.payee_name || tx.transaction_number,
         line.location_id || tx.location_id,line.cost_center_id,tx.partner_id,line.id,JSON.stringify({ cashOutType:'OPERATIONAL_EXPENSE',directedByAccounting:true })],
      );
    }
    if (!total.eq(amount(tx.grand_total))) throw new Error('CASH_OUT_TOTAL_MISMATCH');
    await client.query(
      `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,partner_id,metadata)
       VALUES($1,$2,$3,0,$4,$5,$6,$7,$8::jsonb)`,
      [journalId,lineNo,bankCoa,total.toFixed(4),`Kas/Bank keluar ${tx.transaction_number}`,tx.location_id,tx.partner_id,JSON.stringify({ cashOutType:'OPERATIONAL_EXPENSE' })],
    );
    await client.query(
      `UPDATE transaction_headers SET accounting_status='ACCOUNTING_REVIEW',updated_by=$1,updated_at=NOW() WHERE id=$2`,
      [userId,tx.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'ACCOUNTING_DIRECT_ACCOUNTS',$4::jsonb)`,
      [tx.workspace_id,userId,tx.id,JSON.stringify({ journalId,assignments,engineVersion:ENGINE_VERSION })],
    );
    await client.query('COMMIT');
    return { journalId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
