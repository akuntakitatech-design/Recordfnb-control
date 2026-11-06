import type { NextFunction, Request, Response } from 'express';
import { query } from './db.js';
import type { SessionUser } from './auth.js';

/**
 * Katalog permission = daftar seluruh kewenangan yang dikenal aplikasi.
 *
 * Setiap kali sebuah fitur menambah kewenangan baru, cukup tambahkan di sini:
 * - katalog tersinkron otomatis ke tabel `permissions` saat backend start;
 * - role sistem (lihat ROLE_DEFINITIONS) otomatis mendapat kewenangan baru itu;
 * - role buatan sendiri tidak otomatis, admin mencentangnya sendiri.
 */
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
  | 'payment_request.create'
  | 'payment_request.approve'
  | 'attachment.upload'
  | 'transaction.delete'
  | 'accounting.view'
  | 'journal.post'
  | 'period.close'
  | 'coa.manage'
  | 'user.manage'
  | 'role.manage'
  | 'audit.view'
  | 'report.view'
  | 'approval.act';

export type PermissionItem = {
  code: Permission;
  group: string;
  label: string;
  description: string;
};

export const PERMISSION_CATALOG: PermissionItem[] = [
  { code: 'entity.manage', group: 'Organisasi & Unit', label: 'Ubah profil yayasan', description: 'Nama, NPSN, alamat badan hukum.' },
  { code: 'unit.view', group: 'Organisasi & Unit', label: 'Lihat unit & cabang', description: 'Daftar dan detail unit.' },
  { code: 'unit.create', group: 'Organisasi & Unit', label: 'Tambah unit', description: 'Membuat unit baru.' },
  { code: 'unit.edit', group: 'Organisasi & Unit', label: 'Edit unit', description: 'Mengubah identitas dan pengaturan unit.' },
  { code: 'unit.activate', group: 'Organisasi & Unit', label: 'Aktifkan unit', description: 'Mengaktifkan unit berstatus draft.' },
  { code: 'unit.deactivate', group: 'Organisasi & Unit', label: 'Nonaktifkan unit', description: 'Menghentikan operasi unit.' },
  { code: 'unit.finance', group: 'Organisasi & Unit', label: 'Atur kesiapan keuangan', description: 'Mapping rekening & akun unit.' },

  { code: 'bank.view', group: 'Rekening & Bank', label: 'Lihat rekening', description: 'Daftar rekening dan mutasinya.' },
  { code: 'bank.manage', group: 'Rekening & Bank', label: 'Kelola rekening', description: 'Tambah, edit, verifikasi, nonaktifkan rekening.' },
  { code: 'bank.assign', group: 'Rekening & Bank', label: 'Mapping rekening ke unit', description: 'Menetapkan rekening penerimaan/pembayaran per unit.' },

  { code: 'student.view', group: 'Siswa & Tarif', label: 'Lihat siswa', description: 'Data siswa dan penempatan unit.' },
  { code: 'student.manage', group: 'Siswa & Tarif', label: 'Kelola siswa', description: 'Tambah/edit siswa dan pindah unit.' },
  { code: 'fee.view', group: 'Siswa & Tarif', label: 'Lihat tarif', description: 'Jenis biaya dan tarif per unit.' },
  { code: 'fee.manage', group: 'Siswa & Tarif', label: 'Kelola tarif', description: 'Mengubah jenis biaya dan tarif.' },

  { code: 'billing.view', group: 'Tagihan & Piutang', label: 'Lihat tagihan', description: 'Daftar dan rincian tagihan.' },
  { code: 'billing.generate', group: 'Tagihan & Piutang', label: 'Terbitkan tagihan', description: 'Generate tagihan per unit & periode.' },
  { code: 'invoice.void', group: 'Tagihan & Piutang', label: 'Batalkan tagihan', description: 'Void tagihan beserta jurnalnya.' },
  { code: 'receivable.view', group: 'Tagihan & Piutang', label: 'Lihat piutang', description: 'Piutang dan aging.' },

  { code: 'receipt.view', group: 'Penerimaan & Kas', label: 'Lihat penerimaan', description: 'Kwitansi dan alokasinya.' },
  { code: 'receipt.create', group: 'Penerimaan & Kas', label: 'Catat penerimaan', description: 'Menerima pembayaran dan mengalokasikannya.' },
  { code: 'receipt.void', group: 'Penerimaan & Kas', label: 'Batalkan penerimaan', description: 'Void kwitansi dan memulihkan tagihan.' },
  { code: 'cashbank.view', group: 'Penerimaan & Kas', label: 'Lihat saldo & mutasi', description: 'Saldo rekening dan mutasi kas/bank.' },

  { code: 'expense.view', group: 'Pengeluaran', label: 'Lihat pengajuan', description: 'Daftar dan detail pengajuan pembelian serta MCM.' },
  { code: 'expense.create', group: 'Pengeluaran', label: 'Buat & ubah pengajuan', description: 'Membuat, mengedit, dan mengajukan pengeluaran.' },
  { code: 'expense.manage', group: 'Pengeluaran', label: 'Kelola master pengeluaran', description: 'Jenis biaya dan vendor.' },
  { code: 'expense.approve', group: 'Pengeluaran', label: 'Setujui pengajuan', description: 'Menyetujui atau menolak pengajuan.' },
  { code: 'expense.pay', group: 'Pengeluaran', label: 'Bayar & posting', description: 'Mencatat pembayaran dan posting MCM.' },
  { code: 'expense.void', group: 'Pengeluaran', label: 'Batalkan pembayaran', description: 'Void pembayaran dan jurnal balik.' },
  { code: 'payment_request.create', group: 'Pengeluaran', label: 'Buat MCM', description: 'Membuat dan mengajukan MCM (pengajuan pembayaran).' },
  { code: 'payment_request.approve', group: 'Pengeluaran', label: 'Setujui MCM', description: 'Menyetujui atau menolak MCM.' },
  { code: 'attachment.upload', group: 'Pengeluaran', label: 'Unggah lampiran', description: 'Menambahkan bukti dokumen pada transaksi.' },
  { code: 'transaction.delete', group: 'Pengeluaran', label: 'Hapus permanen transaksi', description: 'Menghapus pengajuan/MCM beserta lampirannya.' },

  { code: 'accounting.view', group: 'Akuntansi', label: 'Lihat akuntansi', description: 'CoA, jurnal, neraca saldo, buku besar.' },
  { code: 'journal.post', group: 'Akuntansi', label: 'Posting jurnal', description: 'Jurnal manual dan jurnal pembalik.' },
  { code: 'period.close', group: 'Akuntansi', label: 'Tutup/buka periode', description: 'Menutup dan membuka kembali periode fiskal.' },
  { code: 'coa.manage', group: 'Akuntansi', label: 'Kelola bagan akun', description: 'Menambah dan mengubah akun (CoA).' },

  { code: 'report.view', group: 'Laporan', label: 'Lihat laporan', description: 'Laporan yayasan dan drill-down.' },
  { code: 'approval.act', group: 'Persetujuan', label: 'Bertindak sebagai penyetuju', description: 'Menyetujui dokumen pada alur approval.' },

  { code: 'user.manage', group: 'Administrasi', label: 'Kelola pengguna', description: 'Menambah, mengubah, dan mereset pengguna.' },
  { code: 'role.manage', group: 'Administrasi', label: 'Kelola role & kewenangan', description: 'Mengatur role dan kewenangan tiap jabatan.' },
  { code: 'audit.view', group: 'Administrasi', label: 'Lihat audit trail', description: 'Jejak audit seluruh aktivitas.' },
];

