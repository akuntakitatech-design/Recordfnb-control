import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { exec, one, query } from '../db.js';
import { isUserRole, ROLES, requireAuth } from '../auth.js';
import { isGlobalRole, requirePermission, ROLE_LABEL } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { text } from '../http.js';

export const userRouter = Router();
userRouter.use(requireAuth);

async function activeEntityId(): Promise<string | null> {
  const entity = await one<{ id: string }>("SELECT id FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  return entity?.id || null;
}

async function unitsOf(userId: string) {
  return query<{ unit_id: string; unit_code: string; unit_name: string }>(
    `SELECT a.unit_id,u.unit_code,u.unit_name
       FROM user_unit_access a JOIN organization_units u ON u.id=a.unit_id
      WHERE a.user_id=? ORDER BY u.unit_name`, [userId],
  );
}

userRouter.get('/roles', (_req, res) => {
  res.json(ROLES.map(role => ({ code: role, label: ROLE_LABEL[role], global: isGlobalRole(role) })));
});

userRouter.get('/users', requirePermission('user.manage'), async (_req, res) => {
  const rows = await query<any>('SELECT id,email,full_name,role,status,created_at,updated_at FROM users ORDER BY full_name');
  const result = [];
  for (const row of rows) {
    result.push({ ...row, units: await unitsOf(row.id) });
  }
  res.json(result);
});

userRouter.post('/users', requirePermission('user.manage'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const fullName = text(req.body?.fullName);
  const email = text(req.body?.email).toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = text(req.body?.role).toUpperCase();

  if (!fullName || !email) return res.status(400).json({ error: 'USER_FIELDS_REQUIRED' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'EMAIL_INVALID' });
  if (password.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  if (!isUserRole(role)) return res.status(400).json({ error: 'ROLE_INVALID' });
  if (await one('SELECT id FROM users WHERE email=?', [email])) return res.status(409).json({ error: 'EMAIL_DUPLICATE' });

  const unitIds: string[] = Array.isArray(req.body?.unitIds) ? req.body.unitIds.map((id: unknown) => text(id)).filter(Boolean) : [];
  if (!isGlobalRole(role) && unitIds.length === 0) return res.status(400).json({ error: 'UNIT_SCOPE_REQUIRED' });
  for (const unitId of unitIds) {
    const unit = await one('SELECT id FROM organization_units WHERE id=? AND legal_entity_id=?', [unitId, entityId]);
    if (!unit) return res.status(400).json({ error: 'UNIT_OUTSIDE_ENTITY' });
  }

  const id = randomUUID();
  await exec('INSERT INTO users(id,email,password_hash,full_name,role,must_change_password) VALUES(?,?,?,?,?,1)', [
    id, email, await bcrypt.hash(password, 12), fullName, role,
  ]);
  for (const unitId of unitIds) {
    await exec('INSERT INTO user_unit_access(id,user_id,unit_id) VALUES(?,?,?)', [randomUUID(), id, unitId]);
  }

  const after = await one('SELECT id,email,full_name,role,status FROM users WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: entityId, userId: req.user!.id, ip: req.ip || null,
    action: 'USER_CREATE', entityType: 'USER', entityId: id, after: { ...after, units: unitIds },
  });
  res.status(201).json({ ...after, units: await unitsOf(id) });
});

userRouter.patch('/users/:id', requirePermission('user.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT id,email,full_name,role,status FROM users WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const fullName = text(req.body?.fullName) || before.full_name;
  const role = text(req.body?.role).toUpperCase() || before.role;
  const status = text(req.body?.status).toUpperCase() || before.status;
  if (!isUserRole(role)) return res.status(400).json({ error: 'ROLE_INVALID' });
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'USER_STATUS_INVALID' });
  if (id === req.user!.id && (role !== before.role || status !== 'ACTIVE')) {
    return res.status(400).json({ error: 'CANNOT_CHANGE_OWN_ACCESS' });
  }

  await exec('UPDATE users SET full_name=?, role=?, status=? WHERE id=?', [fullName, role, status, id]);
  const password = String(req.body?.password ?? '');
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
    await exec('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [await bcrypt.hash(password, 12), id]);
  }

  const after = await one('SELECT id,email,full_name,role,status FROM users WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: await activeEntityId(), userId: req.user!.id, ip: req.ip || null,
    action: 'USER_UPDATE', entityType: 'USER', entityId: id, before, after,
  });
  res.json({ ...after, units: await unitsOf(id) });
});

