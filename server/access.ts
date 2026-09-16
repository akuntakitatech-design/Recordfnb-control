import { query } from './db.js';

const masterWriterRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
  'CLIENT_FINANCE_MANAGER',
]);

const transactionWriterRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
  'CLIENT_FINANCE_MANAGER',
  'CLIENT_FINANCE_STAFF',
  'CLIENT_OUTLET_USER',
]);

export async function isSystemAdmin(userId: string) {
  const result = await query<{ is_system_admin: boolean }>(
    'SELECT is_system_admin FROM users WHERE id=$1 AND status=\'ACTIVE\' LIMIT 1',
    [userId],
  );
  return Boolean(result.rows[0]?.is_system_admin);
}

export async function canAccessWorkspace(userId: string, workspaceId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query(
    `SELECT 1 FROM workspace_memberships
      WHERE user_id=$1 AND workspace_id=$2 AND status='ACTIVE'
      LIMIT 1`,
    [userId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function canAccessCompany(userId: string, companyId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query(
    `SELECT 1
       FROM companies c
       JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id
      WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=c.id)
      LIMIT 1`,
    [userId, companyId],
  );
  return Boolean(result.rowCount);
}

export async function canAccessLocation(userId: string, locationId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query(
    `SELECT 1
       FROM locations l
       JOIN workspace_memberships wm ON wm.workspace_id=l.workspace_id
      WHERE l.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=l.company_id)
        AND (wm.location_id IS NULL OR wm.location_id=l.id)
      LIMIT 1`,
    [userId, locationId],
  );
  return Boolean(result.rowCount);
}

export async function hasUnrestrictedLocationAccess(userId: string, companyId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query(
    `SELECT 1
       FROM companies c
       JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id
      WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=c.id)
        AND wm.location_id IS NULL
      LIMIT 1`,
    [userId, companyId],
  );
  return Boolean(result.rowCount);
}

export async function hasWorkspaceRole(userId: string, workspaceId: string, allowedRoles: Set<string>) {
  if (await isSystemAdmin(userId)) return true;
  const roles = [...allowedRoles];
  const result = await query(
    `SELECT 1
       FROM workspace_memberships wm
       JOIN roles r ON r.id=wm.role_id
      WHERE wm.user_id=$1 AND wm.workspace_id=$2 AND wm.status='ACTIVE'
        AND r.code=ANY($3::text[])
      LIMIT 1`,
    [userId, workspaceId, roles],
  );
  return Boolean(result.rowCount);
}

export async function canWriteWorkspaceMaster(userId: string, workspaceId: string) {
  return hasWorkspaceRole(userId, workspaceId, masterWriterRoles);
}

export async function canWriteCompanyMaster(userId: string, companyId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!result.rowCount) return false;
  const workspaceId = result.rows[0].workspace_id;
  if (!(await canAccessCompany(userId, companyId))) return false;
  return hasWorkspaceRole(userId, workspaceId, masterWriterRoles);
}

export async function canCreateTransaction(userId: string, companyId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!result.rowCount) return false;
  const workspaceId = result.rows[0].workspace_id;
  if (!(await canAccessCompany(userId, companyId))) return false;
  return hasWorkspaceRole(userId, workspaceId, transactionWriterRoles);
}

export async function canManageWorkspaceUsers(userId: string, workspaceId: string) {
  if (await isSystemAdmin(userId)) return true;
  return hasWorkspaceRole(userId, workspaceId, new Set(['AK_SUPER_ADMIN']));
}

export async function canManageAnyUsers(userId: string) {
  if (await isSystemAdmin(userId)) return true;
  const result = await query(
    `SELECT 1
       FROM workspace_memberships wm
       JOIN roles r ON r.id=wm.role_id
      WHERE wm.user_id=$1 AND wm.status='ACTIVE' AND r.code='AK_SUPER_ADMIN'
      LIMIT 1`,
    [userId],
  );
  return Boolean(result.rowCount);
}
