import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import { canManageAnyUsers, canManageWorkspaceUsers, isSystemAdmin } from './access.js';

export const accessRouter = Router();
accessRouter.use(requireAuth);

function text(value: unknown) { return String(value ?? '').trim(); }
function nullable(value: unknown) { const v = text(value); return v || null; }

async function canManageTargetUser(actorId: string, targetUserId: string) {
  if (await isSystemAdmin(actorId)) return true;
  const result = await query(
    `SELECT 1
       FROM workspace_memberships target
       JOIN workspace_memberships actor ON actor.workspace_id=target.workspace_id
       JOIN roles ar ON ar.id=actor.role_id
      WHERE target.user_id=$2 AND target.status='ACTIVE'
        AND actor.user_id=$1 AND actor.status='ACTIVE'
        AND ar.code='AK_SUPER_ADMIN'
      LIMIT 1`,
    [actorId, targetUserId],
  );
  return Boolean(result.rowCount);
}

async function validateMembershipScope(workspaceId: string, companyId: string | null, locationId: string | null) {
  const workspace = await query('SELECT id FROM workspaces WHERE id=$1 AND status=\'ACTIVE\'', [workspaceId]);
  if (!workspace.rowCount) return { error: 'WORKSPACE_NOT_FOUND' as const, companyId };

  let normalizedCompanyId = companyId;
  if (locationId) {
    const location = await query<{ company_id: string }>(
      'SELECT company_id FROM locations WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\'',
      [locationId, workspaceId],
    );
    if (!location.rowCount) return { error: 'LOCATION_OUTSIDE_WORKSPACE' as const, companyId };
    if (normalizedCompanyId && normalizedCompanyId !== location.rows[0].company_id) {
      return { error: 'LOCATION_OUTSIDE_COMPANY' as const, companyId };
    }
    normalizedCompanyId = location.rows[0].company_id;
  }

  if (normalizedCompanyId) {
    const company = await query(
      'SELECT id FROM companies WHERE id=$1 AND workspace_id=$2 AND status=\'ACTIVE\'',
      [normalizedCompanyId, workspaceId],
    );
    if (!company.rowCount) return { error: 'COMPANY_OUTSIDE_WORKSPACE' as const, companyId: normalizedCompanyId };
  }

  return { error: null, companyId: normalizedCompanyId };
}

accessRouter.get('/roles', async (_req, res) => {
  const result = await query('SELECT id,code,name,side FROM roles ORDER BY side,name');
  res.json(result.rows);
});

accessRouter.get('/users', async (req, res) => {
  if (!(await canManageAnyUsers(req.sessionUser!.id))) return res.status(403).json({ error: 'FORBIDDEN' });
  const systemAdmin = await isSystemAdmin(req.sessionUser!.id);

  const result = await query<{
    id: string; email: string; full_name: string; status: string; is_system_admin: boolean;
    membership_id: string | null; membership_status: string | null;
    workspace_id: string | null; workspace_name: string | null;
    company_id: string | null; company_name: string | null;
    location_id: string | null; location_name: string | null;
    role_id: string | null; role_code: string | null; role_name: string | null; side: string | null;
  }>(
    systemAdmin
      ? `SELECT u.id,u.email::text,u.full_name,u.status,u.is_system_admin,
                wm.id membership_id,wm.status membership_status,
                wm.workspace_id,w.name workspace_name,wm.company_id,c.name company_name,
                wm.location_id,l.name location_name,r.id role_id,r.code role_code,r.name role_name,r.side
           FROM users u
           LEFT JOIN workspace_memberships wm ON wm.user_id=u.id
           LEFT JOIN workspaces w ON w.id=wm.workspace_id
           LEFT JOIN companies c ON c.id=wm.company_id
           LEFT JOIN locations l ON l.id=wm.location_id
           LEFT JOIN roles r ON r.id=wm.role_id
          ORDER BY u.is_system_admin DESC,u.full_name,w.name,r.name`
      : `SELECT DISTINCT u.id,u.email::text,u.full_name,u.status,u.is_system_admin,
                wm.id membership_id,wm.status membership_status,
                wm.workspace_id,w.name workspace_name,wm.company_id,c.name company_name,
                wm.location_id,l.name location_name,r.id role_id,r.code role_code,r.name role_name,r.side
           FROM users u
           JOIN workspace_memberships visible ON visible.user_id=u.id
           JOIN workspace_memberships actor ON actor.workspace_id=visible.workspace_id
           JOIN roles actor_role ON actor_role.id=actor.role_id AND actor_role.code='AK_SUPER_ADMIN'
           LEFT JOIN workspace_memberships wm ON wm.user_id=u.id AND wm.workspace_id=actor.workspace_id
           LEFT JOIN workspaces w ON w.id=wm.workspace_id
           LEFT JOIN companies c ON c.id=wm.company_id
           LEFT JOIN locations l ON l.id=wm.location_id
           LEFT JOIN roles r ON r.id=wm.role_id
          WHERE actor.user_id=$1 AND actor.status='ACTIVE'
          ORDER BY u.full_name,w.name,r.name`,
    systemAdmin ? [] : [req.sessionUser!.id],
  );

  const users = new Map<string, any>();
  for (const row of result.rows) {
    if (!users.has(row.id)) {
      users.set(row.id, {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        status: row.status,
        isSystemAdmin: row.is_system_admin,
        memberships: [],
      });
    }
    if (row.membership_id) {
      users.get(row.id).memberships.push({
        id: row.membership_id,
        status: row.membership_status,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        companyId: row.company_id,
        companyName: row.company_name,
        locationId: row.location_id,
        locationName: row.location_name,
        roleId: row.role_id,
        roleCode: row.role_code,
        roleName: row.role_name,
        side: row.side,
      });
    }
  }
  res.json([...users.values()]);
});

