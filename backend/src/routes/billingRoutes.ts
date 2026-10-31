import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { addMonths, fromCents, isDateOnly, paging, text, toCents, upper } from '../http.js';
import { journalForInvoice, reverseJournal } from '../accounting.js';

export const billingRouter = Router();
billingRouter.use(requireAuth);

const PERIOD_RE = /^[0-9A-Za-z-]{3,20}$/;

type Plan = {
  unit: any;
  year: any;
  schemes: any[];
  students: any[];
  totalCents: number;
  installmentCount: number;
};

async function buildPlan(
  unitId: string,
  academicYearId: string,
  invoiceDate: string,
): Promise<Plan | { error: string }> {
  const unit = await one<any>(
    `SELECT id,legal_entity_id,unit_code,unit_name,operational_status,finance_status
       FROM organization_units WHERE id=?`, [unitId],
  );
  if (!unit) return { error: 'UNIT_NOT_FOUND' };
  if (unit.operational_status !== 'ACTIVE') return { error: 'UNIT_NOT_ACTIVE' };
  if (unit.finance_status !== 'READY') return { error: 'UNIT_NOT_READY_FOR_BILLING' };

  const year = await one<any>('SELECT id,name FROM academic_years WHERE id=? AND legal_entity_id=?', [academicYearId, unit.legal_entity_id]);
  if (!year) return { error: 'ACADEMIC_YEAR_OUTSIDE_ENTITY' };

  const rows = await query<any>(
    `SELECT fs.id,fs.fee_type_id,fs.name,fs.amount,fs.frequency,fs.installment_count,fs.effective_start,
            ft.code fee_code,ft.name fee_name
       FROM fee_schemes fs JOIN fee_types ft ON ft.id=fs.fee_type_id
      WHERE fs.unit_id=? AND fs.academic_year_id=? AND fs.status='ACTIVE'
        AND fs.effective_start<=? AND (fs.effective_end IS NULL OR fs.effective_end>=?)
      ORDER BY fs.fee_type_id, fs.effective_start DESC`,
    [unitId, academicYearId, invoiceDate, invoiceDate],
  );
  const latest = new Map<string, any>();
  for (const row of rows) if (!latest.has(row.fee_type_id)) latest.set(row.fee_type_id, row);
  const schemes = [...latest.values()];
  if (!schemes.length) return { error: 'NO_ACTIVE_FEE_SCHEME' };

  const students = await query<any>(
    `SELECT s.id,s.nis,s.full_name,e.class_label
       FROM students s
       JOIN student_enrollments e ON e.student_id=s.id AND e.status='ACTIVE'
      WHERE e.unit_id=? AND e.academic_year_id=? AND s.status='ACTIVE'
      ORDER BY s.full_name`,
    [unitId, academicYearId],
  );
  if (!students.length) return { error: 'NO_ACTIVE_STUDENT' };

  const totalCents = schemes.reduce((sum, scheme) => sum + toCents(scheme.amount), 0);
  const installmentCount = Math.max(1, ...schemes.map(scheme => Number(scheme.installment_count) || 1));
  return { unit, year, schemes, students, totalCents, installmentCount };
}

function splitCents(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const chunks = new Array(parts).fill(base);
  chunks[parts - 1] += total - base * parts;
  return chunks;
}

function validateBillingInput(body: any) {
  const unitId = text(body?.unitId);
  const academicYearId = text(body?.academicYearId);
  const periodLabel = text(body?.periodLabel);
  const invoiceDate = text(body?.invoiceDate);
  const dueDate = text(body?.dueDate);
  if (!unitId || !academicYearId || !periodLabel) return { error: 'BILLING_FIELDS_REQUIRED' };
  if (!PERIOD_RE.test(periodLabel)) return { error: 'PERIOD_LABEL_INVALID' };
  if (!isDateOnly(invoiceDate) || !isDateOnly(dueDate)) return { error: 'BILLING_DATES_INVALID' };
  if (dueDate < invoiceDate) return { error: 'BILLING_DUE_BEFORE_INVOICE' };
  return { unitId, academicYearId, periodLabel, invoiceDate, dueDate };
}

/* ------------------------------------------------------------------ Billing run */

