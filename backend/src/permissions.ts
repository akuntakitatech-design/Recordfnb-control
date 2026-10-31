import type { NextFunction, Request, Response } from 'express';
import { query } from './db.js';
import type { SessionUser, UserRole } from './auth.js';

export type Permission =
  | 'entity.manage'
  | 'unit.view'
  | 'unit.create'
  | 'unit.edit'
  | 'unit.activate'
  | 'unit.deactivate'
  | 'unit.finance'
  | 'bank.view'
  | 'bank.manage'
  | 'bank.assign'
  | 'student.view'
  | 'student.manage'
  | 'fee.view'
  | 'fee.manage'
  | 'billing.view'
  | 'billing.generate'
  | 'invoice.void'
  | 'receivable.view'
  | 'receipt.view'
  | 'receipt.create'
  | 'receipt.void'
  | 'cashbank.view'
  | 'expense.view'
  | 'expense.create'
  | 'expense.manage'
  | 'expense.approve'
  | 'expense.pay'
  | 'expense.void'
  | 'user.manage'
  | 'audit.view'
  | 'report.view'
  | 'approval.act';

export const ROLE_LABEL: Record<UserRole, string> = {
  PIMPINAN: 'Pimpinan Yayasan',
  ADMIN_YAYASAN: 'Admin Yayasan',
  FINANCE_PUSAT: 'Finance Pusat',
  ACCOUNTING_PUSAT: 'Accounting Pusat',
  KEPALA_JENJANG: 'Kepala Jenjang',
  KEPALA_CABANG: 'Kepala Cabang',
  BENDAHARA_CABANG: 'Bendahara Cabang',
  AUDITOR: 'Auditor',
};

const PERMISSIONS: Record<UserRole, Permission[]> = {
  PIMPINAN: [
    'unit.view', 'bank.view', 'report.view', 'audit.view', 'approval.act',
    'student.view', 'fee.view', 'billing.view', 'receivable.view',
    'receipt.view', 'cashbank.view',
    'expense.view', 'expense.approve',
  ],
  ADMIN_YAYASAN: [
    'entity.manage', 'unit.view', 'unit.create', 'unit.edit', 'unit.activate', 'unit.deactivate',
    'unit.finance', 'bank.view', 'bank.manage', 'bank.assign', 'user.manage', 'audit.view', 'report.view',
    'student.view', 'student.manage', 'fee.view', 'fee.manage', 'billing.view', 'billing.generate',
    'invoice.void', 'receivable.view', 'receipt.view', 'receipt.create', 'receipt.void', 'cashbank.view',
    'expense.view', 'expense.create', 'expense.manage', 'expense.approve', 'expense.pay', 'expense.void',
  ],
  FINANCE_PUSAT: [
    'unit.view', 'bank.view', 'bank.manage', 'bank.assign', 'report.view',
    'student.view', 'fee.view', 'billing.view', 'billing.generate', 'invoice.void', 'receivable.view',
    'receipt.view', 'receipt.create', 'receipt.void', 'cashbank.view',
    'expense.view', 'expense.create', 'expense.manage', 'expense.approve', 'expense.pay', 'expense.void',
  ],
  ACCOUNTING_PUSAT: [
    'unit.view', 'unit.finance', 'bank.view', 'report.view', 'audit.view',
    'student.view', 'fee.view', 'fee.manage', 'billing.view', 'invoice.void', 'receivable.view',
    'receipt.view', 'receipt.void', 'cashbank.view',
    'expense.view', 'expense.manage', 'expense.approve', 'expense.void',
  ],
  KEPALA_JENJANG: [
    'unit.view', 'report.view', 'approval.act', 'student.view', 'fee.view', 'billing.view', 'receivable.view',
    'receipt.view', 'cashbank.view', 'expense.view', 'expense.approve',
  ],
  KEPALA_CABANG: [
    'unit.view', 'report.view', 'approval.act', 'student.view', 'fee.view', 'billing.view', 'receivable.view',
    'receipt.view', 'cashbank.view', 'expense.view', 'expense.create', 'expense.approve',
  ],
  BENDAHARA_CABANG: [
    'unit.view', 'report.view', 'student.view', 'student.manage', 'fee.view',
    'billing.view', 'billing.generate', 'receivable.view',
    'receipt.view', 'receipt.create', 'cashbank.view',
    'expense.view', 'expense.create', 'expense.pay',
  ],
  AUDITOR: [
    'unit.view', 'bank.view', 'audit.view', 'report.view', 'student.view', 'fee.view', 'billing.view',
    'receivable.view', 'receipt.view', 'cashbank.view', 'expense.view',
  ],
};

const GLOBAL_ROLES = new Set<UserRole>([
  'PIMPINAN', 'ADMIN_YAYASAN', 'FINANCE_PUSAT', 'ACCOUNTING_PUSAT', 'AUDITOR',
]);

export function isGlobalRole(role: UserRole): boolean {
  return GLOBAL_ROLES.has(role);
}

export function permissionsOf(role: UserRole): Permission[] {
  return PERMISSIONS[role] || [];
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'PERMISSION_DENIED', permission });
    }
    next();
  };
}

/** null = akses ke semua unit (role pusat). */
export async function allowedUnitIds(user: SessionUser): Promise<string[] | null> {
  if (isGlobalRole(user.role)) return null;
  const rows = await query<{ unit_id: string }>('SELECT unit_id FROM user_unit_access WHERE user_id=?', [user.id]);
  return rows.map(row => row.unit_id);
}

export async function canAccessUnit(user: SessionUser, unitId: string): Promise<boolean> {
  const allowed = await allowedUnitIds(user);
  return allowed === null || allowed.includes(unitId);
}

export async function accessibleUnitIds(user: SessionUser): Promise<string[]> {
  if (isGlobalRole(user.role)) return (await query<{ id: string }>('SELECT id FROM organization_units')).map(row => row.id);
  return (await allowedUnitIds(user)) || [];
}
