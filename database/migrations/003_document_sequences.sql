CREATE TABLE IF NOT EXISTS document_sequences (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL,
  sequence_year INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  PRIMARY KEY(company_id, transaction_type, sequence_year)
);

CREATE INDEX IF NOT EXISTS idx_document_sequences_company
ON document_sequences(company_id, transaction_type, sequence_year);
