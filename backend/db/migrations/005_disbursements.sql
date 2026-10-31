SET time_zone = '+00:00';

/* ------------------------------------------------------------------ Master pengeluaran */

CREATE TABLE IF NOT EXISTS expense_categories (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  expense_account_code VARCHAR(30) NULL,
  description VARCHAR(255) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_category_code (legal_entity_id, code),
  CONSTRAINT fk_expense_category_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_category_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS vendors (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  npwp VARCHAR(30) NULL,
  contact_name VARCHAR(150) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(150) NULL,
  address VARCHAR(255) NULL,
  bank_name VARCHAR(100) NULL,
  bank_account_number VARCHAR(50) NULL,
  bank_account_holder VARCHAR(150) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_vendor_code (legal_entity_id, code),
  CONSTRAINT fk_vendor_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_vendor_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Pengajuan & pembayaran */

CREATE TABLE IF NOT EXISTS expense_requests (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  expense_category_id CHAR(36) NOT NULL,
  vendor_id CHAR(36) NULL,
  request_number VARCHAR(60) NOT NULL,
  request_date DATE NOT NULL,
  due_date DATE NULL,
  payee_name VARCHAR(150) NULL,
  description VARCHAR(255) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  paid_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  notes VARCHAR(255) NULL,
  submitted_by CHAR(36) NULL,
  submitted_at DATETIME(6) NULL,
  approved_by CHAR(36) NULL,
  approved_at DATETIME(6) NULL,
  rejected_by CHAR(36) NULL,
  rejected_at DATETIME(6) NULL,
  rejection_reason VARCHAR(255) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_request_number (legal_entity_id, request_number),
  KEY idx_expense_request_unit_status (unit_id, status),
  KEY idx_expense_request_date (legal_entity_id, request_date),
  CONSTRAINT fk_expense_request_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_request_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_request_category FOREIGN KEY (expense_category_id) REFERENCES expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_request_vendor FOREIGN KEY (vendor_id) REFERENCES vendors (id) ON DELETE SET NULL,
  CONSTRAINT chk_expense_request_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','PAID','CANCELLED')),
  CONSTRAINT chk_expense_request_amount CHECK (amount > 0 AND paid_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS expense_payments (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  expense_request_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  bank_account_id CHAR(36) NOT NULL,
  payment_number VARCHAR(60) NOT NULL,
  payment_date DATE NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
  reference_number VARCHAR(100) NULL,
  amount DECIMAL(14,2) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'POSTED',
  idempotency_key VARCHAR(100) NULL,
  notes VARCHAR(255) NULL,
  void_reason VARCHAR(255) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_payment_number (legal_entity_id, payment_number),
  UNIQUE KEY uq_expense_payment_idempotency (legal_entity_id, idempotency_key),
  KEY idx_expense_payment_request (expense_request_id),
  KEY idx_expense_payment_unit (unit_id, payment_date),
  CONSTRAINT fk_expense_payment_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_payment_request FOREIGN KEY (expense_request_id) REFERENCES expense_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_payment_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expense_payment_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_payment_method CHECK (method IN ('CASH','TRANSFER','QRIS','OTHER')),
  CONSTRAINT chk_expense_payment_status CHECK (status IN ('POSTED','VOID')),
  CONSTRAINT chk_expense_payment_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Seed kategori awal */

INSERT IGNORE INTO expense_categories(id,legal_entity_id,code,name,expense_account_code,description)
SELECT '55555555-5555-4555-8555-555555555501', id, 'GAJI', 'Gaji & Tunjangan Guru', '5-1100', 'Beban gaji pendidik dan tenaga kependidikan'
FROM legal_entities LIMIT 1;

INSERT IGNORE INTO expense_categories(id,legal_entity_id,code,name,expense_account_code,description)
SELECT '55555555-5555-4555-8555-555555555502', id, 'OPERASIONAL', 'Operasional Sekolah', '5-2100', 'Listrik, air, kebersihan, dan kebutuhan harian'
FROM legal_entities LIMIT 1;

INSERT IGNORE INTO expense_categories(id,legal_entity_id,code,name,expense_account_code,description)
SELECT '55555555-5555-4555-8555-555555555503', id, 'SARPRAS', 'Sarana & Prasarana', '5-3100', 'Pemeliharaan gedung, perabot, dan peralatan'
FROM legal_entities LIMIT 1;
