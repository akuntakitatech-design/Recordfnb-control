SET time_zone = '+00:00';

/* ------------------------------------------------------------------ Akses */

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(191) NOT NULL,
  password_hash VARCHAR(191) NOT NULL,
  full_name VARCHAR(191) NOT NULL,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_role CHECK (role IN ('PIMPINAN','ADMIN_YAYASAN','FINANCE_PUSAT','ACCOUNTING_PUSAT','KEPALA_JENJANG','KEPALA_CABANG','BENDAHARA_CABANG','AUDITOR')),
  CONSTRAINT chk_users_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Organisasi */

CREATE TABLE IF NOT EXISTS legal_entities (
  id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(191) NOT NULL,
  npsn VARCHAR(8) NULL,
  address VARCHAR(255) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(191) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_entities_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS education_levels (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_levels_entity_code (legal_entity_id, code),
  CONSTRAINT fk_levels_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS school_groups (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  education_level_id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_groups_entity_code (legal_entity_id, code),
  CONSTRAINT fk_groups_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_groups_level FOREIGN KEY (education_level_id) REFERENCES education_levels (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS official_schools (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  education_level_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  npsn VARCHAR(8) NULL,
  verification_status VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED',
  government_reference VARCHAR(100) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_schools_npsn (npsn),
  CONSTRAINT fk_schools_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_schools_level FOREIGN KEY (education_level_id) REFERENCES education_levels (id) ON DELETE RESTRICT,
  CONSTRAINT chk_schools_verification CHECK (verification_status IN ('UNVERIFIED','VERIFIED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS school_locations (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  name VARCHAR(150) NOT NULL,
  address VARCHAR(255) NULL,
  province VARCHAR(100) NULL,
  city VARCHAR(100) NULL,
  district VARCHAR(100) NULL,
  postal_code VARCHAR(10) NULL,
  phone VARCHAR(50) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_locations_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS academic_years (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  name VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_academic_year (legal_entity_id, name),
  CONSTRAINT fk_academic_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_academic_range CHECK (end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Unit / cabang */

CREATE TABLE IF NOT EXISTS organization_units (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  education_level_id CHAR(36) NOT NULL,
  school_group_id CHAR(36) NULL,
  official_school_id CHAR(36) NULL,
  location_id CHAR(36) NULL,
  unit_code VARCHAR(20) NOT NULL,
  unit_name VARCHAR(150) NOT NULL,
  short_name VARCHAR(60) NULL,
  unit_type VARCHAR(20) NOT NULL DEFAULT 'SCHOOL_BRANCH',
  operational_status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  finance_status VARCHAR(16) NOT NULL DEFAULT 'NOT_CONFIGURED',
  address VARCHAR(255) NULL,
  head_user_id CHAR(36) NULL,
  default_academic_year_id CHAR(36) NULL,
  effective_start DATE NULL,
  effective_end DATE NULL,
  notes VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_units_entity_code (legal_entity_id, unit_code),
  KEY idx_units_level (legal_entity_id, education_level_id),
  CONSTRAINT fk_units_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_units_level FOREIGN KEY (education_level_id) REFERENCES education_levels (id) ON DELETE RESTRICT,
  CONSTRAINT fk_units_group FOREIGN KEY (school_group_id) REFERENCES school_groups (id) ON DELETE SET NULL,
  CONSTRAINT fk_units_school FOREIGN KEY (official_school_id) REFERENCES official_schools (id) ON DELETE SET NULL,
  CONSTRAINT fk_units_location FOREIGN KEY (location_id) REFERENCES school_locations (id) ON DELETE SET NULL,
  CONSTRAINT fk_units_head FOREIGN KEY (head_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_units_academic FOREIGN KEY (default_academic_year_id) REFERENCES academic_years (id) ON DELETE SET NULL,
  CONSTRAINT chk_units_type CHECK (unit_type IN ('HEAD_OFFICE','SCHOOL_BRANCH')),
  CONSTRAINT chk_units_status CHECK (operational_status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  CONSTRAINT chk_units_finance CHECK (finance_status IN ('NOT_CONFIGURED','READY','BLOCKED')),
  CONSTRAINT chk_units_effective CHECK (effective_end IS NULL OR effective_start IS NULL OR effective_end >= effective_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS unit_finance_settings (
  unit_id CHAR(36) NOT NULL,
  account_mode VARCHAR(20) NOT NULL DEFAULT 'MIXED',
  receivable_account_code VARCHAR(30) NULL,
  cash_account_code VARCHAR(30) NULL,
  revenue_account_code VARCHAR(30) NULL,
  updated_by CHAR(36) NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (unit_id),
  CONSTRAINT fk_fin_settings_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE CASCADE,
  CONSTRAINT chk_fin_mode CHECK (account_mode IN ('CENTRAL_ONLY','DEDICATED_ONLY','MIXED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Rekening */

CREATE TABLE IF NOT EXISTS bank_accounts (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  bank_name VARCHAR(100) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  account_holder VARCHAR(150) NOT NULL,
  account_usage VARCHAR(16) NOT NULL DEFAULT 'CENTRAL',
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  gl_account_code VARCHAR(30) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  verified_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_identity (legal_entity_id, bank_name, account_number),
  CONSTRAINT fk_bank_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_bank_usage CHECK (account_usage IN ('CENTRAL','DEDICATED')),
  CONSTRAINT chk_bank_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS unit_bank_account_assignments (
  id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  bank_account_id CHAR(36) NOT NULL,
  usage_type VARCHAR(20) NOT NULL,
  allow_receipt TINYINT(1) NOT NULL DEFAULT 1,
  allow_disbursement TINYINT(1) NOT NULL DEFAULT 1,
  is_default_receipt TINYINT(1) NOT NULL DEFAULT 0,
  is_default_disbursement TINYINT(1) NOT NULL DEFAULT 0,
  effective_start DATE NOT NULL,
  effective_end DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_assignment (unit_id, bank_account_id, effective_start),
  KEY idx_assignment_bank (bank_account_id),
  CONSTRAINT fk_assignment_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT chk_assignment_usage CHECK (usage_type IN ('CENTRAL_SHARED','UNIT_DEDICATED')),
  CONSTRAINT chk_assignment_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT chk_assignment_range CHECK (effective_end IS NULL OR effective_end >= effective_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Scope & audit */

CREATE TABLE IF NOT EXISTS user_unit_access (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_unit (user_id, unit_id),
  CONSTRAINT fk_access_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_access_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  legal_entity_id CHAR(36) NULL,
  unit_id CHAR(36) NULL,
  user_id CHAR(36) NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(60) NOT NULL,
  before_data LONGTEXT NULL,
  after_data LONGTEXT NULL,
  reason VARCHAR(255) NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_unit (unit_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
