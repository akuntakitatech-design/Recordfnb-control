-- Trigger: setelah perusahaan menerapkan template COA standar (AK_FNB_STANDARD_V1),
-- otomatis seed mapping metode pembayaran penjualan -> akun COA.
-- Padanan dari fungsi plpgsql seed_sales_payment_mappings_after_template() (migrasi PG 014).
-- File ini dieksekusi sebagai SATU statement oleh runner migrasi (lihat server/migrate.ts).
CREATE TRIGGER trg_seed_sales_payment_mappings_after_template
AFTER INSERT ON company_coa_template_applications
FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM coa_templates t WHERE t.id = NEW.template_id AND t.code = 'AK_FNB_STANDARD_V1') THEN
    INSERT IGNORE INTO sales_payment_mappings (company_id, payment_code, label, account_id)
    SELECT NEW.company_id, v.payment_code, v.label, coa.id
      FROM (
        SELECT 'CASH' AS payment_code, 'Cash' AS label, '1101-00-001' AS account_code
        UNION ALL SELECT 'QRIS', 'QRIS', '1107-00-001'
        UNION ALL SELECT 'TRANSFER', 'Transfer', '1102-00-001'
        UNION ALL SELECT 'COMPLIMENT', 'Compliment', '6000-00-003'
        UNION ALL SELECT 'GOFOOD', 'GoFood', '1107-00-002'
        UNION ALL SELECT 'GRABFOOD', 'GrabFood', '1107-00-002'
      ) v
      JOIN chart_of_accounts coa ON coa.company_id = NEW.company_id AND coa.code = v.account_code;
  END IF;
END