export type RoleDefinition = {
  code: string;
  name: string;
  description: string;
  isGlobal: boolean;
  sortOrder: number;
  permissions: Permission[];
};

/** Role bawaan. `is_system = 1` berarti tidak bisa dihapus dan otomatis mengikuti fitur baru. */
export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    code: 'PIMPINAN',
    name: 'Pimpinan Yayasan',
    description: 'Monitoring semua cabang dan persetujuan.',
    isGlobal: true,
    sortOrder: 10,
    permissions: [
      'unit.view', 'bank.view', 'report.view', 'audit.view', 'approval.act',
      'student.view', 'fee.view', 'billing.view', 'receivable.view',
      'receipt.view', 'cashbank.view',
      'expense.view', 'expense.approve',
      'payment_request.approve',
      'accounting.view',
    ],
  },
  {
    code: 'ADMIN_YAYASAN',
    name: 'Admin Yayasan',
    description: 'Organisasi, pengguna, role, rekening, dan unit.',
    isGlobal: true,
    sortOrder: 20,
    permissions: [
      'entity.manage', 'unit.view', 'unit.create', 'unit.edit', 'unit.activate', 'unit.deactivate',
      'unit.finance', 'bank.view', 'bank.manage', 'bank.assign', 'user.manage', 'role.manage',
      'audit.view', 'report.view',
      'student.view', 'student.manage', 'fee.view', 'fee.manage', 'billing.view', 'billing.generate',
      'invoice.void', 'receivable.view', 'receipt.view', 'receipt.create', 'receipt.void', 'cashbank.view',
      'expense.view', 'expense.create', 'expense.manage', 'expense.approve', 'expense.pay', 'expense.void',
      'payment_request.create', 'payment_request.approve',
      'attachment.upload', 'transaction.delete',
      'accounting.view', 'coa.manage',
    ],
  },
  {
    code: 'FINANCE_PUSAT',
    name: 'Finance Pusat',
    description: 'Rekening, penagihan, penerimaan, pembayaran, dan MCM seluruh unit.',
    isGlobal: true,
    sortOrder: 30,
    permissions: [
      'unit.view', 'bank.view', 'bank.manage', 'bank.assign', 'report.view',
      'student.view', 'fee.view', 'billing.view', 'billing.generate', 'invoice.void', 'receivable.view',
      'receipt.view', 'receipt.create', 'receipt.void', 'cashbank.view',
      'expense.view', 'expense.create', 'expense.manage', 'expense.approve', 'expense.pay', 'expense.void',
      'payment_request.create',
      'attachment.upload',
      'accounting.view',
    ],
  },
  {
    code: 'ACCOUNTING_PUSAT',
    name: 'Accounting Pusat',
    description: 'Mapping akun, jurnal, dan tutup buku.',
    isGlobal: true,
    sortOrder: 40,
    permissions: [
      'unit.view', 'unit.finance', 'bank.view', 'report.view', 'audit.view',
      'student.view', 'fee.view', 'fee.manage', 'billing.view', 'invoice.void', 'receivable.view',
      'receipt.view', 'receipt.void', 'cashbank.view',
      'expense.view', 'expense.manage', 'expense.approve', 'expense.void',
      'accounting.view', 'journal.post', 'period.close', 'coa.manage',
    ],
  },
  {
    code: 'KEPALA_JENJANG',
    name: 'Kepala Jenjang',
    description: 'Monitoring dan persetujuan pada jenjang yang ditetapkan.',
    isGlobal: false,
    sortOrder: 50,
    permissions: [
      'unit.view', 'report.view', 'approval.act', 'student.view', 'fee.view', 'billing.view', 'receivable.view',
      'receipt.view', 'cashbank.view', 'expense.view', 'expense.approve',
      'accounting.view',
    ],
  },
  {
    code: 'KEPALA_CABANG',
    name: 'Kepala Cabang',
    description: 'Monitoring dan persetujuan unit sendiri.',
    isGlobal: false,
    sortOrder: 60,
    permissions: [
      'unit.view', 'report.view', 'approval.act', 'student.view', 'fee.view', 'billing.view', 'receivable.view',
      'receipt.view', 'cashbank.view', 'expense.view', 'expense.create', 'expense.approve',
      'attachment.upload',
      'accounting.view',
    ],
  },
  {
    code: 'BENDAHARA_CABANG',
    name: 'Bendahara Cabang',
    description: 'Input transaksi dan pembayaran pada unit sendiri.',
    isGlobal: false,
    sortOrder: 70,
    permissions: [
      'unit.view', 'report.view', 'student.view', 'student.manage', 'fee.view',
      'billing.view', 'billing.generate', 'receivable.view',
      'receipt.view', 'receipt.create', 'cashbank.view',
      'expense.view', 'expense.create', 'expense.pay',
      'attachment.upload',
      'accounting.view',
    ],
  },
  {
    code: 'PURCHASING',
    name: 'Purchasing',
    description: 'Pengaju pembelian pada unit yang ditetapkan.',
    isGlobal: false,
    sortOrder: 80,
    permissions: [
      'unit.view', 'report.view', 'student.view', 'fee.view', 'billing.view',
      'receipt.view', 'cashbank.view',
      'expense.view', 'expense.create',
      'attachment.upload',
    ],
  },
  {
    code: 'AUDITOR',
    name: 'Auditor',
    description: 'Read-only dan audit trail.',
    isGlobal: true,
    sortOrder: 90,
    permissions: [
      'unit.view', 'bank.view', 'audit.view', 'report.view', 'student.view', 'fee.view', 'billing.view',
      'receivable.view', 'receipt.view', 'cashbank.view', 'expense.view',
      'accounting.view',
    ],
  },
];

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLE_DEFINITIONS.map(role => [role.code, role.name]),
);

