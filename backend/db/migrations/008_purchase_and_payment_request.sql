/* ------------------------------------------------------------------ Pengajuan pembelian

Rincian barang diketik manual saat mengajukan (nama barang, qty, satuan, harga satuan).
Total pengajuan = SUM(rincian) + biaya pengiriman.
*/

CREATE TABLE IF NOT EXISTS expense_request_lines (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  expense_request_id CHAR(36) NOT NULL,
  line_no INT NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  qty DECIMAL(14,3) NOT NULL,
  uom VARCHAR(30) NULL,
  unit_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_line_no (expense_request_id, line_no),
  KEY idx_expense_line_request (expense_request_id),
  CONSTRAINT fk_expense_line_request FOREIGN KEY (expense_request_id) REFERENCES expense_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_expense_line_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_expense_line_qty CHECK (qty > 0),
  CONSTRAINT chk_expense_line_amount CHECK (unit_price >= 0 AND amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

ALTER TABLE expense_requests
  ADD COLUMN IF NOT EXISTS shipping_cost DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER amount;

/* ------------------------------------------------------------------ MCM — pengajuan pembayaran

Dibuat Finance (memilih rekening bank), disetujui Ketua Yayasan, lalu diposting Finance
sehingga kas keluar + jurnal terbentuk. Satu pengajuan pembelian boleh punya beberapa MCM
(DP lalu pelunasan).
*/

CREATE TABLE IF NOT EXISTS payment_requests (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  expense_request_id CHAR(36) NOT NULL,
  bank_account_id CHAR(36) NOT NULL,
  request_number VARCHAR(60) NOT NULL,
  request_date DATE NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'TRANSFER',
  amount DECIMAL(14,2) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  notes VARCHAR(255) NULL,
  payment_id CHAR(36) NULL,
  created_by CHAR(36) NULL,
  submitted_by CHAR(36) NULL,
  submitted_at DATETIME(6) NULL,
  approved_by CHAR(36) NULL,
  approved_at DATETIME(6) NULL,
  rejected_by CHAR(36) NULL,
  rejected_at DATETIME(6) NULL,
  rejection_reason VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_request_number (legal_entity_id, request_number),
  KEY idx_payment_request_status (legal_entity_id, status),
  KEY idx_payment_request_expense (expense_request_id),
  KEY idx_payment_request_unit (unit_id, request_date),
  CONSTRAINT fk_payment_request_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_request_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_request_expense FOREIGN KEY (expense_request_id) REFERENCES expense_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_request_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_request_payment FOREIGN KEY (payment_id) REFERENCES expense_payments (id) ON DELETE SET NULL,
  CONSTRAINT chk_payment_request_method CHECK (method IN ('CASH','TRANSFER','QRIS','OTHER')),
  CONSTRAINT chk_payment_request_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  CONSTRAINT chk_payment_request_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
