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
  | 'audit.view' | 'report.view' | 'approval.act'
  | 'student.view' | 'student.manage'
  | 'fee.view' | 'fee.manage'
  | 'billing.view' | 'billing.generate' | 'invoice.void'
  | 'receipt.view'
  | 'receipt.create'
  | 'receipt.void'
  | 'cashbank.view'
  | 'expense.view' | 'expense.create' | 'expense.manage'
  | 'expense.approve' | 'expense.pay' | 'expense.void'
  | 'accounting.view' | 'journal.post' | 'period.close' | 'coa.manage'
  | 'receivable.view';

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

/* ------------------------------------------------------------------ BILL-01 */

export type StudentRow = {
  id: string;
  nis: string;
  nisn: string | null;
  full_name: string;
  gender: 'L' | 'P' | null;
  birth_date?: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  address?: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  enrollment_id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  academic_year_id: string;
  academic_year_name: string;
  class_label: string | null;
  effective_start: string;
};

export type Enrollment = {
  id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  academic_year_id: string;
  academic_year_name: string;
  class_label: string | null;
  effective_start: string;
  effective_end: string | null;
  status: string;
};

export type FeeType = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  revenue_account_code: string | null;
  recognition_mode: 'IMMEDIATE' | 'DEFERRED';
  status: string;
};

export type FeeScheme = {
  id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  academic_year_id: string;
  academic_year_name: string;
  fee_type_id: string;
  fee_code: string;
  fee_name: string;
  name: string;
  amount: string;
  frequency: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME';
  installment_count: number;
  due_day: number | null;
  effective_start: string;
  effective_end: string | null;
  status: string;
};

export type BillingPreview = {
  unit: { id: string; unit_code: string; unit_name: string };
  academicYear: string;
  periodLabel: string;
  invoiceDate: string;
  dueDate: string;
  alreadyGenerated: boolean;
  studentCount: number;
  installmentCount: number;
  schemes: { feeTypeId: string; feeCode: string; feeName: string; name: string; amount: number; frequency: string; installmentCount: number }[];
  totalPerStudent: number;
  grandTotal: number;
  students: { id: string; nis: string; full_name: string; class_label: string | null }[];
};

export type BillingRun = {
  id: string;
  period_label: string;
  invoice_date: string;
  due_date: string;
  status: string;
  student_count: number;
  invoice_count: number;
  total_amount: string;
  created_at: string;
  unit_code: string;
  unit_name: string;
  academic_year_name: string;
  created_by_name: string | null;
};

export type InvoiceRow = {
  id: string;
  invoice_number: string;
  period_label: string;
  invoice_date: string;
  due_date: string;
  total_amount: string;
  paid_amount: string;
  outstanding: string;
  status: 'ISSUED' | 'PARTIAL' | 'PAID' | 'VOID';
  student_id: string;
  full_name: string;
  nis: string;
  unit_code: string;
  unit_name: string;
};

export type InvoiceDetail = InvoiceRow & {
  guardian_name: string | null;
  academic_year_name: string;
  void_reason: string | null;
  lines: { id: string; fee_type_id: string; description: string; amount: string; sort_order: number }[];
  installments: { id: string; sequence: number; due_date: string; amount: string; paid_amount: string; status: string }[];
};

export type StudentDetail = {
  student: {
    id: string; nis: string; nisn: string | null; full_name: string; gender: 'L' | 'P' | null;
    birth_date: string | null; guardian_name: string | null; guardian_phone: string | null;
    address: string | null; status: string;
  };
  enrollment: Enrollment | null;
  enrollments: Enrollment[];
  invoices: InvoiceRow[];
};

export type ReceivableItem = {
  id: string;
  invoice_number: string;
  period_label: string;
  due_date: string;
  total_amount: string;
  paid_amount: string;
  outstanding: number;
  status: string;
  student_id: string;
  full_name: string;
  nis: string;
  unit_id: string;
  unit_code: string;
  unit_name: string;
  aging_bucket: 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_PLUS';
  days_overdue: number;
};

