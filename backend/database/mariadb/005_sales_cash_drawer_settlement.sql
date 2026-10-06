-- =============================================================
-- 005 — Phase 2: Sales -> Cash Drawer -> Rekonsiliasi -> Finance Verification -> Settlement.
-- Seluruh perubahan ADDITIVE dan idempoten. Tidak mengubah/menghapus data lama.
--   * payment_methods (sudah ada, belum dipakai) diperluas menjadi master metode pembayaran per company/outlet.
--   * sales_import_rows: kolom pembayaran baru SHOPEEFOOD + CARD (Debit/EDC).
--   * cash_drawers + cash_drawer_lines: input aktual per metode oleh Outlet (bukti di tabel attachments).
--   * sales_reconciliations + sales_reconciliation_lines (snapshot saat verifikasi + register settlement)
--     + sales_reconciliation_resolutions (append-only, jejak selisih awal tidak dihapus).
--   * sales_settlement_allocations: penerimaan settlement bank -> outstanding channel.
--   * transaction_headers.source_module/source_reference_id untuk drill-down sumber.
-- =============================================================
SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- 1) Master metode pembayaran (extend tabel existing).
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS company_id CHAR(36) NULL AFTER workspace_id;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS pos_payment_code VARCHAR(32) NULL AFTER method_type;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS evidence_policy VARCHAR(32) NOT NULL DEFAULT 'OPTIONAL' AFTER pos_payment_code;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS destination_behavior VARCHAR(32) NOT NULL DEFAULT 'CASH_DIRECT' AFTER evidence_policy;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS financial_account_id CHAR(36) NULL AFTER destination_behavior;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS clearing_account_id CHAR(36) NULL AFTER financial_account_id;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS fee_account_id CHAR(36) NULL AFTER clearing_account_id;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS reconcile_required TINYINT(1) NOT NULL DEFAULT 1 AFTER fee_account_id;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0 AFTER reconcile_required;
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);
ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6);
ALTER TABLE payment_methods ADD INDEX IF NOT EXISTS idx_payment_methods_company (company_id, status, sort_order);
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_company_id_fkey FOREIGN KEY IF NOT EXISTS (company_id) REFERENCES companies (id) ON DELETE CASCADE;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_financial_account_id_fkey FOREIGN KEY IF NOT EXISTS (financial_account_id) REFERENCES financial_accounts (id);
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_clearing_account_id_fkey FOREIGN KEY IF NOT EXISTS (clearing_account_id) REFERENCES chart_of_accounts (id);
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_fee_account_id_fkey FOREIGN KEY IF NOT EXISTS (fee_account_id) REFERENCES chart_of_accounts (id);
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_evidence_policy_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_evidence_policy_check CHECK (evidence_policy IN ('REQUIRED', 'OPTIONAL'));
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_destination_behavior_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_destination_behavior_check CHECK (destination_behavior IN ('CASH_DIRECT', 'BANK_DIRECT', 'SETTLEMENT'));
ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_pos_payment_code_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_pos_payment_code_check CHECK ((pos_payment_code IS NULL) OR (pos_payment_code IN ('CASH', 'QRIS', 'TRANSFER', 'CARD', 'GOFOOD', 'GRABFOOD', 'SHOPEEFOOD')));

-- Berlaku untuk outlet mana. pos_payment_code disalin agar 1 kode POS = 1 metode per outlet (UNIQUE).
CREATE TABLE IF NOT EXISTS payment_method_locations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  payment_method_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  pos_payment_code VARCHAR(32) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY payment_method_locations_method_location_key (payment_method_id, location_id),
  UNIQUE KEY payment_method_locations_location_code_key (location_id, pos_payment_code),
  CONSTRAINT payment_method_locations_method_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id) ON DELETE CASCADE,
  CONSTRAINT payment_method_locations_location_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 2) Kolom pembayaran POS baru.
