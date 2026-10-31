import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { text } from '../http.js';

export const receivableRouter = Router();
receivableRouter.use(requireAuth);

type Bucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_PLUS';

function agingBucket(dueDate: string, today: string): { bucket: Bucket; days: number } {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  const days = Math.floor((now - due) / 86400000);
  if (days <= 0) return { bucket: 'CURRENT', days };
  if (days <= 30) return { bucket: 'D1_30', days };
  if (days <= 60) return { bucket: 'D31_60', days };
  return { bucket: 'D61_PLUS', days };
}

receivableRouter.get('/receivables', requirePermission('receivable.view'), async (req, res) => {
  const allowed = await allowedUnitIds(req.user!);
  const unitId = text(req.query.unitId);
  if (unitId && !(await canAccessUnit(req.user!, unitId))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }

  const conditions: string[] = ["i.status IN ('ISSUED','PARTIAL')", '(i.total_amount - i.paid_amount) > 0'];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('i.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) { conditions.push('i.unit_id=?'); params.push(unitId); }

  const rows = await query<any>(
    `SELECT i.id,i.invoice_number,i.period_label,i.due_date,i.total_amount,i.paid_amount,
            (i.total_amount - i.paid_amount) outstanding,i.status,
            s.id student_id,s.full_name,s.nis,u.id unit_id,u.unit_code,u.unit_name
       FROM invoices i
       JOIN students s ON s.id=i.student_id
       JOIN organization_units u ON u.id=i.unit_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY i.due_date ASC, s.full_name`,
    params,
  );

  const today = new Date().toISOString().slice(0, 10);
  const summary: Record<Bucket, number> = { CURRENT: 0, D1_30: 0, D31_60: 0, D61_PLUS: 0 };
  const byUnit = new Map<string, { unit_id: string; unit_code: string; unit_name: string; outstanding: number; invoices: number }>();
  let totalOutstanding = 0;

  const items = rows.map(row => {
    const outstanding = Number(row.outstanding);
    const { bucket, days } = agingBucket(String(row.due_date), today);
    summary[bucket] += outstanding;
    totalOutstanding += outstanding;
    const key = String(row.unit_id);
    const unit = byUnit.get(key) || {
      unit_id: row.unit_id, unit_code: row.unit_code, unit_name: row.unit_name, outstanding: 0, invoices: 0,
    };
    unit.outstanding += outstanding;
    unit.invoices += 1;
    byUnit.set(key, unit);
    return { ...row, outstanding, aging_bucket: bucket, days_overdue: Math.max(0, days) };
  });

  res.json({
    today,
    totalOutstanding,
    invoiceCount: items.length,
    aging: summary,
    byUnit: [...byUnit.values()].sort((a, b) => b.outstanding - a.outstanding),
    items,
  });
});
