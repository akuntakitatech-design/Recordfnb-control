import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { isDateOnly, paging, text, today, upper } from '../http.js';

export const reportRouter = Router();
reportRouter.use(requireAuth);

/** Scope unit untuk kolom tertentu; null = seluruh yayasan. */
async function unitScope(req: any, alias: string) {
  const allowed = await allowedUnitIds(req.user!);
  if (allowed === null) return { sql: '', params: [] as any[] };
  if (allowed.length === 0) return { sql: ' AND 1=0', params: [] as any[] };
  return { sql: ` AND ${alias} IN (?)`, params: [allowed] as any[] };
}

function rangeOf(req: any) {
  const firstDay = `${today().slice(0, 7)}-01`;
  const from = isDateOnly(text(req.query.from)) ? text(req.query.from) : firstDay;
  const to = isDateOnly(text(req.query.to)) ? text(req.query.to) : today();
  return { from, to };
}

const CASH_PREFIX = '1-11';

/* ------------------------------------------------------------------ Ringkasan */

reportRouter.get('/reports/overview', requirePermission('report.view'), async (req, res) => {
  const { from, to } = rangeOf(req);
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const unitId = text(req.query.unitId);
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const scope = await unitScope(req, 'u.id');
  const unitFilter = unitId ? ' AND x.unit_id=?' : '';
  const unitParams = unitId ? [unitId] : [];

  const perUnit = await query<any>(
    `SELECT u.id unit_id,u.unit_code,u.unit_name,
            el.id level_id,el.code level_code,el.name level_name,
            COALESCE(b.billed,0) billed, COALESCE(b.invoice_count,0) invoice_count,
            COALESCE(c.collected,0) collected, COALESCE(c.receipt_count,0) receipt_count,
            COALESCE(x.expenses,0) expenses, COALESCE(x.payment_count,0) payment_count,
            COALESCE(o.outstanding,0) outstanding, COALESCE(o.open_invoices,0) open_invoices,
            COALESCE(st.students,0) students
       FROM organization_units u
       LEFT JOIN education_levels el ON el.id=u.education_level_id
       LEFT JOIN (
         SELECT i.unit_id, SUM(i.total_amount) billed, COUNT(*) invoice_count
           FROM invoices i WHERE i.status<>'VOID' AND i.invoice_date BETWEEN ? AND ? GROUP BY i.unit_id
       ) b ON b.unit_id=u.id
       LEFT JOIN (
         SELECT r.unit_id, SUM(r.total_amount) collected, COUNT(*) receipt_count
           FROM receipts r WHERE r.status='POSTED' AND r.receipt_date BETWEEN ? AND ? GROUP BY r.unit_id
       ) c ON c.unit_id=u.id
       LEFT JOIN (
         SELECT p.unit_id, SUM(p.amount) expenses, COUNT(*) payment_count
           FROM expense_payments p WHERE p.status='POSTED' AND p.payment_date BETWEEN ? AND ? GROUP BY p.unit_id
       ) x ON x.unit_id=u.id
       LEFT JOIN (
         SELECT i.unit_id, SUM(i.total_amount - i.paid_amount) outstanding, COUNT(*) open_invoices
           FROM invoices i WHERE i.status<>'VOID' AND (i.total_amount - i.paid_amount) > 0 GROUP BY i.unit_id
       ) o ON o.unit_id=u.id
       LEFT JOIN (
         SELECT e.unit_id, COUNT(*) students FROM student_enrollments e
          WHERE e.status='ACTIVE' GROUP BY e.unit_id
       ) st ON st.unit_id=u.id
      WHERE u.legal_entity_id=?${scope.sql}${unitFilter}
      ORDER BY (COALESCE(b.billed,0) + COALESCE(c.collected,0) + COALESCE(x.expenses,0)
                + COALESCE(o.outstanding,0)) DESC, u.unit_name`,
    [from, to, from, to, from, to, entity.id, ...scope.params, ...unitParams],
  );

  const units = perUnit.map((row: any) => ({
    ...row,
    billed: Number(row.billed),
    collected: Number(row.collected),
    expenses: Number(row.expenses),
    outstanding: Number(row.outstanding),
    surplus: Number(row.collected) - Number(row.expenses),
    students: Number(row.students),
    invoice_count: Number(row.invoice_count),
    receipt_count: Number(row.receipt_count),
    payment_count: Number(row.payment_count),
    open_invoices: Number(row.open_invoices),
  }));

  const levelMap = new Map<string, any>();
  for (const row of units) {
    const key = row.level_id || 'NONE';
    const current = levelMap.get(key) || {
      level_id: row.level_id, level_code: row.level_code || 'LAIN', level_name: row.level_name || 'Tanpa jenjang',
      billed: 0, collected: 0, expenses: 0, outstanding: 0, students: 0, units: 0,
    };
    current.billed += row.billed;
    current.collected += row.collected;
    current.expenses += row.expenses;
    current.outstanding += row.outstanding;
    current.students += row.students;
    current.units += 1;
    levelMap.set(key, current);
  }
  const byLevel = [...levelMap.values()]
    .map(row => ({ ...row, surplus: row.collected - row.expenses }))
    .sort((a, b) => b.collected - a.collected);

  const totals = units.reduce((acc: any, row: any) => ({
    billed: acc.billed + row.billed,
    collected: acc.collected + row.collected,
    expenses: acc.expenses + row.expenses,
    outstanding: acc.outstanding + row.outstanding,
    students: acc.students + row.students,
    invoiceCount: acc.invoiceCount + row.invoice_count,
    receiptCount: acc.receiptCount + row.receipt_count,
    paymentCount: acc.paymentCount + row.payment_count,
  }), { billed: 0, collected: 0, expenses: 0, outstanding: 0, students: 0, invoiceCount: 0, receiptCount: 0, paymentCount: 0 });
  totals.surplus = totals.collected - totals.expenses;

  const agingScope = await unitScope(req, 'i.unit_id');
  const agingUnit = unitId ? ' AND i.unit_id=?' : '';
  const agingRow = await one<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN DATEDIFF(CURRENT_DATE, i.due_date) <= 0 THEN i.total_amount - i.paid_amount ELSE 0 END),0) current_bucket,
       COALESCE(SUM(CASE WHEN DATEDIFF(CURRENT_DATE, i.due_date) BETWEEN 1 AND 30 THEN i.total_amount - i.paid_amount ELSE 0 END),0) d1_30,
       COALESCE(SUM(CASE WHEN DATEDIFF(CURRENT_DATE, i.due_date) BETWEEN 31 AND 60 THEN i.total_amount - i.paid_amount ELSE 0 END),0) d31_60,
       COALESCE(SUM(CASE WHEN DATEDIFF(CURRENT_DATE, i.due_date) > 60 THEN i.total_amount - i.paid_amount ELSE 0 END),0) d61_plus
       FROM invoices i
      WHERE i.legal_entity_id=? AND i.status<>'VOID' AND (i.total_amount - i.paid_amount) > 0${agingScope.sql}${agingUnit}`,
    [entity.id, ...agingScope.params, ...(unitId ? [unitId] : [])],
  );

  const closing = await query(
    'SELECT name,status,start_date,end_date FROM fiscal_periods WHERE legal_entity_id=? ORDER BY start_date DESC LIMIT 6',
    [entity.id],
  );

  res.json({
    from, to,
    totals,
    units,
    byLevel,
    aging: {
      CURRENT: Number(agingRow?.current_bucket || 0),
      D1_30: Number(agingRow?.d1_30 || 0),
      D31_60: Number(agingRow?.d31_60 || 0),
      D61_PLUS: Number(agingRow?.d61_plus || 0),
    },
    closing,
  });
});

/* ------------------------------------------------------------------ Posisi keuangan */

reportRouter.get('/reports/position', requirePermission('report.view'), async (req, res) => {
  const asOf = isDateOnly(text(req.query.asOf)) ? text(req.query.asOf) : today();
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });
  const scope = await unitScope(req, 'l.unit_id');

  const rows = await query<any>(
    `SELECT a.account_type,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE e.legal_entity_id=? AND e.entry_date<=?${scope.sql}
      GROUP BY a.account_type`,
    [entity.id, asOf, ...scope.params],
  );

  const totals: Record<string, number> = { ASSET: 0, LIABILITY: 0, EQUITY: 0, REVENUE: 0, EXPENSE: 0 };
  for (const row of rows) {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const type = String(row.account_type);
    if (type === 'ASSET' || type === 'EXPENSE') totals[type] = debit - credit;
    else totals[type] = credit - debit;
  }
  const netIncome = totals.REVENUE - totals.EXPENSE;
  const liabilitiesAndEquity = totals.LIABILITY + totals.EQUITY + netIncome;

  res.json({
    asOf,
    assets: totals.ASSET,
    liabilities: totals.LIABILITY,
    equity: totals.EQUITY,
    revenue: totals.REVENUE,
    expense: totals.EXPENSE,
    netIncome,
    liabilitiesAndEquity,
    difference: totals.ASSET - liabilitiesAndEquity,
    balanced: Math.abs(totals.ASSET - liabilitiesAndEquity) < 0.005,
  });
});

/* ------------------------------------------------------------------ Aktivitas (pendapatan & beban) */

reportRouter.get('/reports/activity', requirePermission('report.view'), async (req, res) => {
  const { from, to } = rangeOf(req);
  const unitId = text(req.query.unitId);
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });
  const scope = await unitScope(req, 'l.unit_id');

  const rows = await query<any>(
    `SELECT a.code,a.name,a.account_type,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE e.legal_entity_id=? AND e.entry_date BETWEEN ? AND ?
        AND a.account_type IN ('REVENUE','EXPENSE')${scope.sql}${unitId ? ' AND l.unit_id=?' : ''}
      GROUP BY a.id,a.code,a.name,a.account_type
      ORDER BY a.account_type DESC, a.code`,
    [entity.id, from, to, ...scope.params, ...(unitId ? [unitId] : [])],
  );

  const items = rows.map((row: any) => {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const amount = row.account_type === 'REVENUE' ? credit - debit : debit - credit;
    return { code: row.code, name: row.name, account_type: row.account_type, amount };
  });
  const revenue = items.filter(row => row.account_type === 'REVENUE').reduce((sum, row) => sum + row.amount, 0);
  const expense = items.filter(row => row.account_type === 'EXPENSE').reduce((sum, row) => sum + row.amount, 0);

  res.json({ from, to, items, revenue, expense, surplus: revenue - expense });
});

/* ------------------------------------------------------------------ Arus kas */

reportRouter.get('/reports/cash-flow', requirePermission('report.view'), async (req, res) => {
  const { from, to } = rangeOf(req);
  const unitId = text(req.query.unitId);
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });
  const scope = await unitScope(req, 'l.unit_id');

  const openingRow = await one<any>(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) total
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE e.legal_entity_id=? AND a.code LIKE ? AND e.entry_date < ?${scope.sql}${unitId ? ' AND l.unit_id=?' : ''}`,
    [entity.id, `${CASH_PREFIX}%`, from, ...scope.params, ...(unitId ? [unitId] : [])],
  );

  const rows = await query<any>(
    `SELECT e.source_type, COALESCE(SUM(l.debit - l.credit),0) net
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE e.legal_entity_id=? AND a.code LIKE ? AND e.entry_date BETWEEN ? AND ?${scope.sql}${unitId ? ' AND l.unit_id=?' : ''}
      GROUP BY e.source_type
      ORDER BY e.source_type`,
    [entity.id, `${CASH_PREFIX}%`, from, to, ...scope.params, ...(unitId ? [unitId] : [])],
  );

  const LABELS: Record<string, string> = {
    RECEIPT: 'Penerimaan siswa',
    RECEIPT_VOID: 'Pembatalan penerimaan',
    EXPENSE_PAYMENT: 'Pengeluaran',
    EXPENSE_PAYMENT_VOID: 'Pembatalan pengeluaran',
    MANUAL: 'Penyesuaian manual',
  };
  const movements = rows.map((row: any) => ({
    source_type: row.source_type,
    label: LABELS[row.source_type] || row.source_type,
    amount: Number(row.net),
  }));
  const opening = Number(openingRow?.total || 0);
  const netChange = movements.reduce((sum, row) => sum + row.amount, 0);

  res.json({
    from, to, opening, movements, netChange, closing: opening + netChange,
    inflow: movements.filter(row => row.amount > 0).reduce((sum, row) => sum + row.amount, 0),
    outflow: movements.filter(row => row.amount < 0).reduce((sum, row) => sum + row.amount, 0),
  });
});