export type ReceivableSummary = {
  today: string;
  totalOutstanding: number;
  invoiceCount: number;
  aging: { CURRENT: number; D1_30: number; D31_60: number; D61_PLUS: number };
  byUnit: { unit_id: string; unit_code: string; unit_name: string; outstanding: number; invoices: number }[];
  items: ReceivableItem[];
};

export type ReceiptSummary = {
  today: string;
  totalOutstanding: number;
  invoiceCount: number;
  aging: { CURRENT: number; D1_30: number; D31_60: number; D61_PLUS: number };
  byUnit: { unit_id: string; unit_code: string; unit_name: string; outstanding: number; invoices: number }[];
  items: ReceivableItem[];
};

export type ReceiptRow = {
  id: string;
  receipt_number: string;
  receipt_date: string;
  method: 'CASH' | 'TRANSFER' | 'QRIS' | 'OTHER';
  reference_number: string | null;
  payer_name: string | null;
  total_amount: string;
  allocated_amount: string;
  unallocated_amount: string;
  status: 'POSTED' | 'VOID';
  unit_code: string;
  unit_name: string;
  bank_name: string;
  allocation_count: number;
};

export type ReceiptAllocation = {
  id: string;
  amount: string;
  unit_id: string;
  invoice_id: string;
  student_id: string;
  invoice_number: string;
  period_label: string;
  invoice_status: string;
  total_amount: string;
  paid_amount: string;
  full_name: string;
  nis: string;
  unit_code: string;
  unit_name: string;
};

export type ReceiptDetail = ReceiptRow & {
  notes: string | null;
  void_reason: string | null;
  created_by_name: string | null;
  allocations: ReceiptAllocation[];
};

export type BankBalance = {
  id: string;
  bank_name: string;
  account_number: string;
  account_holder: string;
  account_usage: 'CENTRAL' | 'DEDICATED';
  currency: string;
  status: 'ACTIVE' | 'INACTIVE';
  verified_at: string | null;
  total_in: number;
  total_out: number;
  balance: number;
  receipt_unit_ids: string[];
  disbursement_unit_ids: string[];
};

export type BankMutation = {
  id: string;
  mutation_date: string;
  direction: 'IN' | 'OUT';
  amount: string;
  source_type: string;
  source_id: string | null;
  description: string | null;
  bank_name: string;
  account_number: string;
  unit_code: string | null;
  unit_name: string | null;
};

/* ------------------------------------------------------------------ Pengeluaran (FC-01) */

export type ExpenseCategory = {
  id: string;
  code: string;
  name: string;
  expense_account_code: string | null;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
};

export type Vendor = {
  id: string;
  code: string;
  name: string;
  npwp: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_holder: string | null;
  status: 'ACTIVE' | 'INACTIVE';
};

export type ExpenseStatus =
  | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PAID' | 'CANCELLED';

export type ExpenseRow = {
  id: string;
  unit_id: string;
  request_number: string;
  request_date: string;
  due_date: string | null;
  payee_name: string | null;
  description: string;
  amount: string;
  paid_amount: string;
  remaining: string;
  status: ExpenseStatus;
  unit_code: string;
  unit_name: string;
  category_code: string;
  category_name: string;
  vendor_name: string | null;
  created_by_name: string | null;
  payment_count: number;
};

export type ExpensePayment = {
  id: string;
  payment_number: string;
  payment_date: string;
  method: 'CASH' | 'TRANSFER' | 'QRIS' | 'OTHER';
  reference_number: string | null;
  amount: string;
  status: 'POSTED' | 'VOID';
  void_reason: string | null;
  bank_name: string;
  account_number: string;
  account_usage: 'CENTRAL' | 'DEDICATED';
  created_by_name: string | null;
  request_number?: string;
  description?: string;
  unit_code?: string;
  unit_name?: string;
};

export type ExpenseDetail = ExpenseRow & {
  expense_category_id: string;
  vendor_id: string | null;
  notes: string | null;
  rejection_reason: string | null;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  expense_account_code: string | null;
  payments: ExpensePayment[];
};

/* ------------------------------------------------------------------ Akuntansi (ACC-01) */