ALTER TABLE sales_import_rows ADD COLUMN IF NOT EXISTS payment_card DECIMAL(20,4) NOT NULL DEFAULT 0 AFTER payment_grabfood;
ALTER TABLE sales_import_rows ADD COLUMN IF NOT EXISTS payment_shopeefood DECIMAL(20,4) NOT NULL DEFAULT 0 AFTER payment_card;
ALTER TABLE sales_import_rows DROP CONSTRAINT IF EXISTS sales_import_rows_payment_card_check;
ALTER TABLE sales_import_rows ADD CONSTRAINT sales_import_rows_payment_card_check CHECK ((payment_card >= (0)));
ALTER TABLE sales_import_rows DROP CONSTRAINT IF EXISTS sales_import_rows_payment_shopeefood_check;
ALTER TABLE sales_import_rows ADD CONSTRAINT sales_import_rows_payment_shopeefood_check CHECK ((payment_shopeefood >= (0)));
ALTER TABLE sales_payment_mappings DROP CONSTRAINT IF EXISTS sales_payment_mappings_payment_code_check;
ALTER TABLE sales_payment_mappings ADD CONSTRAINT sales_payment_mappings_payment_code_check CHECK (payment_code IN ('CASH', 'QRIS', 'TRANSFER', 'COMPLIMENT', 'GOFOOD', 'GRABFOOD', 'CARD', 'SHOPEEFOOD'));
ALTER TABLE sales_import_payment_aliases DROP CONSTRAINT IF EXISTS sales_import_payment_aliases_payment_code_check;
ALTER TABLE sales_import_payment_aliases ADD CONSTRAINT sales_import_payment_aliases_payment_code_check CHECK (payment_code IN ('CASH', 'QRIS', 'TRANSFER', 'COMPLIMENT', 'GOFOOD', 'GRABFOOD', 'SHOPEEFOOD', 'CARD', 'OTHER'));

-- 3) Sumber dokumen untuk drill-down (SALES_VERIFICATION / QRIS_SETTLEMENT / OJOL_SETTLEMENT ...).
ALTER TABLE transaction_headers ADD COLUMN IF NOT EXISTS source_module VARCHAR(64) NULL;
ALTER TABLE transaction_headers ADD COLUMN IF NOT EXISTS source_reference_id CHAR(36) NULL;
ALTER TABLE transaction_headers ADD INDEX IF NOT EXISTS idx_th_source_reference (source_reference_id);

-- 4) Rekonsiliasi per outlet + tanggal bisnis.
CREATE TABLE IF NOT EXISTS sales_reconciliations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  business_date DATE NOT NULL,
  reconciliation_number VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  pos_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  actual_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  difference_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  difference_transaction_id CHAR(36) NULL,
  notes TEXT,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  verified_by CHAR(36),
  verified_at DATETIME(6),
  PRIMARY KEY (id),
  UNIQUE KEY sales_reconciliations_location_date_key (location_id, business_date),
  KEY idx_sales_reconciliations_company (company_id, business_date, status),
  CONSTRAINT sales_reconciliations_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT sales_reconciliations_company_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT sales_reconciliations_location_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT sales_reconciliations_diff_tx_fkey FOREIGN KEY (difference_transaction_id) REFERENCES transaction_headers (id),
  CONSTRAINT sales_reconciliations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT sales_reconciliations_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES users (id),
  CONSTRAINT sales_reconciliations_status_check CHECK (status IN ('OPEN', 'VERIFIED'))
) ENGINE=InnoDB;

-- 5) Cash Drawer (Outlet). Shift opsional ('' = harian); beberapa shift dijumlah saat rekonsiliasi.
CREATE TABLE IF NOT EXISTS cash_drawers (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  business_date DATE NOT NULL,
  shift_label VARCHAR(100) NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'SUBMITTED',
  notes TEXT,
  reconciliation_id CHAR(36) NULL,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  locked_at DATETIME(6),
  PRIMARY KEY (id),
  UNIQUE KEY cash_drawers_location_date_shift_key (location_id, business_date, shift_label),
  KEY idx_cash_drawers_company_date (company_id, business_date),
  CONSTRAINT cash_drawers_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT cash_drawers_company_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT cash_drawers_location_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT cash_drawers_reconciliation_fkey FOREIGN KEY (reconciliation_id) REFERENCES sales_reconciliations (id),
  CONSTRAINT cash_drawers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT cash_drawers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT cash_drawers_status_check CHECK (status IN ('SUBMITTED', 'LOCKED'))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cash_drawer_lines (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  cash_drawer_id CHAR(36) NOT NULL,
  payment_method_id CHAR(36) NOT NULL,
  actual_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  updated_by CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY cash_drawer_lines_drawer_method_key (cash_drawer_id, payment_method_id),
  CONSTRAINT cash_drawer_lines_drawer_fkey FOREIGN KEY (cash_drawer_id) REFERENCES cash_drawers (id) ON DELETE CASCADE,
  CONSTRAINT cash_drawer_lines_method_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id),
  CONSTRAINT cash_drawer_lines_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT cash_drawer_lines_amount_check CHECK ((actual_amount >= (0)))
) ENGINE=InnoDB;