/* ------------------------------------------------------------------ Drill-down */

const DRILLDOWN = {
  billed: {
    listSql: `SELECT i.id,i.invoice_number document_number,i.invoice_date document_date,i.total_amount amount,
                     i.status,s.full_name party,s.nis reference,u.unit_code,u.unit_name
                FROM invoices i JOIN students s ON s.id=i.student_id
                JOIN organization_units u ON u.id=i.unit_id`,
    fromSql: `invoices i JOIN students s ON s.id=i.student_id JOIN organization_units u ON u.id=i.unit_id`,
    whereSql: "i.status<>'VOID'",
    alias: 'i', dateColumn: 'invoice_date', sumExpr: 'i.total_amount',
  },
  collected: {
    listSql: `SELECT r.id,r.receipt_number document_number,r.receipt_date document_date,r.total_amount amount,
                     r.status,r.payer_name party,r.reference_number reference,u.unit_code,u.unit_name
                FROM receipts r JOIN organization_units u ON u.id=r.unit_id`,
    fromSql: 'receipts r JOIN organization_units u ON u.id=r.unit_id',
    whereSql: "r.status='POSTED'",
    alias: 'r', dateColumn: 'receipt_date', sumExpr: 'r.total_amount',
  },
  expense: {
    listSql: `SELECT p.id,p.payment_number document_number,p.payment_date document_date,p.amount amount,
                     p.status,r.request_number reference,b.bank_name party,u.unit_code,u.unit_name
                FROM expense_payments p
                JOIN expense_requests r ON r.id=p.expense_request_id
                JOIN organization_units u ON u.id=p.unit_id
                JOIN bank_accounts b ON b.id=p.bank_account_id`,
    fromSql: `expense_payments p JOIN expense_requests r ON r.id=p.expense_request_id
              JOIN organization_units u ON u.id=p.unit_id JOIN bank_accounts b ON b.id=p.bank_account_id`,
    whereSql: "p.status='POSTED'",
    alias: 'p', dateColumn: 'payment_date', sumExpr: 'p.amount',
  },
  outstanding: {
    listSql: `SELECT i.id,i.invoice_number document_number,i.due_date document_date,
                     (i.total_amount - i.paid_amount) amount,i.status,s.full_name party,s.nis reference,
                     u.unit_code,u.unit_name
                FROM invoices i JOIN students s ON s.id=i.student_id
                JOIN organization_units u ON u.id=i.unit_id`,
    fromSql: `invoices i JOIN students s ON s.id=i.student_id JOIN organization_units u ON u.id=i.unit_id`,
    whereSql: "i.status<>'VOID' AND (i.total_amount - i.paid_amount) > 0",
    alias: 'i', dateColumn: 'invoice_date', sumExpr: 'i.total_amount - i.paid_amount',
  },
};

