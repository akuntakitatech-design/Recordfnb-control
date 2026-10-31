import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { isDateOnly, nullableText, paging, text, toCents, today, upper } from '../http.js';
import {
  ensurePeriod, journalForExpensePayment, journalForInvoice, journalForReceipt, postJournal, reverseJournal,
} from '../accounting.js';

export const accountingRouter = Router();
accountingRouter.use(requireAuth);

const MAX_AMOUNT = 1_000_000_000_00; // Rp 1 miliar dalam sen

/* ------------------------------------------------------------------ Bagan akun */

accountingRouter.get('/accounts', requirePermission('accounting.view'), async (req, res) => {
  const search = text(req.query.q);
  const type = upper(req.query.type);
  const conditions: string[] = [];
  const params: any[] = [];
  if (type) { conditions.push('account_type=?'); params.push(type); }
  if (search) { conditions.push('(code LIKE ? OR name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await query(
    `SELECT id,code,name,account_type,normal_balance,parent_id,is_postable,status
       FROM accounts ${where} ORDER BY code`, params,
  ));
});

accountingRouter.post('/accounts', requirePermission('coa.manage'), async (req, res) => {
  const code = text(req.body?.code);
  const name = text(req.body?.name);
  const type = upper(req.body?.accountType);
  const normal = upper(req.body?.normalBalance);
  if (!code || name.length < 3) return res.status(400).json({ error: 'ACCOUNT_FIELDS_REQUIRED' });
  if (!['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].includes(type)) {
    return res.status(400).json({ error: 'ACCOUNT_TYPE_INVALID' });
  }
  if (!['DEBIT', 'CREDIT'].includes(normal)) return res.status(400).json({ error: 'ACCOUNT_NORMAL_INVALID' });

  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });
  if (await one('SELECT id FROM accounts WHERE legal_entity_id=? AND code=?', [entity.id, code])) {
    return res.status(409).json({ error: 'ACCOUNT_DUPLICATE' });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance,is_postable)
     VALUES(?,?,?,?,?,?,?)`,
    [id, entity.id, code, name, type, normal, req.body?.isPostable === false ? 0 : 1],
  );
  await writeAudit({
    legalEntityId: entity.id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'ACCOUNT_CREATE', entityType: 'ACCOUNT', entityId: id,
    after: { code, name, account_type: type, normal_balance: normal },
  });
  res.status(201).json(await one('SELECT * FROM accounts WHERE id=?', [id]));
});

accountingRouter.patch('/accounts/:id', requirePermission('coa.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM accounts WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });

  const name = nullableText(req.body?.name) ?? before.name;
  const status = upper(req.body?.status) || before.status;
  const postable = req.body?.isPostable === undefined ? before.is_postable : (req.body?.isPostable ? 1 : 0);
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'ACCOUNT_STATUS_INVALID' });

  await query('UPDATE accounts SET name=?,status=?,is_postable=? WHERE id=?', [name, status, postable, id]);
  const after = await one('SELECT * FROM accounts WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'ACCOUNT_UPDATE', entityType: 'ACCOUNT', entityId: id, before, after,
  });
  res.json(after);
});

/* ------------------------------------------------------------------ Periode fiskal */

accountingRouter.get('/fiscal-periods', requirePermission('accounting.view'), async (req, res) => {
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.json([]);

  // Pastikan periode bulan berjalan tersedia agar penutupan bisa dilakukan.
  const conn = await pool.getConnection();
  try {
    await ensurePeriod(conn, entity.id, today());
  } catch {
    // periode berjalan mungkin sudah ditutup — tetap tampilkan daftar
  } finally {
    conn.release();
  }

  res.json(await query(
    `SELECT p.id,p.name,p.start_date,p.end_date,p.status,p.closed_at,p.reopened_at,p.reopen_reason,
            cu.full_name closed_by_name
       FROM fiscal_periods p
       LEFT JOIN users cu ON cu.id=p.closed_by
      WHERE p.legal_entity_id=? ORDER BY p.start_date DESC`,
    [entity.id],
  ));
});

accountingRouter.post('/fiscal-periods/:id/close', requirePermission('period.close'), async (req, res) => {
  const id = text(req.params.id);
  const period = await one<any>('SELECT * FROM fiscal_periods WHERE id=?', [id]);
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });
  if (period.status === 'CLOSED') return res.status(409).json({ error: 'PERIOD_ALREADY_CLOSED' });

  await query("UPDATE fiscal_periods SET status='CLOSED',closed_by=?,closed_at=NOW(6) WHERE id=?", [req.user!.id, id]);
  await writeAudit({
    legalEntityId: period.legal_entity_id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'PERIOD_CLOSE', entityType: 'FISCAL_PERIOD', entityId: id,
    before: { status: 'OPEN' }, after: { status: 'CLOSED' },
  });
  res.json(await one('SELECT * FROM fiscal_periods WHERE id=?', [id]));
});

accountingRouter.post('/fiscal-periods/:id/reopen', requirePermission('period.close'), async (req, res) => {
  const id = text(req.params.id);
  const reason = text(req.body?.reason);
  const period = await one<any>('SELECT * FROM fiscal_periods WHERE id=?', [id]);
  if (!period) return res.status(404).json({ error: 'PERIOD_NOT_FOUND' });
  if (reason.length < 5) return res.status(400).json({ error: 'REOPEN_REASON_REQUIRED' });
  if (period.status === 'OPEN') return res.status(409).json({ error: 'PERIOD_ALREADY_OPEN' });

  await query(
    "UPDATE fiscal_periods SET status='OPEN',reopened_by=?,reopened_at=NOW(6),reopen_reason=? WHERE id=?",
    [req.user!.id, reason, id],
  );
  await writeAudit({
    legalEntityId: period.legal_entity_id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'PERIOD_REOPEN', entityType: 'FISCAL_PERIOD', entityId: id,
    before: { status: 'CLOSED' }, after: { status: 'OPEN' }, reason,
  });
  res.json(await one('SELECT * FROM fiscal_periods WHERE id=?', [id]));
});

/* ------------------------------------------------------------------ Jurnal */

accountingRouter.get('/journal-entries', requirePermission('accounting.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const from = text(req.query.from);
  const to = text(req.query.to);
  const sourceType = upper(req.query.sourceType);
  const search = text(req.query.q);

  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('e.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('e.unit_id=?'); params.push(unitId); }
  if (from && isDateOnly(from)) { conditions.push('e.entry_date>=?'); params.push(from); }
  if (to && isDateOnly(to)) { conditions.push('e.entry_date<=?'); params.push(to); }
  if (sourceType) { conditions.push('e.source_type=?'); params.push(sourceType); }
  if (search) { conditions.push('(e.entry_number LIKE ? OR e.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT e.id,e.entry_number,e.entry_date,e.description,e.source_type,e.source_id,e.entry_kind,e.status,
            u.unit_code,u.unit_name,cu.full_name created_by_name,
            (SELECT COALESCE(SUM(l.debit),0) FROM journal_lines l WHERE l.entry_id=e.id) total_debit
       FROM journal_entries e
       LEFT JOIN organization_units u ON u.id=e.unit_id
       LEFT JOIN users cu ON cu.id=e.created_by
       ${where}
      ORDER BY e.entry_date DESC, e.entry_number DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(`SELECT COUNT(*) total FROM journal_entries e ${where}`, params);
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

accountingRouter.get('/journal-entries/:id', requirePermission('accounting.view'), async (req, res) => {
  const id = text(req.params.id);
  const entry = await one<any>(
    `SELECT e.*,u.unit_code,u.unit_name,p.name period_name,cu.full_name created_by_name
       FROM journal_entries e
       LEFT JOIN organization_units u ON u.id=e.unit_id
       JOIN fiscal_periods p ON p.id=e.period_id
       LEFT JOIN users cu ON cu.id=e.created_by
      WHERE e.id=?`, [id],
  );
  if (!entry) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  if (entry.unit_id && !(await canAccessUnit(req.user!, entry.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const lines = await query(
    `SELECT l.id,l.line_no,l.description,l.debit,l.credit,a.code account_code,a.name account_name,
            a.account_type,ou.unit_code,ou.unit_name
       FROM journal_lines l
       JOIN accounts a ON a.id=l.account_id
       LEFT JOIN organization_units ou ON ou.id=l.unit_id
      WHERE l.entry_id=? ORDER BY l.line_no`, [id],
  );
  res.json({ ...entry, lines });
});

accountingRouter.post('/journal-entries', requirePermission('journal.post'), async (req, res) => {
  const entryDate = text(req.body?.entryDate);
  const description = text(req.body?.description);
  const unitId = nullableText(req.body?.unitId);
  const rawLines: any[] = Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!isDateOnly(entryDate)) return res.status(400).json({ error: 'JOURNAL_DATE_INVALID' });
  if (description.length < 3) return res.status(400).json({ error: 'JOURNAL_DESCRIPTION_REQUIRED' });
  if (rawLines.length < 2) return res.status(400).json({ error: 'JOURNAL_LINES_REQUIRED' });
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const lines = rawLines.map(line => ({
    accountCode: text(line?.accountCode),
    debitCents: Math.abs(toCents(line?.debit) || 0),
    creditCents: Math.abs(toCents(line?.credit) || 0),
    description: nullableText(line?.description),
  }));
  for (const line of lines) {
    if (!line.accountCode) return res.status(400).json({ error: 'ACCOUNT_CODE_REQUIRED' });
    if ((line.debitCents > 0) === (line.creditCents > 0)) {
      return res.status(400).json({ error: 'JOURNAL_LINE_AMOUNT_INVALID' });
    }
    if (line.debitCents > MAX_AMOUNT || line.creditCents > MAX_AMOUNT) {
      return res.status(400).json({ error: 'JOURNAL_AMOUNT_TOO_LARGE' });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const id = await postJournal(conn, {
      legalEntityId: entity.id,
      unitId,
      entryDate,
      description,
      sourceType: 'MANUAL',
      sourceId: null,
      idempotencyKey: `MANUAL:${randomUUID()}`,
      createdBy: req.user!.id,
      lines,
    });
    if (!id) throw Object.assign(new Error('JOURNAL_LINES_REQUIRED'), { statusCode: 400 });
    await conn.commit();
    await writeAudit({
      legalEntityId: entity.id, unitId, userId: req.user!.id, ip: req.ip || null,
      action: 'JOURNAL_POST', entityType: 'JOURNAL_ENTRY', entityId: id,
      after: { entryDate, description, lines: lines.length },
    });
    res.status(201).json(await one(
      `SELECT e.*,u.unit_code,u.unit_name,p.name period_name FROM journal_entries e
         LEFT JOIN organization_units u ON u.id=e.unit_id
         JOIN fiscal_periods p ON p.id=e.period_id WHERE e.id=?`, [id],
    ));
  } catch (error: any) {
    await conn.rollback();
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    conn.release();
  }
});

accountingRouter.post('/journal-entries/:id/reverse', requirePermission('journal.post'), async (req, res) => {
  const id = text(req.params.id);
  const reason = text(req.body?.reason);
  const entry = await one<any>('SELECT * FROM journal_entries WHERE id=?', [id]);
  if (!entry) return res.status(404).json({ error: 'JOURNAL_NOT_FOUND' });
  if (entry.unit_id && !(await canAccessUnit(req.user!, entry.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  if (reason.length < 5) return res.status(400).json({ error: 'VOID_REASON_REQUIRED' });
  if (entry.status !== 'POSTED' || entry.entry_kind !== 'ORIGINAL') {
    return res.status(409).json({ error: 'JOURNAL_NOT_REVERSIBLE' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await reverseJournal(conn, {
      legalEntityId: entry.legal_entity_id, originalId: id, reason, userId: req.user!.id,
    });
    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: entry.legal_entity_id, unitId: entry.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'JOURNAL_REVERSE', entityType: 'JOURNAL_ENTRY', entityId: id,
    before: { status: 'POSTED' }, after: { status: 'REVERSED' }, reason,
  });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ Laporan */

accountingRouter.get('/accounting/trial-balance', requirePermission('accounting.view'), async (req, res) => {
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const from = text(req.query.from) || '2000-01-01';
  const to = text(req.query.to) || today();
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions = ['e.legal_entity_id=(SELECT id FROM legal_entities LIMIT 1)', 'e.entry_date BETWEEN ? AND ?'];
  const params: any[] = [from, to];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('l.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('l.unit_id=?'); params.push(unitId); }

  const rows = await query<any>(
    `SELECT a.code,a.name,a.account_type,a.normal_balance,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE ${conditions.join(' AND ')}
      GROUP BY a.id,a.code,a.name,a.account_type,a.normal_balance
      ORDER BY a.code`, params,
  );

  const items = rows.map((row: any) => {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    const balance = row.normal_balance === 'DEBIT' ? debit - credit : credit - debit;
    return {
      code: row.code, name: row.name, account_type: row.account_type,
      normal_balance: row.normal_balance, debit, credit, balance,
    };
  });
  const totalDebit = items.reduce((sum, row) => sum + row.debit, 0);
  const totalCredit = items.reduce((sum, row) => sum + row.credit, 0);
  res.json({ from, to, items, totalDebit, totalCredit, balanced: totalDebit === totalCredit });
});

accountingRouter.get('/accounting/general-ledger', requirePermission('accounting.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const accountCode = text(req.query.accountCode);
  const unitId = text(req.query.unitId);
  const from = text(req.query.from) || '2000-01-01';
  const to = text(req.query.to) || today();
  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions = ['e.legal_entity_id=(SELECT id FROM legal_entities LIMIT 1)', 'e.entry_date BETWEEN ? AND ?'];
  const params: any[] = [from, to];
  if (accountCode) { conditions.push('a.code=?'); params.push(accountCode); }
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('l.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('l.unit_id=?'); params.push(unitId); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query(
    `SELECT l.id,e.id entry_id,e.entry_number,e.entry_date,e.description entry_description,e.source_type,
            a.code account_code,a.name account_name,l.description,l.debit,l.credit,
            u.unit_code,u.unit_name
       FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
       LEFT JOIN organization_units u ON u.id=l.unit_id
       ${where}
      ORDER BY e.entry_date DESC, e.entry_number DESC, l.line_no
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM journal_lines l
       JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id ${where}`, params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

accountingRouter.get('/accounting/reconciliation', requirePermission('accounting.view'), async (req, res) => {
  const allowed = await allowedUnitIds(req.user!);
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const scopeLine = allowed === null
    ? { sql: '', params: [] as any[] }
    : (allowed.length === 0
      ? { sql: ' AND 1=0', params: [] as any[] }
      : { sql: ' AND l.unit_id IN (?)', params: [allowed] as any[] });

  async function glBalance(code: string) {
    const row = await one<any>(
      `SELECT COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
         FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
         JOIN accounts a ON a.id=l.account_id
        WHERE e.legal_entity_id=? AND a.code=?${scopeLine.sql}`,
      [entity!.id, code, ...scopeLine.params],
    );
    return Number(row?.debit || 0) - Number(row?.credit || 0);
  }

  const unitFilter = allowed === null
    ? { sql: '', params: [] as any[] }
    : (allowed.length === 0
      ? { sql: ' AND 1=0', params: [] as any[] }
      : { sql: ' AND i.unit_id IN (?)', params: [allowed] as any[] });
  const receivableRow = await one<any>(
    `SELECT COALESCE(SUM(i.total_amount - i.paid_amount),0) total FROM invoices i
      WHERE i.legal_entity_id=? AND i.status<>'VOID'${unitFilter.sql}`,
    [entity.id, ...unitFilter.params],
  );

  const depositUnitFilter = allowed === null
    ? { sql: '', params: [] as any[] }
    : (allowed.length === 0
      ? { sql: ' AND 1=0', params: [] as any[] }
      : { sql: ' AND r.unit_id IN (?)', params: [allowed] as any[] });
  const depositRow = await one<any>(
    `SELECT COALESCE(SUM(r.unallocated_amount),0) total FROM receipts r
      WHERE r.legal_entity_id=? AND r.status='POSTED'${depositUnitFilter.sql}`,
    [entity.id, ...depositUnitFilter.params],
  );

  const mutationUnitFilter = allowed === null
    ? { sql: '', params: [] as any[] }
    : (allowed.length === 0
      ? { sql: ' AND 1=0', params: [] as any[] }
      : { sql: ' AND m.unit_id IN (?)', params: [allowed] as any[] });
  const mutationRow = await one<any>(
    `SELECT COALESCE(SUM(CASE WHEN m.direction='IN' THEN m.amount ELSE -m.amount END),0) total
       FROM bank_mutations m WHERE m.legal_entity_id=?${mutationUnitFilter.sql}`,
    [entity.id, ...mutationUnitFilter.params],
  );

  const receivableGl = await glBalance('1-1200');
  const depositGl = -(await glBalance('2-1200'));
  const cashGl = await glBalance('1-1100');
  const receivableSub = Number(receivableRow?.total || 0);
  const depositSub = Number(depositRow?.total || 0);
  const cashMutations = Number(mutationRow?.total || 0);

  // Jurnal manual yang menyentuh kas tidak punya mutasi bank; tampilkan sebagai penjelas selisih.
  const manualRow = await one<any>(
    `SELECT COALESCE(SUM(l.debit - l.credit),0) total
       FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
       JOIN accounts a ON a.id=l.account_id
      WHERE e.legal_entity_id=? AND a.code='1-1100' AND e.source_type='MANUAL'${scopeLine.sql}`,
    [entity.id, ...scopeLine.params],
  );
  const cashManual = Number(manualRow?.total || 0);
  const cashUnexplained = cashGl - cashMutations - cashManual;

  res.json({
    asOf: today(),
    receivable: { gl: receivableGl, subledger: receivableSub, difference: receivableGl - receivableSub },
    deposit: { gl: depositGl, subledger: depositSub, difference: depositGl - depositSub },
    cash: {
      gl: cashGl, mutations: cashMutations, manualAdjustments: cashManual,
      difference: cashGl - cashMutations, unexplained: cashUnexplained,
    },
    balanced:
      Math.abs(receivableGl - receivableSub) < 0.005
      && Math.abs(depositGl - depositSub) < 0.005
      && Math.abs(cashUnexplained) < 0.005,
  });
});

/**
 * Backfill jurnal untuk transaksi yang sudah ada sebelum ACC-01 aktif.
 * Idempoten: jurnal yang sudah ada tidak dibuat ulang.
 */
accountingRouter.post('/accounting/backfill', requirePermission('journal.post'), async (req, res) => {
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const invoices = await query<{ id: string; status: string }>(
    'SELECT id,status FROM invoices WHERE legal_entity_id=? ORDER BY invoice_date', [entity.id],
  );
  const receipts = await query<{ id: string; status: string; receipt_number: string }>(
    'SELECT id,status,receipt_number FROM receipts WHERE legal_entity_id=? ORDER BY receipt_date', [entity.id],
  );
  const payments = await query<{ id: string; status: string }>(
    'SELECT id,status FROM expense_payments WHERE legal_entity_id=? ORDER BY payment_date', [entity.id],
  );

  const result = { invoices: 0, receipts: 0, expensePayments: 0, reversals: 0, skipped: 0, errors: [] as string[] };

  async function run(work: (conn: any) => Promise<void>) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await work(conn);
      await conn.commit();
    } catch (error: any) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  for (const invoice of invoices) {
    try {
      await run(async conn => { await journalForInvoice(conn, invoice.id, req.user!.id); });
      result.invoices += 1;
      if (invoice.status === 'VOID') {
        await run(async conn => {
          await reverseJournal(conn, {
            legalEntityId: entity.id, sourceType: 'INVOICE', sourceId: invoice.id,
            reason: 'Backfill pembatalan tagihan', userId: req.user!.id,
          });
        });
        result.reversals += 1;
      }
    } catch (error: any) {
      result.errors.push(`INVOICE ${invoice.id}: ${error?.message}`);
    }
  }

  for (const receipt of receipts) {
    try {
      await run(async conn => { await journalForReceipt(conn, receipt.id, req.user!.id); });
      result.receipts += 1;
      if (receipt.status === 'VOID') {
        await run(async conn => {
          await reverseJournal(conn, {
            legalEntityId: entity.id, sourceType: 'RECEIPT', sourceId: receipt.id,
            reason: 'Backfill pembatalan penerimaan', userId: req.user!.id,
          });
        });
        result.reversals += 1;
      }
    } catch (error: any) {
      result.errors.push(`RECEIPT ${receipt.receipt_number}: ${error?.message}`);
    }
  }

  for (const payment of payments) {
    try {
      await run(async conn => { await journalForExpensePayment(conn, payment.id, req.user!.id); });
      result.expensePayments += 1;
      if (payment.status === 'VOID') {
        await run(async conn => {
          await reverseJournal(conn, {
            legalEntityId: entity.id, sourceType: 'EXPENSE_PAYMENT', sourceId: payment.id,
            reason: 'Backfill pembatalan pembayaran', userId: req.user!.id,
          });
        });
        result.reversals += 1;
      }
    } catch (error: any) {
      result.errors.push(`EXPENSE_PAYMENT ${payment.id}: ${error?.message}`);
    }
  }

  await writeAudit({
    legalEntityId: entity.id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'JOURNAL_BACKFILL', entityType: 'JOURNAL_ENTRY', entityId: entity.id,
    after: { invoices: result.invoices, receipts: result.receipts, payments: result.expensePayments, reversals: result.reversals },
  });
  res.json(result);
});
