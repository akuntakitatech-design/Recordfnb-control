SET time_zone = '+00:00';

/* ------------------------------------------------------------------ Penerimaan */

CREATE TABLE IF NOT EXISTS receipts (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  bank_account_id CHAR(36) NOT NULL,
  receipt_number VARCHAR(60) NOT NULL,
  receipt_date DATE NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
  reference_number VARCHAR(100) NULL,
  payer_name VARCHAR(150) NULL,
  total_amount DECIMAL(14,2) NOT NULL,
  allocated_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  unallocated_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'POSTED',
  idempotency_key VARCHAR(100) NULL,
  notes VARCHAR(255) NULL,
  void_reason VARCHAR(255) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipt_number (legal_entity_id, receipt_number),
  UNIQUE KEY uq_receipt_idempotency (legal_entity_id, idempotency_key),
  KEY idx_receipt_unit_date (unit_id, receipt_date),
  CONSTRAINT fk_receipt_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_receipt_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_receipt_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT chk_receipt_method CHECK (method IN ('CASH','TRANSFER','QRIS','OTHER')),
  CONSTRAINT chk_receipt_status CHECK (status IN ('POSTED','VOID')),
  CONSTRAINT chk_receipt_amount CHECK (total_amount >= 0 AND allocated_amount >= 0 AND unallocated_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id CHAR(36) NOT NULL,
  receipt_id CHAR(36) NOT NULL,
  invoice_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_allocation_receipt (receipt_id),
  KEY idx_allocation_invoice (invoice_id),
  KEY idx_allocation_unit (unit_id),
  CONSTRAINT fk_allocation_receipt FOREIGN KEY (receipt_id) REFERENCES receipts (id) ON DELETE CASCADE,
  CONSTRAINT fk_allocation_invoice FOREIGN KEY (invoice_id) REFERENCES invoices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_allocation_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE RESTRICT,
  CONSTRAINT chk_allocation_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

/* ------------------------------------------------------------------ Mutasi kas & bank */

CREATE TABLE IF NOT EXISTS bank_mutations (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  bank_account_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NULL,
  mutation_date DATE NOT NULL,
  direction VARCHAR(8) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  source_type VARCHAR(20) NOT NULL,
  source_id CHAR(36) NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_mutation_account (bank_account_id, mutation_date),
  KEY idx_mutation_unit (unit_id, mutation_date),
  CONSTRAINT fk_mutation_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mutation_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT chk_mutation_direction CHECK (direction IN ('IN','OUT')),
  CONSTRAINT chk_mutation_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