export type RoleState = {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  isGlobal: boolean;
  status: string;
  permissions: Set<string>;
};

/**
 * Cache role -> kewenangan. Dibaca dari DB saat startup dan diperbarui setiap
 * kali role disimpan, sehingga `hasPermission` tetap sinkron di seluruh route.
 */
const cache = new Map<string, RoleState>();

function fallbackRole(code: string): RoleState | undefined {
  const definition = ROLE_DEFINITIONS.find(role => role.code === code);
  if (!definition) return undefined;
  return {
    id: definition.code,
    code: definition.code,
    name: definition.name,
    isSystem: true,
    isGlobal: definition.isGlobal,
    status: 'ACTIVE',
    permissions: new Set(definition.permissions),
  };
}

export async function refreshRoleCache(): Promise<void> {
  const roles = await query<any>('SELECT id,code,name,is_system,is_global,status FROM roles');
  const grants = await query<any>('SELECT role_id,permission FROM role_permissions');
  const byRoleId = new Map<string, Set<string>>();
  for (const grant of grants) {
    const set = byRoleId.get(grant.role_id) || new Set<string>();
    set.add(grant.permission);
    byRoleId.set(grant.role_id, set);
  }
  const next = new Map<string, RoleState>();
  for (const role of roles) {
    next.set(role.code, {
      id: role.id,
      code: role.code,
      name: role.name,
      isSystem: Boolean(role.is_system),
      isGlobal: Boolean(role.is_global),
      status: role.status,
      permissions: byRoleId.get(role.id) || new Set<string>(),
    });
  }
  cache.clear();
  for (const [code, state] of next) cache.set(code, state);
}

export function roleState(code: string): RoleState | undefined {
  return cache.get(code) || fallbackRole(code);
}

export function roleIsActive(code: string): boolean {
  const state = roleState(code);
  return Boolean(state && state.status === 'ACTIVE');
}

export function isGlobalRole(role: string): boolean {
  return roleState(role)?.isGlobal === true;
}

export function permissionsOf(role: string): string[] {
  return [...(roleState(role)?.permissions || [])];
}

export function hasPermission(role: string, permission: Permission): boolean {
  return roleState(role)?.permissions.has(permission) === true;
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

/** Lolos bila pengguna punya salah satu dari permission yang diminta. */
export function requireAnyPermission(permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    const allowed = permissions.some(permission => hasPermission(req.user!.role, permission));
    if (!allowed) return res.status(403).json({ error: 'PERMISSION_DENIED', permission: permissions[0] });
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