export type Account = {
  id: string;
  code: string;
  name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normal_balance: 'DEBIT' | 'CREDIT';
  parent_id: string | null;
  is_postable: number;
  status: 'ACTIVE' | 'INACTIVE';
};

export type FiscalPeriod = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'OPEN' | 'CLOSED';
  closed_at: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  closed_by_name: string | null;
};

export type JournalEntryRow = {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  source_type: string;
  source_id: string | null;
  entry_kind: 'ORIGINAL' | 'REVERSAL';
  status: 'POSTED' | 'REVERSED';
  unit_code: string | null;
  unit_name: string | null;
  created_by_name: string | null;
  total_debit: string;
};

export type JournalLine = {
  id: string;
  line_no: number;
  description: string | null;
  debit: string;
  credit: string;
  account_code: string;
  account_name: string;
  account_type: string;
  unit_code: string | null;
  unit_name: string | null;
};

export type JournalEntryDetail = JournalEntryRow & {
  period_name: string;
  lines: JournalLine[];
};

export type TrialBalanceItem = {
  code: string;
  name: string;
  account_type: string;
  normal_balance: 'DEBIT' | 'CREDIT';
  debit: number;
  credit: number;
  balance: number;
};

export type TrialBalance = {
  from: string;
  to: string;
  items: TrialBalanceItem[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
};

export type Reconciliation = {
  asOf: string;
  receivable: { gl: number; subledger: number; difference: number };
  deposit: { gl: number; subledger: number; difference: number };
  cash: {
    gl: number; mutations: number; manualAdjustments: number;
    difference: number; unexplained: number;
  };
  balanced: boolean;
};

export type LedgerRow = {
  id: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  entry_description: string;
  source_type: string;
  account_code: string;
  account_name: string;
  description: string | null;
  debit: string;
  credit: string;
  unit_code: string | null;
  unit_name: string | null;
};

/* ------------------------------------------------------------------ Laporan (RPT-01) */

export type ReportTotals = {
  billed: number;
  collected: number;
  expenses: number;
  surplus: number;
  outstanding: number;
  students: number;
  invoiceCount: number;
  receiptCount: number;
  paymentCount: number;
};

export type ReportUnitRow = {
  unit_id: string;
  unit_code: string;
  unit_name: string;
  level_id: string | null;
  level_code: string | null;
  level_name: string | null;
  billed: number;
  collected: number;
  expenses: number;
  surplus: number;
  outstanding: number;
  students: number;
  invoice_count: number;
  receipt_count: number;
  payment_count: number;
  open_invoices: number;
};

export type ReportLevelRow = {
  level_id: string | null;
  level_code: string;
  level_name: string;
  billed: number;
  collected: number;
  expenses: number;
  surplus: number;
  outstanding: number;
  students: number;
  units: number;
};

export type ReportOverview = {
  from: string;
  to: string;
  totals: ReportTotals;
  units: ReportUnitRow[];
  byLevel: ReportLevelRow[];
  aging: { CURRENT: number; D1_30: number; D31_60: number; D61_PLUS: number };
  closing: { name: string; status: string; start_date: string; end_date: string }[];
};

export type ReportPosition = {
  asOf: string;
  assets: number;
  liabilities: number;
  equity: number;
  revenue: number;
  expense: number;
  netIncome: number;
  liabilitiesAndEquity: number;
  difference: number;
  balanced: boolean;
};

export type ReportActivity = {
  from: string;
  to: string;
  items: { code: string; name: string; account_type: 'REVENUE' | 'EXPENSE'; amount: number }[];
  revenue: number;
  expense: number;
  surplus: number;
};

export type ReportCashFlow = {
  from: string;
  to: string;
  opening: number;
  movements: { source_type: string; label: string; amount: number }[];
  netChange: number;
  closing: number;
  inflow: number;
  outflow: number;
};

export type DrilldownRow = {
  id: string;
  document_number: string;
  document_date: string;
  amount: string;
  status: string;
  party: string | null;
  reference: string | null;
  unit_code: string;
  unit_name: string;
};

export type Drilldown = {
  metric: string;
  from: string;
  to: string;
  rows: DrilldownRow[];
  total: number;
  sumAmount: number;
  page: number;
  pageSize: number;
};
