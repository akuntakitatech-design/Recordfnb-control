import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { fromCents, isDateOnly, nullableText, paging, text, toCents, today, upper } from '../http.js';
import { journalForExpensePayment, reverseJournal } from '../accounting.js';

export const expenseRouter = Router();
expenseRouter.use(requireAuth);

const METHODS = ['CASH', 'TRANSFER', 'QRIS', 'OTHER'];

async function isExpenseAccount(legalEntityId: string, code: string) {
  const account = await one<any>(
    'SELECT account_type,is_postable,status FROM accounts WHERE legal_entity_id=? AND code=?',
    [legalEntityId, code],
  );
  return Boolean(account && account.account_type === 'EXPENSE' && account.is_postable && account.status === 'ACTIVE');
}

/**
 * Hitung ulang paid_amount + status pengajuan dari pembayaran yang masih POSTED.
 * Status workflow tetap: APPROVED selama belum lunas, PAID bila sudah lunas.
 */
async function refreshRequest(conn: any, requestId: string) {
  const [rows]: any = await conn.query(
    `SELECT r.amount,r.status,
            COALESCE((SELECT SUM(p.amount) FROM expense_payments p
                       WHERE p.expense_request_id=r.id AND p.status='POSTED'), 0) paid
       FROM expense_requests r WHERE r.id=?`,
    [requestId],
  );
  const row = rows[0];
  if (!row) return;
  const amountCents = toCents(row.amount);
  const paidCents = toCents(row.paid);
  const status = ['DRAFT', 'SUBMITTED', 'REJECTED', 'CANCELLED'].includes(row.status)
    ? row.status
    : (paidCents >= amountCents ? 'PAID' : 'APPROVED');
  await conn.query('UPDATE expense_requests SET paid_amount=?, status=? WHERE id=?', [
    fromCents(paidCents), status, requestId,
  ]);
}

async function requestDetail(id: string) {
  const request = await one<any>(
    `SELECT r.*,u.unit_code,u.unit_name,c.code category_code,c.name category_name,
            c.expense_account_code,v.name vendor_name,
            cu.full_name created_by_name,au.full_name approved_by_name,ru.full_name rejected_by_name,
            (r.amount - r.paid_amount) remaining
       FROM expense_requests r
       JOIN organization_units u ON u.id=r.unit_id
       JOIN expense_categories c ON c.id=r.expense_category_id
       LEFT JOIN vendors v ON v.id=r.vendor_id
       LEFT JOIN users cu ON cu.id=r.created_by
       LEFT JOIN users au ON au.id=r.approved_by
       LEFT JOIN users ru ON ru.id=r.rejected_by
      WHERE r.id=?`, [id],
  );
  if (!request) return null;
  const payments = await query<any>(
    `SELECT p.id,p.payment_number,p.payment_date,p.method,p.reference_number,p.amount,p.status,
            p.void_reason,p.created_at,b.bank_name,b.account_number,b.account_usage,
            pu.full_name created_by_name
       FROM expense_payments p
       JOIN bank_accounts b ON b.id=p.bank_account_id
       LEFT JOIN users pu ON pu.id=p.created_by
      WHERE p.expense_request_id=?
      ORDER BY p.payment_date, p.created_at`,
    [id],
  );
  return { ...request, payments };
}

async function unitForExpense(req: any, res: any, unitId: string) {
  if (!unitId) {
    res.status(400).json({ error: 'EXPENSE_FIELDS_REQUIRED' });
    return null;
  }
  if (!(await canAccessUnit(req.user!, unitId))) {
    res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    return null;
  }
  const unit = await one<any>(
    'SELECT id,legal_entity_id,unit_code,unit_name,operational_status,finance_status FROM organization_units WHERE id=?',
    [unitId],
  );
  if (!unit) {
    res.status(404).json({ error: 'UNIT_NOT_FOUND' });
    return null;
  }
  if (unit.operational_status !== 'ACTIVE') {
    res.status(400).json({ error: 'UNIT_NOT_ACTIVE' });
    return null;
  }
  if (unit.finance_status !== 'READY') {
    res.status(400).json({ error: 'UNIT_NOT_READY_FOR_EXPENSE' });
    return null;
  }
  return unit;
}

/* ------------------------------------------------------------------ Master kategori */

