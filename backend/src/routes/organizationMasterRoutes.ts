import { Router } from 'express';
import { exec, one } from '../db.js';
import { requireAuth } from '../auth.js';
import { requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { isDateOnly, text, upper } from '../http.js';

/**
 * Kelola master organisasi: edit tahun ajaran, aktif/nonaktif, dan hapus.
 * Dipisah dari organizationRoutes agar aturan "hapus hanya bila belum dipakai" mudah dibaca.
 */
export const organizationMasterRouter = Router();
organizationMasterRouter.use(requireAuth);

function auditContext(req: any, entityId: string | null) {
  return {
    legalEntityId: entityId,
    unitId: null,
    userId: req.user?.id ?? null,
    ip: req.ip || null,
  };
}

/* ------------------------------------------------------------------ Tahun ajaran */

organizationMasterRouter.put('/academic-years/:id', requirePermission('entity.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM academic_years WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'ACADEMIC_YEAR_NOT_FOUND' });
  const name = text(req.body?.name);
  const start = text(req.body?.startDate);
  const end = text(req.body?.endDate);
  if (!name || !isDateOnly(start) || !isDateOnly(end)) return res.status(400).json({ error: 'ACADEMIC_YEAR_FIELDS_REQUIRED' });
  if (end < start) return res.status(400).json({ error: 'ACADEMIC_YEAR_RANGE_INVALID' });
  if (await one('SELECT id FROM academic_years WHERE legal_entity_id=? AND name=? AND id<>?', [before.legal_entity_id, name, id])) {
    return res.status(409).json({ error: 'ACADEMIC_YEAR_DUPLICATE' });
  }
  await exec('UPDATE academic_years SET name=?, start_date=?, end_date=?, status=? WHERE id=?', [
    name, start, end, upper(req.body?.status) || before.status, id,
  ]);
  const after = await one('SELECT * FROM academic_years WHERE id=?', [id]);
  await writeAudit({ ...auditContext(req, before.legal_entity_id), action: 'ACADEMIC_YEAR_UPDATE', entityType: 'ACADEMIC_YEAR', entityId: id, before, after });
  res.json(after);
});

/* ------------------------------------------------------------------ Nonaktifkan & hapus master */

type MasterAdminConfig = {
  table: string;
  entityType: string;
  auditPrefix: string;
  notFound: string;
  refs: { label: string; sql: string }[];
};

/**
 * Master data organisasi: bisa dinonaktifkan kapan saja, tetapi hanya boleh dihapus
 * bila belum dipakai. Unit memakai ON DELETE SET NULL, jadi tanpa pemeriksaan ini
 * menghapus master akan diam-diam memutus relasi unit.
 */
const MASTER_ADMIN: Record<string, MasterAdminConfig> = {
  'education-levels': {
    table: 'education_levels', entityType: 'EDUCATION_LEVEL', auditPrefix: 'LEVEL', notFound: 'LEVEL_NOT_FOUND',
    refs: [
      { label: 'kelompok sekolah', sql: 'SELECT COUNT(*) total FROM school_groups WHERE education_level_id=?' },
      { label: 'sekolah resmi', sql: 'SELECT COUNT(*) total FROM official_schools WHERE education_level_id=?' },
      { label: 'unit', sql: 'SELECT COUNT(*) total FROM organization_units WHERE education_level_id=?' },
      { label: 'tarif', sql: 'SELECT COUNT(*) total FROM fee_schemes WHERE education_level_id=?' },
    ],
  },
  'school-groups': {
    table: 'school_groups', entityType: 'SCHOOL_GROUP', auditPrefix: 'GROUP', notFound: 'GROUP_NOT_FOUND',
    refs: [{ label: 'unit', sql: 'SELECT COUNT(*) total FROM organization_units WHERE school_group_id=?' }],
  },
  'official-schools': {
    table: 'official_schools', entityType: 'OFFICIAL_SCHOOL', auditPrefix: 'SCHOOL', notFound: 'SCHOOL_NOT_FOUND',
    refs: [{ label: 'unit', sql: 'SELECT COUNT(*) total FROM organization_units WHERE official_school_id=?' }],
  },
  'locations': {
    table: 'school_locations', entityType: 'SCHOOL_LOCATION', auditPrefix: 'LOCATION', notFound: 'LOCATION_NOT_FOUND',
    refs: [{ label: 'unit', sql: 'SELECT COUNT(*) total FROM organization_units WHERE location_id=?' }],
  },
  'academic-years': {
    table: 'academic_years', entityType: 'ACADEMIC_YEAR', auditPrefix: 'ACADEMIC_YEAR', notFound: 'ACADEMIC_YEAR_NOT_FOUND',
    refs: [
      { label: 'unit', sql: 'SELECT COUNT(*) total FROM organization_units WHERE default_academic_year_id=?' },
      { label: 'siswa', sql: 'SELECT COUNT(*) total FROM student_enrollments WHERE academic_year_id=?' },
      { label: 'tarif', sql: 'SELECT COUNT(*) total FROM fee_schemes WHERE academic_year_id=?' },
      { label: 'tagihan', sql: 'SELECT COUNT(*) total FROM invoices WHERE academic_year_id=?' },
      { label: 'proses tagihan', sql: 'SELECT COUNT(*) total FROM billing_runs WHERE academic_year_id=?' },
    ],
  },
};

async function masterReferences(config: MasterAdminConfig, id: string) {
  const references: { label: string; count: number }[] = [];
  for (const ref of config.refs) {
    const row = await one<{ total: number }>(ref.sql, [id]);
    const count = Number(row?.total || 0);
    if (count > 0) references.push({ label: ref.label, count });
  }
  return references;
}

function masterInUse(res: any, references: { label: string; count: number }[]) {
  const detail = references.length
    ? references.map(ref => `${ref.count} ${ref.label}`).join(', ')
    : 'data terkait';
  return res.status(409).json({
    error: 'MASTER_IN_USE',
    references,
    errors: [{ field: 'references', message: `Dipakai oleh: ${detail}. Nonaktifkan saja bila sudah tidak dipakai.` }],
  });
}

for (const [path, config] of Object.entries(MASTER_ADMIN)) {
  organizationMasterRouter.patch(`/${path}/:id/status`, requirePermission('entity.manage'), async (req, res) => {
    const id = text(req.params.id);
    const before = await one<any>(`SELECT * FROM ${config.table} WHERE id=?`, [id]);
    if (!before) return res.status(404).json({ error: config.notFound });
    const status = upper(req.body?.status);
    if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'STATUS_INVALID' });
    await exec(`UPDATE ${config.table} SET status=? WHERE id=?`, [status, id]);
    const after = await one<any>(`SELECT * FROM ${config.table} WHERE id=?`, [id]);
    await writeAudit({
      ...auditContext(req, before.legal_entity_id),
      action: `${config.auditPrefix}_STATUS`, entityType: config.entityType, entityId: id, before, after,
    });
    res.json(after);
  });

  organizationMasterRouter.delete(`/${path}/:id`, requirePermission('entity.manage'), async (req, res) => {
    const id = text(req.params.id);
    const before = await one<any>(`SELECT * FROM ${config.table} WHERE id=?`, [id]);
    if (!before) return res.status(404).json({ error: config.notFound });

    const references = await masterReferences(config, id);
    if (references.length) return masterInUse(res, references);

    try {
      await exec(`DELETE FROM ${config.table} WHERE id=?`, [id]);
    } catch (error: any) {
      // Relasi yang belum tercakup daftar pemeriksaan tetap ditolak dengan pesan ramah.
      const raw = `${error?.code || ''} ${error?.message || ''}`;
      if (/ER_ROW_IS_REFERENCED|foreign key|constraint/i.test(raw)) return masterInUse(res, references);
      throw error;
    }
    await writeAudit({
      ...auditContext(req, before.legal_entity_id),
      action: `${config.auditPrefix}_DELETE`, entityType: config.entityType, entityId: id, before,
    });
    res.json({ ok: true });
  });
}
