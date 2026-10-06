-- 007 — Phase 2: akun selisih terpisah sebagai DEFAULT (aditif, idempotent, tanpa data uji).
--  * Cash Drawer Variance / Selisih Kas         -> role CASH_DRAWER_VARIANCE  -> COA 6900-00-004
--  * Settlement Variance / Selisih Settlement   -> role SETTLEMENT_VARIANCE   -> COA 6900-00-005
--  * MDR/Admin Fee TIDAK di sini: tetap akun biaya per metode pembayaran (payment_methods.fee_account_id).
-- Mapping tetap dapat diubah Accounting dari master (PUT /api/sales-flow/variance-accounts).
-- Tidak menimpa mapping yang sudah ada; tidak mengubah/menghapus akun atau transaksi lama.

-- Template COA standar (company baru mendapat akun + mapping otomatis saat apply template)
INSERT IGNORE INTO coa_template_accounts (id, template_id, code, name, account_type, normal_balance, report_group, report_subgroup, allow_manual_posting, sort_order)
SELECT UUID(), t.id, '6900-00-004', 'Selisih Kas (Cash Drawer)', 'EXPENSE', 'DEBIT', 'Pengeluaran Operasional', 'Beban Operasional Lain', 1, 15904
  FROM coa_templates t WHERE t.code = 'AK_FNB_STANDARD_V1';

INSERT IGNORE INTO coa_template_accounts (id, template_id, code, name, account_type, normal_balance, report_group, report_subgroup, allow_manual_posting, sort_order)
SELECT UUID(), t.id, '6900-00-005', 'Selisih Settlement', 'EXPENSE', 'DEBIT', 'Pengeluaran Operasional', 'Beban Operasional Lain', 1, 15905
  FROM coa_templates t WHERE t.code = 'AK_FNB_STANDARD_V1';

INSERT IGNORE INTO coa_template_important_accounts (template_id, role_code, label, account_code)
SELECT t.id, 'CASH_DRAWER_VARIANCE', 'Cash Drawer Variance / Selisih Kas', '6900-00-004' FROM coa_templates t WHERE t.code = 'AK_FNB_STANDARD_V1';

INSERT IGNORE INTO coa_template_important_accounts (template_id, role_code, label, account_code)
SELECT t.id, 'SETTLEMENT_VARIANCE', 'Settlement Variance / Selisih Settlement', '6900-00-005' FROM coa_templates t WHERE t.code = 'AK_FNB_STANDARD_V1';

-- Company yang sudah memakai COA standar (punya akun template 6900-00-002): tambahkan akun bila kode belum dipakai
INSERT IGNORE INTO chart_of_accounts (id, workspace_id, company_id, code, name, account_type, normal_balance, allow_manual_posting, report_group, report_subgroup)
SELECT UUID(), c.workspace_id, c.company_id, '6900-00-004', 'Selisih Kas (Cash Drawer)', 'EXPENSE', 'DEBIT', 1, 'Pengeluaran Operasional', 'Beban Operasional Lain'
  FROM chart_of_accounts c WHERE c.code = '6900-00-002';

INSERT IGNORE INTO chart_of_accounts (id, workspace_id, company_id, code, name, account_type, normal_balance, allow_manual_posting, report_group, report_subgroup)
SELECT UUID(), c.workspace_id, c.company_id, '6900-00-005', 'Selisih Settlement', 'EXPENSE', 'DEBIT', 1, 'Pengeluaran Operasional', 'Beban Operasional Lain'
  FROM chart_of_accounts c WHERE c.code = '6900-00-002';

-- Mapping default hanya bila role belum dipetakan DAN akun pada kode tsb memang akun selisih ini (cek nama, aman bila kode sudah dipakai akun lain)
INSERT IGNORE INTO important_accounts (id, workspace_id, company_id, role_code, account_id)
SELECT UUID(), a.workspace_id, a.company_id, 'CASH_DRAWER_VARIANCE', a.id
  FROM chart_of_accounts a WHERE a.code = '6900-00-004' AND a.name = 'Selisih Kas (Cash Drawer)' AND a.status = 'ACTIVE';

INSERT IGNORE INTO important_accounts (id, workspace_id, company_id, role_code, account_id)
SELECT UUID(), a.workspace_id, a.company_id, 'SETTLEMENT_VARIANCE', a.id
  FROM chart_of_accounts a WHERE a.code = '6900-00-005' AND a.name = 'Selisih Settlement' AND a.status = 'ACTIVE';