expenseRouter.get('/expense-categories', requirePermission('expense.view'), async (req, res) => {
  const status = upper(req.query.status);
  const search = text(req.query.q);
  const conditions: string[] = [];
  const params: any[] = [];
  if (status) { conditions.push('status=?'); params.push(status); }
  if (search) { conditions.push('(code LIKE ? OR name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await query(
    `SELECT id,code,name,expense_account_code,description,status
       FROM expense_categories ${where} ORDER BY code`,
    params,
  ));
});

expenseRouter.post('/expense-categories', requirePermission('expense.manage'), async (req, res) => {
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  if (!code || name.length < 3) return res.status(400).json({ error: 'EXPENSE_CATEGORY_FIELDS_REQUIRED' });
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const existing = await one('SELECT id FROM expense_categories WHERE legal_entity_id=? AND code=?', [entity.id, code]);
  if (existing) return res.status(409).json({ error: 'EXPENSE_CATEGORY_DUPLICATE' });

  // ACC-01: akun beban harus ada di CoA dan bertipe EXPENSE.
  const accountCode = nullableText(req.body?.expenseAccountCode);
  if (accountCode && !(await isExpenseAccount(entity.id, accountCode))) {
    return res.status(400).json({ error: 'EXPENSE_ACCOUNT_MAPPING_MISSING' });
  }

  const id = randomUUID();
  await query(
    `INSERT INTO expense_categories(id,legal_entity_id,code,name,expense_account_code,description)
     VALUES(?,?,?,?,?,?)`,
    [id, entity.id, code, name, accountCode, nullableText(req.body?.description)],
  );
  await writeAudit({
    legalEntityId: entity.id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_CATEGORY_CREATE', entityType: 'EXPENSE_CATEGORY', entityId: id,
    after: { code, name, expense_account_code: accountCode },
  });
  res.status(201).json(await one('SELECT * FROM expense_categories WHERE id=?', [id]));
});

expenseRouter.patch('/expense-categories/:id', requirePermission('expense.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM expense_categories WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'EXPENSE_CATEGORY_NOT_FOUND' });

  const name = nullableText(req.body?.name) ?? before.name;
  const accountCode = req.body?.expenseAccountCode === undefined
    ? before.expense_account_code : nullableText(req.body?.expenseAccountCode);
  const description = req.body?.description === undefined ? before.description : nullableText(req.body?.description);
  const status = upper(req.body?.status) || before.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'EXPENSE_CATEGORY_STATUS_INVALID' });
  if (accountCode && !(await isExpenseAccount(before.legal_entity_id, accountCode))) {
    return res.status(400).json({ error: 'EXPENSE_ACCOUNT_MAPPING_MISSING' });
  }

  await query(
    'UPDATE expense_categories SET name=?,expense_account_code=?,description=?,status=? WHERE id=?',
    [name, accountCode, description, status, id],
  );
  const after = await one('SELECT * FROM expense_categories WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_CATEGORY_UPDATE', entityType: 'EXPENSE_CATEGORY', entityId: id, before, after,
  });
  res.json(after);
});

/* ------------------------------------------------------------------ Vendor */

expenseRouter.get('/vendors', requirePermission('expense.view'), async (req, res) => {
  const status = upper(req.query.status);
  const search = text(req.query.q);
  const conditions: string[] = [];
  const params: any[] = [];
  if (status) { conditions.push('status=?'); params.push(status); }
  if (search) { conditions.push('(code LIKE ? OR name LIKE ? OR contact_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await query(
    `SELECT id,code,name,npwp,contact_name,phone,email,address,bank_name,bank_account_number,
            bank_account_holder,status
       FROM vendors ${where} ORDER BY name`,
    params,
  ));
});

