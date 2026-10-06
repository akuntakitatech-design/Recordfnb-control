import type { NextFunction, Request, Response } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';

/*
 * Role engine (Role V2 — Foundation).
 * Role tetap memakai tabel `roles` existing (tanpa role/tabel baru). Pengelompokan area kerja:
 *   FINANCE    = CLIENT_FINANCE_MANAGER, CLIENT_FINANCE_STAFF        → Finance Control
 *   ACCOUNTING = AK_SUPER_ADMIN, AK_ACCOUNTING_REVIEWER, AK_ACCOUNTING_STAFF → Finance Control + Accounting Control
 *   OWNER      = CLIENT_OWNER                                        → read-only
 *   OUTLET     = CLIENT_OUTLET_USER                                  → operasional outlet yang ditugaskan
 * System Admin (users.is_system_admin) = administrasi teknis saja (user/akses, organisasi, pengaturan).
 * System Admin TIDAK otomatis mendapat akses bisnis/Accounting — akses bisnis wajib lewat membership.
 */
export const FINANCE_ROLES = ['CLIENT_FINANCE_MANAGER', 'CLIENT_FINANCE_STAFF'] as const;
export const ACCOUNTING_ROLES = ['AK_SUPER_ADMIN', 'AK_ACCOUNTING_REVIEWER', 'AK_ACCOUNTING_STAFF'] as const;
export const OWNER_ROLES = ['CLIENT_OWNER'] as const;
export const OUTLET_ROLES = ['CLIENT_OUTLET_USER'] as const;

export type RoleGroup = 'FINANCE' | 'ACCOUNTING' | 'OWNER' | 'OUTLET';
const groupRoles: Record<RoleGroup, readonly string[]> = {
  FINANCE: FINANCE_ROLES,
  ACCOUNTING: ACCOUNTING_ROLES,
  OWNER: OWNER_ROLES,
  OUTLET: OUTLET_ROLES,
};
const rolesOf = (...groups: RoleGroup[]) => new Set(groups.flatMap(g => groupRoles[g]));

const accountingSetupRoles = rolesOf('ACCOUNTING');

// Master operasional (barang, supplier) boleh dikelola Finance dan Accounting.
const operationalMasterWriterRoles = rolesOf('ACCOUNTING', 'FINANCE');

// Transaksi operasional yang juga boleh dicatat Outlet (penjualan/POS, pemakaian, transfer, stock opname)
// — tetap dibatasi location assignment lewat canAccessLocation.
const transactionWriterRoles = rolesOf('ACCOUNTING', 'FINANCE', 'OUTLET');

// Transaksi Finance perusahaan (pembelian, kas & bank, hutang, produksi): tanpa Outlet & Owner.
const financeTransactionWriterRoles = rolesOf('ACCOUNTING', 'FINANCE');

const transactionVerifierRoles = rolesOf('ACCOUNTING', 'FINANCE');

const journalReviewerRoles = rolesOf('ACCOUNTING');

const journalPosterRoles = new Set(['AK_SUPER_ADMIN', 'AK_ACCOUNTING_REVIEWER']);

// BOM / Resep: pemilik master = Accounting (create, edit/versioning, deactivate).
const bomManagerRoles = rolesOf('ACCOUNTING');

export async function isSystemAdmin(userId: string) {
  const result = await query<{ is_system_admin: boolean }>(
    'SELECT is_system_admin FROM users WHERE id=$1 AND status=\'ACTIVE\' LIMIT 1',
    [userId],
  );
  return Boolean(result.rows[0]?.is_system_admin);
}

/** Semua kode role dari membership ACTIVE user (lintas workspace). */
export async function activeRoleCodes(userId: string) {
  const result = await query<{ code: string }>(
    `SELECT DISTINCT r.code
       FROM workspace_memberships wm
       JOIN roles r ON r.id=wm.role_id
       JOIN users u ON u.id=wm.user_id
      WHERE wm.user_id=$1 AND wm.status='ACTIVE' AND u.status='ACTIVE'`,
    [userId],
  );
  return new Set(result.rows.map(row => row.code));
}

export function roleGroupsOf(codes: Set<string>) {
  const groups = new Set<RoleGroup>();
  (Object.keys(groupRoles) as RoleGroup[]).forEach(group => {
    if (groupRoles[group].some(code => codes.has(code))) groups.add(group);
  });
  return groups;
}

export async function canAccessWorkspace(userId: string, workspaceId: string) {
  const result = await query(
    `SELECT 1 FROM workspace_memberships
      WHERE user_id=$1 AND workspace_id=$2 AND status='ACTIVE'
      LIMIT 1`,
    [userId, workspaceId],
  );
  return Boolean(result.rowCount);
}

