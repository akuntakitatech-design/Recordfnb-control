-- Lampiran dokumen generik untuk semua transaksi (entity_type + entity_id).
-- Isi file disimpan di kolom BLOB agar tidak bergantung pada volume container.
-- Batas: 5 MB per file, maksimal 10 file per permintaan.

CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) NOT NULL,
  legal_entity_id CHAR(36) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  file_name VARCHAR(200) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT NOT NULL,
  content MEDIUMBLOB NOT NULL,
  uploaded_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_attachment_entity (entity_type, entity_id),
  KEY idx_attachment_created (legal_entity_id, created_at),
  CONSTRAINT fk_attachment_entity FOREIGN KEY (legal_entity_id) REFERENCES legal_entities (id) ON DELETE RESTRICT,
  CONSTRAINT chk_attachment_size CHECK (size_bytes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