/** Reset password oleh admin: password sementara + wajib ganti saat login berikutnya. */
userRouter.post('/users/:id/reset-password', requirePermission('user.manage'), async (req, res) => {
  const id = text(req.params.id);
  const target = await one<any>('SELECT id,email,full_name FROM users WHERE id=?', [id]);
  if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const password = String(req.body?.password ?? '');
  if (password.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });

  await exec(
    'UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?',
    [await bcrypt.hash(password, 12), id],
  );
  await writeAudit({
    legalEntityId: await activeEntityId(), userId: req.user!.id, ip: req.ip || null,
    action: 'USER_PASSWORD_RESET', entityType: 'USER', entityId: id,
    after: { email: target.email, must_change_password: true },
  });
  res.json({ ok: true, mustChangePassword: true });
});

userRouter.put('/users/:id/units', requirePermission('user.manage'), async (req, res) => {
  const id = text(req.params.id);
  const user = await one<any>('SELECT id,email,full_name,role FROM users WHERE id=?', [id]);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const rawUnits: unknown[] = Array.isArray(req.body?.unitIds) ? req.body.unitIds : [];
  const unitIds: string[] = [...new Set(rawUnits.map(value => text(value)).filter(Boolean))];
  const entityId = await activeEntityId();
  for (const unitId of unitIds) {
    const unit = await one('SELECT id FROM organization_units WHERE id=? AND legal_entity_id=?', [unitId, entityId]);
    if (!unit) return res.status(400).json({ error: 'UNIT_OUTSIDE_ENTITY' });
  }
  if (!isGlobalRole(user.role) && unitIds.length === 0) return res.status(400).json({ error: 'UNIT_SCOPE_REQUIRED' });

  const before = await unitsOf(id);
  await exec('DELETE FROM user_unit_access WHERE user_id=?', [id]);
  for (const unitId of unitIds) {
    await exec('INSERT INTO user_unit_access(id,user_id,unit_id) VALUES(?,?,?)', [randomUUID(), id, unitId]);
  }
  const after = await unitsOf(id);
  await writeAudit({
    legalEntityId: entityId, userId: req.user!.id, ip: req.ip || null,
    action: 'USER_UNIT_SCOPE_UPDATE', entityType: 'USER', entityId: id, before, after,
  });
  res.json({ ok: true, units: after });
});

/* ------------------------------------------------------------------ Audit log global */

userRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const unitId = text(req.query.unitId);
  const entityType = text(req.query.entityType);
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));

  const conditions: string[] = [];
  const params: any[] = [];
  if (unitId) { conditions.push('a.unit_id=?'); params.push(unitId); }
  if (entityType) { conditions.push('a.entity_type=?'); params.push(entityType); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT a.id,a.action,a.entity_type,a.entity_id,a.reason,a.created_at,a.user_id,
            u.full_name user_name,u.email user_email
       FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
       ${where}
      ORDER BY a.created_at DESC LIMIT ?`,
    [...params, limit],
  );
  res.json(rows);
});

userRouter.get('/audit-logs/:id', requirePermission('audit.view'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'AUDIT_ID_INVALID' });
  const row = await one(
    `SELECT a.*,u.full_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.id=?`,
    [id],
  );
  if (!row) return res.status(404).json({ error: 'AUDIT_NOT_FOUND' });
  res.json(row);
});