-- 6) Snapshot per metode saat Finance Verification + register settlement outstanding.
CREATE TABLE IF NOT EXISTS sales_reconciliation_lines (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  reconciliation_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  business_date DATE NOT NULL,
  payment_method_id CHAR(36) NOT NULL,
  pos_payment_code VARCHAR(32) NOT NULL,
  method_name VARCHAR(255) NOT NULL,
  destination_behavior VARCHAR(32) NOT NULL,
  financial_account_id CHAR(36) NULL,
  pos_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  actual_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  difference DECIMAL(20,4) NOT NULL DEFAULT 0,
  settled_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  fee_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  settlement_difference DECIMAL(20,4) NOT NULL DEFAULT 0,
  settlement_status VARCHAR(32) NOT NULL DEFAULT 'NOT_REQUIRED',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY sales_reconciliation_lines_recon_method_key (reconciliation_id, payment_method_id),
  KEY idx_srl_settlement (company_id, settlement_status, payment_method_id, business_date),
  CONSTRAINT srl_reconciliation_fkey FOREIGN KEY (reconciliation_id) REFERENCES sales_reconciliations (id) ON DELETE CASCADE,
  CONSTRAINT srl_method_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id),
  CONSTRAINT srl_financial_account_fkey FOREIGN KEY (financial_account_id) REFERENCES financial_accounts (id),
  CONSTRAINT srl_settlement_status_check CHECK (settlement_status IN ('NOT_REQUIRED', 'OUTSTANDING', 'PARTIAL', 'SETTLED'))
) ENGINE=InnoDB;

-- 7) Penyelesaian selisih (append-only; versi lama menjadi SUPERSEDED, tidak dihapus).
CREATE TABLE IF NOT EXISTS sales_reconciliation_resolutions (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  reconciliation_id CHAR(36) NOT NULL,
  payment_method_id CHAR(36) NULL,
  pos_payment_code VARCHAR(32) NOT NULL,
  pos_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  actual_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  difference DECIMAL(20,4) NOT NULL DEFAULT 0,
  reason_code VARCHAR(64) NOT NULL,
  notes TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_srr_reconciliation (reconciliation_id, status),
  CONSTRAINT srr_reconciliation_fkey FOREIGN KEY (reconciliation_id) REFERENCES sales_reconciliations (id) ON DELETE CASCADE,
  CONSTRAINT srr_method_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id),
  CONSTRAINT srr_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT srr_status_check CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  CONSTRAINT srr_reason_check CHECK (reason_code IN ('SALAH_INPUT', 'UANG_KURANG', 'UANG_LEBIH', 'SALAH_METODE_POS', 'BELUM_TERCATAT', 'REFUND_CANCEL', 'ADJUSTMENT', 'LAINNYA'))
) ENGINE=InnoDB;

-- 8) Alokasi settlement bank -> outstanding per tanggal/outlet/metode.
CREATE TABLE IF NOT EXISTS sales_settlement_allocations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  settlement_transaction_id CHAR(36) NOT NULL,
  reconciliation_line_id CHAR(36) NOT NULL,
  gross_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_ssa_line (reconciliation_line_id),
  KEY idx_ssa_tx (settlement_transaction_id),
  CONSTRAINT ssa_tx_fkey FOREIGN KEY (settlement_transaction_id) REFERENCES transaction_headers (id),
  CONSTRAINT ssa_line_fkey FOREIGN KEY (reconciliation_line_id) REFERENCES sales_reconciliation_lines (id),
  CONSTRAINT ssa_gross_check CHECK ((gross_amount > (0)))
) ENGINE=InnoDB;