export async function canAccessCompany(userId: string, companyId: string) {
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

/** Transaksi operasional (penjualan, pemakaian, transfer, stock opname) — termasuk Outlet. */
export async function canCreateTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, transactionWriterRoles);
}

/** Transaksi Finance perusahaan (pembelian, kas & bank, hutang, produksi) — Finance & Accounting saja. */
export async function canCreateFinanceTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, financeTransactionWriterRoles);
}

/** Transaction engine generik / jurnal manual — Accounting saja. */
export async function canCreateAccountingTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, accountingSetupRoles);
}

export async function canVerifyTransaction(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, transactionVerifierRoles);
}

/** Akses baca/tulis area Accounting Control untuk company tertentu. */
export async function canAccessAccountingCompany(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, accountingSetupRoles);
}

/** Baca data Finance perusahaan (Finance, Accounting, Owner read-only) — tanpa Outlet. */
export async function canReadFinanceCompany(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, rolesOf('ACCOUNTING', 'FINANCE', 'OWNER'));
}

/** Jenis transaksi yang menjadi area kerja Outlet (dibatasi location assignment). */
export const OUTLET_TRANSACTION_TYPES = new Set(['SALES_INVOICE', 'STOCK_USAGE', 'STOCK_TRANSFER', 'STOCK_OPNAME']);

export async function canManageBom(userId: string, companyId: string) {
  return hasCompanyRole(userId, companyId, bomManagerRoles);
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

/** Master organisasi (company/location): administrasi teknis (System Admin) atau Accounting setup. */
export async function canManageOrganizationWorkspace(userId: string, workspaceId: string) {
  if (await isSystemAdmin(userId)) return true;
  return canWriteWorkspaceMaster(userId, workspaceId);
}

export async function canManageOrganizationCompany(userId: string, companyId: string) {
  if (await isSystemAdmin(userId)) return true;
  return canWriteCompanyMaster(userId, companyId);
}

/* ---------------------------------------------------------------------------------------------
 * Guard router (lapis pertama). Cek scope company/location tetap dilakukan di masing-masing route.
 *   read  = group yang boleh GET/HEAD
 *   write = group yang boleh POST/PUT/PATCH/DELETE
 * Owner read-only: tidak pernah ada di daftar `write`.
 * ------------------------------------------------------------------------------------------- */
export type AreaPolicy = { read: RoleGroup[]; write: RoleGroup[] };

export const AREA = {
  ACCOUNTING: { read: ['ACCOUNTING'], write: ['ACCOUNTING'] } as AreaPolicy,
  FINANCE: { read: ['ACCOUNTING', 'FINANCE', 'OWNER'], write: ['ACCOUNTING', 'FINANCE'] } as AreaPolicy,
  OPERATIONAL: { read: ['ACCOUNTING', 'FINANCE', 'OWNER', 'OUTLET'], write: ['ACCOUNTING', 'FINANCE', 'OUTLET'] } as AreaPolicy,
  MASTER_READ: { read: ['ACCOUNTING', 'FINANCE', 'OWNER', 'OUTLET'], write: ['ACCOUNTING', 'FINANCE'] } as AreaPolicy,
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function policyAllows(groups: Set<RoleGroup>, policy: AreaPolicy, method: string) {
  const allowed = READ_METHODS.has(method.toUpperCase()) ? policy.read : policy.write;
  return allowed.some(group => groups.has(group));
}

function deny(res: Response, groups: Set<RoleGroup>, policy: AreaPolicy, method: string) {
  const readOnly = !READ_METHODS.has(method.toUpperCase()) && policy.read.some(g => groups.has(g));
  if (readOnly && groups.has('OWNER')) return res.status(403).json({ error: 'OWNER_READ_ONLY' });
  if (policy === AREA.ACCOUNTING) return res.status(403).json({ error: 'ACCOUNTING_ROLE_REQUIRED' });
  if (groups.has('OUTLET') && !groups.has('FINANCE') && !groups.has('ACCOUNTING')) return res.status(403).json({ error: 'OUTLET_AREA_FORBIDDEN' });
  return res.status(403).json({ error: 'ROLE_FORBIDDEN' });
}

/**
 * Middleware: requireAuth + cek group role. `resolve` dapat memilih policy berdasarkan path
 * (dipakai untuk router campuran seperti /api/client-transactions).
 */
export function requireArea(policyOrResolver: AreaPolicy | ((req: Request) => AreaPolicy)) {
  const check = async (req: Request, res: Response, next: NextFunction) => {
    const policy = typeof policyOrResolver === 'function' ? policyOrResolver(req) : policyOrResolver;
    const groups = roleGroupsOf(await activeRoleCodes(req.sessionUser!.id));
    if (!policyAllows(groups, policy, req.method)) return deny(res, groups, policy, req.method);
    next();
  };
  return [requireAuth, (req: Request, res: Response, next: NextFunction) => { check(req, res, next).catch(next); }];
}
