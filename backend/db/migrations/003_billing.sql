SET time_zone = '+00:00';

/* ------------------------------------------------------------------ Siswa & enrollment */

CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  nis VARCHAR(30) NOT NULL,
  nisn VARCHAR(20) NULL,
  full_name VARCHAR(150) NOT NULL,
  gender CHAR(1) NULL,
  birth_date DATE NULL,
  guardian_name VARCHAR(150) NULL,
  guardian_phone VARCHAR(50) NULL,
  address VARCHAR(255) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_students_entity_nis (legal_entity_id, nis),
  KEY idx_students_name (full_name),
  CONSTRAINT fk_students_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_students_gender CHECK (gender IS NULL OR gender IN ('L','P')),
  CONSTRAINT chk_students_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS student_enrollments (
  id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  academic_year_id CHAR(36) NOT NULL,
  class_label VARCHAR(50) NULL,
  effective_start DATE NOT NULL,
  effective_end DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enrollment (student_id, unit_id, academic_year_id, effective_start),
  KEY idx_enrollment_unit_year (unit_id, academic_year_id, status),
  KEY idx_enrollment_student (student_id, status),
  CONSTRAINT fk_enrollment_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_enrollment_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_enrollment_year FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) ON DELETE RESTRICT,
  CONSTRAINT chk_enrollment_status CHECK (status IN ('ACTIVE','MOVED','COMPLETED','INACTIVE')),
  CONSTRAINT chk_enrollment_range CHECK (effective_end IS NULL OR effective_end >= effective_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Tarif */

CREATE TABLE IF NOT EXISTS fee_types (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(255) NULL,
  revenue_account_code VARCHAR(30) NULL,
  recognition_mode VARCHAR(16) NOT NULL DEFAULT 'IMMEDIATE',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fee_types_code (legal_entity_id, code),
  CONSTRAINT fk_fee_types_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_fee_types_recognition CHECK (recognition_mode IN ('IMMEDIATE','DEFERRED')),
  CONSTRAINT chk_fee_types_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS fee_schemes (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  education_level_id CHAR(36) NULL,
  academic_year_id CHAR(36) NOT NULL,
  fee_type_id CHAR(36) NOT NULL,
  name VARCHAR(150) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  frequency VARCHAR(16) NOT NULL DEFAULT 'MONTHLY',
  installment_count INT NOT NULL DEFAULT 1,
  due_day INT NULL,
  effective_start DATE NOT NULL,
  effective_end DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fee_scheme (unit_id, academic_year_id, fee_type_id, effective_start),
  KEY idx_fee_scheme_lookup (unit_id, academic_year_id, status),
  CONSTRAINT fk_fee_scheme_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_scheme_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_scheme_level FOREIGN KEY (education_level_id) REFERENCES education_levels (id) ON DELETE SET NULL,
  CONSTRAINT fk_fee_scheme_year FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fee_scheme_type FOREIGN KEY (fee_type_id) REFERENCES fee_types (id) ON DELETE RESTRICT,
  CONSTRAINT chk_fee_scheme_amount CHECK (amount > 0),
  CONSTRAINT chk_fee_scheme_frequency CHECK (frequency IN ('MONTHLY','ANNUAL','ONE_TIME')),
  CONSTRAINT chk_fee_scheme_installments CHECK (installment_count BETWEEN 1 AND 12),
  CONSTRAINT chk_fee_scheme_range CHECK (effective_end IS NULL OR effective_end >= effective_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Tagihan */

CREATE TABLE IF NOT EXISTS billing_runs (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  academic_year_id CHAR(36) NOT NULL,
  period_label VARCHAR(20) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ISSUED',
  student_count INT NOT NULL DEFAULT 0,
  invoice_count INT NOT NULL DEFAULT 0,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_run (unit_id, academic_year_id, period_label),
  KEY idx_billing_unit (unit_id, created_at),
  CONSTRAINT fk_billing_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_billing_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_billing_year FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) ON DELETE RESTRICT,
  CONSTRAINT chk_billing_status CHECK (status IN ('DRAFT','ISSUED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  academic_year_id CHAR(36) NOT NULL,
  billing_run_id CHAR(36) NULL,
  invoice_number VARCHAR(60) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  period_label VARCHAR(20) NOT NULL,
  total_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ISSUED',
  void_reason VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_number (legal_entity_id, invoice_number),
  KEY idx_invoice_unit_status (unit_id, status),
  KEY idx_invoice_student (student_id, invoice_date),
  CONSTRAINT fk_invoice_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_year FOREIGN KEY (academic_year_id) REFERENCES academic_years (id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoice_run FOREIGN KEY (billing_run_id) REFERENCES billing_runs (id) ON DELETE SET NULL,
  CONSTRAINT chk_invoice_status CHECK (status IN ('ISSUED','PARTIAL','PAID','VOID')),
  CONSTRAINT chk_invoice_amount CHECK (total_amount >= 0 AND paid_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id CHAR(36) NOT NULL,
  invoice_id CHAR(36) NOT NULL,
  fee_type_id CHAR(36) NOT NULL,
  description VARCHAR(150) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_invoice_lines (invoice_id),
  CONSTRAINT fk_invoice_line_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoice_line_type FOREIGN KEY (fee_type_id) REFERENCES fee_types (id) ON DELETE RESTRICT,
  CONSTRAINT chk_invoice_line_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS invoice_installments (
  id CHAR(36) NOT NULL,
  invoice_id CHAR(36) NOT NULL,
  sequence INT NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'UNPAID',
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoice_installment (invoice_id, sequence),
  CONSTRAINT fk_installment_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE CASCADE,
  CONSTRAINT chk_installment_status CHECK (status IN ('UNPAID','PARTIAL','PAID','VOID')),
  CONSTRAINT chk_installment_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
