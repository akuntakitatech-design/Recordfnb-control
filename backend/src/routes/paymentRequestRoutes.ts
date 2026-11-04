import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { canAccessUnit, hasPermission, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { fromCents, isDateOnly, nullableText, paging, text, toCents, upper } from '../http.js';
import { postExpensePayment } from '../expensePosting.js';

/**
 * MCM — pengajuan pembayaran.
 *
 * Alur: Finance membuat MCM (memilih rekening bank & nominal, boleh DP) ->
 * diajukan -> disetujui Ketua Yayasan -> diposting Finance sehingga kas keluar
 * dan jurnal terbentuk. Satu pengajuan pembelian boleh punya beberapa MCM.
 */
export const paymentRequestRouter = Router();
paymentRequestRouter.use(requireAuth);

const METHODS = ['CASH', 'TRANSFER', 'QRIS', 'OTHER'];

const SELECT = `SELECT p.*,u.unit_code,u.unit_name,b.bank_name,b.account_number,b.account_usage,
       r.request_number expense_request_number,r.description expense_description,
       r.amount expense_amount,r.paid_amount expense_paid,
       (r.amount - r.paid_amount) expense_remaining,
       cu.full_name created_by_name,au.full_name approved_by_name,ru.full_name rejected_by_name
  FROM payment_requests p
  JOIN organization_units u ON u.id=p.unit_id
  JOIN bank_accounts b ON b.id=p.bank_account_id
  JOIN expense_requests r ON r.id=p.expense_request_id
  LEFT JOIN users cu ON cu.id=p.created_by
  LEFT JOIN users au ON au.id=p.approved_by
  LEFT JOIN users ru ON ru.id=p.rejected_by`;

async function paymentRequestDetail(id: string) {
  return one<any>(`${SELECT} WHERE p.id=?`, [id]);
}

async function loadForAction(req: any, res: any, permission: string) {
  const detail = await paymentRequestDetail(text(req.params.id));
  if (!detail) {
    res.status(404).json({ error: 'PAYMENT_REQUEST_NOT_FOUND' });
    return null;
  }
  if (!(await canAccessUnit(req.user!, detail.unit_id))) {
    res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    return null;
  }
  if (!hasPermission(req.user!.role, permission as any)) {
    res.status(403).json({ error: 'PERMISSION_DENIED', permission });
    return null;
  }
  return detail;
}

paymentRequestRouter.get('/payment-requests', requirePermission('expense.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const conditions: string[] = [];
  const params: any[] = [];
  const unitId = text(req.query.unitId);
  const status = upper(req.query.status);
  const search = text(req.query.q);

  if (unitId) {
    if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    conditions.push('p.unit_id=?');
    params.push(unitId);
  }
  if (status) { conditions.push('p.status=?'); params.push(status); }
  if (search) {
    conditions.push('(p.request_number LIKE ? OR r.request_number LIKE ? OR r.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query(`${SELECT} ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM payment_requests p JOIN expense_requests r ON r.id=p.expense_request_id ${where}`,
    params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

paymentRequestRouter.get('/payment-requests/:id', requirePermission('expense.view'), async (req, res) => {
  const detail = await paymentRequestDetail(text(req.params.id));
  if (!detail) return res.status(404).json({ error: 'PAYMENT_REQUEST_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, detail.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  res.json(detail);
});

paymentRequestRouter.post('/payment-requests', requirePermission('payment_request.create'), async (req, res) => {
  const expenseRequestId = text(req.body?.expenseRequestId);
  const bankAccountId = text(req.body?.bankAccountId);
  const requestDate = text(req.body?.requestDate);
  const method = upper(req.body?.method) || 'TRANSFER';
  const amountCents = toCents(req.body?.amount);

  if (!expenseRequestId || !bankAccountId) return res.status(400).json({ error: 'PAYMENT_REQUEST_FIELDS_REQUIRED' });
  if (!isDateOnly(requestDate)) return res.status(400).json({ error: 'PAYMENT_DATE_INVALID' });
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'PAYMENT_METHOD_INVALID' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'PAYMENT_AMOUNT_INVALID' });

  const request = await one<any>(
    `SELECT r.id,r.legal_entity_id,r.unit_id,r.status,r.amount,r.paid_amount,u.unit_code
       FROM expense_requests r JOIN organization_units u ON u.id=r.unit_id WHERE r.id=?`,
    [expenseRequestId],
  );
  if (!request) return res.status(404).json({ error: 'EXPENSE_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, request.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  if (!['APPROVED', 'PAID'].includes(request.status)) {
    return res.status(409).json({ error: 'EXPENSE_NOT_APPROVED', status: request.status });
  }

  const remainingCents = toCents(request.amount) - toCents(request.paid_amount);
  if (amountCents > remainingCents) return res.status(409).json({ error: 'PAYMENT_EXCEEDS_REMAINING' });

  // BANK-03 / BANK-05: rekening aktif, terverifikasi, dan berizin bayar untuk unit ini.
  const account = await one<any>(
    'SELECT id,status,verified_at FROM bank_accounts WHERE id=? AND legal_entity_id=?',
    [bankAccountId, request.legal_entity_id],
  );
  if (!account) return res.status(403).json({ error: 'BANK_ACCOUNT_NOT_ALLOWED' });
  if (account.status !== 'ACTIVE' || !account.verified_at) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_READY' });
  const assignment = await one(
    `SELECT 1 FROM unit_bank_account_assignments
      WHERE unit_id=? AND bank_account_id=? AND status='ACTIVE' AND allow_disbursement=1
        AND effective_start<=? AND (effective_end IS NULL OR effective_end>=?)`,
    [request.unit_id, bankAccountId, requestDate, requestDate],
  );
  if (!assignment) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT' });

  const unitCode = String(request.unit_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase() || 'UNIT';
  const total = await one<{ total: number }>(
    'SELECT COUNT(*) total FROM payment_requests WHERE legal_entity_id=? AND request_number LIKE ?',
    [request.legal_entity_id, `MCM-${requestDate.replace(/-/g, '')}-${unitCode}-%`],
  );
  const requestNumber = `MCM-${requestDate.replace(/-/g, '')}-${unitCode}-${String(Number(total?.total || 0) + 1).padStart(3, '0')}`;

  const id = randomUUID();
  await query(
    `INSERT INTO payment_requests(id,legal_entity_id,unit_id,expense_request_id,bank_account_id,request_number,
       request_date,method,amount,status,notes,created_by)
     VALUES(?,?,?,?,?,?,?,?,?, 'DRAFT', ?,?)`,
    [id, request.legal_entity_id, request.unit_id, expenseRequestId, bankAccountId, requestNumber,
      requestDate, method, fromCents(amountCents), nullableText(req.body?.notes), req.user!.id],
  );

  await writeAudit({
    legalEntityId: request.legal_entity_id, unitId: request.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_CREATE', entityType: 'PAYMENT_REQUEST', entityId: id,
    after: { number: requestNumber, amount: Number(fromCents(amountCents)), expense_request_id: expenseRequestId },
  });
  res.status(201).json(await paymentRequestDetail(id));
});

paymentRequestRouter.post('/payment-requests/:id/submit', requirePermission('payment_request.create'), async (req, res) => {
  const detail = await loadForAction(req, res, 'payment_request.create');
  if (!detail) return;
  if (!['DRAFT', 'REJECTED'].includes(detail.status)) {
    return res.status(409).json({ error: 'PAYMENT_REQUEST_INVALID_STATUS', status: detail.status });
  }
  await query(
    `UPDATE payment_requests SET status='SUBMITTED',submitted_by=?,submitted_at=NOW(6),
       rejected_by=NULL,rejected_at=NULL,rejection_reason=NULL WHERE id=?`,
    [req.user!.id, detail.id],
  );
  await writeAudit({
    legalEntityId: detail.legal_entity_id, unitId: detail.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_SUBMIT', entityType: 'PAYMENT_REQUEST', entityId: detail.id, after: { status: 'SUBMITTED' },
  });
  res.json(await paymentRequestDetail(detail.id));
});

paymentRequestRouter.post('/payment-requests/:id/approve', requirePermission('payment_request.approve'), async (req, res) => {
  const detail = await loadForAction(req, res, 'payment_request.approve');
  if (!detail) return;
  if (detail.status !== 'SUBMITTED') {
    return res.status(409).json({ error: 'PAYMENT_REQUEST_INVALID_STATUS', status: detail.status });
  }
  // Maker-checker: pembuat MCM tidak boleh menyetujui MCM-nya sendiri.
  if (detail.created_by && detail.created_by === req.user!.id) {
    return res.status(403).json({ error: 'PAYMENT_REQUEST_SELF_APPROVAL_FORBIDDEN' });
  }
  await query(
    "UPDATE payment_requests SET status='APPROVED',approved_by=?,approved_at=NOW(6) WHERE id=?",
    [req.user!.id, detail.id],
  );
  await writeAudit({
    legalEntityId: detail.legal_entity_id, unitId: detail.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_APPROVE', entityType: 'PAYMENT_REQUEST', entityId: detail.id, after: { status: 'APPROVED' },
  });
  res.json(await paymentRequestDetail(detail.id));
});

paymentRequestRouter.post('/payment-requests/:id/reject', requirePermission('payment_request.approve'), async (req, res) => {
  const detail = await loadForAction(req, res, 'payment_request.approve');
  if (!detail) return;
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'REJECTION_REASON_REQUIRED' });
  if (detail.status !== 'SUBMITTED') {
    return res.status(409).json({ error: 'PAYMENT_REQUEST_INVALID_STATUS', status: detail.status });
  }
  await query(
    `UPDATE payment_requests SET status='REJECTED',rejected_by=?,rejected_at=NOW(6),rejection_reason=? WHERE id=?`,
    [req.user!.id, reason, detail.id],
  );
  await writeAudit({
    legalEntityId: detail.legal_entity_id, unitId: detail.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_REJECT', entityType: 'PAYMENT_REQUEST', entityId: detail.id,
    after: { status: 'REJECTED' }, reason,
  });
  res.json(await paymentRequestDetail(detail.id));
});

paymentRequestRouter.post('/payment-requests/:id/cancel', requirePermission('payment_request.create'), async (req, res) => {
  const detail = await loadForAction(req, res, 'payment_request.create');
  if (!detail) return;
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'CANCEL_REASON_REQUIRED' });
  if (!['DRAFT', 'SUBMITTED', 'REJECTED'].includes(detail.status)) {
    return res.status(409).json({ error: 'PAYMENT_REQUEST_INVALID_STATUS', status: detail.status });
  }
  await query("UPDATE payment_requests SET status='CANCELLED' WHERE id=?", [detail.id]);
  await writeAudit({
    legalEntityId: detail.legal_entity_id, unitId: detail.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_CANCEL', entityType: 'PAYMENT_REQUEST', entityId: detail.id,
    after: { status: 'CANCELLED' }, reason,
  });
  res.json(await paymentRequestDetail(detail.id));
});

paymentRequestRouter.post('/payment-requests/:id/post', requirePermission('expense.pay'), async (req, res) => {
  const detail = await loadForAction(req, res, 'expense.pay');
  if (!detail) return;
  if (detail.status === 'POSTED') {
    return res.json({ paymentRequest: await paymentRequestDetail(detail.id), idempotent: true });
  }
  if (detail.status !== 'APPROVED') {
    return res.status(409).json({ error: 'PAYMENT_REQUEST_NOT_APPROVED', status: detail.status });
  }

  let payment: { id: string; paymentNumber: string };
  try {
    payment = await postExpensePayment({
      legalEntityId: detail.legal_entity_id,
      unitId: detail.unit_id,
      unitCode: detail.unit_code,
      requestId: detail.expense_request_id,
      bankAccountId: detail.bank_account_id,
      paymentDate: String(detail.request_date).slice(0, 10),
      method: detail.method,
      referenceNumber: detail.request_number,
      amountCents: toCents(detail.amount),
      idempotencyKey: `MCM:${detail.id}`,
      notes: detail.notes,
      userId: req.user!.id,
    });
  } catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'EXPENSE_PAYMENT_DUPLICATE' });
    }
    throw error;
  }

  await query("UPDATE payment_requests SET status='POSTED',payment_id=? WHERE id=?", [payment.id, detail.id]);
  await writeAudit({
    legalEntityId: detail.legal_entity_id, unitId: detail.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'PAYMENT_REQUEST_POST', entityType: 'PAYMENT_REQUEST', entityId: detail.id,
    after: { status: 'POSTED', payment_id: payment.id, payment_number: payment.paymentNumber },
  });
  res.json({ paymentRequest: await paymentRequestDetail(detail.id), paymentId: payment.id, paymentNumber: payment.paymentNumber });
});
