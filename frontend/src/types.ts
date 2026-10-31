export const ROLES = [
  'PIMPINAN',
  'ADMIN_YAYASAN',
  'FINANCE_PUSAT',
  'ACCOUNTING_PUSAT',
  'KEPALA_JENJANG',
  'KEPALA_CABANG',
  'BENDAHARA_CABANG',
  'AUDITOR',
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  PIMPINAN: 'Pimpinan Yayasan',
  ADMIN_YAYASAN: 'Admin Yayasan',
  FINANCE_PUSAT: 'Finance Pusat',
  ACCOUNTING_PUSAT: 'Accounting Pusat',
  KEPALA_JENJANG: 'Kepala Jenjang',
  KEPALA_CABANG: 'Kepala Cabang',
  BENDAHARA_CABANG: 'Bendahara Cabang',
  AUDITOR: 'Auditor',
};

export type Permission =
  | 'entity.manage' | 'unit.view' | 'unit.create' | 'unit.edit' | 'unit.activate' | 'unit.deactivate'
  | 'unit.finance' | 'bank.view' | 'bank.manage' | 'bank.assign' | 'user.manage'
  | 'audit.view' | 'report.view' | 'approval.act';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
};

export type Session = {
  user: SessionUser;
  permissions: Permission[];
  unitScope: string[] | null;
};

export type LegalEntity = {
  id: string;
  code: string;
  name: string;
  npsn: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  updated_at?: string;
};

export type EducationLevel = { id: string; code: string; name: string; sort_order: number; status: string };
export type SchoolGroup = { id: string; code: string; name: string; level_name?: string; education_level_id?: string; status: string };
export type OfficialSchool = {
  id: string; name: string; npsn: string | null; level_name?: string; education_level_id?: string;
  verification_status: 'UNVERIFIED' | 'VERIFIED'; government_reference: string | null; status: string;
};
export type SchoolLocation = {
  id: string; name: string; address: string | null; province: string | null; city: string | null;
  district: string | null; postal_code: string | null; phone: string | null; status: string;
};
export type AcademicYear = { id: string; name: string; start_date: string; end_date: string; status: string };

export type Unit = {
  id: string;
  legal_entity_id: string;
  education_level_id: string;
  school_group_id: string | null;
  official_school_id: string | null;
  location_id: string | null;
  unit_code: string;
  unit_name: string;
  short_name: string | null;
  unit_type: 'HEAD_OFFICE' | 'SCHOOL_BRANCH';
  operational_status: 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  finance_status: 'NOT_CONFIGURED' | 'READY' | 'BLOCKED';
  address: string | null;
  head_user_id: string | null;
  head_user_name?: string | null;
  default_academic_year_id: string | null;
  academic_year_name?: string | null;
  effective_start: string | null;
  effective_end: string | null;
  notes: string | null;
  level_name?: string;
  level_code?: string;
  group_name?: string | null;
  official_school_name?: string | null;
  location_name?: string | null;
  bank_assignments?: number;
  created_at?: string;
  updated_at?: string;
};

export type ReadinessCheck = { field: string; label: string; ok: boolean; required: boolean };
export type Readiness = {
  unitId: string;
  unitCode: string;
  unitName: string;
  accountMode: 'CENTRAL_ONLY' | 'DEDICATED_ONLY' | 'MIXED';
  status: 'READY' | 'NOT_CONFIGURED';
  checks: ReadinessCheck[];
  missingFields: { field: string; message: string }[];
};

export type UnitFinanceSettings = {
  unit_id: string;
  account_mode: 'CENTRAL_ONLY' | 'DEDICATED_ONLY' | 'MIXED';
  receivable_account_code: string | null;
  cash_account_code: string | null;
  revenue_account_code: string | null;
};

export type UnitAssignment = {
  id: string;
  usage_type: 'CENTRAL_SHARED' | 'UNIT_DEDICATED';
  allow_receipt: boolean;
  allow_disbursement: boolean;
  is_default_receipt: boolean;
  is_default_disbursement: boolean;
  effective_start: string;
  effective_end: string | null;
  status: string;
  bank_account_id: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  account_usage: 'CENTRAL' | 'DEDICATED';
  bank_status: string;
  verified_at: string | null;
};

export type AuditLog = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  reason: string | null;
  created_at: string;
  user_id: string | null;
  user_name?: string | null;
  user_email?: string | null;
  before_data?: unknown;
  after_data?: unknown;
};

export type UnitDetail = Unit & {
  settings: UnitFinanceSettings | null;
  assignments: UnitAssignment[];
  readiness: Readiness;
  auditLogs: AuditLog[];
};

export type BankAccount = {
  id: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  account_usage: 'CENTRAL' | 'DEDICATED';
  currency: string;
  gl_account_code: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  verified_at: string | null;
  unit_count: number;
  created_at: string;
};

export type AppUser = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  units: { unit_id: string; unit_code: string; unit_name: string }[];
};

export type DashboardData = {
  legalEntity: { id: string; code: string; name: string };
  unitsTotal: number;
  unitsByStatus: { status: string; total: number }[];
  financeByStatus: { status: string; total: number }[];
  readyUnits: number;
  counts: { banks: number; users: number };
  needConfig: {
    id: string; unit_code: string; unit_name: string;
    operational_status: string; finance_status: string;
  }[];
  recentAudit: AuditLog[];
};

export type Hierarchy = {
  legalEntity: LegalEntity;
  levels: EducationLevel[];
  groups: SchoolGroup[];
  schools: OfficialSchool[];
  locations: SchoolLocation[];
  academicYears: AcademicYear[];
  units: { id: string; unit_code: string; unit_name: string; operational_status: string; finance_status: string; education_level_id: string; level_name: string }[];
};
