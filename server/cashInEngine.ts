import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

const ENGINE_VERSION = '0.10';

type CashInHeader = {
  id:string; workspace_id:string; company_id:string; location_id:string|null; financial_account_id:string|null;
  transaction_number:string; transaction_date:string; grand_total:string; workflow_status:string; accounting_status:string;
  cash_in_type:string|null; source_name:string|null;
};

function amount(value:string|number|null|undefined) { return new Decimal(value || 0); }

async function loadHeader(client:PoolClient, transactionId:string) {
  const result = await client.query<CashInHeader>(
    `SELECT id,workspace_id,company_id,location_id,financial_account_id,transaction_number,transaction_date::text,
            grand_total::text,workflow_status,accounting_status,cash_in_type,source_name
       FROM transaction_headers
      WHERE id=$1 AND transaction_type='CASH_IN'
      FOR UPDATE`, [transactionId],
  );
  if (!result.rowCount) throw new Error('CASH_IN_NOT_FOUND');
  return result.rows[0];
}

async function financialCoa(client:PoolClient, tx:CashInHeader) {
  if (!tx.financial_account_id) throw new Error('FINANCIAL_ACCOUNT_REQUIRED');
  const result = await client.query<{ coa_account_id:string }>(
    `SELECT coa_account_id FROM financial_accounts
      WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [tx.financial_account_id, tx.company_id],
  );
  if (!result.rowCount) throw new Error('INVALID_FINANCIAL_ACCOUNT');
  return result.rows[0].coa_account_id;
}

async function existingJournal(client:PoolClient, transactionId:string) {
  const result = await client.query<{ id:string }>(
    `SELECT id FROM journal_headers WHERE source_transaction_id=$1 AND status<>'VOID' LIMIT 1`, [transactionId],
  );
  return result.rows[0]?.id || null;
}

async function markVerified(client:PoolClient, tx:CashInHeader, userId:string) {
  await client.query(
    `UPDATE transaction_headers
        SET workflow_status='FINANCE_VERIFIED',operational_status='FINANCE_VERIFIED',accounting_status='NEEDS_ACCOUNT_DIRECTION',
            verified_by=$1,verified_at=COALESCE(verified_at,NOW()),updated_by=$1,updated_at=NOW()
      WHERE id=$2`, [userId,tx.id],
  );
  await client.query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'TRANSACTION',$3,'FINANCE_VERIFY_CASH_IN',$4::jsonb)`,
    [tx.workspace_id,userId,tx.id,JSON.stringify({ accountingStatus:'NEEDS_ACCOUNT_DIRECTION',engineVersion:ENGINE_VERSION })],
  );
}

