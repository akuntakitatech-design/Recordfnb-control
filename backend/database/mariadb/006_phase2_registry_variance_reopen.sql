-- 006 — Phase 2 lanjutan (ADITIF, tidak mengubah/menghapus data historis)
--  1. Registry kode pembayaran POS (pos_payment_codes) -> kode baru cukup ditambah sebagai baris, tanpa ubah kode/constraint.
--     CHECK constraint daftar kode yang di-hard-code dilepas (validasi pindah ke registry di aplikasi).
--  2. sales_import_rows.payment_extra (JSON) untuk kode tanpa kolom khusus.
--  3. Akun selisih terpisah: CASH_DRAWER_VARIANCE (selisih kas) & SETTLEMENT_VARIANCE (selisih settlement) — role important_accounts.
--  4. Reopen terkontrol (Accounting): status REOPENED, ronde verifikasi, baris snapshot/alokasi settlement di-VOID/REVERSED (tidak dihapus).

CREATE TABLE IF NOT EXISTS pos_payment_codes (
  code VARCHAR(32) NOT NULL,
  label VARCHAR(100) NOT NULL,
  aliases TEXT NULL,
  method_type VARCHAR(32) NOT NULL DEFAULT 'OTHER',
  include_in_reconciliation TINYINT(1) NOT NULL DEFAULT 1,
  settlement_module VARCHAR(64) NOT NULL DEFAULT 'CHANNEL_SETTLEMENT',
  legacy_column VARCHAR(64) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (code),
  CONSTRAINT pos_payment_codes_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

INSERT IGNORE INTO pos_payment_codes(code,label,aliases,method_type,include_in_reconciliation,settlement_module,legacy_column,sort_order) VALUES
  ('CASH','Cash','CASH,TUNAI','CASH',1,'CASH','payment_cash',10),
  ('QRIS','QRIS','QRIS,QRCODE,QR','QRIS',1,'QRIS_SETTLEMENT','payment_qris',20),
  ('TRANSFER','Transfer','TRANSFER,BANKTRANSFER,TRANSFERBANK','BANK_TRANSFER',1,'BANK_TRANSFER','payment_transfer',30),
  ('CARD','Debit/EDC (Kartu)','CARD,DEBIT,EDC,KARTU,DEBITCARD,KARTUDEBIT,CREDITCARD,KARTUKREDIT,KREDIT,DEBITEDC,EDCDEBIT,DEBITBCA,EDCBCA,DEBITMANDIRI,EDCMANDIRI,DEBITBRI,EDCBRI,DEBITBNI,EDCBNI','CARD',1,'EDC_SETTLEMENT','payment_card',40),
  ('GOFOOD','GoFood','GOFOOD,GOJEKFOOD,GOJEK','OJOL',1,'OJOL_SETTLEMENT','payment_gofood',50),
  ('GRABFOOD','GrabFood','GRABFOOD,GRAB','OJOL',1,'OJOL_SETTLEMENT','payment_grabfood',60),
  ('SHOPEEFOOD','ShopeeFood','SHOPEEFOOD,SHOPEE,SPFOOD','OJOL',1,'OJOL_SETTLEMENT','payment_shopeefood',70),
  ('COMPLIMENT','Compliment','COMPLIMENT,COMPLIMENTARY,COMPLIMEN','COMPLIMENT',0,'NONE','payment_compliment',90);

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_pos_payment_code_check;
ALTER TABLE sales_payment_mappings DROP CONSTRAINT IF EXISTS sales_payment_mappings_payment_code_check;
ALTER TABLE sales_import_payment_aliases DROP CONSTRAINT IF EXISTS sales_import_payment_aliases_payment_code_check;

ALTER TABLE sales_import_rows ADD COLUMN IF NOT EXISTS payment_extra LONGTEXT NULL AFTER payment_shopeefood;

-- Template COA: role akun penting baru (dipetakan Accounting per company; tidak di-default ke CASH_BANK_VARIANCE)
-- (important_accounts.role_code bebas VARCHAR; mapping per company via /api/sales-flow/variance-accounts)

-- Reopen terkontrol
ALTER TABLE sales_reconciliations DROP CONSTRAINT IF EXISTS sales_reconciliations_status_check;
ALTER TABLE sales_reconciliations ADD CONSTRAINT sales_reconciliations_status_check CHECK (status IN ('OPEN', 'VERIFIED', 'REOPENED'));
ALTER TABLE sales_reconciliations ADD COLUMN IF NOT EXISTS verification_round INT NOT NULL DEFAULT 0;
ALTER TABLE sales_reconciliations ADD COLUMN IF NOT EXISTS reopened_by CHAR(36) NULL;
ALTER TABLE sales_reconciliations ADD COLUMN IF NOT EXISTS reopened_at DATETIME(6) NULL;
ALTER TABLE sales_reconciliations ADD COLUMN IF NOT EXISTS reopen_reason TEXT NULL;
ALTER TABLE sales_reconciliations ADD COLUMN IF NOT EXISTS reopen_count INT NOT NULL DEFAULT 0;

ALTER TABLE sales_reconciliation_lines ADD COLUMN IF NOT EXISTS verification_round INT NOT NULL DEFAULT 1;
ALTER TABLE sales_reconciliation_lines ADD COLUMN IF NOT EXISTS line_status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE sales_reconciliation_lines ADD COLUMN IF NOT EXISTS voided_at DATETIME(6) NULL;
ALTER TABLE sales_reconciliation_lines ADD INDEX IF NOT EXISTS idx_srl_recon_round (reconciliation_id, payment_method_id, verification_round);
ALTER TABLE sales_reconciliation_lines DROP INDEX IF EXISTS sales_reconciliation_lines_recon_method_key;
ALTER TABLE sales_reconciliation_lines ADD UNIQUE KEY IF NOT EXISTS srl_recon_method_round_key (reconciliation_id, payment_method_id, verification_round);
ALTER TABLE sales_reconciliation_lines DROP CONSTRAINT IF EXISTS srl_line_status_check;
ALTER TABLE sales_reconciliation_lines ADD CONSTRAINT srl_line_status_check CHECK (line_status IN ('ACTIVE', 'VOID'));

ALTER TABLE sales_settlement_allocations ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE sales_settlement_allocations ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE sales_settlement_allocations ADD COLUMN IF NOT EXISTS difference_amount DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE sales_settlement_allocations ADD COLUMN IF NOT EXISTS previous_status VARCHAR(32) NULL;
ALTER TABLE sales_settlement_allocations ADD COLUMN IF NOT EXISTS reversed_at DATETIME(6) NULL;
ALTER TABLE sales_settlement_allocations DROP CONSTRAINT IF EXISTS ssa_status_check;
ALTER TABLE sales_settlement_allocations ADD CONSTRAINT ssa_status_check CHECK (status IN ('ACTIVE', 'REVERSED'));
