import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { fromCents, isDateOnly, nullableText, paging, text, toCents, upper } from '../http.js';

export const receiptRouter = Router();
receiptRouter.use(requireAuth);

const METHODS = ['CASH', 'TRANSFER', 'QRIS', 'OTHER'];

/**
 * Hitung ulang paid_amount + status invoice dari alokasi penerimaan yang masih POSTED,
 * lalu distribusikan ke angsuran secara FIFO (sequence).
 */
async function refreshInvoice(conn: any, invoiceId: string) {
  const [rows]: any = await conn.query(
    `SELECT i.total_amount,
            COALESCE((SELECT SUM(a.amount) FROM receipt_allocations a
                        JOIN receipts r ON r.id=a.receipt_id
                       WHERE a.invoice_id=i.id AND r.status='POSTED'), 0) paid
       FROM invoices i WHERE i.id=?`,
    [invoiceId],
  );
  const row = rows[0];
  if (!row) return;
  const totalCents = toCents(row.total_amount);
  const paidCents = toCents(row.paid);
  const status = paidCents <= 0 ? 'ISSUED' : paidCents < totalCents ? 'PARTIAL' : 'PAID';
  await conn.query('UPDATE invoices SET paid_amount=?, status=? WHERE id=?', [fromCents(paidCents), status, invoiceId]);

  const [installments]: any = await conn.query(
    "SELECT id,amount FROM invoice_installments WHERE invoice_id=? AND status<>'VOID' ORDER BY sequence",
    [invoiceId],
  );
  let remaining = paidCents;
  for (const installment of installments) {
    const amountCents = toCents(installment.amount);
    const applied = Math.max(0, Math.min(remaining, amountCents));
    remaining -= applied;
    const installmentStatus = applied <= 0 ? 'UNPAID' : applied < amountCents ? 'PARTIAL' : 'PAID';
    await conn.query('UPDATE invoice_installments SET paid_amount=?, status=? WHERE id=?', [
      fromCents(applied), installmentStatus, installment.id,
    ]);
  }
}

async function receiptDetail(receiptId: string) {
  const receipt = await one<any>(
    `SELECT r.*,u.unit_code,u.unit_name,b.bank_name,b.account_number,b.account_holder,
            cu.full_name created_by_name
       FROM receipts r
       JOIN organization_units u ON u.id=r.unit_id
       JOIN bank_accounts b ON b.id=r.bank_account_id
       LEFT JOIN users cu ON cu.id=r.created_by
      WHERE r.id=?`, [receiptId],
  );
  if (!receipt) return null;
  const allocations = await query<any>(
    `SELECT a.id,a.amount,a.unit_id,a.invoice_id,a.student_id,
            i.invoice_number,i.period_label,i.status invoice_status,i.total_amount,i.paid_amount,
            s.full_name,s.nis,ou.unit_code,ou.unit_name
       FROM receipt_allocations a
       JOIN invoices i ON i.id=a.invoice_id
       JOIN students s ON s.id=a.student_id
       JOIN organization_units ou ON ou.id=a.unit_id
      WHERE a.receipt_id=? ORDER BY s.full_name`,
    [receiptId],
  );
  return { ...receipt, allocations };
}

