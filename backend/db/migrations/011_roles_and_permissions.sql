-- Role dinamis: daftar role, katalog permission, dan kewenangan per role.
-- Katalog permission diisi ulang otomatis oleh backend saat start.

CREATE TABLE IF NOT EXISTS permissions (
  code VARCHAR(64) NOT NULL,
  group_name VARCHAR(64) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS roles (
  id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  is_global TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  sort_order INT NOT NULL DEFAULT 100,
  seeded_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_code (code),
  CONSTRAINT chk_roles_status CHECK (status IN ('ACTIVE','INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id CHAR(36) NOT NULL,
  permission VARCHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (role_id, permission),
  KEY idx_role_permissions_code (permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- Role bawaan (is_system = 1 tidak bisa dihapus dan otomatis mengikuti fitur baru).
INSERT IGNORE INTO roles (id, code, name, description, is_system, is_global, sort_order) VALUES
  ('11111111-0000-4000-8000-000000000001', 'PIMPINAN', 'Pimpinan Yayasan', 'Monitoring semua cabang dan persetujuan.', 1, 1, 10),
  ('11111111-0000-4000-8000-000000000002', 'ADMIN_YAYASAN', 'Admin Yayasan', 'Organisasi, pengguna, role, rekening, dan unit.', 1, 1, 20),
  ('11111111-0000-4000-8000-000000000003', 'FINANCE_PUSAT', 'Finance Pusat', 'Rekening, penagihan, penerimaan, pembayaran, dan MCM seluruh unit.', 1, 1, 30),
  ('11111111-0000-4000-8000-000000000004', 'ACCOUNTING_PUSAT', 'Accounting Pusat', 'Mapping akun, jurnal, dan tutup buku.', 1, 1, 40),
  ('11111111-0000-4000-8000-000000000005', 'KEPALA_JENJANG', 'Kepala Jenjang', 'Monitoring dan persetujuan pada jenjang yang ditetapkan.', 1, 0, 50),
  ('11111111-0000-4000-8000-000000000006', 'KEPALA_CABANG', 'Kepala Cabang', 'Monitoring dan persetujuan unit sendiri.', 1, 0, 60),
  ('11111111-0000-4000-8000-000000000007', 'BENDAHARA_CABANG', 'Bendahara Cabang', 'Input transaksi dan pembayaran pada unit sendiri.', 1, 0, 70),
  ('11111111-0000-4000-8000-000000000008', 'PURCHASING', 'Purchasing', 'Pengaju pembelian pada unit yang ditetapkan.', 1, 0, 80),
  ('11111111-0000-4000-8000-000000000009', 'AUDITOR', 'Auditor', 'Read-only dan audit trail.', 1, 1, 90);

-- Role kini dikelola tabel, sehingga CHECK pada users.role tidak lagi relevan.
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