billingRouter.get('/billing-runs', requirePermission('billing.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('br.unit_id IN (?)'); params.push(allowed); }
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await query(
    `SELECT br.id,br.period_label,br.invoice_date,br.due_date,br.status,br.student_count,br.invoice_count,
            br.total_amount,br.created_at,u.unit_code,u.unit_name,ay.name academic_year_name,
            cu.full_name created_by_name
       FROM billing_runs br
       JOIN organization_units u ON u.id=br.unit_id
       JOIN academic_years ay ON ay.id=br.academic_year_id
       LEFT JOIN users cu ON cu.id=br.created_by
       ${where}
      ORDER BY br.created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  ));
});

billingRouter.post('/billing-runs/preview', requirePermission('billing.view'), async (req, res) => {
  const input = validateBillingInput(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  if (!(await canAccessUnit(req.user!, input.unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const plan = await buildPlan(input.unitId, input.academicYearId, input.invoiceDate);
  if ('error' in plan) return res.status(400).json({ error: plan.error });

  const existing = await one(
    'SELECT id FROM billing_runs WHERE unit_id=? AND academic_year_id=? AND period_label=?',
    [input.unitId, input.academicYearId, input.periodLabel],
  );

  res.json({
    unit: { id: plan.unit.id, unit_code: plan.unit.unit_code, unit_name: plan.unit.unit_name },
    academicYear: plan.year.name,
    periodLabel: input.periodLabel,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    alreadyGenerated: Boolean(existing),
    studentCount: plan.students.length,
    installmentCount: plan.installmentCount,
    schemes: plan.schemes.map(scheme => ({
      feeTypeId: scheme.fee_type_id, feeCode: scheme.fee_code, feeName: scheme.fee_name,
      name: scheme.name, amount: Number(fromCents(toCents(scheme.amount))),
      frequency: scheme.frequency, installmentCount: scheme.installment_count,
    })),
    totalPerStudent: Number(fromCents(plan.totalCents)),
    grandTotal: Number(fromCents(plan.totalCents * plan.students.length)),
    students: plan.students,
  });
});

billingRouter.post('/billing-runs/generate', requirePermission('billing.generate'), async (req, res) => {
  const input = validateBillingInput(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  if (!(await canAccessUnit(req.user!, input.unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const plan = await buildPlan(input.unitId, input.academicYearId, input.invoiceDate);
  if ('error' in plan) return res.status(400).json({ error: plan.error });

  if (await one('SELECT id FROM billing_runs WHERE unit_id=? AND academic_year_id=? AND period_label=?',
    [input.unitId, input.academicYearId, input.periodLabel])) {
    return res.status(409).json({ error: 'BILLING_RUN_DUPLICATE' });
  }

  const billingRunId = randomUUID();
  const periodKey = input.periodLabel.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const unitKey = String(plan.unit.unit_code).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const installments = splitCents(plan.totalCents, plan.installmentCount);

  const conn = await pool.getConnection();
  let invoiceCount = 0;
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO billing_runs(id,legal_entity_id,unit_id,academic_year_id,period_label,invoice_date,due_date,
         status,student_count,invoice_count,total_amount,created_by)
       VALUES(?,?,?,?,?,?,?,'ISSUED',?,?,?,?)`,
      [billingRunId, plan.unit.legal_entity_id, input.unitId, input.academicYearId, input.periodLabel,
        input.invoiceDate, input.dueDate, plan.students.length, plan.students.length,
        fromCents(plan.totalCents * plan.students.length), req.user!.id],
    );

    for (const [index, student] of plan.students.entries()) {
      const invoiceId = randomUUID();
      const invoiceNumber = `INV-${periodKey}-${unitKey}-${String(index + 1).padStart(4, '0')}`;
      await conn.query(
        `INSERT INTO invoices(id,legal_entity_id,unit_id,student_id,academic_year_id,billing_run_id,
           invoice_number,invoice_date,due_date,period_label,total_amount,paid_amount,status)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'ISSUED')`,
        [invoiceId, plan.unit.legal_entity_id, input.unitId, student.id, input.academicYearId, billingRunId,
          invoiceNumber, input.invoiceDate, input.dueDate, input.periodLabel, fromCents(plan.totalCents)],
      );

      for (const [lineIndex, scheme] of plan.schemes.entries()) {
        await conn.query(
          `INSERT INTO invoice_lines(id,invoice_id,fee_type_id,description,amount,sort_order)
           VALUES(?,?,?,?,?,?)`,
          [randomUUID(), invoiceId, scheme.fee_type_id, scheme.fee_name, scheme.amount, lineIndex],
        );
      }

      for (const [chunkIndex, cents] of installments.entries()) {
        await conn.query(
          `INSERT INTO invoice_installments(id,invoice_id,sequence,due_date,amount,paid_amount,status)
           VALUES(?,?,?,?,?,0,'UNPAID')`,
          [randomUUID(), invoiceId, chunkIndex + 1, addMonths(input.dueDate, chunkIndex), fromCents(cents)],
        );
      }

      // ACC-01: Dr Piutang, Cr Pendapatan per jenis biaya (idempoten per invoice).
      await journalForInvoice(conn, invoiceId, req.user!.id);
      invoiceCount += 1;
    }

    await conn.commit();
  } catch (error: any) {
    await conn.rollback();
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    if (error?.errno === 1062 || error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'BILLING_RUN_DUPLICATE' });
    }
    throw error;
  } finally {
    conn.release();
  }

  await writeAudit({
    legalEntityId: plan.unit.legal_entity_id, unitId: input.unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'BILLING_RUN_GENERATE', entityType: 'BILLING_RUN', entityId: billingRunId,
    after: {
      periodLabel: input.periodLabel, invoiceCount, perStudent: Number(fromCents(plan.totalCents)),
      totalAmount: Number(fromCents(plan.totalCents * invoiceCount)),
    },
  });

  res.status(201).json({
    ok: true, billingRunId, invoiceCount, periodLabel: input.periodLabel,
    totalPerStudent: Number(fromCents(plan.totalCents)),
    totalAmount: Number(fromCents(plan.totalCents * invoiceCount)),
  });
});

