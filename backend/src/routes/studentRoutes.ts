import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { exec, one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds, canAccessUnit, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { addDays, isDateOnly, nullableText, paging, text, upper } from '../http.js';

export const studentRouter = Router();
studentRouter.use(requireAuth);

async function activeEntityId(): Promise<string | null> {
  const entity = await one<{ id: string }>("SELECT id FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  return entity?.id || null;
}

async function currentEnrollment(studentId: string) {
  return one<any>(
    `SELECT e.*,u.unit_code,u.unit_name FROM student_enrollments e
       JOIN organization_units u ON u.id=e.unit_id
      WHERE e.student_id=? AND e.status='ACTIVE' ORDER BY e.effective_start DESC LIMIT 1`,
    [studentId],
  );
}

studentRouter.get('/students', requirePermission('student.view'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const { pageSize, offset } = paging(req.query.page, req.query.pageSize);
  const search = text(req.query.q);
  const unitId = text(req.query.unitId);
  const allowed = await allowedUnitIds(req.user!);

  const conditions: string[] = ['s.legal_entity_id=?'];
  const params: any[] = [entityId];
  if (allowed !== null) {
    if (allowed.length === 0) conditions.push('1=0');
    else { conditions.push('e.unit_id IN (?)'); params.push(allowed); }
  }
  if (unitId) {
    if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
    conditions.push('e.unit_id=?');
    params.push(unitId);
  }
  if (search) {
    conditions.push('(s.full_name LIKE ? OR s.nis LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query(
    `SELECT s.id,s.nis,s.nisn,s.full_name,s.gender,s.guardian_name,s.guardian_phone,s.status,
            e.id enrollment_id,e.unit_id,u.unit_code,u.unit_name,e.academic_year_id,ay.name academic_year_name,
            e.class_label,e.effective_start
       FROM students s
       JOIN student_enrollments e ON e.student_id=s.id AND e.status='ACTIVE'
       JOIN organization_units u ON u.id=e.unit_id
       JOIN academic_years ay ON ay.id=e.academic_year_id
       ${where}
      ORDER BY s.full_name
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await one<{ total: number }>(
    `SELECT COUNT(*) total FROM students s
       JOIN student_enrollments e ON e.student_id=s.id AND e.status='ACTIVE' ${where}`,
    params,
  );
  res.json({ rows, total: Number(total?.total || 0), page: Math.floor(offset / pageSize) + 1, pageSize });
});

studentRouter.post('/students', requirePermission('student.manage'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const nis = text(req.body?.nis);
  const fullName = text(req.body?.fullName);
  const unitId = text(req.body?.unitId);
  const academicYearId = text(req.body?.academicYearId);
  const effectiveStart = text(req.body?.effectiveStart) || new Date().toISOString().slice(0, 10);
  const gender = upper(req.body?.gender);

  if (!nis || !fullName) return res.status(400).json({ error: 'STUDENT_NIS_NAME_REQUIRED' });
  if (!unitId || !academicYearId) return res.status(400).json({ error: 'STUDENT_UNIT_YEAR_REQUIRED' });
  if (!isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (gender && !['L', 'P'].includes(gender)) return res.status(400).json({ error: 'INVALID_GENDER' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const unit = await one<any>('SELECT id,legal_entity_id,operational_status FROM organization_units WHERE id=?', [unitId]);
  if (!unit || unit.legal_entity_id !== entityId) return res.status(400).json({ error: 'UNIT_OUTSIDE_ENTITY' });
  const year = await one('SELECT id FROM academic_years WHERE id=? AND legal_entity_id=?', [academicYearId, entityId]);
  if (!year) return res.status(400).json({ error: 'ACADEMIC_YEAR_OUTSIDE_ENTITY' });
  if (await one('SELECT id FROM students WHERE legal_entity_id=? AND nis=?', [entityId, nis])) {
    return res.status(409).json({ error: 'STUDENT_NIS_DUPLICATE' });
  }

  const birthDate = nullableText(req.body?.birthDate);
  if (birthDate && !isDateOnly(birthDate)) return res.status(400).json({ error: 'INVALID_BIRTH_DATE' });

  const id = randomUUID();
  const enrollmentId = randomUUID();
  await exec(
    `INSERT INTO students(id,legal_entity_id,nis,nisn,full_name,gender,birth_date,guardian_name,guardian_phone,address)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [id, entityId, nis, nullableText(req.body?.nisn), fullName, gender || null, birthDate,
      nullableText(req.body?.guardianName), nullableText(req.body?.guardianPhone), nullableText(req.body?.address)],
  );
  await exec(
    `INSERT INTO student_enrollments(id,student_id,unit_id,academic_year_id,class_label,effective_start)
     VALUES(?,?,?,?,?,?)`,
    [enrollmentId, id, unitId, academicYearId, nullableText(req.body?.classLabel), effectiveStart],
  );

  await writeAudit({
    legalEntityId: entityId, unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'STUDENT_CREATE', entityType: 'STUDENT', entityId: id,
    after: { nis, fullName, unitId, academicYearId, classLabel: req.body?.classLabel || null },
  });
  res.status(201).json(await one('SELECT * FROM students WHERE id=?', [id]));
});

studentRouter.patch('/students/:id', requirePermission('student.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM students WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'STUDENT_NOT_FOUND' });
  const enrollment = await currentEnrollment(id);
  if (!enrollment || !(await canAccessUnit(req.user!, enrollment.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }

  const fullName = text(req.body?.fullName) || before.full_name;
  const gender = req.body?.gender === undefined ? before.gender : upper(req.body.gender);
  if (gender && !['L', 'P'].includes(gender)) return res.status(400).json({ error: 'INVALID_GENDER' });
  const birthDate = req.body?.birthDate === undefined ? before.birth_date : nullableText(req.body.birthDate);
  if (birthDate && !isDateOnly(birthDate)) return res.status(400).json({ error: 'INVALID_BIRTH_DATE' });

  await exec(
    `UPDATE students SET nisn=?, full_name=?, gender=?, birth_date=?, guardian_name=?, guardian_phone=?, address=?, status=?
      WHERE id=?`,
    [
      req.body?.nisn === undefined ? before.nisn : nullableText(req.body.nisn),
      fullName, gender || null, birthDate,
      req.body?.guardianName === undefined ? before.guardian_name : nullableText(req.body.guardianName),
      req.body?.guardianPhone === undefined ? before.guardian_phone : nullableText(req.body.guardianPhone),
      req.body?.address === undefined ? before.address : nullableText(req.body.address),
      upper(req.body?.status) || before.status, id,
    ],
  );
  const after = await one('SELECT * FROM students WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, unitId: enrollment.unit_id, userId: req.user!.id, ip: req.ip || null,
    action: 'STUDENT_UPDATE', entityType: 'STUDENT', entityId: id, before, after,
  });
  res.json(after);
});

studentRouter.post('/students/:id/enrollments', requirePermission('student.manage'), async (req, res) => {
  const studentId = text(req.params.id);
  const student = await one<any>('SELECT id,legal_entity_id,full_name FROM students WHERE id=?', [studentId]);
  if (!student) return res.status(404).json({ error: 'STUDENT_NOT_FOUND' });

  const unitId = text(req.body?.unitId);
  const academicYearId = text(req.body?.academicYearId);
  const effectiveStart = text(req.body?.effectiveStart) || new Date().toISOString().slice(0, 10);
  if (!unitId || !academicYearId) return res.status(400).json({ error: 'STUDENT_UNIT_YEAR_REQUIRED' });
  if (!isDateOnly(effectiveStart)) return res.status(400).json({ error: 'EFFECTIVE_START_INVALID' });
  if (!(await canAccessUnit(req.user!, unitId))) return res.status(403).json({ error: 'UNIT_FORBIDDEN' });

  const unit = await one<any>('SELECT id,legal_entity_id FROM organization_units WHERE id=?', [unitId]);
  if (!unit || unit.legal_entity_id !== student.legal_entity_id) return res.status(400).json({ error: 'UNIT_OUTSIDE_ENTITY' });
  if (!(await one('SELECT id FROM academic_years WHERE id=? AND legal_entity_id=?', [academicYearId, student.legal_entity_id]))) {
    return res.status(400).json({ error: 'ACADEMIC_YEAR_OUTSIDE_ENTITY' });
  }
  if (await one('SELECT id FROM student_enrollments WHERE student_id=? AND unit_id=? AND academic_year_id=? AND effective_start=?',
    [studentId, unitId, academicYearId, effectiveStart])) {
    return res.status(409).json({ error: 'ENROLLMENT_DUPLICATE' });
  }

  const active = await currentEnrollment(studentId);
  if (active) {
    await exec("UPDATE student_enrollments SET status='MOVED', effective_end=? WHERE id=?", [
      addDays(effectiveStart, -1), active.id,
    ]);
  }
  const id = randomUUID();
  await exec(
    `INSERT INTO student_enrollments(id,student_id,unit_id,academic_year_id,class_label,effective_start,status)
     VALUES(?,?,?,?,?,?,'ACTIVE')`,
    [id, studentId, unitId, academicYearId, nullableText(req.body?.classLabel), effectiveStart],
  );
  await writeAudit({
    legalEntityId: student.legal_entity_id, unitId, userId: req.user!.id, ip: req.ip || null,
    action: 'STUDENT_ENROLLMENT_CHANGE', entityType: 'STUDENT', entityId: studentId,
    before: active ? { unitId: active.unit_id, academicYearId: active.academic_year_id } : null,
    after: { unitId, academicYearId, classLabel: req.body?.classLabel || null, effectiveStart },
    reason: nullableText(req.body?.reason),
  });
  res.status(201).json(await one('SELECT * FROM student_enrollments WHERE id=?', [id]));
});

studentRouter.get('/students/:id', requirePermission('student.view'), async (req, res) => {
  const id = text(req.params.id);
  const student = await one<any>('SELECT * FROM students WHERE id=?', [id]);
  if (!student) return res.status(404).json({ error: 'STUDENT_NOT_FOUND' });
  const enrollment = await currentEnrollment(id);
  if (!enrollment || !(await canAccessUnit(req.user!, enrollment.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }

  const [enrollments, invoices] = await Promise.all([
    query(
      `SELECT e.id,e.unit_id,u.unit_code,u.unit_name,e.academic_year_id,ay.name academic_year_name,
              e.class_label,e.effective_start,e.effective_end,e.status
         FROM student_enrollments e
         JOIN organization_units u ON u.id=e.unit_id
         JOIN academic_years ay ON ay.id=e.academic_year_id
        WHERE e.student_id=? ORDER BY e.effective_start DESC`, [id],
    ),
    query(
      `SELECT i.id,i.invoice_number,i.invoice_date,i.due_date,i.period_label,i.total_amount,i.paid_amount,i.status
         FROM invoices i WHERE i.student_id=? ORDER BY i.invoice_date DESC LIMIT 20`, [id],
    ),
  ]);
  res.json({ student, enrollment, enrollments, invoices });
});