expenseRouter.post('/vendors', requirePermission('expense.manage'), async (req, res) => {
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  if (!code || name.length < 3) return res.status(400).json({ error: 'VENDOR_FIELDS_REQUIRED' });
  const entity = await one<{ id: string }>('SELECT id FROM legal_entities LIMIT 1');
  if (!entity) return res.status(400).json({ error: 'LEGAL_ENTITY_MISSING' });

  const existing = await one('SELECT id FROM vendors WHERE legal_entity_id=? AND code=?', [entity.id, code]);
  if (existing) return res.status(409).json({ error: 'VENDOR_DUPLICATE' });

  const id = randomUUID();
  await query(
    `INSERT INTO vendors(id,legal_entity_id,code,name,npwp,contact_name,phone,email,address,
       bank_name,bank_account_number,bank_account_holder)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, entity.id, code, name, nullableText(req.body?.npwp), nullableText(req.body?.contactName),
      nullableText(req.body?.phone), nullableText(req.body?.email), nullableText(req.body?.address),
      nullableText(req.body?.bankName), nullableText(req.body?.bankAccountNumber),
      nullableText(req.body?.bankAccountHolder)],
  );
  await writeAudit({
    legalEntityId: entity.id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'VENDOR_CREATE', entityType: 'VENDOR', entityId: id, after: { code, name },
  });
  res.status(201).json(await one('SELECT * FROM vendors WHERE id=?', [id]));
});

expenseRouter.patch('/vendors/:id', requirePermission('expense.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM vendors WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'VENDOR_NOT_FOUND' });

  const pick = (key: string) => (req.body?.[key] === undefined ? before[key] : nullableText(req.body?.[key]));
  const name = nullableText(req.body?.name) ?? before.name;
  const status = upper(req.body?.status) || before.status;
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'VENDOR_STATUS_INVALID' });

  await query(
    `UPDATE vendors SET name=?,npwp=?,contact_name=?,phone=?,email=?,address=?,
       bank_name=?,bank_account_number=?,bank_account_holder=?,status=? WHERE id=?`,
    [name, pick('npwp'), pick('contactName'), pick('phone'), pick('email'), pick('address'),
      pick('bankName'), pick('bankAccountNumber'), pick('bankAccountHolder'), status, id],
  );
  const after = await one('SELECT * FROM vendors WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, unitId: null, userId: req.user!.id, ip: req.ip || null,
    action: 'VENDOR_UPDATE', entityType: 'VENDOR', entityId: id, before, after,
  });
  res.json(after);
});

/* ------------------------------------------------------------------ Pengajuan */

expenseRouter.get('/expenses', requirePermission('expense.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const status = upper(req.query.status);
  const from = text(req.query.from);
  const to = text(req.query.to);
  const search = text(req.query.q);

  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('r.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('r.unit_id=?'); params.push(unitId); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (from && isDateOnly(from)) { conditions.push('r.request_date>=?'); params.push(from); }
  if (to && isDateOnly(to)) { conditions.push('r.request_date<=?'); params.push(to); }
  if (search) {
    conditions.push('(r.request_number LIKE ? OR r.description LIKE ? OR r.payee_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT r.id,r.unit_id,r.request_number,r.request_date,r.due_date,r.payee_name,r.description,
            r.amount,r.paid_amount,(r.amount - r.paid_amount) remaining,r.status,
            u.unit_code,u.unit_name,c.code category_code,c.name category_name,
            v.name vendor_name,cu.full_name created_by_name,
            (SELECT COUNT(*) FROM expense_payments p WHERE p.expense_request_id=r.id AND p.status='POSTED') payment_count
       FROM expense_requests r
       JOIN organization_units u ON u.id=r.unit_id
       JOIN expense_categories c ON c.id=r.expense_category_id
       LEFT JOIN vendors v ON v.id=r.vendor_id
       LEFT JOIN users cu ON cu.id=r.created_by
       ${where}
      ORDER BY r.request_date DESC, r.request_number DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(`SELECT COUNT(*) total FROM expense_requests r ${where}`, params);
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

expenseRouter.post('/expenses', requirePermission('expense.create'), async (req, res) => {
  const unitId = text(req.body?.unitId);
  const categoryId = text(req.body?.expenseCategoryId);
  const requestDate = text(req.body?.requestDate);
  const dueDate = nullableText(req.body?.dueDate);
  const description = text(req.body?.description);
  const amountCents = toCents(req.body?.amount);

  if (!unitId || !categoryId || !description) return res.status(400).json({ error: 'EXPENSE_FIELDS_REQUIRED' });
  if (description.length < 3) return res.status(400).json({ error: 'EXPENSE_DESCRIPTION_TOO_SHORT' });
  if (!isDateOnly(requestDate)) return res.status(400).json({ error: 'EXPENSE_DATE_INVALID' });
  if (dueDate && !isDateOnly(dueDate)) return res.status(400).json({ error: 'EXPENSE_DUE_DATE_INVALID' });
  if (dueDate && dueDate < requestDate) return res.status(400).json({ error: 'EXPENSE_DUE_BEFORE_REQUEST' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'EXPENSE_AMOUNT_INVALID' });

  const unit = await unitForExpense(req, res, unitId);
  if (!unit) return;

  // ACC-01: jenis biaya wajib punya mapping akun beban sebelum dipakai.
  const category = await one<any>(
    'SELECT id,status,expense_account_code FROM expense_categories WHERE id=? AND legal_entity_id=?',
    [categoryId, unit.legal_entity_id],
  );
  if (!category || category.status !== 'ACTIVE') return res.status(400).json({ error: 'EXPENSE_CATEGORY_INVALID' });
  if (!category.expense_account_code) return res.status(400).json({ error: 'EXPENSE_ACCOUNT_MAPPING_MISSING' });

  const vendorId = nullableText(req.body?.vendorId);
  if (vendorId) {
    const vendor = await one('SELECT id FROM vendors WHERE id=? AND legal_entity_id=? AND status=?', [vendorId, unit.legal_entity_id, 'ACTIVE']);
    if (!vendor) return res.status(400).json({ error: 'VENDOR_INVALID' });
  }

  const id = randomUUID();
  const submit = req.body?.submit === true || upper(req.body?.submit) === 'TRUE';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const unitCode = String(unit.unit_code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    const [seqRows]: any = await conn.query(
      'SELECT COUNT(*) total FROM expense_requests WHERE legal_entity_id=? AND request_number LIKE ?',
      [unit.legal_entity_id, `EXP-${requestDate.replace(/-/g, '')}-${unitCode}-%`],
    );
    const requestNumber = `EXP-${requestDate.replace(/-/g, '')}-${unitCode}-${String(Number(seqRows[0].total) + 1).padStart(3, '0')}`;

    await conn.query(
      `INSERT INTO expense_requests(id,legal_entity_id,unit_id,expense_category_id,vendor_id,request_number,
         request_date,due_date,payee_name,description,amount,status,notes,created_by,
         submitted_by,submitted_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, unit.legal_entity_id, unitId, categoryId, vendorId, requestNumber, requestDate, dueDate,
        nullableText(req.body?.payeeName), description, fromCents(amountCents),
        submit ? 'SUBMITTED' : 'DRAFT', nullableText(req.body?.notes), req.user!.id,
        submit ? req.user!.id : null, submit ? new Date() : null],
    );
    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'EXPENSE_DUPLICATE' });
    }
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: unit.legal_entity_id, unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_REQUEST_CREATE', entityType: 'EXPENSE_REQUEST', entityId: id,
    after: { amount: Number(fromCents(amountCents)), status: submit ? 'SUBMITTED' : 'DRAFT' },
  });
  res.status(201).json(await requestDetail(id));
});