reportRouter.get('/reports/drilldown', requirePermission('report.view'), async (req, res) => {
  const key = (upper(req.query.metric) || 'BILLED').toLowerCase() as keyof typeof DRILLDOWN;
  const config = DRILLDOWN[key];
  if (!config) return res.status(400).json({ error: 'DRILLDOWN_METRIC_INVALID' });

  const { from, to } = rangeOf(req);
  const unitId = text(req.query.unitId);
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const scope = await unitScope(req, `${config.alias}.unit_id`);

  const extraSql = unitId ? ` AND ${config.alias}.unit_id=?` : '';
  const extraParams = unitId ? [unitId] : [];
  const baseParams: any[] = [entity.id, from, to, ...scope.params, ...extraParams];

  const rows = await query(
    `${config.listSql}
      WHERE ${config.alias}.legal_entity_id=? AND ${config.whereSql}
        AND ${config.alias}.${config.dateColumn} BETWEEN ? AND ?${scope.sql}${extraSql}
      ORDER BY document_date DESC, document_number DESC
      LIMIT ? OFFSET ?`,
    [...baseParams, pageSize, offset],
  );
  const aggregate = await one<any>(
    `SELECT COUNT(*) total, COALESCE(SUM(${config.sumExpr}),0) sum_amount
       FROM ${config.fromSql}
      WHERE ${config.alias}.legal_entity_id=? AND ${config.whereSql}
        AND ${config.alias}.${config.dateColumn} BETWEEN ? AND ?${scope.sql}${extraSql}`,
    baseParams,
  );

  res.json({
    metric: key, from, to,
    rows,
    total: Number(aggregate?.total || 0),
    sumAmount: Number(aggregate?.sum_amount || 0),
    page: Math.floor(offset / pageSize) + 1,
    pageSize,
  });
});
