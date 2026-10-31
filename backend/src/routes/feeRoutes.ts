import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { exec, one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { fromCents, isDateOnly, nullableText, text, toCents, upper } from '../http.js';

export const feeRouter = Router();
feeRouter.use(requireAuth);

const FREQUENCIES = ['MONTHLY', 'ANNUAL', 'ONE_TIME'];
const RECOGNITIONS = ['IMMEDIATE', 'DEFERRED'];

async function activeEntityId(): Promise<string | null> {
  const entity = await one<{ id: string }>("SELECT id FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  return entity?.id || null;
}

/** ACC-01: akun pendapatan harus ada di CoA dan bertipe REVENUE. */
async function isRevenueAccount(legalEntityId: string, code: string) {
  const account = await one<any>(
    'SELECT account_type,is_postable,status FROM accounts WHERE legal_entity_id=? AND code=?',
    [legalEntityId, code],
  );
  return Boolean(account && account.account_type === 'REVENUE' && account.is_postable && account.status === 'ACTIVE');
}

/* ------------------------------------------------------------------ Jenis biaya */

feeRouter.get('/fee-types', requirePermission('fee.view'), async (_req, res) => {
  res.json(await query(
    `SELECT id,code,name,description,revenue_account_code,recognition_mode,status
       FROM fee_types ORDER BY name`,
  ));
});

feeRouter.post('/fee-types', requirePermission('fee.manage'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const recognition = upper(req.body?.recognitionMode) || 'IMMEDIATE';
  if (!code || !name) return res.status(400).json({ error: 'FEE_TYPE_FIELDS_REQUIRED' });
  if (!RECOGNITIONS.includes(recognition)) return res.status(400).json({ error: 'RECOGNITION_MODE_INVALID' });
  if (await one('SELECT id FROM fee_types WHERE legal_entity_id=? AND code=?', [entityId, code])) {
    return res.status(409).json({ error: 'FEE_TYPE_CODE_DUPLICATE' });
  }

  const revenueAccountCode = nullableText(req.body?.revenueAccountCode);
  if (revenueAccountCode && !(await isRevenueAccount(entityId, revenueAccountCode))) {
    return res.status(400).json({ error: 'ACCOUNT_MAPPING_MISSING' });
  }

  const id = randomUUID();
  await exec(
    'INSERT INTO fee_types(id,legal_entity_id,code,name,description,revenue_account_code,recognition_mode) VALUES(?,?,?,?,?,?,?)',
    [id, entityId, code, name, nullableText(req.body?.description), revenueAccountCode, recognition],
  );
  const after = await one('SELECT * FROM fee_types WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: entityId, userId: req.user!.id, ip: req.ip || null,
    action: 'FEE_TYPE_CREATE', entityType: 'FEE_TYPE', entityId: id, after,
  });
  res.status(201).json(after);
});

feeRouter.patch('/fee-types/:id', requirePermission('fee.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM fee_types WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'FEE_TYPE_NOT_FOUND' });

  const code = upper(req.body?.code) || before.code;
  const name = text(req.body?.name) || before.name;
  const recognition = upper(req.body?.recognitionMode) || before.recognition_mode;
  if (!RECOGNITIONS.includes(recognition)) return res.status(400).json({ error: 'RECOGNITION_MODE_INVALID' });
  if (await one('SELECT id FROM fee_types WHERE legal_entity_id=? AND code=? AND id<>?', [before.legal_entity_id, code, id])) {
    return res.status(409).json({ error: 'FEE_TYPE_CODE_DUPLICATE' });
  }

  const revenueAccountCode = nullableText(req.body?.revenueAccountCode ?? before.revenue_account_code);
  if (revenueAccountCode && !(await isRevenueAccount(before.legal_entity_id, revenueAccountCode))) {
    return res.status(400).json({ error: 'ACCOUNT_MAPPING_MISSING' });
  }

  await exec(
    'UPDATE fee_types SET code=?, name=?, description=?, revenue_account_code=?, recognition_mode=?, status=? WHERE id=?',
    [code, name, nullableText(req.body?.description ?? before.description),
      revenueAccountCode, recognition, upper(req.body?.status) || before.status, id],
  );
  const after = await one('SELECT * FROM fee_types WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, userId: req.user!.id, ip: req.ip || null,
    action: 'FEE_TYPE_UPDATE', entityType: 'FEE_TYPE', entityId: id, before, after,
  });
  res.json(after);
});

/* ------------------------------------------------------------------ Tarif per unit */