receiptRouter.get('/receipts', requirePermission('receipt.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const from = text(req.query.from);
  const to = text(req.query.to);
  const status = upper(req.query.status);
  const search = text(req.query.q);

  if (unitId && !(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) {
      conditions.push('1=0');
    } else {
      conditions.push(`(r.unit_id IN (?) OR EXISTS (
        SELECT 1 FROM receipt_allocations a WHERE a.receipt_id=r.id AND a.unit_id IN (?)
      ))`);
      params.push(allowed, allowed);
    }
  }
  if (unitId) { conditions.push('r.unit_id=?'); params.push(unitId); }
  if (from && isDateOnly(from)) { conditions.push('r.receipt_date>=?'); params.push(from); }
  if (to && isDateOnly(to)) { conditions.push('r.receipt_date<=?'); params.push(to); }
  if (status) { conditions.push('r.status=?'); params.push(status); }
  if (search) {
    conditions.push('(r.receipt_number LIKE ? OR r.payer_name LIKE ? OR r.reference_number LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT r.id,r.receipt_number,r.receipt_date,r.method,r.reference_number,r.payer_name,
            r.total_amount,r.allocated_amount,r.unallocated_amount,r.status,
            u.unit_code,u.unit_name,b.bank_name,
            (SELECT COUNT(*) FROM receipt_allocations a WHERE a.receipt_id=r.id) allocation_count
       FROM receipts r
       JOIN organization_units u ON u.id=r.unit_id
       JOIN bank_accounts b ON b.id=r.bank_account_id
       ${where}
      ORDER BY r.receipt_date DESC, r.receipt_number DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(`SELECT COUNT(*) total FROM receipts r ${where}`, params);
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

receiptRouter.post('/receipts', requirePermission('receipt.create'), async (req, res) => {
  const unitId = text(req.body?.unitId);
  const bankAccountId = text(req.body?.bankAccountId);
  const receiptDate = text(req.body?.receiptDate);
  const method = upper(req.body?.method) || 'TRANSFER';
  const idempotencyKey = nullableText(req.body?.idempotencyKey);

  if (!unitId || !bankAccountId) return res.status(400).json({ error: 'RECEIPT_FIELDS_REQUIRED' });
  if (!isDateOnly(receiptDate)) return res.status(400).json({ error: 'RECEIPT_DATE_INVALID' });
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'RECEIPT_METHOD_INVALID' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const unit = await one<any>('SELECT id,legal_entity_id,unit_code FROM organization_units WHERE id=?', [unitId]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });

  if (idempotencyKey) {
    const existing = await one<any>(
      'SELECT id FROM receipts WHERE legal_entity_id=? AND idempotency_key=?',
      [unit.legal_entity_id, idempotencyKey],
    );
    if (existing) {
      return res.json({ receipt: await receiptDetail(existing.id), idempotent: true });
    }
  }

  const account = await one<any>(
    'SELECT id,status,verified_at FROM bank_accounts WHERE id=? AND legal_entity_id=?',
    [bankAccountId, unit.legal_entity_id],
  );
  if (!account) return res.status(403).json({ error: 'BANK_ACCOUNT_NOT_ALLOWED' });
  if (account.status !== 'ACTIVE' || !account.verified_at) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_READY' });

  const assignment = await one(
    `SELECT 1 FROM unit_bank_account_assignments
      WHERE unit_id=? AND bank_account_id=? AND status='ACTIVE' AND allow_receipt=1
        AND effective_start<=? AND (effective_end IS NULL OR effective_end>=?)`,
    [unitId, bankAccountId, receiptDate, receiptDate],
  );
  if (!assignment) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT' });

  const totalCents = toCents(req.body?.totalAmount);
  if (!Number.isFinite(totalCents) || totalCents <= 0) return res.status(400).json({ error: 'RECEIPT_AMOUNT_INVALID' });

  const rawAllocations: any[] = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
  const allocations = rawAllocations
    .map(item => ({ invoiceId: text(item?.invoiceId), amountCents: toCents(item?.amount) }))
    .filter(item => item.invoiceId);
  for (const allocation of allocations) {
    if (!Number.isFinite(allocation.amountCents) || allocation.amountCents <= 0) {
      return res.status(400).json({ error: 'ALLOCATION_AMOUNT_INVALID' });
    }
  }

  const allocatedCents = allocations.reduce((sum, item) => sum + item.amountCents, 0);
  if (allocatedCents > totalCents) {
    return res.status(400).json({ error: 'ALLOCATION_EXCEEDS_RECEIPT' });
  }
  const unallocatedCents = totalCents - allocatedCents;

  const id = randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [seqRows]: any = await conn.query(
      'SELECT COUNT(*) total FROM receipts WHERE legal_entity_id=? AND receipt_number LIKE ?',
      [unit.legal_entity_id, `RCP-${receiptDate.replace(/-/g, '')}-${String(unit.unit_code).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}-%`],
    );
    const sequence = Number(seqRows[0].total) + 1;
    const receiptNumber = `RCP-${receiptDate.replace(/-/g, '')}-${String(unit.unit_code).replace(/[^0-9A-Za-z]/g, '').toUpperCase()}-${String(sequence).padStart(3, '0')}`;

    await conn.query(
      `INSERT INTO receipts(id,legal_entity_id,unit_id,bank_account_id,receipt_number,receipt_date,method,
         reference_number,payer_name,total_amount,allocated_amount,unallocated_amount,status,idempotency_key,notes,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'POSTED', ?,?,?)`,
      [id, unit.legal_entity_id, unitId, bankAccountId, receiptNumber, receiptDate, method,
        nullableText(req.body?.referenceNumber), nullableText(req.body?.payerName),
        fromCents(totalCents), fromCents(allocatedCents), fromCents(unallocatedCents),
        idempotencyKey, nullableText(req.body?.notes), req.user!.id],
    );

    for (const allocation of allocations) {
      const [invoiceRows]: any = await conn.query(
        `SELECT i.id,i.legal_entity_id,i.unit_id,i.student_id,i.total_amount,i.paid_amount,i.status
           FROM invoices i WHERE i.id=? FOR UPDATE`,
        [allocation.invoiceId],
      );
      const invoice = invoiceRows[0];
      if (!invoice) throw Object.assign(new Error('INVOICE_NOT_FOUND'), { statusCode: 400 });
      if (invoice.legal_entity_id !== unit.legal_entity_id) throw Object.assign(new Error('INVOICE_OUTSIDE_ENTITY'), { statusCode: 400 });
      if (invoice.status === 'VOID') throw Object.assign(new Error('INVOICE_VOID'), { statusCode: 400 });
      if (!(await canAccessUnit(req.user!, invoice.unit_id))) {
        throw Object.assign(new Error('UNIT_FORBIDDEN'), { statusCode: 403 });
      }
      const outstanding = toCents(invoice.total_amount) - toCents(invoice.paid_amount);
      if (allocation.amountCents > outstanding) {
        throw Object.assign(new Error('ALLOCATION_EXCEEDS_OUTSTANDING'), { statusCode: 409 });
      }

      await conn.query(
        'INSERT INTO receipt_allocations(id,receipt_id,invoice_id,student_id,unit_id,amount) VALUES(?,?,?,?,?,?)',
        [randomUUID(), id, invoice.id, invoice.student_id, invoice.unit_id, fromCents(allocation.amountCents)],
      );
      await refreshInvoice(conn, invoice.id);
    }

    await conn.query(
      `INSERT INTO bank_mutations(id,legal_entity_id,bank_account_id,unit_id,mutation_date,direction,amount,source_type,source_id,description)
       VALUES(?,?,?,?,?, 'IN', ?, 'RECEIPT', ?, ?)`,
      [randomUUID(), unit.legal_entity_id, bankAccountId, unitId, receiptDate, fromCents(totalCents), id,
        `Penerimaan ${receiptNumber}`],
    );

    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'RECEIPT_DUPLICATE' });
    }
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: unit.legal_entity_id, unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'RECEIPT_CREATE', entityType: 'RECEIPT', entityId: id,
    after: { total: Number(fromCents(totalCents)), allocated: Number(fromCents(allocatedCents)), unallocated: Number(fromCents(unallocatedCents)) },
  });

  res.status(201).json({ receipt: await receiptDetail(id), idempotent: false });
});

