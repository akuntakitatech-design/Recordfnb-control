-- Flexible POS import profiles v0.16A

CREATE TABLE IF NOT EXISTS sales_import_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  file_mode TEXT NOT NULL DEFAULT 'WIDE' CHECK (file_mode IN ('WIDE','VERTICAL','REPORT')),
  header_row INTEGER NOT NULL DEFAULT 1 CHECK (header_row > 0),
  delimiter TEXT NOT NULL DEFAULT 'AUTO',
  date_format TEXT NOT NULL DEFAULT 'AUTO',
  number_format TEXT NOT NULL DEFAULT 'AUTO',
  header_signature JSONB NOT NULL DEFAULT '[]'::jsonb,
  column_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,name)
);

CREATE TABLE IF NOT EXISTS sales_import_item_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sales_import_profiles(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_code TEXT,
  external_name TEXT NOT NULL DEFAULT '',
  item_id UUID NOT NULL REFERENCES items(id),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (COALESCE(NULLIF(BTRIM(external_code),''),NULLIF(BTRIM(external_name),'')) IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_import_item_alias_code
ON sales_import_item_aliases(profile_id,UPPER(BTRIM(external_code)))
WHERE external_code IS NOT NULL AND BTRIM(external_code)<>'';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_import_item_alias_name
ON sales_import_item_aliases(profile_id,LOWER(BTRIM(external_name)))
WHERE BTRIM(external_name)<>'';

CREATE TABLE IF NOT EXISTS sales_import_payment_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sales_import_profiles(id) ON DELETE CASCADE,
  external_value TEXT NOT NULL,
  payment_code TEXT NOT NULL CHECK (payment_code IN ('CASH','QRIS','TRANSFER','COMPLIMENT','GOFOOD','GRABFOOD','SHOPEEFOOD','OTHER')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(profile_id,external_value)
);

ALTER TABLE sales_import_batches
  ADD COLUMN IF NOT EXISTS import_profile_id UUID REFERENCES sales_import_profiles(id),
  ADD COLUMN IF NOT EXISTS header_signature JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS parser_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_sales_import_profiles_company
ON sales_import_profiles(company_id,status,name);

CREATE INDEX IF NOT EXISTS idx_sales_import_item_aliases_profile
ON sales_import_item_aliases(profile_id,item_id);

CREATE INDEX IF NOT EXISTS idx_sales_import_payment_aliases_profile
ON sales_import_payment_aliases(profile_id,payment_code);
