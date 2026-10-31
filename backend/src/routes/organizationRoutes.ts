import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { exec, one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { parseAuditRow, writeAudit } from '../audit.js';
import { isDateOnly, nullableText, paging, text, upper } from '../http.js';

export const organizationRouter = Router();
organizationRouter.use(requireAuth);

const UNIT_CODE_RE = /^[A-Z0-9-]{2,20}$/;

const UNIT_SELECT = `
  SELECT u.id,u.legal_entity_id,u.education_level_id,u.school_group_id,u.official_school_id,u.location_id,
         u.unit_code,u.unit_name,u.short_name,u.unit_type,u.operational_status,u.finance_status,
         u.address,u.head_user_id,u.default_academic_year_id,u.effective_start,u.effective_end,u.notes,
         u.created_at,u.updated_at,
         l.name level_name,l.code level_code,
         g.name group_name,
         s.name official_school_name,s.npsn,s.verification_status,
         loc.name location_name,
         h.full_name head_user_name,
         ay.name academic_year_name,
         (SELECT COUNT(*) FROM unit_bank_account_assignments a WHERE a.unit_id=u.id AND a.status='ACTIVE') bank_assignments
    FROM organization_units u
    JOIN education_levels l ON l.id=u.education_level_id
    LEFT JOIN school_groups g ON g.id=u.school_group_id
    LEFT JOIN official_schools s ON s.id=u.official_school_id
    LEFT JOIN school_locations loc ON loc.id=u.location_id
    LEFT JOIN users h ON h.id=u.head_user_id
    LEFT JOIN academic_years ay ON ay.id=u.default_academic_year_id
`;

async function activeEntity() {
  return one<{ id: string; code: string; name: string }>(
    "SELECT id,code,name FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1",
  );
}

function auditContext(req: any, entityId: string | null, unitId: string | null) {
  return {
    legalEntityId: entityId,
    unitId,
    userId: req.user?.id ?? null,
    ip: req.ip || null,
  };
}

/* ------------------------------------------------------------------ Hierarki */

organizationRouter.get('/hierarchy', async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const [levels, groups, schools, locations, academicYears, units] = await Promise.all([
    query('SELECT id,code,name,sort_order,status FROM education_levels WHERE legal_entity_id=? ORDER BY sort_order,code', [entity.id]),
    query('SELECT g.id,g.code,g.name,g.education_level_id,l.name level_name FROM school_groups g JOIN education_levels l ON l.id=g.education_level_id WHERE g.legal_entity_id=? ORDER BY g.name', [entity.id]),
    query('SELECT id,name,npsn,education_level_id,verification_status,status FROM official_schools WHERE legal_entity_id=? ORDER BY name', [entity.id]),
    query('SELECT id,name,city,province,status FROM school_locations WHERE legal_entity_id=? ORDER BY name', [entity.id]),
    query('SELECT id,name,start_date,end_date,status FROM academic_years WHERE legal_entity_id=? ORDER BY name DESC', [entity.id]),
    query(`SELECT u.id,u.unit_code,u.unit_name,u.operational_status,u.finance_status,u.education_level_id,l.name level_name
             FROM organization_units u JOIN education_levels l ON l.id=u.education_level_id
            WHERE u.legal_entity_id=? ORDER BY u.unit_name`, [entity.id]),
  ]);

  res.json({ legalEntity: entity, levels, groups, schools, locations, academicYears, units });
});

/* ------------------------------------------------------------------ Badan hukum */

organizationRouter.get('/legal-entity', async (_req, res) => {
  const entity = await one('SELECT id,code,name,npsn,address,phone,email,status,updated_at FROM legal_entities ORDER BY created_at LIMIT 1');
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  res.json(entity);
});

