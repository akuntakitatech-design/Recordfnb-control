-- =============================================================
-- 004 — Kas & Bank Control: transfer antar kas/bank, kategori pengeluaran, rekonsiliasi.
-- Seluruh perubahan ADDITIVE dan idempoten (IF NOT EXISTS). Tidak mengubah/menghapus data lama.
-- =============================================================
SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- 1) Transfer internal kas/bank (transaction_type='CASH_TRANSFER'):
--    financial_account_id = sumber (sudah ada), transfer_to_financial_account_id = tujuan (baru).
ALTER TABLE transaction_headers
  ADD COLUMN IF NOT EXISTS transfer_to_financial_account_id CHAR(36) NULL AFTER transfer_to_location_id;
ALTER TABLE transaction_headers
  ADD CONSTRAINT transaction_headers_transfer_to_financial_account_id_fkey
    FOREIGN KEY IF NOT EXISTS (transfer_to_financial_account_id) REFERENCES financial_accounts (id);
ALTER TABLE transaction_headers
  ADD INDEX IF NOT EXISTS idx_th_transfer_to_financial_account (transfer_to_financial_account_id, transaction_date);

-- 2) Kategori pengeluaran (bahasa bisnis untuk Finance) + mapping COA oleh Accounting.
--    account_id NULL = belum dipetakan -> transaksi masuk antrean PERLU REVIEW (NEEDS_ACCOUNT_DIRECTION).
CREATE TABLE IF NOT EXISTS expense_categories (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  account_id CHAR(36) NULL,
  status VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY expense_categories_company_id_code_key (company_id, code),
  KEY idx_expense_categories_company (company_id, status, name),
  CONSTRAINT expense_categories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT expense_categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT expense_categories_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT expense_categories_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

ALTER TABLE transaction_lines
  ADD COLUMN IF NOT EXISTS expense_category_id CHAR(36) NULL AFTER cost_center_id;
ALTER TABLE transaction_lines
  ADD CONSTRAINT transaction_lines_expense_category_id_fkey
    FOREIGN KEY IF NOT EXISTS (expense_category_id) REFERENCES expense_categories (id);

-- 3) Pondasi rekonsiliasi kas (cash count) & bank (rekening koran).
CREATE TABLE IF NOT EXISTS cash_bank_reconciliations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  financial_account_id CHAR(36) NOT NULL,
  reconciliation_date DATE NOT NULL,
  system_balance DECIMAL(20,4) NOT NULL DEFAULT 0,
  actual_balance DECIMAL(20,4) NOT NULL DEFAULT 0,
  difference DECIMAL(20,4) NOT NULL DEFAULT 0,
  status VARCHAR(191) NOT NULL DEFAULT 'BELUM_REKONSILIASI',
  notes TEXT,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reconciled_by CHAR(36),
  reconciled_at DATETIME(6),
  PRIMARY KEY (id),
  KEY idx_cash_bank_reconciliations_account_date (financial_account_id, reconciliation_date DESC),
  KEY idx_cash_bank_reconciliations_company (company_id, status),
  CONSTRAINT cash_bank_reconciliations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT cash_bank_reconciliations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT cash_bank_reconciliations_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES financial_accounts (id) ON DELETE CASCADE,
  CONSTRAINT cash_bank_reconciliations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT cash_bank_reconciliations_reconciled_by_fkey FOREIGN KEY (reconciled_by) REFERENCES users (id),
  CONSTRAINT cash_bank_reconciliations_status_check CHECK (status IN ('BELUM_REKONSILIASI', 'RECONCILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