/* ------------------------------------------------------------------ Invoice */

billingRouter.get('/invoices', requirePermission('billing.view'), async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  const status = upper(req.query.status);
  const periodLabel = text(req.query.periodLabel);
  const search = text(req.query.q);

  const conditions: string[] = ['i.status <> \'VOID\''];
  const params: any[] = [];
  if (status) { conditions.push('i.status=?'); params.push(status); }
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('i.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) {
    if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    conditions.push('i.unit_id=?');
    params.push(unitId);
  }
  if (periodLabel) { conditions.push('i.period_label=?'); params.push(periodLabel); }
  if (search) {
    conditions.push('(i.invoice_number LIKE ? OR s.full_name LIKE ? OR s.nis LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query(
    `SELECT i.id,i.invoice_number,i.period_label,i.invoice_date,i.due_date,i.total_amount,i.paid_amount,
            (i.total_amount - i.paid_amount) outstanding,i.status,
            s.id student_id,s.full_name,s.nis,u.unit_code,u.unit_name
       FROM invoices i
       JOIN students s ON s.id=i.student_id
       JOIN organization_units u ON u.id=i.unit_id
       ${where}
      ORDER BY i.invoice_date DESC, i.invoice_number DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM invoices i JOIN students s ON s.id=i.student_id ${where}`, params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

billingRouter.get('/invoices/:id', requirePermission('billing.view'), async (req, res) => {
  const id = text(req.params.id);
  const invoice = await one<any>(
    `SELECT i.*,s.full_name,s.nis,s.guardian_name,u.unit_code,u.unit_name,ay.name academic_year_name
       FROM invoices i
       JOIN students s ON s.id=i.student_id
       JOIN organization_units u ON u.id=i.unit_id
       JOIN academic_years ay ON ay.id=i.academic_year_id
      WHERE i.id=?`, [id],
  );
  if (!invoice) return res.status(404).json({ error: 'INVOICE_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, invoice.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const [lines, installments] = await Promise.all([
    query('SELECT id,fee_type_id,description,amount,sort_order FROM invoice_lines WHERE invoice_id=? ORDER BY sort_order', [id]),
    query('SELECT id,sequence,due_date,amount,paid_amount,status FROM invoice_installments WHERE invoice_id=? ORDER BY sequence', [id]),
  ]);
  res.json({ ...invoice, lines, installments });
});

billingRouter.post('/invoices/:id/void', requirePermission('invoice.void'), async (req, res) => {
  const id = text(req.params.id);
  const reason = text(req.body?.reason);
  const invoice = await one<any>('SELECT * FROM invoices WHERE id=?', [id]);
  if (!invoice) return res.status(404).json({ error: 'INVOICE_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, invoice.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  if (reason.length < 5) return res.status(400).json({ error: 'VOID_REASON_REQUIRED' });
  if (invoice.status === 'VOID') return res.status(409).json({ error: 'INVOICE_ALREADY_VOID' });
  if (toCents(invoice.paid_amount) > 0) return res.status(409).json({ error: 'INVOICE_HAS_PAYMENT' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE invoices SET status='VOID', void_reason=? WHERE id=?", [reason, id]);
    await conn.query("UPDATE invoice_installments SET status='VOID' WHERE invoice_id=?", [id]);
    await reverseJournal(conn, {
      legalEntityId: invoice.legal_entity_id, sourceType: 'INVOICE', sourceId: id,
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
    legalEntityId: invoice.legal_entity_id, unitId: invoice.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'INVOICE_VOID', entityType: 'INVOICE', entityId: id,
    before: { status: invoice.status }, after: { status: 'VOID' }, reason,
  });
  res.json({ ok: true });
});
