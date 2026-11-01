SET time_zone = '+00:00';

/* Penanda wajib ganti password (reset oleh admin / bootstrap reset). */
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at DATETIME(6) NULL;