receiptRouter.get('/receipts/:id', requirePermission('receipt.view'), async (req, res) => {
  const receipt = await receiptDetail(text(req.params.id));
  if (!receipt) return res.status(404).json({ error: 'RECEIPT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, receipt.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  res.json(receipt);
});

receiptRouter.post('/receipts/:id/void', requirePermission('receipt.void'), async (req, res) => {
  const id = text(req.params.id);
  const reason = text(req.body?.reason);
  const receipt = await one<any>('SELECT * FROM receipts WHERE id=?', [id]);
  if (!receipt) return res.status(404).json({ error: 'RECEIPT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, receipt.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  if (reason.length < 5) return res.status(400).json({ error: 'VOID_REASON_REQUIRED' });
  if (receipt.status === 'VOID') return res.status(409).json({ error: 'RECEIPT_ALREADY_VOID' });

  const affected = await query<{ invoice_id: string }>(
    'SELECT DISTINCT invoice_id FROM receipt_allocations WHERE receipt_id=?', [id],
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE receipts SET status='VOID', void_reason=? WHERE id=?", [reason, id]);
    for (const row of affected) await refreshInvoice(conn, row.invoice_id);
    await conn.query(
      `INSERT INTO bank_mutations(id,legal_entity_id,bank_account_id,unit_id,mutation_date,direction,amount,source_type,source_id,description)
       VALUES(?,?,?,?,?, 'OUT', ?, 'RECEIPT_VOID', ?, ?)`,
      [randomUUID(), receipt.legal_entity_id, receipt.bank_account_id, receipt.unit_id,
        new Date().toISOString().slice(0, 10), receipt.total_amount, id,
        `Pembatalan ${receipt.receipt_number}`],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: receipt.legal_entity_id, unitId: receipt.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'RECEIPT_VOID', entityType: 'RECEIPT', entityId: id,
    before: { status: 'POSTED' }, after: { status: 'VOID' }, reason,
  });
  res.json({ ok: true });
});