expenseRouter.get('/expenses/:id', requirePermission('expense.view'), async (req, res) => {
  const detail = await requestDetail(text(req.params.id));
  if (!detail) return res.status(404).json({ error: 'EXPENSE_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, detail.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  res.json(detail);
});

async function loadRequestForAction(req: any, res: any) {
  const id = text(req.params.id);
  const existing = await one<any>(
    `SELECT r.*,u.unit_code FROM expense_requests r
       JOIN organization_units u ON u.id=r.unit_id WHERE r.id=?`, [id],
  );
  if (!existing) {
    res.status(404).json({ error: 'EXPENSE_NOT_FOUND' });
    return null;
  }
  if (!(await canAccessUnit(req.user!, existing.unit_id))) {
    res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    return null;
  }
  return existing;
}

expenseRouter.post('/expenses/:id/submit', requirePermission('expense.create'), async (req, res) => {
  const existing = await loadRequestForAction(req, res);
  if (!existing) return;
  if (!['DRAFT', 'REJECTED'].includes(existing.status)) {
    return res.status(409).json({ error: 'EXPENSE_INVALID_STATUS', status: existing.status });
  }
  await query(
    `UPDATE expense_requests SET status='SUBMITTED',submitted_by=?,submitted_at=NOW(6),
       rejected_by=NULL,rejected_at=NULL,rejection_reason=NULL WHERE id=?`,
    [req.user!.id, existing.id],
  );
  await writeAudit({
    legalEntityId: existing.legal_entity_id, unitId: existing.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_REQUEST_SUBMIT', entityType: 'EXPENSE_REQUEST', entityId: existing.id,
    before: { status: existing.status }, after: { status: 'SUBMITTED' },
  });
  res.json(await requestDetail(existing.id));
});

expenseRouter.post('/expenses/:id/approve', requirePermission('expense.approve'), async (req, res) => {
  const existing = await loadRequestForAction(req, res);
  if (!existing) return;
  if (existing.status !== 'SUBMITTED') {
    return res.status(409).json({ error: 'EXPENSE_INVALID_STATUS', status: existing.status });
  }
  // Maker-checker: pengaju tidak boleh menyetujui pengajuannya sendiri.
  if (existing.created_by && existing.created_by === req.user!.id) {
    return res.status(403).json({ error: 'EXPENSE_SELF_APPROVAL_FORBIDDEN' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows]: any = await conn.query('SELECT status FROM expense_requests WHERE id=? FOR UPDATE', [existing.id]);
    if (rows[0]?.status !== 'SUBMITTED') {
      await conn.rollback();
      return res.status(409).json({ error: 'EXPENSE_INVALID_STATUS', status: rows[0]?.status });
    }
    await conn.query(
      "UPDATE expense_requests SET status='APPROVED',approved_by=?,approved_at=NOW(6) WHERE id=?",
      [req.user!.id, existing.id],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: existing.legal_entity_id, unitId: existing.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_REQUEST_APPROVE', entityType: 'EXPENSE_REQUEST', entityId: existing.id,
    before: { status: 'SUBMITTED' }, after: { status: 'APPROVED' },
  });
  res.json(await requestDetail(existing.id));
});

expenseRouter.post('/expenses/:id/reject', requirePermission('expense.approve'), async (req, res) => {
  const existing = await loadRequestForAction(req, res);
  if (!existing) return;
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'REJECTION_REASON_REQUIRED' });
  if (existing.status !== 'SUBMITTED') {
    return res.status(409).json({ error: 'EXPENSE_INVALID_STATUS', status: existing.status });
  }
  if (existing.created_by && existing.created_by === req.user!.id) {
    return res.status(403).json({ error: 'EXPENSE_SELF_APPROVAL_FORBIDDEN' });
  }

  await query(
    "UPDATE expense_requests SET status='REJECTED',rejected_by=?,rejected_at=NOW(6),rejection_reason=? WHERE id=?",
    [req.user!.id, reason, existing.id],
  );
  await writeAudit({
    legalEntityId: existing.legal_entity_id, unitId: existing.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_REQUEST_REJECT', entityType: 'EXPENSE_REQUEST', entityId: existing.id,
    before: { status: 'SUBMITTED' }, after: { status: 'REJECTED' }, reason,
  });
  res.json(await requestDetail(existing.id));
});

expenseRouter.post('/expenses/:id/cancel', requirePermission('expense.create'), async (req, res) => {
  const existing = await loadRequestForAction(req, res);
  if (!existing) return;
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'CANCEL_REASON_REQUIRED' });
  if (toCents(existing.paid_amount) > 0) {
    return res.status(409).json({ error: 'EXPENSE_HAS_PAYMENT' });
  }
  if (['PAID', 'CANCELLED'].includes(existing.status)) {
    return res.status(409).json({ error: 'EXPENSE_INVALID_STATUS', status: existing.status });
  }

  await query("UPDATE expense_requests SET status='CANCELLED',notes=CONCAT(COALESCE(notes,''),' [batal: ',? ,']') WHERE id=?",
    [reason, existing.id]);
  await writeAudit({
    legalEntityId: existing.legal_entity_id, unitId: existing.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_REQUEST_CANCEL', entityType: 'EXPENSE_REQUEST', entityId: existing.id,
    before: { status: existing.status }, after: { status: 'CANCELLED' }, reason,
  });
  res.json(await requestDetail(existing.id));
});