accessRouter.post('/users', async (req, res) => {
  const actorId = req.sessionUser!.id;
  const fullName = text(req.body?.fullName);
  const email = text(req.body?.email).toLowerCase();
  const temporaryPassword = String(req.body?.temporaryPassword || '');
  const workspaceId = text(req.body?.workspaceId);
  const roleId = text(req.body?.roleId);
  const companyId = nullable(req.body?.companyId);
  const locationId = nullable(req.body?.locationId);

  if (!fullName || !email || !workspaceId || !roleId || !temporaryPassword) {
    return res.status(400).json({ error: 'USER_REQUIRED_FIELDS' });
  }
  if (temporaryPassword.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  if (!(await canManageWorkspaceUsers(actorId, workspaceId))) return res.status(403).json({ error: 'FORBIDDEN' });

  const scope = await validateMembershipScope(workspaceId, companyId, locationId);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const role = await query<{ id: string }>('SELECT id FROM roles WHERE id=$1', [roleId]);
  if (!role.rowCount) return res.status(400).json({ error: 'ROLE_NOT_FOUND' });
  const duplicate = await query('SELECT id FROM users WHERE email=$1 LIMIT 1', [email]);
  if (duplicate.rowCount) return res.status(409).json({ error: 'EMAIL_ALREADY_EXISTS' });

  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  const created = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,full_name)
     VALUES($1,$2,$3) RETURNING id`,
    [email, passwordHash, fullName],
  );
  const userId = created.rows[0].id;
  const membership = await query<{ id: string }>(
    `INSERT INTO workspace_memberships(workspace_id,user_id,role_id,company_id,location_id)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [workspaceId, userId, roleId, scope.companyId, locationId],
  );
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'USER',$3,'CREATE_USER',$4::jsonb)`,
    [workspaceId, actorId, userId, JSON.stringify({ email, fullName, membershipId: membership.rows[0].id })],
  );
  res.status(201).json({ id: userId, ok: true });
});

accessRouter.patch('/users/:userId', async (req, res) => {
  const actorId = req.sessionUser!.id;
  const targetId = text(req.params.userId);
  if (!(await canManageTargetUser(actorId, targetId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const target = await query<{ is_system_admin: boolean }>('SELECT is_system_admin FROM users WHERE id=$1', [targetId]);
  if (!target.rowCount) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (target.rows[0].is_system_admin && !(await isSystemAdmin(actorId))) return res.status(403).json({ error: 'SYSTEM_ADMIN_PROTECTED' });

  const fullName = text(req.body?.fullName);
  const status = text(req.body?.status).toUpperCase();
  if (!fullName || !['ACTIVE','INACTIVE','LOCKED'].includes(status)) return res.status(400).json({ error: 'INVALID_USER_UPDATE' });
  if (targetId === actorId && status !== 'ACTIVE') return res.status(400).json({ error: 'CANNOT_DISABLE_SELF' });

  await query('UPDATE users SET full_name=$1,status=$2,updated_at=NOW() WHERE id=$3', [fullName, status, targetId]);
  await query(
    `INSERT INTO audit_logs(user_id,entity_type,entity_id,action,after_data)
     VALUES($1,'USER',$2,'UPDATE_USER',$3::jsonb)`,
    [actorId, targetId, JSON.stringify({ fullName, status })],
  );
  res.json({ ok: true });
});

accessRouter.post('/users/:userId/memberships', async (req, res) => {
  const actorId = req.sessionUser!.id;
  const targetId = text(req.params.userId);
  const workspaceId = text(req.body?.workspaceId);
  const roleId = text(req.body?.roleId);
  const companyId = nullable(req.body?.companyId);
  const locationId = nullable(req.body?.locationId);
  if (!workspaceId || !roleId) return res.status(400).json({ error: 'MEMBERSHIP_REQUIRED_FIELDS' });
  if (!(await canManageWorkspaceUsers(actorId, workspaceId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const target = await query('SELECT id FROM users WHERE id=$1', [targetId]);
  if (!target.rowCount) return res.status(404).json({ error: 'USER_NOT_FOUND' });

  const scope = await validateMembershipScope(workspaceId, companyId, locationId);
  if (scope.error) return res.status(400).json({ error: scope.error });
  const role = await query('SELECT id FROM roles WHERE id=$1', [roleId]);
  if (!role.rowCount) return res.status(400).json({ error: 'ROLE_NOT_FOUND' });

  try {
    const created = await query<{ id: string }>(
      `INSERT INTO workspace_memberships(workspace_id,user_id,role_id,company_id,location_id)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [workspaceId, targetId, roleId, scope.companyId, locationId],
    );
    await query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
       VALUES($1,$2,'USER',$3,'ADD_MEMBERSHIP',$4::jsonb)`,
      [workspaceId, actorId, targetId, JSON.stringify({ membershipId: created.rows[0].id, roleId, companyId: scope.companyId, locationId })],
    );
    res.status(201).json({ id: created.rows[0].id, ok: true });
  } catch (error: any) {
    if (error?.code === '23505') return res.status(409).json({ error: 'MEMBERSHIP_ALREADY_EXISTS' });
    throw error;
  }
});

accessRouter.patch('/memberships/:membershipId', async (req, res) => {
  const actorId = req.sessionUser!.id;
  const membershipId = text(req.params.membershipId);
  const current = await query<{ workspace_id: string; user_id: string }>(
    'SELECT workspace_id,user_id FROM workspace_memberships WHERE id=$1',
    [membershipId],
  );
  if (!current.rowCount) return res.status(404).json({ error: 'MEMBERSHIP_NOT_FOUND' });
  if (!(await canManageWorkspaceUsers(actorId, current.rows[0].workspace_id))) return res.status(403).json({ error: 'FORBIDDEN' });

  const status = text(req.body?.status).toUpperCase();
  if (!['ACTIVE','INACTIVE'].includes(status)) return res.status(400).json({ error: 'INVALID_MEMBERSHIP_STATUS' });
  if (current.rows[0].user_id === actorId && status === 'INACTIVE' && !(await isSystemAdmin(actorId))) {
    return res.status(400).json({ error: 'CANNOT_DISABLE_OWN_ADMIN_ACCESS' });
  }
  await query('UPDATE workspace_memberships SET status=$1 WHERE id=$2', [status, membershipId]);
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data)
     VALUES($1,$2,'MEMBERSHIP',$3,'UPDATE_MEMBERSHIP',$4::jsonb)`,
    [current.rows[0].workspace_id, actorId, membershipId, JSON.stringify({ status })],
  );
  res.json({ ok: true });
});

accessRouter.post('/users/:userId/reset-password', async (req, res) => {
  const actorId = req.sessionUser!.id;
  const targetId = text(req.params.userId);
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  if (!(await canManageTargetUser(actorId, targetId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const target = await query<{ is_system_admin: boolean }>('SELECT is_system_admin FROM users WHERE id=$1', [targetId]);
  if (!target.rowCount) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  if (target.rows[0].is_system_admin && !(await isSystemAdmin(actorId))) return res.status(403).json({ error: 'SYSTEM_ADMIN_PROTECTED' });

  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2', [hash, targetId]);
  await query(
    `INSERT INTO audit_logs(user_id,entity_type,entity_id,action,after_data)
     VALUES($1,'USER',$2,'ADMIN_RESET_PASSWORD',$3::jsonb)`,
    [actorId, targetId, JSON.stringify({ changedAt: new Date().toISOString() })],
  );
  res.json({ ok: true });
});
