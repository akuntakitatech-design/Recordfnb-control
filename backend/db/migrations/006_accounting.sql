SET time_zone = '+00:00';

/* ------------------------------------------------------------------ Bagan akun (CoA) */

CREATE TABLE IF NOT EXISTS accounts (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(150) NOT NULL,
  account_type VARCHAR(16) NOT NULL,
  normal_balance VARCHAR(8) NOT NULL,
  parent_id CHAR(36) NULL,
  is_postable TINYINT(1) NOT NULL DEFAULT 1,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_code (legal_entity_id, code),
  KEY idx_account_type (legal_entity_id, account_type),
  CONSTRAINT fk_account_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_account_parent FOREIGN KEY (parent_id) REFERENCES accounts (id) ON DELETE SET NULL,
  CONSTRAINT chk_account_type CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  CONSTRAINT chk_account_normal CHECK (normal_balance IN ('DEBIT','CREDIT')),
  CONSTRAINT chk_account_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Periode fiskal */

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  name VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  closed_by CHAR(36) NULL,
  closed_at DATETIME(6) NULL,
  reopened_by CHAR(36) NULL,
  reopened_at DATETIME(6) NULL,
  reopen_reason VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fiscal_period_name (legal_entity_id, name),
  CONSTRAINT fk_fiscal_period_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_fiscal_period_status CHECK (status IN ('OPEN','CLOSED')),
  CONSTRAINT chk_fiscal_period_range CHECK (end_date >= start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Jurnal */

CREATE TABLE IF NOT EXISTS journal_entries (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NULL,
  period_id CHAR(36) NOT NULL,
  entry_number VARCHAR(60) NOT NULL,
  entry_date DATE NOT NULL,
  description VARCHAR(255) NOT NULL,
  source_type VARCHAR(30) NOT NULL,
  source_id CHAR(36) NULL,
  entry_kind VARCHAR(16) NOT NULL DEFAULT 'ORIGINAL',
  reversal_of CHAR(36) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'POSTED',
  idempotency_key VARCHAR(120) NOT NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_number (legal_entity_id, entry_number),
  UNIQUE KEY uq_journal_idempotency (legal_entity_id, idempotency_key),
  KEY idx_journal_date (legal_entity_id, entry_date),
  KEY idx_journal_source (source_type, source_id),
  CONSTRAINT fk_journal_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_period FOREIGN KEY (period_id) REFERENCES fiscal_periods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_journal_reversal FOREIGN KEY (reversal_of) REFERENCES journal_entries (id) ON DELETE SET NULL,
  CONSTRAINT chk_journal_kind CHECK (entry_kind IN ('ORIGINAL','REVERSAL')),
  CONSTRAINT chk_journal_status CHECK (status IN ('POSTED','REVERSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS journal_lines (
  id CHAR(36) NOT NULL,
  entry_id CHAR(36) NOT NULL,
  line_no INT NOT NULL,
  account_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NULL,
  description VARCHAR(255) NULL,
  debit DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_line (entry_id, line_no),
  KEY idx_journal_line_account (account_id, entry_id),
  KEY idx_journal_line_unit (unit_id),
  CONSTRAINT fk_journal_line_entry FOREIGN KEY (entry_id) REFERENCES journal_entries (id) ON DELETE CASCADE,
  CONSTRAINT fk_journal_line_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE RESTRICT,
  CONSTRAINT chk_journal_line_amount CHECK (debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Mapping akun rekening fisik */

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS gl_account_code VARCHAR(30) NULL;

/* ------------------------------------------------------------------ Seed CoA awal */

INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666601', id, '1-1100', 'Kas & Bank', 'ASSET', 'DEBIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666602', id, '1-1200', 'Piutang Siswa', 'ASSET', 'DEBIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666603', id, '2-1200', 'Uang Muka Siswa', 'LIABILITY', 'CREDIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666604', id, '3-1100', 'Aset Neto', 'EQUITY', 'CREDIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666605', id, '4-1100', 'Pendapatan SPP', 'REVENUE', 'CREDIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666606', id, '4-1200', 'Pendapatan Lain', 'REVENUE', 'CREDIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666607', id, '5-1100', 'Beban Gaji', 'EXPENSE', 'DEBIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666608', id, '5-2100', 'Beban Operasional', 'EXPENSE', 'DEBIT' FROM legal_entities LIMIT 1;
INSERT IGNORE INTO accounts(id,legal_entity_id,code,name,account_type,normal_balance)
SELECT '66666666-6666-4666-8666-666666666609', id, '5-3100', 'Beban Sarana & Prasarana', 'EXPENSE', 'DEBIT' FROM legal_entities LIMIT 1;

/* Lengkapi mapping akun pada setting unit yang belum diisi agar posting otomatis konsisten. */
UPDATE unit_finance_settings
   SET receivable_account_code = COALESCE(receivable_account_code, '1-1200'),
       cash_account_code = COALESCE(cash_account_code, '1-1100'),
       revenue_account_code = COALESCE(revenue_account_code, '4-1100');
