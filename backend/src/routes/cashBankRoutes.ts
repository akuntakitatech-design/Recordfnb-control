import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, requirePermission } from '../permissions.js';
import { isDateOnly, paging, text } from '../http.js';

export const cashBankRouter = Router();
cashBankRouter.use(requireAuth);

cashBankRouter.get('/cash-bank/balances', requirePermission('cashbank.view'), async (req, res) => {
  const allowed = await allowedUnitIds(req.user!);
  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else {
      conditions.push(`b.id IN (SELECT a.bank_account_id FROM unit_bank_account_assignments a
                                 WHERE a.status='ACTIVE' AND a.unit_id IN (?))`);
      params.push(allowed);
    }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<any>(
    `SELECT b.id,b.bank_name,b.account_number,b.account_holder,b.account_usage,b.currency,b.status,b.verified_at,
            COALESCE(SUM(CASE WHEN m.direction='IN' THEN m.amount ELSE 0 END), 0) total_in,
            COALESCE(SUM(CASE WHEN m.direction='OUT' THEN m.amount ELSE 0 END), 0) total_out
       FROM bank_accounts b
       LEFT JOIN bank_mutations m ON m.bank_account_id=b.id
       ${where}
      GROUP BY b.id
      ORDER BY b.bank_name, b.account_number`,
    params,
  );

  const assignmentRows = await query<{ bank_account_id: string; unit_id: string }>(
    `SELECT DISTINCT bank_account_id,unit_id FROM unit_bank_account_assignments
      WHERE status='ACTIVE' AND allow_receipt=1${allowed !== null && allowed.length ? ' AND unit_id IN (?)' : ''}`,
    allowed !== null && allowed.length ? [allowed] : [],
  );
  const receiptUnits = new Map<string, string[]>();
  for (const row of assignmentRows) {
    const list = receiptUnits.get(row.bank_account_id) || [];
    list.push(row.unit_id);
    receiptUnits.set(row.bank_account_id, list);
  }

  res.json(rows.map(row => ({
    ...row,
    total_in: Number(row.total_in),
    total_out: Number(row.total_out),
    balance: Number(row.total_in) - Number(row.total_out),
    receipt_unit_ids: receiptUnits.get(row.id) || [],
  })));
});

cashBankRouter.get('/cash-bank/mutations', requirePermission('cashbank.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const bankAccountId = text(req.query.bankAccountId);
  const from = text(req.query.from);
  const to = text(req.query.to);

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('m.unit_id IN (?)'); params.push(allowed); }
  }
  if (bankAccountId) { conditions.push('m.bank_account_id=?'); params.push(bankAccountId); }
  if (from && isDateOnly(from)) { conditions.push('m.mutation_date>=?'); params.push(from); }
  if (to && isDateOnly(to)) { conditions.push('m.mutation_date<=?'); params.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT m.id,m.mutation_date,m.direction,m.amount,m.source_type,m.source_id,m.description,
            b.bank_name,b.account_number,u.unit_code,u.unit_name
       FROM bank_mutations m
       JOIN bank_accounts b ON b.id=m.bank_account_id
       LEFT JOIN organization_units u ON u.id=m.unit_id
       ${where}
      ORDER BY m.mutation_date DESC, m.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(`SELECT COUNT(*) total FROM bank_mutations m ${where}`, params);

  const totalIn = await one<{ total: number }>(
    `SELECT COALESCE(SUM(m.amount),0) total FROM bank_mutations m ${where ? `${where} AND` : 'WHERE'} m.direction='IN'`, params,
  );
  const totalOut = await one<{ total: number }>(
    `SELECT COALESCE(SUM(m.amount),0) total FROM bank_mutations m ${where ? `${where} AND` : 'WHERE'} m.direction='OUT'`, params,
  );

  res.json({
    rows,
    total: Number(total?.total || 0),
    page: Math.floor(offset / pageSize) + 1,
    pageSize,
    totals: { in: Number(totalIn?.total || 0), out: Number(totalOut?.total || 0) },
  });
});
