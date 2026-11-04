-- Prioritas pengajuan pembelian: NORMAL, TINGGI, MENDESAK.
ALTER TABLE expense_requests
  ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'NORMAL' AFTER description;

-- Batas waktu pembayaran (countdown seperti checkout marketplace).
-- NULL = tanpa batas waktu.
ALTER TABLE expense_requests
  ADD COLUMN IF NOT EXISTS payment_due_at DATETIME(6) NULL AFTER due_date;