/* ------------------------------------------------------------------ Pembayaran */

expenseRouter.get('/expense-payments', requirePermission('expense.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const bankAccountId = text(req.query.bankAccountId);
  const status = upper(req.query.status);
  const from = text(req.query.from);
  const to = text(req.query.to);
  const search = text(req.query.q);

  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('p.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('p.unit_id=?'); params.push(unitId); }
  if (bankAccountId) { conditions.push('p.bank_account_id=?'); params.push(bankAccountId); }
  if (status) { conditions.push('p.status=?'); params.push(status); }
  if (from && isDateOnly(from)) { conditions.push('p.payment_date>=?'); params.push(from); }
  if (to && isDateOnly(to)) { conditions.push('p.payment_date<=?'); params.push(to); }
  if (search) {
    conditions.push('(p.payment_number LIKE ? OR p.reference_number LIKE ? OR r.request_number LIKE ? OR r.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT p.id,p.payment_number,p.payment_date,p.method,p.reference_number,p.amount,p.status,
            r.id request_id,r.request_number,r.description,
            u.unit_code,u.unit_name,b.bank_name,b.account_number,b.account_usage,
            cu.full_name created_by_name
       FROM expense_payments p
       JOIN expense_requests r ON r.id=p.expense_request_id
       JOIN organization_units u ON u.id=p.unit_id
       JOIN bank_accounts b ON b.id=p.bank_account_id
       LEFT JOIN users cu ON cu.id=p.created_by
       ${where}
      ORDER BY p.payment_date DESC, p.payment_number DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM expense_payments p JOIN expense_requests r ON r.id=p.expense_request_id ${where}`, params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

expenseRouter.post('/expenses/:id/payments', requirePermission('expense.pay'), async (req, res) => {
  const existing = await loadRequestForAction(req, res);
  if (!existing) return;
  const bankAccountId = text(req.body?.bankAccountId);
  const paymentDate = text(req.body?.paymentDate);
  const method = upper(req.body?.method) || 'TRANSFER';
  const idempotencyKey = nullableText(req.body?.idempotencyKey);
  const amountCents = toCents(req.body?.amount);

  if (!bankAccountId) return res.status(400).json({ error: 'EXPENSE_FIELDS_REQUIRED' });
  if (!isDateOnly(paymentDate)) return res.status(400).json({ error: 'PAYMENT_DATE_INVALID' });
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'PAYMENT_METHOD_INVALID' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'PAYMENT_AMOUNT_INVALID' });

  if (idempotencyKey) {
    const replay = await one<any>(
      'SELECT id FROM expense_payments WHERE legal_entity_id=? AND idempotency_key=?',
      [existing.legal_entity_id, idempotencyKey],
    );
    if (replay) {
      return res.json({ payment: await paymentDetail(replay.id), idempotent: true });
    }
  }

  if (!['APPROVED', 'PAID'].includes(existing.status)) {
    return res.status(409).json({ error: 'EXPENSE_NOT_APPROVED', status: existing.status });
  }

  // BANK-03 / BANK-05: hanya rekening aktif, terverifikasi, dan berizin bayar untuk unit ini.
  const account = await one<any>(
    'SELECT id,status,verified_at FROM bank_accounts WHERE id=? AND legal_entity_id=?',
    [bankAccountId, existing.legal_entity_id],
  );
  if (!account) return res.status(403).json({ error: 'BANK_ACCOUNT_NOT_ALLOWED' });
  if (account.status !== 'ACTIVE' || !account.verified_at) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_READY' });

  const assignment = await one(
    `SELECT 1 FROM unit_bank_account_assignments
      WHERE unit_id=? AND bank_account_id=? AND status='ACTIVE' AND allow_disbursement=1
        AND effective_start<=? AND (effective_end IS NULL OR effective_end>=?)`,
    [existing.unit_id, bankAccountId, paymentDate, paymentDate],
  );
  if (!assignment) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT' });

  const id = randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows]: any = await conn.query(
      'SELECT status,amount,paid_amount FROM expense_requests WHERE id=? FOR UPDATE',
      [existing.id],
    );
    const locked = rows[0];
    if (!locked) throw Object.assign(new Error('EXPENSE_NOT_FOUND'), { statusCode: 404 });
    if (!['APPROVED', 'PAID'].includes(locked.status)) {
      throw Object.assign(new Error('EXPENSE_NOT_APPROVED'), { statusCode: 409 });
    }
    const remainingCents = toCents(locked.amount) - toCents(locked.paid_amount);
    if (amountCents > remainingCents) {
      throw Object.assign(new Error('PAYMENT_EXCEEDS_REMAINING'), { statusCode: 409 });
    }

    const unitCode = String(existing.unit_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() || 'UNIT';
    const [seqRows]: any = await conn.query(
      'SELECT COUNT(*) total FROM expense_payments WHERE legal_entity_id=? AND payment_number LIKE ?',
      [existing.legal_entity_id, `PAY-${paymentDate.replace(/-/g, '')}-${unitCode}-%`],
    );
    const paymentNumber = `PAY-${paymentDate.replace(/-/g, '')}-${unitCode}-${String(Number(seqRows[0].total) + 1).padStart(3, '0')}`;

    await conn.query(
      `INSERT INTO expense_payments(id,legal_entity_id,expense_request_id,unit_id,bank_account_id,payment_number,
         payment_date,method,reference_number,amount,status,idempotency_key,notes,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?, 'POSTED', ?,?,?)`,
      [id, existing.legal_entity_id, existing.id, existing.unit_id, bankAccountId, paymentNumber,
        paymentDate, method, nullableText(req.body?.referenceNumber), fromCents(amountCents),
        idempotencyKey, nullableText(req.body?.notes), req.user!.id],
    );

    await conn.query(
      `INSERT INTO bank_mutations(id,legal_entity_id,bank_account_id,unit_id,mutation_date,direction,amount,source_type,source_id,description)
       VALUES(?,?,?,?,?, 'OUT', ?, 'EXPENSE', ?, ?)`,
      [randomUUID(), existing.legal_entity_id, bankAccountId, existing.unit_id, paymentDate,
        fromCents(amountCents), id, `Pengeluaran ${paymentNumber}`],
    );

    await refreshRequest(conn, existing.id);

    // ACC-01: Dr Beban jenis biaya, Cr Kas/Bank.
    await journalForExpensePayment(conn, id, req.user!.id);

    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'EXPENSE_PAYMENT_DUPLICATE' });
    }
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: existing.legal_entity_id, unitId: existing.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_PAYMENT_CREATE', entityType: 'EXPENSE_PAYMENT', entityId: id,
    after: { amount: Number(fromCents(amountCents)), request_id: existing.id, method },
  });
  res.status(201).json({ payment: await paymentDetail(id), idempotent: false });
});

async function paymentDetail(id: string) {
  return one<any>(
    `SELECT p.*,r.request_number,r.description,r.amount request_amount,r.paid_amount request_paid_amount,
            u.unit_code,u.unit_name,b.bank_name,b.account_number,b.account_holder,b.account_usage,
            cu.full_name created_by_name
       FROM expense_payments p
       JOIN expense_requests r ON r.id=p.expense_request_id
       JOIN organization_units u ON u.id=p.unit_id
       JOIN bank_accounts b ON b.id=p.bank_account_id
       LEFT JOIN users cu ON cu.id=p.created_by
      WHERE p.id=?`, [id],
  );
}

expenseRouter.post('/expense-payments/:id/void', requirePermission('expense.void'), async (req, res) => {
  const id = text(req.params.id);
  const reason = text(req.body?.reason);
  const payment = await one<any>('SELECT * FROM expense_payments WHERE id=?', [id]);
  if (!payment) return res.status(404).json({ error: 'EXPENSE_PAYMENT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, payment.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  if (reason.length < 5) return res.status(400).json({ error: 'VOID_REASON_REQUIRED' });
  if (payment.status === 'VOID') return res.status(409).json({ error: 'EXPENSE_PAYMENT_ALREADY_VOID' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE expense_payments SET status='VOID',void_reason=? WHERE id=?", [reason, id]);
    await refreshRequest(conn, payment.expense_request_id);
    await conn.query(
      `INSERT INTO bank_mutations(id,legal_entity_id,bank_account_id,unit_id,mutation_date,direction,amount,source_type,source_id,description)
       VALUES(?,?,?,?,?, 'IN', ?, 'EXPENSE_VOID', ?, ?)`,
      [randomUUID(), payment.legal_entity_id, payment.bank_account_id, payment.unit_id, today(),
        payment.amount, id, `Pembatalan ${payment.payment_number}`],
    );
    await reverseJournal(conn, {
      legalEntityId: payment.legal_entity_id, sourceType: 'EXPENSE_PAYMENT', sourceId: id,
      reason, userId: req.user!.id,
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
    legalEntityId: payment.legal_entity_id, unitId: payment.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'EXPENSE_PAYMENT_VOID', entityType: 'EXPENSE_PAYMENT', entityId: id,
    before: { status: 'POSTED' }, after: { status: 'VOID' }, reason,
  });
  res.json({ ok: true, payment: await paymentDetail(id) });
});
