CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  tax_number TEXT,
  base_currency CHAR(3) NOT NULL DEFAULT 'IDR',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES locations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type IN ('HEAD_OFFICE','OUTLET','CENTRAL_KITCHEN','WAREHOUSE','PRODUCTION_KITCHEN','CLOUD_KITCHEN','BOOTH','OTHER')),
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES cost_centers(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','LOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('CLIENT','AKUNTAKITA','SYSTEM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_membership_scope
ON workspace_memberships(
  workspace_id,
  user_id,
  role_id,
  COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE TABLE IF NOT EXISTS units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  decimal_precision SMALLINT NOT NULL DEFAULT 3 CHECK (decimal_precision BETWEEN 0 AND 6),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES item_categories(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category_type TEXT NOT NULL CHECK (category_type IN ('RAW_MATERIAL','SEMI_FINISHED','FINISHED_GOOD','PACKAGING','SUPPLIES','NON_INVENTORY','SERVICE','ASSET_CANDIDATE','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id UUID NOT NULL REFERENCES item_categories(id),
  base_unit_id UUID NOT NULL REFERENCES units(id),
  track_stock BOOLEAN NOT NULL DEFAULT TRUE,
  can_purchase BOOLEAN NOT NULL DEFAULT TRUE,
  can_sell BOOLEAN NOT NULL DEFAULT FALSE,
  can_produce BOOLEAN NOT NULL DEFAULT FALSE,
  can_use_in_recipe BOOLEAN NOT NULL DEFAULT TRUE,
  valuation_method TEXT NOT NULL DEFAULT 'MOVING_AVERAGE' CHECK (valuation_method IN ('MOVING_AVERAGE','STANDARD','NONE')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS unit_conversions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  from_unit_id UUID NOT NULL REFERENCES units(id),
  to_unit_id UUID NOT NULL REFERENCES units(id),
  multiplier NUMERIC(20,8) NOT NULL CHECK (multiplier > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_unit_conversion_scope
ON unit_conversions(
  workspace_id,
  COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid),
  from_unit_id,
  to_unit_id
);

CREATE TABLE IF NOT EXISTS business_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('SUPPLIER','CUSTOMER','BOTH','MERCHANT','OTHER')),
  tax_number TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  payment_term_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_term_days >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES chart_of_accounts(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE','OTHER_INCOME','OTHER_EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  allow_manual_posting BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS tax_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  tax_type TEXT NOT NULL CHECK (tax_type IN ('VAT','WITHHOLDING','NONE','OTHER')),
  rate NUMERIC(9,6) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  default_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
  input_tax_account_id UUID REFERENCES chart_of_accounts(id),
  output_tax_account_id UUID REFERENCES chart_of_accounts(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(workspace_id, code, effective_from)
);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('DINE_IN','TAKE_AWAY','OJOL','WHATSAPP','WEBSITE','CATERING','CORPORATE','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  method_type TEXT NOT NULL CHECK (method_type IN ('CASH','BANK_TRANSFER','QRIS','CARD','OJOL','EWALLET','CREDIT','OTHER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(workspace_id, code)
);

CREATE TABLE IF NOT EXISTS financial_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_kind TEXT NOT NULL CHECK (account_kind IN ('CASH','BANK','SETTLEMENT','EWALLET','CLEARING','OTHER')),
  coa_account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS important_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  UNIQUE(company_id, role_code)
);

CREATE INDEX IF NOT EXISTS idx_locations_workspace ON locations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_items_workspace ON items(workspace_id);
CREATE INDEX IF NOT EXISTS idx_partners_workspace ON business_partners(workspace_id);

INSERT INTO roles(code, name, side) VALUES
  ('CLIENT_FINANCE_STAFF', 'Finance Staff', 'CLIENT'),
  ('CLIENT_FINANCE_MANAGER', 'Finance Manager', 'CLIENT'),
  ('CLIENT_OWNER', 'Owner / Management', 'CLIENT'),
  ('CLIENT_OUTLET_USER', 'Outlet User', 'CLIENT'),
  ('AK_ACCOUNTING_STAFF', 'Accounting Staff', 'AKUNTAKITA'),
  ('AK_ACCOUNTING_REVIEWER', 'Accounting Reviewer', 'AKUNTAKITA'),
  ('AK_SUPER_ADMIN', 'Super Admin', 'AKUNTAKITA')
ON CONFLICT (code) DO NOTHING;