export async function verifyClientCashIn(transactionId:string,userId:string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client,transactionId);
    const journalId = await existingJournal(client,tx.id);
    if (journalId) { await client.query('COMMIT'); return { journalId,requiresAccountDirection:false,existing:true }; }
    if (tx.workflow_status === 'FINANCE_VERIFIED' && tx.accounting_status === 'NEEDS_ACCOUNT_DIRECTION') {
      await client.query('COMMIT');
      return { journalId:null,requiresAccountDirection:true,existing:true };
    }
    if (tx.workflow_status !== 'DRAFT') throw new Error(`TRANSACTION_STATUS_MUST_BE_DRAFT_${tx.workflow_status}`);
    if (!['BUSINESS_RECEIPT','OTHER_RECEIPT'].includes(tx.cash_in_type || '')) throw new Error('CASH_IN_TYPE_REQUIRED');
    await financialCoa(client,tx);
    const lines = await client.query<{ line_total:string }>(
      `SELECT line_total::text FROM transaction_lines WHERE transaction_id=$1 ORDER BY line_no`, [tx.id],
    );
    if (!lines.rowCount) throw new Error('CASH_IN_LINES_REQUIRED');
    const total = lines.rows.reduce((sum,row) => sum.add(amount(row.line_total)),new Decimal(0));
    if (!total.eq(amount(tx.grand_total))) throw new Error('CASH_IN_TOTAL_MISMATCH');
    await markVerified(client,tx,userId);
    await client.query('COMMIT');
    return { journalId:null,requiresAccountDirection:true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function directCashIn(transactionId:string,userId:string,assignments:Array<{ lineId:string; accountId:string }>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await loadHeader(client,transactionId);
    if (tx.workflow_status !== 'FINANCE_VERIFIED' || tx.accounting_status !== 'NEEDS_ACCOUNT_DIRECTION') {
      throw new Error('TRANSACTION_NOT_WAITING_ACCOUNT_DIRECTION');
    }
    if (await existingJournal(client,tx.id)) throw new Error('JOURNAL_ALREADY_EXISTS');

    const sourceLines = await client.query<{ id:string;line_no:number;description:string|null;line_total:string;location_id:string|null;cost_center_id:string|null }>(
      `SELECT id,line_no,description,line_total::text,location_id,cost_center_id
         FROM transaction_lines WHERE transaction_id=$1 ORDER BY line_no FOR UPDATE`, [tx.id],
    );
    if (!sourceLines.rowCount) throw new Error('CASH_IN_LINES_REQUIRED');
    const assignmentMap = new Map(assignments.map(x => [x.lineId,x.accountId]));
    if (assignmentMap.size !== sourceLines.rowCount) throw new Error('ACCOUNT_DIRECTION_REQUIRED_FOR_ALL_LINES');

    const accountIds = [...new Set(assignments.map(x => x.accountId))];
    const accounts = await client.query<{ id:string }>(
      `SELECT id FROM chart_of_accounts WHERE id=ANY($1::uuid[]) AND company_id=$2 AND status='ACTIVE' AND allow_manual_posting=TRUE`,
      [accountIds,tx.company_id],
    );
    if (accounts.rowCount !== accountIds.length) throw new Error('INVALID_ACCOUNT_DIRECTION');

    const bankCoa = await financialCoa(client,tx);
    const journal = await client.query<{ id:string }>(
      `INSERT INTO journal_headers(
         workspace_id,company_id,journal_number,journal_date,journal_type,source_transaction_id,status,description,engine_version)
       VALUES($1,$2,$3,$4,'AUTO_CASH_IN',$5,'DRAFT',$6,$7)
       RETURNING id`,
      [tx.workspace_id,tx.company_id,`AJ-${tx.transaction_number}`,tx.transaction_date,tx.id,`Auto journal ${tx.transaction_number}`,ENGINE_VERSION],
    );
    const journalId = journal.rows[0].id;
    const total = amount(tx.grand_total);
    let lineNo = 1;

    await client.query(
      `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,metadata)
       VALUES($1,$2,$3,$4,0,$5,$6,$7::jsonb)`,
      [journalId,lineNo++,bankCoa,total.toFixed(4),`Kas/Bank masuk ${tx.transaction_number}`,tx.location_id,
       JSON.stringify({ cashInType:tx.cash_in_type,sourceName:tx.source_name })],
    );

    let directedTotal = new Decimal(0);
    for (const line of sourceLines.rows) {
      const accountId = assignmentMap.get(line.id);
      if (!accountId) throw new Error(`ACCOUNT_REQUIRED_LINE_${line.line_no}`);
      const lineAmount = amount(line.line_total);
      if (lineAmount.lte(0)) throw new Error(`POSITIVE_AMOUNT_REQUIRED_LINE_${line.line_no}`);
      directedTotal = directedTotal.add(lineAmount);
      await client.query(`UPDATE transaction_lines SET line_type='ACCOUNT',account_id=$1 WHERE id=$2`,[accountId,line.id]);
      await client.query(
        `INSERT INTO journal_lines(journal_id,line_no,account_id,debit,credit,description,location_id,cost_center_id,source_transaction_line_id,metadata)
         VALUES($1,$2,$3,0,$4,$5,$6,$7,$8,$9::jsonb)`,
        [journalId,lineNo++,accountId,lineAmount.toFixed(4),line.description || tx.source_name || tx.transaction_number,
         line.location_id || tx.location_id,line.cost_center_id,line.id,
         JSON.stringify({ cashInType:tx.cash_in_type,directedByAccounting:true })],
      );
    }
    if (!directedTotal.eq(total)) throw new Error('CASH_IN_TOTAL_MISMATCH');

    await client.query(
      `UPDATE transaction_headers SET accounting_status='ACCOUNTING_REVIEW',updated_by=$1,updated_at=NOW() WHERE id=$2`,
      [userId,tx.id],
    );
    await client.query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'TRANSACTION',$3,'ACCOUNTING_DIRECT_CASH_IN',$4::jsonb)`,
      [tx.workspace_id,userId,tx.id,JSON.stringify({ journalId,assignments,engineVersion:ENGINE_VERSION })],
    );
    await client.query('COMMIT');
    return { journalId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