organizationRouter.put('/legal-entity', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const name = text(req.body?.name);
  const code = upper(req.body?.code);
  if (!name || !code) return res.status(400).json({ error: 'ENTITY_NAME_CODE_REQUIRED' });

  const before = await one('SELECT * FROM legal_entities WHERE id=?', [entity.id]);
  await exec('UPDATE legal_entities SET code=?, name=?, npsn=?, address=?, phone=?, email=? WHERE id=?', [
    code, name, nullableText(req.body?.npsn), nullableText(req.body?.address),
    nullableText(req.body?.phone), nullableText(req.body?.email), entity.id,
  ]);
  const after = await one('SELECT * FROM legal_entities WHERE id=?', [entity.id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'ENTITY_UPDATE', entityType: 'LEGAL_ENTITY', entityId: entity.id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Jenjang */

organizationRouter.get('/education-levels', async (_req, res) => {
  res.json(await query('SELECT id,code,name,sort_order,status FROM education_levels ORDER BY sort_order,code'));
});

organizationRouter.post('/education-levels', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  if (!code || !name) return res.status(400).json({ error: 'LEVEL_CODE_NAME_REQUIRED' });
  if (await one('SELECT id FROM education_levels WHERE legal_entity_id=? AND code=?', [entity.id, code])) {
    return res.status(409).json({ error: 'LEVEL_CODE_DUPLICATE' });
  }
  const id = randomUUID();
  await exec('INSERT INTO education_levels(id,legal_entity_id,code,name,sort_order) VALUES(?,?,?,?,?)', [
    id, entity.id, code, name, Number(req.body?.sortOrder || 0),
  ]);
  const after = await one('SELECT * FROM education_levels WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'LEVEL_CREATE', entityType: 'EDUCATION_LEVEL', entityId: id, after });
  res.status(201).json(after);
});

organizationRouter.put('/education-levels/:id', requirePermission('entity.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM education_levels WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'LEVEL_NOT_FOUND' });
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  if (!code || !name) return res.status(400).json({ error: 'LEVEL_CODE_NAME_REQUIRED' });
  const duplicate = await one('SELECT id FROM education_levels WHERE legal_entity_id=? AND code=? AND id<>?', [before.legal_entity_id, code, id]);
  if (duplicate) return res.status(409).json({ error: 'LEVEL_CODE_DUPLICATE' });
  await exec('UPDATE education_levels SET code=?, name=?, sort_order=?, status=? WHERE id=?', [
    code, name, Number(req.body?.sortOrder || 0), upper(req.body?.status) || before.status, id,
  ]);
  const after = await one('SELECT * FROM education_levels WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id, null), action: 'LEVEL_UPDATE', entityType: 'EDUCATION_LEVEL', entityId: id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Kelompok sekolah */

organizationRouter.get('/school-groups', async (_req, res) => {
  res.json(await query(
    `SELECT g.id,g.code,g.name,g.education_level_id,l.name level_name,g.status
       FROM school_groups g JOIN education_levels l ON l.id=g.education_level_id ORDER BY g.name`,
  ));
});

organizationRouter.post('/school-groups', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const levelId = text(req.body?.educationLevelId);
  if (!code || !name || !levelId) return res.status(400).json({ error: 'GROUP_FIELDS_REQUIRED' });
  if (!(await one('SELECT id FROM education_levels WHERE id=? AND legal_entity_id=?', [levelId, entity.id]))) {
    return res.status(400).json({ error: 'LEVEL_OUTSIDE_ENTITY' });
  }
  if (await one('SELECT id FROM school_groups WHERE legal_entity_id=? AND code=?', [entity.id, code])) {
    return res.status(409).json({ error: 'GROUP_CODE_DUPLICATE' });
  }
  const id = randomUUID();
  await exec('INSERT INTO school_groups(id,legal_entity_id,education_level_id,code,name) VALUES(?,?,?,?,?)', [
    id, entity.id, levelId, code, name,
  ]);
  const after = await one('SELECT * FROM school_groups WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'GROUP_CREATE', entityType: 'SCHOOL_GROUP', entityId: id, after });
  res.status(201).json(after);
});

organizationRouter.put('/school-groups/:id', requirePermission('entity.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM school_groups WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'GROUP_NOT_FOUND' });
  const code = upper(req.body?.code);
  const name = text(req.body?.name);
  const levelId = text(req.body?.educationLevelId);
  if (!code || !name || !levelId) return res.status(400).json({ error: 'GROUP_FIELDS_REQUIRED' });
  if (!(await one('SELECT id FROM education_levels WHERE id=? AND legal_entity_id=?', [levelId, before.legal_entity_id]))) {
    return res.status(400).json({ error: 'LEVEL_OUTSIDE_ENTITY' });
  }
  await exec('UPDATE school_groups SET code=?, name=?, education_level_id=?, status=? WHERE id=?', [
    code, name, levelId, upper(req.body?.status) || before.status, id,
  ]);
  const after = await one('SELECT * FROM school_groups WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id, null), action: 'GROUP_UPDATE', entityType: 'SCHOOL_GROUP', entityId: id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Sekolah resmi */

organizationRouter.get('/official-schools', async (_req, res) => {
  res.json(await query(
    `SELECT s.id,s.name,s.npsn,s.education_level_id,l.name level_name,s.verification_status,s.government_reference,s.status
       FROM official_schools s JOIN education_levels l ON l.id=s.education_level_id ORDER BY s.name`,
  ));
});

organizationRouter.post('/official-schools', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const name = text(req.body?.name);
  const levelId = text(req.body?.educationLevelId);
  const npsn = nullableText(req.body?.npsn);
  if (!name || !levelId) return res.status(400).json({ error: 'SCHOOL_FIELDS_REQUIRED' });
  if (npsn && !/^[A-Za-z0-9]{8}$/.test(npsn)) return res.status(400).json({ error: 'NPSN_INVALID' });
  if (!(await one('SELECT id FROM education_levels WHERE id=? AND legal_entity_id=?', [levelId, entity.id]))) {
    return res.status(400).json({ error: 'LEVEL_OUTSIDE_ENTITY' });
  }
  if (npsn && await one('SELECT id FROM official_schools WHERE npsn=?', [npsn])) {
    return res.status(409).json({ error: 'NPSN_DUPLICATE' });
  }
  const id = randomUUID();
  await exec('INSERT INTO official_schools(id,legal_entity_id,education_level_id,name,npsn,government_reference) VALUES(?,?,?,?,?,?)', [
    id, entity.id, levelId, name, npsn, nullableText(req.body?.governmentReference),
  ]);
  const after = await one('SELECT * FROM official_schools WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'SCHOOL_CREATE', entityType: 'OFFICIAL_SCHOOL', entityId: id, after });
  res.status(201).json(after);
});

organizationRouter.put('/official-schools/:id', requirePermission('entity.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM official_schools WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'SCHOOL_NOT_FOUND' });
  const name = text(req.body?.name);
  const levelId = text(req.body?.educationLevelId);
  const npsn = nullableText(req.body?.npsn);
  const verification = upper(req.body?.verificationStatus) || before.verification_status;
  if (!name || !levelId) return res.status(400).json({ error: 'SCHOOL_FIELDS_REQUIRED' });
  if (!['UNVERIFIED', 'VERIFIED'].includes(verification)) return res.status(400).json({ error: 'VERIFICATION_STATUS_INVALID' });
  if (npsn && !/^[A-Za-z0-9]{8}$/.test(npsn)) return res.status(400).json({ error: 'NPSN_INVALID' });
  if (npsn && await one('SELECT id FROM official_schools WHERE npsn=? AND id<>?', [npsn, id])) {
    return res.status(409).json({ error: 'NPSN_DUPLICATE' });
  }
  await exec(
    'UPDATE official_schools SET name=?, education_level_id=?, npsn=?, verification_status=?, government_reference=?, status=? WHERE id=?',
    [name, levelId, npsn, verification, nullableText(req.body?.governmentReference), upper(req.body?.status) || before.status, id],
  );
  const after = await one('SELECT * FROM official_schools WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id, null), action: 'SCHOOL_UPDATE', entityType: 'OFFICIAL_SCHOOL', entityId: id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Lokasi */

organizationRouter.get('/locations', async (_req, res) => {
  res.json(await query(
    'SELECT id,name,address,province,city,district,postal_code,phone,status FROM school_locations ORDER BY name',
  ));
});

organizationRouter.post('/locations', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const name = text(req.body?.name);
  if (!name) return res.status(400).json({ error: 'LOCATION_NAME_REQUIRED' });
  const province = nullableText(req.body?.province);
  const city = nullableText(req.body?.city);
  if (province && !city) return res.status(400).json({ error: 'LOCATION_REGION_INCOMPLETE' });
  const postal = nullableText(req.body?.postalCode);
  if (postal && !/^\d{5}$/.test(postal)) return res.status(400).json({ error: 'POSTAL_CODE_INVALID' });

  const id = randomUUID();
  await exec(
    'INSERT INTO school_locations(id,legal_entity_id,name,address,province,city,district,postal_code,phone) VALUES(?,?,?,?,?,?,?,?,?)',
    [id, entity.id, name, nullableText(req.body?.address), province, city,
      nullableText(req.body?.district), postal, nullableText(req.body?.phone)],
  );
  const after = await one('SELECT * FROM school_locations WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'LOCATION_CREATE', entityType: 'SCHOOL_LOCATION', entityId: id, after });
  res.status(201).json(after);
});

organizationRouter.put('/locations/:id', requirePermission('entity.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM school_locations WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'LOCATION_NOT_FOUND' });
  const name = text(req.body?.name);
  if (!name) return res.status(400).json({ error: 'LOCATION_NAME_REQUIRED' });
  const province = nullableText(req.body?.province);
  const city = nullableText(req.body?.city);
  if (province && !city) return res.status(400).json({ error: 'LOCATION_REGION_INCOMPLETE' });
  const postal = nullableText(req.body?.postalCode);
  if (postal && !/^\d{5}$/.test(postal)) return res.status(400).json({ error: 'POSTAL_CODE_INVALID' });

  await exec(
    'UPDATE school_locations SET name=?, address=?, province=?, city=?, district=?, postal_code=?, phone=?, status=? WHERE id=?',
    [name, nullableText(req.body?.address), province, city, nullableText(req.body?.district), postal,
      nullableText(req.body?.phone), upper(req.body?.status) || before.status, id],
  );
  const after = await one('SELECT * FROM school_locations WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id, null), action: 'LOCATION_UPDATE', entityType: 'SCHOOL_LOCATION', entityId: id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Tahun ajaran */

organizationRouter.get('/academic-years', async (_req, res) => {
  res.json(await query('SELECT id,name,start_date,end_date,status FROM academic_years ORDER BY name DESC'));
});

organizationRouter.post('/academic-years', requirePermission('entity.manage'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });
  const name = text(req.body?.name);
  const start = text(req.body?.startDate);
  const end = text(req.body?.endDate);
  if (!name || !isDateOnly(start) || !isDateOnly(end)) return res.status(400).json({ error: 'ACADEMIC_YEAR_FIELDS_REQUIRED' });
  if (end < start) return res.status(400).json({ error: 'ACADEMIC_YEAR_RANGE_INVALID' });
  const id = randomUUID();
  await exec('INSERT INTO academic_years(id,legal_entity_id,name,start_date,end_date) VALUES(?,?,?,?,?)', [id, entity.id, name, start, end]);
  const after = await one('SELECT * FROM academic_years WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, entity.id, null), action: 'ACADEMIC_YEAR_CREATE', entityType: 'ACADEMIC_YEAR', entityId: id, after });
  res.status(201).json(after);
});

/* ------------------------------------------------------------------ Kesiapan keuangan */

async function computeReadiness(unitId: string) {
  const unit = await one<any>(`${UNIT_SELECT} WHERE u.id=?`, [unitId]);
  if (!unit) return null;
  const settings = await one<any>('SELECT * FROM unit_finance_settings WHERE unit_id=?', [unitId]);
  const assignments = await query<any>(
    `SELECT a.id,a.usage_type,a.status,a.effective_start,a.effective_end,
            b.account_usage,b.bank_name,b.account_number,b.status bank_status,b.verified_at
       FROM unit_bank_account_assignments a
       JOIN bank_accounts b ON b.id=a.bank_account_id
      WHERE a.unit_id=? AND a.status='ACTIVE'`,
    [unitId],
  );

  const mode = settings?.account_mode || 'MIXED';
  const usable = (usage: string) => assignments.filter(a =>
    a.account_usage === usage && a.bank_status === 'ACTIVE' && Boolean(a.verified_at));

  const checks: { field: string; label: string; ok: boolean; required: boolean }[] = [
    { field: 'official_school', label: 'Sekolah resmi terhubung', ok: Boolean(unit.official_school_id), required: true },
    { field: 'location', label: 'Lokasi operasional terhubung', ok: Boolean(unit.location_id), required: true },
    { field: 'effective_start', label: 'Tanggal mulai efektif', ok: Boolean(unit.effective_start), required: true },
    { field: 'receivable_account_id', label: 'Mapping akun piutang', ok: Boolean(settings?.receivable_account_code), required: true },
    { field: 'revenue_account_id', label: 'Mapping akun pendapatan', ok: Boolean(settings?.revenue_account_code), required: true },
  ];
  if (mode !== 'DEDICATED_ONLY') {
    checks.push({ field: 'central_bank_account', label: 'Rekening pusat aktif & terverifikasi', ok: usable('CENTRAL').length > 0, required: true });
  }
  if (mode !== 'CENTRAL_ONLY') {
    checks.push({ field: 'dedicated_bank_account', label: 'Rekening khusus aktif & terverifikasi', ok: usable('DEDICATED').length > 0, required: true });
  }

  const missing = checks.filter(check => check.required && !check.ok);
  return {
    unitId,
    unitCode: unit.unit_code,
    unitName: unit.unit_name,
    accountMode: mode,
    status: missing.length ? 'NOT_CONFIGURED' : 'READY',
    checks,
    missingFields: missing.map(check => ({ field: check.field, message: `Belum diisi: ${check.label}` })),
  };
}

async function refreshFinanceStatus(unitId: string) {
  const readiness = await computeReadiness(unitId);
  if (!readiness) return null;
  await exec('UPDATE organization_units SET finance_status=? WHERE id=?', [readiness.status, unitId]);
  return readiness;
}

/* ------------------------------------------------------------------ Unit */

organizationRouter.get('/units', async (req, res) => {
  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const levelId = text(req.query.levelId);
  const status = upper(req.query.status);
  const search = text(req.query.q);

  const allowed = await allowedUnitIds(req.user!);
  if (allowed !== null && allowed.length === 0) {
    return res.json({ rows: [], total: 0, page: 1, pageSize });
  }

  const conditions: string[] = ['u.legal_entity_id=?'];
  const params: any[] = [(await activeEntity())?.id || ''];
  if (allowed !== null) {
    conditions.push('u.id IN (?)');
    params.push(allowed);
  }
  if (levelId) {
    conditions.push('u.education_level_id=?');
    params.push(levelId);
  }
  if (status) {
    conditions.push('u.operational_status=?');
    params.push(status);
  }
  if (search) {
    conditions.push('(u.unit_name LIKE ? OR u.unit_code LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query(
    `${UNIT_SELECT} ${where} ORDER BY u.unit_name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM organization_units u ${where}`, params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

organizationRouter.post('/units', requirePermission('unit.create'), async (req, res) => {
  const entity = await activeEntity();
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const unitCode = upper(req.body?.unitCode);
  const unitName = text(req.body?.unitName);
  const levelId = text(req.body?.educationLevelId);
  if (!UNIT_CODE_RE.test(unitCode)) return res.status(400).json({ error: 'UNIT_CODE_INVALID' });
  if (unitName.length < 3 || unitName.length > 150) return res.status(400).json({ error: 'UNIT_NAME_INVALID' });
  if (!levelId) return res.status(400).json({ error: 'UNIT_LEVEL_REQUIRED' });

  const level = await one<any>('SELECT id,status FROM education_levels WHERE id=? AND legal_entity_id=?', [levelId, entity.id]);
  if (!level) return res.status(400).json({ error: 'LEVEL_OUTSIDE_ENTITY' });
  if (level.status !== 'ACTIVE') return res.status(400).json({ error: 'LEVEL_INACTIVE' });

  const groupId = nullableText(req.body?.schoolGroupId);
  const schoolId = nullableText(req.body?.officialSchoolId);
  const locationId = nullableText(req.body?.locationId);
  const headUserId = nullableText(req.body?.headUserId);
  const academicYearId = nullableText(req.body?.defaultAcademicYearId);

  for (const [table, id, label] of [
    ['school_groups', groupId, 'GROUP_OUTSIDE_ENTITY'],
    ['official_schools', schoolId, 'SCHOOL_OUTSIDE_ENTITY'],
    ['school_locations', locationId, 'LOCATION_OUTSIDE_ENTITY'],
    ['academic_years', academicYearId, 'ACADEMIC_YEAR_OUTSIDE_ENTITY'],
  ] as [string, string | null, string][]) {
    if (id && !(await one(`SELECT id FROM ${table} WHERE id=? AND legal_entity_id=?`, [id, entity.id]))) {
      return res.status(400).json({ error: label });
    }
  }
  if (headUserId && !(await one('SELECT id FROM users WHERE id=?', [headUserId]))) {
    return res.status(400).json({ error: 'HEAD_USER_NOT_FOUND' });
  }
  if (await one('SELECT id FROM organization_units WHERE legal_entity_id=? AND unit_code=?', [entity.id, unitCode])) {
    return res.status(409).json({ error: 'UNIT_CODE_DUPLICATE' });
  }

  const effectiveStart = nullableText(req.body?.effectiveStart);
  const effectiveEnd = nullableText(req.body?.effectiveEnd);
  if (effectiveStart && !isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (effectiveEnd && !isDateOnly(effectiveEnd)) return res.status(400).json({ error: 'EFFECTIVE_END_INVALID' });
  if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
    return res.status(400).json({ error: 'EFFECTIVE_RANGE_INVALID' });
  }

  const id = randomUUID();
  const unitType = upper(req.body?.unitType) || 'SCHOOL_BRANCH';
  if (!['HEAD_OFFICE', 'SCHOOL_BRANCH'].includes(unitType)) return res.status(400).json({ error: 'UNIT_TYPE_INVALID' });

  await exec(
    `INSERT INTO organization_units(
       id,legal_entity_id,education_level_id,school_group_id,official_school_id,location_id,
       unit_code,unit_name,short_name,unit_type,address,head_user_id,default_academic_year_id,
       effective_start,effective_end,notes)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, entity.id, levelId, groupId, schoolId, locationId, unitCode, unitName,
      nullableText(req.body?.shortName), unitType, nullableText(req.body?.address), headUserId,
      academicYearId, effectiveStart, effectiveEnd, nullableText(req.body?.notes)],
  );
  await exec('INSERT INTO unit_finance_settings(unit_id,account_mode) VALUES(?,?)', [
    id, upper(req.body?.accountMode) || 'MIXED',
  ]);

  const after = await one<any>(`${UNIT_SELECT} WHERE u.id=?`, [id]);
  await writeAudit({ ...auditContext(req, entity.id, id), action: 'UNIT_CREATE', entityType: 'ORGANIZATION_UNIT', entityId: id, after });
  res.status(201).json(after);
});

organizationRouter.get('/units/:id', async (req, res) => {
  const id = text(req.params.id);
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const unit = await one<any>(`${UNIT_SELECT} WHERE u.id=?`, [id]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });

  const [settings, assignments, readiness, logs] = await Promise.all([
    one('SELECT * FROM unit_finance_settings WHERE unit_id=?', [id]),
    query(
      `SELECT a.id,a.usage_type,a.allow_receipt,a.allow_disbursement,a.is_default_receipt,a.is_default_disbursement,
              a.effective_start,a.effective_end,a.status,
              b.id bank_account_id,b.bank_name,b.account_number,b.account_holder,b.account_usage,b.status bank_status,b.verified_at
         FROM unit_bank_account_assignments a JOIN bank_accounts b ON b.id=a.bank_account_id
        WHERE a.unit_id=? ORDER BY a.created_at DESC`,
      [id],
    ),
    computeReadiness(id),
    query(
      `SELECT id,action,entity_type,entity_id,before_data,after_data,reason,created_at,user_id
         FROM audit_logs WHERE entity_type='ORGANIZATION_UNIT' AND entity_id=? ORDER BY created_at DESC LIMIT 20`,
      [id],
    ),
  ]);

  res.json({ ...unit, settings, assignments, readiness, auditLogs: logs.map(parseAuditRow) });
});

organizationRouter.patch('/units/:id', requirePermission('unit.edit'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM organization_units WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const unitName = text(req.body?.unitName ?? before.unit_name);
  const levelId = text(req.body?.educationLevelId ?? before.education_level_id);
  if (unitName.length < 3 || unitName.length > 150) return res.status(400).json({ error: 'UNIT_NAME_INVALID' });
  if (!(await one('SELECT id FROM education_levels WHERE id=? AND legal_entity_id=?', [levelId, before.legal_entity_id]))) {
    return res.status(400).json({ error: 'LEVEL_OUTSIDE_ENTITY' });
  }

  const groupId = req.body?.schoolGroupId === undefined ? before.school_group_id : nullableText(req.body.schoolGroupId);
  const schoolId = req.body?.officialSchoolId === undefined ? before.official_school_id : nullableText(req.body.officialSchoolId);
  const locationId = req.body?.locationId === undefined ? before.location_id : nullableText(req.body.locationId);
  const academicYearId = req.body?.defaultAcademicYearId === undefined ? before.default_academic_year_id : nullableText(req.body.defaultAcademicYearId);
  const headUserId = req.body?.headUserId === undefined ? before.head_user_id : nullableText(req.body.headUserId);

  for (const [table, ref, label] of [
    ['school_groups', groupId, 'GROUP_OUTSIDE_ENTITY'],
    ['official_schools', schoolId, 'SCHOOL_OUTSIDE_ENTITY'],
    ['school_locations', locationId, 'LOCATION_OUTSIDE_ENTITY'],
    ['academic_years', academicYearId, 'ACADEMIC_YEAR_OUTSIDE_ENTITY'],
  ] as [string, string | null, string][]) {
    if (ref && !(await one(`SELECT id FROM ${table} WHERE id=? AND legal_entity_id=?`, [ref, before.legal_entity_id]))) {
      return res.status(400).json({ error: label });
    }
  }
  if (headUserId && !(await one('SELECT id FROM users WHERE id=?', [headUserId]))) {
    return res.status(400).json({ error: 'HEAD_USER_NOT_FOUND' });
  }

  const effectiveStart = req.body?.effectiveStart === undefined ? before.effective_start : nullableText(req.body.effectiveStart);
  const effectiveEnd = req.body?.effectiveEnd === undefined ? before.effective_end : nullableText(req.body.effectiveEnd);
  if (effectiveStart && !isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (effectiveEnd && !isDateOnly(effectiveEnd)) return res.status(400).json({ error: 'EFFECTIVE_END_INVALID' });
  if (effectiveStart && effectiveEnd && effectiveEnd < effectiveStart) {
    return res.status(400).json({ error: 'EFFECTIVE_RANGE_INVALID' });
  }

  await exec(
    `UPDATE organization_units SET education_level_id=?, school_group_id=?, official_school_id=?, location_id=?,
            unit_name=?, short_name=?, unit_type=?, address=?, head_user_id=?, default_academic_year_id=?,
            effective_start=?, effective_end=?, notes=?
      WHERE id=?`,
    [levelId, groupId, schoolId, locationId, unitName, nullableText(req.body?.shortName ?? before.short_name),
      upper(req.body?.unitType) || before.unit_type, nullableText(req.body?.address ?? before.address),
      headUserId, academicYearId, effectiveStart, effectiveEnd,
      nullableText(req.body?.notes ?? before.notes), id],
  );
  const after = await one('SELECT * FROM organization_units WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id, id), action: 'UNIT_UPDATE', entityType: 'ORGANIZATION_UNIT', entityId: id, before, after });
  res.json(after);
});

organizationRouter.post('/units/:id/activate', requirePermission('unit.activate'), async (req, res) => {
  const id = text(req.params.id);
  const unit = await one<any>(`${UNIT_SELECT} WHERE u.id=?`, [id]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const errors: { field: string; message: string }[] = [];
  if (!unit.official_school_id) errors.push({ field: 'official_school_id', message: 'Sekolah resmi belum dipilih' });
  if (!unit.location_id) errors.push({ field: 'location_id', message: 'Lokasi belum dipilih' });
  if (!unit.effective_start) errors.push({ field: 'effective_start', message: 'Tanggal mulai efektif belum diisi' });
  if (!unit.address) errors.push({ field: 'address', message: 'Alamat unit belum diisi' });
  if (unit.effective_end && unit.effective_start && unit.effective_end < unit.effective_start) {
    errors.push({ field: 'effective_end', message: 'Tanggal berakhir sebelum tanggal mulai' });
  }

  if (unit.official_school_id) {
    const school = await one<any>('SELECT id,education_level_id,status FROM official_schools WHERE id=?', [unit.official_school_id]);
    if (!school) errors.push({ field: 'official_school_id', message: 'Sekolah resmi tidak ditemukan' });
    else {
      if (school.status !== 'ACTIVE') errors.push({ field: 'official_school_id', message: 'Sekolah resmi tidak aktif' });
      if (school.education_level_id !== unit.education_level_id) {
        errors.push({ field: 'official_school_id', message: 'Jenjang sekolah resmi tidak sesuai jenjang unit' });
      }
    }
  }
  if (unit.location_id) {
    const location = await one<any>('SELECT id,status FROM school_locations WHERE id=?', [unit.location_id]);
    if (!location || location.status !== 'ACTIVE') errors.push({ field: 'location_id', message: 'Lokasi tidak aktif' });
  }
  if (unit.level_code && !unit.level_name) errors.push({ field: 'education_level_id', message: 'Jenjang unit tidak valid' });

  if (errors.length) {
    return res.status(400).json({ error: 'UNIT_ACTIVATION_INCOMPLETE', unit_code: unit.unit_code, errors });
  }

  const before = await one('SELECT * FROM organization_units WHERE id=?', [id]);
  await exec("UPDATE organization_units SET operational_status='ACTIVE' WHERE id=?", [id]);
  const readiness = await refreshFinanceStatus(id);
  const after = await one('SELECT * FROM organization_units WHERE id=?', [id]);
  await writeAudit({
    ...auditContext(req, unit.legal_entity_id, id),
    action: 'UNIT_ACTIVATE', entityType: 'ORGANIZATION_UNIT', entityId: id, before, after,
    reason: text(req.body?.reason) || null,
  });
  res.json({ ok: true, unit: after, readiness });
});

organizationRouter.post('/units/:id/deactivate', requirePermission('unit.deactivate'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM organization_units WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'DEACTIVATE_REASON_REQUIRED' });

  await exec("UPDATE organization_units SET operational_status='INACTIVE' WHERE id=?", [id]);
  const after = await one('SELECT * FROM organization_units WHERE id=?', [id]);
  await writeAudit({
    ...auditContext(req, before.legal_entity_id, id),
    action: 'UNIT_DEACTIVATE', entityType: 'ORGANIZATION_UNIT', entityId: id, before, after, reason,
  });
  res.json({ ok: true, unit: after });
});

organizationRouter.get('/units/:id/readiness', async (req, res) => {
  const id = text(req.params.id);
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const readiness = await computeReadiness(id);
  if (!readiness) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  const ok = readiness.status === 'READY';
  res.status(ok ? 200 : 200).json({ success: ok, code: ok ? 'UNIT_FINANCE_READY' : 'UNIT_FINANCE_NOT_READY', ...readiness });
});

organizationRouter.put('/units/:id/finance-settings', requirePermission('unit.finance'), async (req, res) => {
  const id = text(req.params.id);
  const unit = await one<any>('SELECT id,legal_entity_id FROM organization_units WHERE id=?', [id]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, id))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const mode = upper(req.body?.accountMode) || 'MIXED';
  if (!['CENTRAL_ONLY', 'DEDICATED_ONLY', 'MIXED'].includes(mode)) {
    return res.status(400).json({ error: 'ACCOUNT_MODE_INVALID' });
  }
  const before = await one('SELECT * FROM unit_finance_settings WHERE unit_id=?', [id]);
  await exec(
    `INSERT INTO unit_finance_settings(unit_id,account_mode,receivable_account_code,cash_account_code,revenue_account_code,updated_by)
     VALUES(?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE account_mode=VALUES(account_mode), receivable_account_code=VALUES(receivable_account_code),
                             cash_account_code=VALUES(cash_account_code), revenue_account_code=VALUES(revenue_account_code),
                             updated_by=VALUES(updated_by)`,
    [id, mode, nullableText(req.body?.receivableAccountCode), nullableText(req.body?.cashAccountCode),
      nullableText(req.body?.revenueAccountCode), req.user!.id],
  );
  const readiness = await refreshFinanceStatus(id);
  const after = await one('SELECT * FROM unit_finance_settings WHERE unit_id=?', [id]);
  await writeAudit({
    ...auditContext(req, unit.legal_entity_id, id),
    action: 'UNIT_FINANCE_SETTINGS_UPDATE', entityType: 'ORGANIZATION_UNIT', entityId: id, before, after,
  });
  res.json({ ok: true, settings: after, readiness });
});

/* ------------------------------------------------------------------ Assignment rekening */

organizationRouter.post('/units/:id/bank-assignments', requirePermission('bank.assign'), async (req, res) => {
  const unitId = text(req.params.id);
  const unit = await one<any>('SELECT id,legal_entity_id FROM organization_units WHERE id=?', [unitId]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const bankAccountId = text(req.body?.bankAccountId);
  const usageType = upper(req.body?.usageType) || 'CENTRAL_SHARED';
  if (!bankAccountId) return res.status(400).json({ error: 'BANK_ACCOUNT_REQUIRED' });
  if (!['CENTRAL_SHARED', 'UNIT_DEDICATED'].includes(usageType)) return res.status(400).json({ error: 'USAGE_TYPE_INVALID' });

  const account = await one<any>('SELECT * FROM bank_accounts WHERE id=? AND legal_entity_id=?', [bankAccountId, unit.legal_entity_id]);
  if (!account) return res.status(403).json({ error: 'BANK_ACCOUNT_NOT_ALLOWED' });
  if (account.status !== 'ACTIVE' || !account.verified_at) return res.status(400).json({ error: 'BANK_ACCOUNT_NOT_READY' });
  if (usageType === 'CENTRAL_SHARED' && account.account_usage !== 'CENTRAL') {
    return res.status(400).json({ error: 'BANK_ACCOUNT_USAGE_MISMATCH' });
  }
  if (usageType === 'UNIT_DEDICATED' && account.account_usage !== 'DEDICATED') {
    return res.status(400).json({ error: 'BANK_ACCOUNT_USAGE_MISMATCH' });
  }

  const effectiveStart = text(req.body?.effectiveStart) || new Date().toISOString().slice(0, 10);
  const effectiveEnd = nullableText(req.body?.effectiveEnd);
  if (!isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (effectiveEnd && !isDateOnly(effectiveEnd)) return res.status(400).json({ error: 'EFFECTIVE_END_INVALID' });
  if (effectiveEnd && effectiveEnd < effectiveStart) return res.status(400).json({ error: 'EFFECTIVE_RANGE_INVALID' });

  // BANK-02: rekening khusus tidak boleh dipakai unit lain pada periode yang tumpang tindih.
  if (usageType === 'UNIT_DEDICATED') {
    const conflict = await one(
      `SELECT a.id FROM unit_bank_account_assignments a
        WHERE a.bank_account_id=? AND a.unit_id<>? AND a.status='ACTIVE'
          AND a.effective_start <= COALESCE(?, '9999-12-31')
          AND COALESCE(a.effective_end, '9999-12-31') >= ?
        LIMIT 1`,
      [bankAccountId, unitId, effectiveEnd, effectiveStart],
    );
    if (conflict) return res.status(409).json({ error: 'BANK_ACCOUNT_DEDICATED_CONFLICT' });
  }

  const wantsDefaultReceipt = Boolean(req.body?.isDefaultReceipt);
  const wantsDefaultDisbursement = Boolean(req.body?.isDefaultDisbursement);
  if (wantsDefaultReceipt || wantsDefaultDisbursement) {
    const defaults = await query<any>(
      `SELECT id,is_default_receipt,is_default_disbursement FROM unit_bank_account_assignments
        WHERE unit_id=? AND status='ACTIVE'
          AND (is_default_receipt=1 OR is_default_disbursement=1)
          AND effective_start <= COALESCE(?, '9999-12-31')
          AND COALESCE(effective_end, '9999-12-31') >= ?`,
      [unitId, effectiveEnd, effectiveStart],
    );
    for (const row of defaults) {
      if (wantsDefaultReceipt && row.is_default_receipt) return res.status(409).json({ error: 'DEFAULT_RECEIPT_DUPLICATE' });
      if (wantsDefaultDisbursement && row.is_default_disbursement) return res.status(409).json({ error: 'DEFAULT_DISBURSEMENT_DUPLICATE' });
    }
  }

  const id = randomUUID();
  await exec(
    `INSERT INTO unit_bank_account_assignments(
       id,unit_id,bank_account_id,usage_type,allow_receipt,allow_disbursement,
       is_default_receipt,is_default_disbursement,effective_start,effective_end)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id, unitId, bankAccountId, usageType, req.body?.allowReceipt === false ? 0 : 1,
      req.body?.allowDisbursement === false ? 0 : 1, wantsDefaultReceipt ? 1 : 0,
      wantsDefaultDisbursement ? 1 : 0, effectiveStart, effectiveEnd],
  );
  const after = await one('SELECT * FROM unit_bank_account_assignments WHERE id=?', [id]);
  await writeAudit({
    ...auditContext(req, unit.legal_entity_id, unitId),
    action: 'UNIT_BANK_ASSIGNMENT_CREATE', entityType: 'UNIT_BANK_ASSIGNMENT', entityId: id,
    after: { ...after, bank_name: account.bank_name, account_number: account.account_number },
  });
  const readiness = await refreshFinanceStatus(unitId);
  res.status(201).json({ ok: true, assignment: after, readiness });
});

organizationRouter.delete('/units/:id/bank-assignments/:assignmentId', requirePermission('bank.assign'), async (req, res) => {
  const unitId = text(req.params.id);
  const assignmentId = text(req.params.assignmentId);
  const unit = await one<any>('SELECT id,legal_entity_id FROM organization_units WHERE id=?', [unitId]);
  if (!unit) return res.status(404).json({ error: 'UNIT_NOT_FOUND' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const before = await one<any>('SELECT * FROM unit_bank_account_assignments WHERE id=? AND unit_id=?', [assignmentId, unitId]);
  if (!before) return res.status(404).json({ error: 'ASSIGNMENT_NOT_FOUND' });
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'DEACTIVATE_REASON_REQUIRED' });

  await exec("UPDATE unit_bank_account_assignments SET status='INACTIVE' WHERE id=?", [assignmentId]);
  await writeAudit({
    ...auditContext(req, unit.legal_entity_id, unitId),
    action: 'UNIT_BANK_ASSIGNMENT_DEACTIVATE', entityType: 'UNIT_BANK_ASSIGNMENT', entityId: assignmentId, before, reason,
  });
  const readiness = await refreshFinanceStatus(unitId);
  res.json({ ok: true, readiness });
});

organizationRouter.get('/units/:id/audit-logs', async (req, res) => {
  const unitId = text(req.params.id);
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  const rows = await query(
    `SELECT id,action,entity_type,entity_id,before_data,after_data,reason,created_at,user_id
       FROM audit_logs WHERE unit_id=? ORDER BY created_at DESC LIMIT 100`, [unitId],
  );
  res.json(rows.map(parseAuditRow));
});