feeRouter.get('/fee-schemes', requirePermission('fee.view'), async (req, res) => {
  const unitId = text(req.query.unitId);
  const academicYearId = text(req.query.academicYearId);
  const allowed = await allowedUnitIds(req.user!);

  const conditions: string[] = [];
  const params: any[] = [];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('fs.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) {
    if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    conditions.push('fs.unit_id=?');
    params.push(unitId);
  }
  if (academicYearId) { conditions.push('fs.academic_year_id=?'); params.push(academicYearId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  res.json(await query(
    `SELECT fs.id,fs.unit_id,u.unit_code,u.unit_name,fs.academic_year_id,ay.name academic_year_name,
            fs.fee_type_id,ft.code fee_code,ft.name fee_name,
            fs.name,fs.amount,fs.frequency,fs.installment_count,fs.due_day,
            fs.effective_start,fs.effective_end,fs.status
       FROM fee_schemes fs
       JOIN organization_units u ON u.id=fs.unit_id
       JOIN academic_years ay ON ay.id=fs.academic_year_id
       JOIN fee_types ft ON ft.id=fs.fee_type_id
       ${where}
      ORDER BY u.unit_name, ft.name, fs.effective_start DESC`,
    params,
  ));
});

feeRouter.post('/fee-schemes', requirePermission('fee.manage'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const unitId = text(req.body?.unitId);
  const academicYearId = text(req.body?.academicYearId);
  const feeTypeId = text(req.body?.feeTypeId);
  const name = text(req.body?.name);
  const amountCents = toCents(req.body?.amount);
  const frequency = upper(req.body?.frequency) || 'MONTHLY';
  const installmentCount = Number(req.body?.installmentCount || 1);
  const effectiveStart = text(req.body?.effectiveStart);
  const effectiveEnd = nullableText(req.body?.effectiveEnd);

  if (!unitId || !academicYearId || !feeTypeId || !name) return res.status(400).json({ error: 'FEE_SCHEME_FIELDS_REQUIRED' });
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'FEE_AMOUNT_INVALID' });
  if (!FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'FEE_FREQUENCY_INVALID' });
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 12) {
    return res.status(400).json({ error: 'INSTALLMENT_COUNT_INVALID' });
  }
  if (!isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (effectiveEnd && !isDateOnly(effectiveEnd)) return res.status(400).json({ error: 'EFFECTIVE_END_INVALID' });
  if (effectiveEnd && effectiveEnd < effectiveStart) return res.status(400).json({ error: 'EFFECTIVE_RANGE_INVALID' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const unit = await one<any>('SELECT id,legal_entity_id FROM organization_units WHERE id=?', [unitId]);
  if (!unit || unit.legal_entity_id !== entityId) return res.status(400).json({ error: 'UNIT_OUTSIDE_ENTITY' });
  if (!(await one('SELECT id FROM academic_years WHERE id=? AND legal_entity_id=?', [academicYearId, entityId]))) {
    return res.status(400).json({ error: 'ACADEMIC_YEAR_OUTSIDE_ENTITY' });
  }
  if (!(await one('SELECT id FROM fee_types WHERE id=? AND legal_entity_id=?', [feeTypeId, entityId]))) {
    return res.status(400).json({ error: 'FEE_TYPE_OUTSIDE_ENTITY' });
  }
  if (await one('SELECT id FROM fee_schemes WHERE unit_id=? AND academic_year_id=? AND fee_type_id=? AND effective_start=?',
    [unitId, academicYearId, feeTypeId, effectiveStart])) {
    return res.status(409).json({ error: 'FEE_SCHEME_DUPLICATE' });
  }

  const dueDayRaw = req.body?.dueDay === undefined || req.body?.dueDay === null || req.body?.dueDay === ''
    ? null : Number(req.body.dueDay);
  if (dueDayRaw !== null && (!Number.isInteger(dueDayRaw) || dueDayRaw < 1 || dueDayRaw > 28)) {
    return res.status(400).json({ error: 'DUE_DAY_INVALID' });
  }

  const id = randomUUID();
  await exec(
    `INSERT INTO fee_schemes(id,legal_entity_id,unit_id,academic_year_id,fee_type_id,name,amount,frequency,
       installment_count,due_day,effective_start,effective_end)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, entityId, unitId, academicYearId, feeTypeId, name, fromCents(amountCents), frequency,
      installmentCount, dueDayRaw, effectiveStart, effectiveEnd],
  );
  const after = await one('SELECT * FROM fee_schemes WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: entityId, unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'FEE_SCHEME_CREATE', entityType: 'FEE_SCHEME', entityId: id, after,
  });
  res.status(201).json(after);
});

feeRouter.patch('/fee-schemes/:id', requirePermission('fee.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM fee_schemes WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'FEE_SCHEME_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, before.unit_id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const name = text(req.body?.name) || before.name;
  const amountCents = req.body?.amount === undefined ? toCents(before.amount) : toCents(req.body.amount);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return res.status(400).json({ error: 'FEE_AMOUNT_INVALID' });
  const frequency = upper(req.body?.frequency) || before.frequency;
  if (!FREQUENCIES.includes(frequency)) return res.status(400).json({ error: 'FEE_FREQUENCY_INVALID' });
  const installmentCount = req.body?.installmentCount === undefined ? before.installment_count : Number(req.body.installmentCount);
  if (!Number.isInteger(installmentCount) || installmentCount < 1 || installmentCount > 12) {
    return res.status(400).json({ error: 'INSTALLMENT_COUNT_INVALID' });
  }
  const effectiveEnd = req.body?.effectiveEnd === undefined ? before.effective_end : nullableText(req.body.effectiveEnd);
  if (effectiveEnd && effectiveEnd < before.effective_start) return res.status(400).json({ error: 'EFFECTIVE_RANGE_INVALID' });

  await exec(
    'UPDATE fee_schemes SET name=?, amount=?, frequency=?, installment_count=?, due_day=?, effective_end=?, status=? WHERE id=?',
    [name, fromCents(amountCents), frequency, installmentCount,
      req.body?.dueDay === undefined ? before.due_day : req.body?.dueDay || null,
      effectiveEnd, upper(req.body?.status) || before.status, id],
  );
  const after = await one('SELECT * FROM fee_schemes WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, unitId: before.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'FEE_SCHEME_UPDATE', entityType: 'FEE_SCHEME', entityId: id, before, after,
  });
  res.json(after);
});
