-- Akuntakita Standard COA - F&B v1
-- Normalized from the MeatNight chart of accounts supplied by the user.

ALTER TABLE chart_of_accounts
  ADD COLUMN IF NOT EXISTS report_group TEXT,
  ADD COLUMN IF NOT EXISTS report_subgroup TEXT;

CREATE TABLE IF NOT EXISTS coa_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT 'F&B',
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coa_template_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE','OTHER_INCOME','OTHER_EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  report_group TEXT NOT NULL,
  report_subgroup TEXT,
  allow_manual_posting BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(template_id, code)
);

CREATE TABLE IF NOT EXISTS coa_template_important_accounts (
  template_id UUID NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL,
  label TEXT NOT NULL,
  account_code TEXT NOT NULL,
  PRIMARY KEY(template_id, role_code)
);

CREATE TABLE IF NOT EXISTS coa_template_item_categories (
  template_id UUID NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  category_code TEXT NOT NULL,
  category_name TEXT NOT NULL,
  category_type TEXT NOT NULL CHECK (category_type IN ('RAW_MATERIAL','SEMI_FINISHED','FINISHED_GOOD','PACKAGING','SUPPLIES','NON_INVENTORY','SERVICE','ASSET_CANDIDATE','OTHER')),
  inventory_account_code TEXT,
  cogs_account_code TEXT,
  sales_account_code TEXT,
  usage_account_code TEXT,
  PRIMARY KEY(template_id, category_code)
);

CREATE TABLE IF NOT EXISTS coa_template_asset_categories (
  template_id UUID NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  category_code TEXT NOT NULL,
  category_name TEXT NOT NULL,
  asset_account_code TEXT NOT NULL,
  accumulated_depreciation_account_code TEXT NOT NULL,
  depreciation_expense_account_code TEXT NOT NULL,
  PRIMARY KEY(template_id, category_code)
);

CREATE TABLE IF NOT EXISTS coa_template_tax_accounts (
  template_id UUID NOT NULL REFERENCES coa_templates(id) ON DELETE CASCADE,
  tax_role_code TEXT NOT NULL,
  label TEXT NOT NULL,
  account_code TEXT NOT NULL,
  PRIMARY KEY(template_id, tax_role_code)
);

CREATE TABLE IF NOT EXISTS item_category_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES item_categories(id) ON DELETE CASCADE,
  inventory_account_id UUID REFERENCES chart_of_accounts(id),
  cogs_account_id UUID REFERENCES chart_of_accounts(id),
  sales_account_id UUID REFERENCES chart_of_accounts(id),
  usage_account_id UUID REFERENCES chart_of_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, category_id)
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS asset_category_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_category_id UUID NOT NULL REFERENCES asset_categories(id) ON DELETE CASCADE,
  asset_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  accumulated_depreciation_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  depreciation_expense_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, asset_category_id)
);

CREATE TABLE IF NOT EXISTS tax_account_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_role_code TEXT NOT NULL,
  label TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, tax_role_code)
);

CREATE TABLE IF NOT EXISTS company_coa_template_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES coa_templates(id),
  template_version INTEGER NOT NULL,
  applied_by UUID REFERENCES users(id),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO coa_templates(code,name,industry,version,description,is_system)
VALUES(
  'AK_FNB_STANDARD_V1',
  'Akuntakita Standard COA - F&B',
  'F&B',
  1,
  'COA generik untuk restaurant, cafe, bakery, cloud kitchen, catering, multi-outlet dan central kitchen. Dinormalisasi dari COA MeatNight.',
  TRUE
)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  version=EXCLUDED.version,
  is_system=TRUE,
  status='ACTIVE',
  updated_at=NOW();

