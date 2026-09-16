import { query } from './db.js';

const accountingSetupRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
]);

const operationalMasterWriterRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
  'CLIENT_FINANCE_MANAGER',
  'CLIENT_FINANCE_STAFF',
]);

const transactionWriterRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
  'CLIENT_FINANCE_MANAGER',
  'CLIENT_FINANCE_STAFF',
  'CLIENT_OUTLET_USER',
]);

const transactionVerifierRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
  'CLIENT_FINANCE_MANAGER',
  'CLIENT_FINANCE_STAFF',
]);

const journalReviewerRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
  'AK_ACCOUNTING_STAFF',
]);

const journalPosterRoles = new Set([
  'AK_SUPER_ADMIN',
  'AK_ACCOUNTING_REVIEWER',
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

export async function hasCompanyRole(userId: string, companyId: string, allowedRoles: Set<string>) {
  if (await isSystemAdmin(userId)) return true;
  const roles = [...allowedRoles];
  const result = await query(
    `SELECT 1
       FROM companies c
       JOIN workspace_memberships wm ON wm.workspace_id=c.workspace_id
       JOIN roles r ON r.id=wm.role_id
      WHERE c.id=$2 AND wm.user_id=$1 AND wm.status='ACTIVE'
        AND (wm.company_id IS NULL OR wm.company_id=c.id)
        AND r.code=ANY($3::text[])
      LIMIT 1`,
    [userId, companyId, roles],
  );
  return Boolean(result.rowCount);
}

// Accounting/setup masters are intentionally owned by Akuntakita.
// Client users consume these masters but do not change their accounting structure.
export async function canWriteWorkspaceMaster(userId: string, workspaceId: string) {
  return hasWorkspaceRole(userId, workspaceId, accountingSetupRoles);
}

export async function canWriteCompanyMaster(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, accountingSetupRoles);
}

// Operational masters such as item and supplier may be created by the client finance team.
export async function canWriteOperationalWorkspaceMaster(userId: string, workspaceId: string) {
  return hasWorkspaceRole(userId, workspaceId, operationalMasterWriterRoles);
}

export async function canCreateTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, transactionWriterRoles);
}

export async function canVerifyTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, transactionVerifierRoles);
}

export async function canReviewJournal(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, journalReviewerRoles);
}

export async function canPostJournal(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, journalPosterRoles);
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