-- Leaf/postable accounts. Product-specific MeatNight accounts are normalized into generic F&B groups.
INSERT INTO coa_template_accounts(template_id,code,name,account_type,normal_balance,report_group,report_subgroup,sort_order)
SELECT t.id,v.code,v.name,v.account_type,v.normal_balance,v.report_group,v.report_subgroup,v.sort_order
FROM coa_templates t
CROSS JOIN (VALUES
  ('1101-00-001','Kas Kasir','ASSET','DEBIT','Harta','Kas',101),
  ('1101-00-002','Kas Finance / Operasional','ASSET','DEBIT','Harta','Kas',102),
  ('1101-00-099','Kas Lainnya','ASSET','DEBIT','Harta','Kas',199),
  ('1102-00-001','Bank Operasional','ASSET','DEBIT','Harta','Bank',201),
  ('1102-00-099','Bank Lainnya','ASSET','DEBIT','Harta','Bank',299),
  ('1103-00-001','Piutang Usaha','ASSET','DEBIT','Harta','Piutang Usaha',301),
  ('1103-00-099','Piutang Usaha Lainnya','ASSET','DEBIT','Harta','Piutang Usaha',399),
  ('1104-00-001','Piutang Karyawan','ASSET','DEBIT','Harta','Piutang Lain',401),
  ('1104-00-002','Piutang Pengelola','ASSET','DEBIT','Harta','Piutang Lain',402),
  ('1104-00-003','Cadangan Kerugian Piutang','ASSET','CREDIT','Harta','Piutang Lain',403),
  ('1104-00-099','Piutang Lainnya','ASSET','DEBIT','Harta','Piutang Lain',499),
  ('1105-00-001','Persediaan Bahan Baku','ASSET','DEBIT','Harta','Persediaan Barang',501),
  ('1105-00-002','Persediaan Bahan Pendukung','ASSET','DEBIT','Harta','Persediaan Barang',502),
  ('1105-00-003','Persediaan Bahan Setengah Jadi','ASSET','DEBIT','Harta','Persediaan Barang',503),
  ('1105-00-004','Persediaan Barang Jadi','ASSET','DEBIT','Harta','Persediaan Barang',504),
  ('1105-00-005','Persediaan Packaging','ASSET','DEBIT','Harta','Persediaan Barang',505),
  ('1105-00-099','Persediaan Lainnya','ASSET','DEBIT','Harta','Persediaan Barang',599),
  ('1106-00-001','Persediaan Yang Belum Dibebankan','ASSET','DEBIT','Harta','Persediaan Lainnya',601),
  ('1107-00-001','Settlement QRIS','ASSET','DEBIT','Harta','Settlement / Dana Belum Cair',701),
  ('1107-00-002','Settlement OJOL','ASSET','DEBIT','Harta','Settlement / Dana Belum Cair',702),
  ('1107-00-099','Settlement Lainnya','ASSET','DEBIT','Harta','Settlement / Dana Belum Cair',799),
  ('1110-00-001','Uang Muka Pembelian','ASSET','DEBIT','Harta','Uang Muka',1001),
  ('1110-00-002','Uang Muka Karyawan','ASSET','DEBIT','Harta','Uang Muka',1002),
  ('1110-00-003','Uang Muka Pembelian Aset','ASSET','DEBIT','Harta','Uang Muka',1003),
  ('1110-00-099','Uang Muka Lainnya','ASSET','DEBIT','Harta','Uang Muka',1099),
  ('1111-00-001','Sewa Dibayar Di Muka','ASSET','DEBIT','Harta','Biaya Dibayar Di Muka',1101),
  ('1111-00-002','Biaya Dibayar Di Muka Lainnya','ASSET','DEBIT','Harta','Biaya Dibayar Di Muka',1102),
  ('1112-00-001','Pajak Dibayar Di Muka - PPh 23','ASSET','DEBIT','Harta','Pajak Dibayar Di Muka',1201),
  ('1112-00-002','Pajak Dibayar Di Muka - PPh 25','ASSET','DEBIT','Harta','Pajak Dibayar Di Muka',1202),
  ('1112-00-003','Pajak Dibayar Di Muka - PPN Masukan','ASSET','DEBIT','Harta','Pajak Dibayar Di Muka',1203),
  ('1201-00-001','Nilai Perolehan - Inventaris','ASSET','DEBIT','Harta Tetap','Nilai Perolehan Aset Tetap',2001),
  ('1201-00-002','Nilai Perolehan - Peralatan','ASSET','DEBIT','Harta Tetap','Nilai Perolehan Aset Tetap',2002),
  ('1201-00-003','Nilai Perolehan - Pra Operasi','ASSET','DEBIT','Harta Tetap','Nilai Perolehan Aset Tetap',2003),
  ('1202-00-001','Akum. Penyusutan - Inventaris','ASSET','CREDIT','Harta Tetap','Akumulasi Penyusutan Aset Tetap',2101),
  ('1202-00-002','Akum. Penyusutan - Peralatan','ASSET','CREDIT','Harta Tetap','Akumulasi Penyusutan Aset Tetap',2102),
  ('1202-00-003','Akum. Penyusutan - Pra Operasi','ASSET','CREDIT','Harta Tetap','Akumulasi Penyusutan Aset Tetap',2103),
  ('1999-00-001','Aset Tetap Belum Didepresiasi','ASSET','DEBIT','Harta Tidak Lancar','Aktiva Tidak Lancar Lainnya',9901),
  ('1999-00-002','Aktiva Dalam Proses','ASSET','DEBIT','Harta Tidak Lancar','Aktiva Tidak Lancar Lainnya',9902),

  ('2101-00-001','Utang Usaha','LIABILITY','CREDIT','Kewajiban','Utang Usaha',10001),
  ('2101-00-002','Utang Konsinyasi','LIABILITY','CREDIT','Kewajiban','Utang Usaha',10002),
  ('2101-00-003','Uang Muka Penjualan','LIABILITY','CREDIT','Kewajiban','Utang Usaha',10003),
  ('2101-00-004','Utang Belum Ditagih','LIABILITY','CREDIT','Kewajiban','Utang Usaha',10004),
  ('2101-00-099','Utang Lain-lain','LIABILITY','CREDIT','Kewajiban','Utang Usaha',10099),
  ('2102-00-001','Utang Pajak - PPh 21','LIABILITY','CREDIT','Kewajiban','Utang Pajak',10101),
  ('2102-00-002','Utang Pajak - PPh 23','LIABILITY','CREDIT','Kewajiban','Utang Pajak',10102),
  ('2102-00-003','Utang Pajak - PPh Ps 4 ayat 2','LIABILITY','CREDIT','Kewajiban','Utang Pajak',10103),
  ('2102-00-004','Utang Pajak - PPN Keluaran','LIABILITY','CREDIT','Kewajiban','Utang Pajak',10104),
  ('2102-00-005','Utang Pajak - PB1','LIABILITY','CREDIT','Kewajiban','Utang Pajak',10105),
  ('2103-00-001','BMHD - Utang Belum Ditagih','LIABILITY','CREDIT','Kewajiban','Biaya Yang Masih Harus Dibayar',10201),
  ('2103-00-002','BMHD - Gaji Karyawan','LIABILITY','CREDIT','Kewajiban','Biaya Yang Masih Harus Dibayar',10202),
  ('2103-00-003','BMHD - Insentif Manajemen','LIABILITY','CREDIT','Kewajiban','Biaya Yang Masih Harus Dibayar',10203),
  ('2103-00-004','BMHD - Jasa Konsultan','LIABILITY','CREDIT','Kewajiban','Biaya Yang Masih Harus Dibayar',10204),
  ('2103-00-099','BMHD - Lainnya','LIABILITY','CREDIT','Kewajiban','Biaya Yang Masih Harus Dibayar',10299),
  ('2104-00-001','Utang Pinjaman Ke Pengelola','LIABILITY','CREDIT','Kewajiban','Utang Jangka Pendek Pihak Berelasi',10301),
  ('2104-00-002','Utang Bagi Hasil Pengelola','LIABILITY','CREDIT','Kewajiban','Utang Jangka Pendek Pihak Berelasi',10302),
  ('2104-00-003','Utang Bagi Hasil Investor','LIABILITY','CREDIT','Kewajiban','Utang Jangka Pendek Pihak Berelasi',10303),
  ('2104-00-004','Utang Dividen','LIABILITY','CREDIT','Kewajiban','Utang Jangka Pendek Pihak Berelasi',10304),
  ('2104-00-005','Utang Pemegang Saham','LIABILITY','CREDIT','Kewajiban','Utang Jangka Pendek Pihak Berelasi',10305),
  ('2199-00-001','Utang Lain-lain','LIABILITY','CREDIT','Kewajiban','Utang Lain',10901),
  ('2201-00-001','Utang Bank','LIABILITY','CREDIT','Kewajiban Jangka Panjang','Utang Tidak Lancar',11001),
  ('2201-00-002','Utang Jangka Panjang Pihak Berelasi','LIABILITY','CREDIT','Kewajiban Jangka Panjang','Utang Tidak Lancar',11002),

  ('3100-00-001','Modal Disetor Pemilik','EQUITY','CREDIT','Modal','Modal Disetor',12001),
  ('3100-00-002','Modal Disetor Pihak Ketiga','EQUITY','CREDIT','Modal','Modal Disetor',12002),
  ('3201-00-001','Laba Ditahan','EQUITY','CREDIT','Modal','Saldo Laba',12101),
  ('3201-00-002','Laba Rugi Tahun Berjalan','EQUITY','CREDIT','Modal','Saldo Laba',12102),
  ('3201-00-003','Ekuitas Saldo Awal','EQUITY','CREDIT','Modal','Saldo Laba',12103),
  ('3201-00-004','Bagi Hasil Pengelola','EQUITY','DEBIT','Modal','Saldo Laba',12104),
  ('3201-00-005','Bagi Hasil Investor','EQUITY','DEBIT','Modal','Saldo Laba',12105),

  ('4101-00-001','Penjualan Makanan','REVENUE','CREDIT','Pendapatan','Penjualan Produk',13001),
  ('4101-00-002','Penjualan Minuman','REVENUE','CREDIT','Pendapatan','Penjualan Produk',13002),
  ('4101-00-003','Penjualan Produk Lainnya','REVENUE','CREDIT','Pendapatan','Penjualan Produk',13003),
  ('4101-00-004','Pendapatan Catering / Corporate','REVENUE','CREDIT','Pendapatan','Penjualan Produk',13004),
  ('4101-00-099','Penjualan Lainnya','REVENUE','CREDIT','Pendapatan','Penjualan Produk',13099),
  ('4201-00-001','Diskon Penjualan','REVENUE','DEBIT','Pendapatan','Potongan Penjualan',13101),
  ('4201-00-002','Biaya Merchant / Payment Gateway','REVENUE','DEBIT','Pendapatan','Potongan Penjualan',13102),
  ('4201-00-003','Biaya Platform / OJOL','REVENUE','DEBIT','Pendapatan','Potongan Penjualan',13103),
  ('4301-00-001','Retur Penjualan','REVENUE','DEBIT','Pendapatan','Retur Penjualan',13201),
  ('4401-00-001','Selisih Penjualan','REVENUE','DEBIT','Pendapatan','Selisih Penjualan',13301),
  ('4900-00-999','Pendapatan Usaha Lain','REVENUE','CREDIT','Pendapatan','Pendapatan Usaha Lain',13999),

  ('5101-00-001','HPP Makanan','COGS','DEBIT','Harga Pokok Penjualan','HPP Produk',14001),
  ('5101-00-002','HPP Minuman','COGS','DEBIT','Harga Pokok Penjualan','HPP Produk',14002),
  ('5101-00-003','HPP Packaging','COGS','DEBIT','Harga Pokok Penjualan','HPP Produk',14003),
  ('5101-00-099','HPP Lainnya','COGS','DEBIT','Harga Pokok Penjualan','HPP Produk',14099),
  ('5102-00-001','Stock Opname Bahan Baku','COGS','DEBIT','Harga Pokok Penjualan','Stock Opname',14101),
  ('5102-00-002','Stock Opname Bahan Pendukung','COGS','DEBIT','Harga Pokok Penjualan','Stock Opname',14102),
  ('5102-00-003','Stock Opname Barang Jadi / Minuman','COGS','DEBIT','Harga Pokok Penjualan','Stock Opname',14103),
  ('5102-00-099','Selisih Persediaan Lainnya','COGS','DEBIT','Harga Pokok Penjualan','Stock Opname',14199),
  ('5300-00-001','Diskon Pembelian','COGS','CREDIT','Harga Pokok Penjualan','Biaya Atas Pendapatan',14301),
  ('5300-00-002','Biaya Pengiriman Pembelian','COGS','DEBIT','Harga Pokok Penjualan','Biaya Atas Pendapatan',14302),

  ('6000-00-001','Beban Iklan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemasaran',15001),
  ('6000-00-002','Beban Komisi Penjualan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemasaran',15002),
  ('6000-00-003','Beban Compliment','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemasaran',15003),
  ('6000-00-004','Beban Event','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemasaran',15004),
  ('6100-00-001','Beban Gaji & Upah','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Kompensasi SDM',15101),
  ('6100-00-002','Beban Insentif Karyawan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Kompensasi SDM',15102),
  ('6100-00-003','Beban Lembur','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Kompensasi SDM',15103),
  ('6100-00-004','THR Karyawan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Kompensasi SDM',15104),
  ('6200-00-001','Beban Staff Ahli & Perizinan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15201),
  ('6200-00-002','Beban Sistem & Teknologi','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15202),
  ('6200-00-003','Beban Sewa','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15203),
  ('6200-00-004','Beban Listrik','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15204),
  ('6200-00-005','Beban Air','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15205),
  ('6200-00-006','Beban Telepon','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15206),
  ('6200-00-007','Beban Internet','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15207),
  ('6200-00-008','Beban Perlengkapan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15208),
  ('6200-00-009','Beban ATK dan Photocopy','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15209),
  ('6200-00-010','Beban Keamanan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15210),
  ('6200-00-011','Beban Kebersihan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15211),
  ('6200-00-012','Beban Konsumsi','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15212),
  ('6200-00-013','Beban BBM dan Parkir','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15213),
  ('6200-00-014','Beban Jasa Konsultan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15214),
  ('6200-00-015','Beban Jasa Aplikasi','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15215),
  ('6200-00-016','Beban Pajak','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Administrasi Dan Umum',15216),
  ('6300-00-001','Beban Perbaikan Aset','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemeliharaan Aset',15301),
  ('6300-00-002','Beban Renovasi Bangunan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Pemeliharaan Aset',15302),
  ('6900-00-001','Beban Lain-Lain','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Operasional Lain',15901),
  ('6900-00-002','Beban Selisih Kas dan Bank','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Operasional Lain',15902),
  ('6900-00-003','Selisih Pembulatan','EXPENSE','DEBIT','Pengeluaran Operasional','Beban Operasional Lain',15903),

  ('7000-00-001','Beban Peny. Inventaris','EXPENSE','DEBIT','Pengeluaran Non Operasional','Beban Penyusutan Aset Tetap',16001),
  ('7000-00-002','Beban Peny. Peralatan','EXPENSE','DEBIT','Pengeluaran Non Operasional','Beban Penyusutan Aset Tetap',16002),
  ('7000-00-003','Beban Peny. Pra Operasi','EXPENSE','DEBIT','Pengeluaran Non Operasional','Beban Penyusutan Aset Tetap',16003),
  ('8000-00-001','Pendapatan Bunga Bank','OTHER_INCOME','CREDIT','Pendapatan Lain','Pendapatan Luar Usaha',17001),
  ('8000-00-002','Laba / Rugi Selisih Kurs','OTHER_INCOME','CREDIT','Pendapatan Lain','Pendapatan Luar Usaha',17002),
  ('8001-00-001','Beban Jasa Bank','OTHER_EXPENSE','DEBIT','Pendapatan Lain','Beban Luar Usaha',17101),
  ('8001-00-002','Pajak Bank','OTHER_EXPENSE','DEBIT','Pendapatan Lain','Beban Luar Usaha',17102),
  ('9000-00-001','Beban Pajak Penghasilan','OTHER_EXPENSE','DEBIT','Pengeluaran Lain','Beban Pajak Penghasilan',18001)
) AS v(code,name,account_type,normal_balance,report_group,report_subgroup,sort_order)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT (template_id,code) DO UPDATE SET
  name=EXCLUDED.name,
  account_type=EXCLUDED.account_type,
  normal_balance=EXCLUDED.normal_balance,
  report_group=EXCLUDED.report_group,
  report_subgroup=EXCLUDED.report_subgroup,
  sort_order=EXCLUDED.sort_order;

INSERT INTO coa_template_important_accounts(template_id,role_code,label,account_code)
SELECT t.id,v.role_code,v.label,v.account_code
FROM coa_templates t
CROSS JOIN (VALUES
  ('TRADE_RECEIVABLE','Piutang Usaha Default','1103-00-001'),
  ('TRADE_PAYABLE','Utang Usaha Default','2101-00-001'),
  ('PURCHASE_ADVANCE','Uang Muka Pembelian','1110-00-001'),
  ('EMPLOYEE_ADVANCE','Uang Muka Karyawan','1110-00-002'),
  ('ASSET_PURCHASE_ADVANCE','Uang Muka Pembelian Aset','1110-00-003'),
  ('CUSTOMER_ADVANCE','Uang Muka Pelanggan / Penjualan','2101-00-003'),
  ('UNBILLED_PURCHASE','Utang Belum Ditagih','2101-00-004'),
  ('ACCRUED_EXPENSE','Biaya Masih Harus Dibayar Default','2103-00-099'),
  ('RETAINED_EARNINGS','Laba Ditahan','3201-00-001'),
  ('CURRENT_YEAR_EARNINGS','Laba Rugi Tahun Berjalan','3201-00-002'),
  ('OPENING_BALANCE_EQUITY','Ekuitas Saldo Awal','3201-00-003'),
  ('CASH_BANK_VARIANCE','Selisih Kas dan Bank','6900-00-002'),
  ('ROUNDING','Selisih Pembulatan','6900-00-003')
) AS v(role_code,label,account_code)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT (template_id,role_code) DO UPDATE SET label=EXCLUDED.label,account_code=EXCLUDED.account_code;

INSERT INTO coa_template_item_categories(template_id,category_code,category_name,category_type,inventory_account_code,cogs_account_code,sales_account_code,usage_account_code)
SELECT t.id,v.category_code,v.category_name,v.category_type,v.inventory_account_code,v.cogs_account_code,v.sales_account_code,v.usage_account_code
FROM coa_templates t
CROSS JOIN (VALUES
  ('BAHAN_BAKU','Bahan Baku','RAW_MATERIAL','1105-00-001',NULL,NULL,NULL),
  ('BAHAN_PENDUKUNG','Bahan Pendukung','SUPPLIES','1105-00-002',NULL,NULL,NULL),
  ('SETENGAH_JADI','Bahan Setengah Jadi','SEMI_FINISHED','1105-00-003',NULL,NULL,NULL),
  ('MAKANAN','Makanan / Food','FINISHED_GOOD','1105-00-004','5101-00-001','4101-00-001',NULL),
  ('MINUMAN','Minuman / Beverage','FINISHED_GOOD','1105-00-004','5101-00-002','4101-00-002',NULL),
  ('PACKAGING','Packaging','PACKAGING','1105-00-005','5101-00-003',NULL,'5101-00-003'),
  ('PRODUK_LAIN','Produk Lainnya','OTHER','1105-00-099','5101-00-099','4101-00-099',NULL)
) AS v(category_code,category_name,category_type,inventory_account_code,cogs_account_code,sales_account_code,usage_account_code)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT (template_id,category_code) DO UPDATE SET
  category_name=EXCLUDED.category_name,
  category_type=EXCLUDED.category_type,
  inventory_account_code=EXCLUDED.inventory_account_code,
  cogs_account_code=EXCLUDED.cogs_account_code,
  sales_account_code=EXCLUDED.sales_account_code,
  usage_account_code=EXCLUDED.usage_account_code;

INSERT INTO coa_template_asset_categories(template_id,category_code,category_name,asset_account_code,accumulated_depreciation_account_code,depreciation_expense_account_code)
SELECT t.id,v.category_code,v.category_name,v.asset_account_code,v.accumulated_depreciation_account_code,v.depreciation_expense_account_code
FROM coa_templates t
CROSS JOIN (VALUES
  ('INVENTARIS','Inventaris','1201-00-001','1202-00-001','7000-00-001'),
  ('PERALATAN','Peralatan','1201-00-002','1202-00-002','7000-00-002'),
  ('PRA_OPERASI','Pra Operasi','1201-00-003','1202-00-003','7000-00-003')
) AS v(category_code,category_name,asset_account_code,accumulated_depreciation_account_code,depreciation_expense_account_code)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT (template_id,category_code) DO UPDATE SET
  category_name=EXCLUDED.category_name,
  asset_account_code=EXCLUDED.asset_account_code,
  accumulated_depreciation_account_code=EXCLUDED.accumulated_depreciation_account_code,
  depreciation_expense_account_code=EXCLUDED.depreciation_expense_account_code;

INSERT INTO coa_template_tax_accounts(template_id,tax_role_code,label,account_code)
SELECT t.id,v.tax_role_code,v.label,v.account_code
FROM coa_templates t
CROSS JOIN (VALUES
  ('PPN_MASUKAN','PPN Masukan','1112-00-003'),
  ('PPN_KELUARAN','PPN Keluaran','2102-00-004'),
  ('PPH23_DIBAYAR_DIMUKA','PPh 23 Dibayar Di Muka','1112-00-001'),
  ('PPH25_DIBAYAR_DIMUKA','PPh 25 Dibayar Di Muka','1112-00-002'),
  ('PPH21_TERUTANG','PPh 21 Terutang','2102-00-001'),
  ('PPH23_TERUTANG','PPh 23 Terutang','2102-00-002'),
  ('PPH4_2_TERUTANG','PPh Ps 4 ayat 2 Terutang','2102-00-003'),
  ('PB1_TERUTANG','PB1 Terutang','2102-00-005')
) AS v(tax_role_code,label,account_code)
WHERE t.code='AK_FNB_STANDARD_V1'
ON CONFLICT (template_id,tax_role_code) DO UPDATE SET label=EXCLUDED.label,account_code=EXCLUDED.account_code;

CREATE INDEX IF NOT EXISTS idx_coa_template_accounts_template ON coa_template_accounts(template_id,sort_order);
CREATE INDEX IF NOT EXISTS idx_item_category_mapping_company ON item_category_account_mappings(company_id);
CREATE INDEX IF NOT EXISTS idx_asset_category_mapping_company ON asset_category_account_mappings(company_id);
CREATE INDEX IF NOT EXISTS idx_tax_account_defaults_company ON tax_account_defaults(company_id);
