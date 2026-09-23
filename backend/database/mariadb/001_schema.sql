-- =============================================================
-- Akuntakita F&B Control — Skema MariaDB 11.x (konsolidasi dari skema final PostgreSQL)
-- Dihasilkan oleh scripts/convert_schema.py + penyesuaian manual (generated columns, trigger).
-- Konvensi: uuid -> CHAR(36) DEFAULT (UUID()), timestamptz -> DATETIME(6) UTC, jsonb -> JSON,
--           boolean -> TINYINT(1), numeric -> DECIMAL, citext -> VARCHAR (collation *_ai_ci = case-insensitive).
-- =============================================================
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS workspaces (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY workspaces_code_key (code),
  CONSTRAINT workspaces_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS companies (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  legal_name TEXT,
  tax_number VARCHAR(255),
  base_currency CHAR(3) NOT NULL DEFAULT 'IDR',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY companies_workspace_id_code_key (workspace_id, code),
  CONSTRAINT companies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT companies_fiscal_year_start_month_check CHECK (((fiscal_year_start_month >= 1) AND (fiscal_year_start_month <= 12))),
  CONSTRAINT companies_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS accounting_periods (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'OPEN',
  soft_closed_at DATETIME(6),
  hard_closed_at DATETIME(6),
  PRIMARY KEY (id),
  UNIQUE KEY accounting_periods_company_id_period_start_period_end_key (company_id, period_start, period_end),
  CONSTRAINT accounting_periods_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT accounting_periods_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT accounting_periods_check CHECK ((period_end >= period_start)),
  CONSTRAINT accounting_periods_status_check CHECK (status IN ('OPEN', 'SOFT_CLOSED', 'HARD_CLOSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS asset_categories (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY asset_categories_workspace_id_code_key (workspace_id, code),
  CONSTRAINT asset_categories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT asset_categories_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  parent_id CHAR(36),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  account_type VARCHAR(255) NOT NULL,
  normal_balance VARCHAR(500) NOT NULL,
  allow_manual_posting TINYINT(1) NOT NULL DEFAULT 1,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  report_group VARCHAR(500),
  report_subgroup VARCHAR(500),
  PRIMARY KEY (id),
  UNIQUE KEY chart_of_accounts_company_id_code_key (company_id, code),
  CONSTRAINT chart_of_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT chart_of_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT chart_of_accounts_account_type_check CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')),
  CONSTRAINT chart_of_accounts_normal_balance_check CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  CONSTRAINT chart_of_accounts_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS asset_category_account_mappings (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  asset_category_id CHAR(36) NOT NULL,
  asset_account_id CHAR(36) NOT NULL,
  accumulated_depreciation_account_id CHAR(36) NOT NULL,
  depreciation_expense_account_id CHAR(36) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY asset_category_account_mapping_company_id_asset_category_id_key (company_id, asset_category_id),
  KEY idx_asset_category_mapping_company (company_id),
  CONSTRAINT asset_category_account_mappin_accumulated_depreciation_acc_fkey FOREIGN KEY (accumulated_depreciation_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT asset_category_account_mappin_depreciation_expense_account_fkey FOREIGN KEY (depreciation_expense_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT asset_category_account_mappings_asset_account_id_fkey FOREIGN KEY (asset_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT asset_category_account_mappings_asset_category_id_fkey FOREIGN KEY (asset_category_id) REFERENCES asset_categories (id) ON DELETE CASCADE,
  CONSTRAINT asset_category_account_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  email VARCHAR(191) NOT NULL,
  password_hash VARCHAR(500) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  is_system_admin TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_key (email),
  CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  entity_type VARCHAR(255) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type VARCHAR(255),
  file_size BIGINT,
  uploaded_by CHAR(36),
  uploaded_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users (id),
  CONSTRAINT attachments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  workspace_id CHAR(36),
  user_id CHAR(36),
  entity_type VARCHAR(191) NOT NULL,
  entity_id VARCHAR(191) NOT NULL,
  action VARCHAR(255) NOT NULL,
  before_data JSON,
  after_data JSON,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT audit_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS item_categories (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  parent_id CHAR(36),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  category_type VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY item_categories_workspace_id_code_key (workspace_id, code),
  CONSTRAINT item_categories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT item_categories_category_type_check CHECK (category_type IN ('RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD', 'PACKAGING', 'SUPPLIES', 'NON_INVENTORY', 'SERVICE', 'ASSET_CANDIDATE', 'OTHER')),
  CONSTRAINT item_categories_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS units (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  decimal_precision SMALLINT NOT NULL DEFAULT 3,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY units_workspace_id_code_key (workspace_id, code),
  CONSTRAINT units_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT units_decimal_precision_check CHECK (((decimal_precision >= 0) AND (decimal_precision <= 6))),
  CONSTRAINT units_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS items (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  category_id CHAR(36) NOT NULL,
  base_unit_id CHAR(36) NOT NULL,
  track_stock TINYINT(1) NOT NULL DEFAULT 1,
  can_purchase TINYINT(1) NOT NULL DEFAULT 1,
  can_sell TINYINT(1) NOT NULL DEFAULT 0,
  can_produce TINYINT(1) NOT NULL DEFAULT 0,
  can_use_in_recipe TINYINT(1) NOT NULL DEFAULT 1,
  valuation_method VARCHAR(255) NOT NULL DEFAULT 'MOVING_AVERAGE',
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY items_workspace_id_code_key (workspace_id, code),
  KEY idx_items_workspace (workspace_id),
  CONSTRAINT items_base_unit_id_fkey FOREIGN KEY (base_unit_id) REFERENCES units (id),
  CONSTRAINT items_category_id_fkey FOREIGN KEY (category_id) REFERENCES item_categories (id),
  CONSTRAINT items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT items_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT items_valuation_method_check CHECK (valuation_method IN ('MOVING_AVERAGE', 'STANDARD', 'NONE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS bom_headers (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  bom_type VARCHAR(191) NOT NULL,
  output_item_id CHAR(36) NOT NULL,
  output_quantity DECIMAL(20,6) NOT NULL DEFAULT 1,
  output_unit_id CHAR(36) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  notes TEXT,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY bom_headers_company_id_bom_type_output_item_id_key (company_id, bom_type, output_item_id),
  KEY idx_bom_headers_company_type (company_id, bom_type, status, output_item_id),
  CONSTRAINT bom_headers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT bom_headers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT bom_headers_output_item_id_fkey FOREIGN KEY (output_item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT bom_headers_output_unit_id_fkey FOREIGN KEY (output_unit_id) REFERENCES units (id),
  CONSTRAINT bom_headers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT bom_headers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT bom_headers_bom_type_check CHECK (bom_type IN ('MENU', 'PRODUCTION')),
  CONSTRAINT bom_headers_output_quantity_check CHECK ((output_quantity > (0))),
  CONSTRAINT bom_headers_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT bom_headers_version_check CHECK ((version > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS bom_lines (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  bom_id CHAR(36) NOT NULL,
  line_no INT NOT NULL,
  component_item_id CHAR(36) NOT NULL,
  quantity DECIMAL(20,6) NOT NULL,
  unit_id CHAR(36) NOT NULL,
  waste_percent DECIMAL(9,4) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY bom_lines_bom_id_component_item_id_key (bom_id, component_item_id),
  UNIQUE KEY bom_lines_bom_id_line_no_key (bom_id, line_no),
  KEY idx_bom_lines_bom (bom_id, line_no),
  CONSTRAINT bom_lines_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES bom_headers (id) ON DELETE CASCADE,
  CONSTRAINT bom_lines_component_item_id_fkey FOREIGN KEY (component_item_id) REFERENCES items (id),
  CONSTRAINT bom_lines_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES units (id),
  CONSTRAINT bom_lines_line_no_check CHECK ((line_no > 0)),
  CONSTRAINT bom_lines_quantity_check CHECK ((quantity > (0))),
  CONSTRAINT bom_lines_waste_percent_check CHECK (((waste_percent >= (0)) AND (waste_percent <= (100))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS business_partners (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  partner_type VARCHAR(255) NOT NULL,
  tax_number VARCHAR(255),
  phone VARCHAR(500),
  email VARCHAR(255),
  address TEXT,
  payment_term_days INT NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY business_partners_workspace_id_code_key (workspace_id, code),
  KEY idx_partners_workspace (workspace_id),
  CONSTRAINT business_partners_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT business_partners_partner_type_check CHECK (partner_type IN ('SUPPLIER', 'CUSTOMER', 'BOTH', 'MERCHANT', 'OTHER')),
  CONSTRAINT business_partners_payment_term_days_check CHECK ((payment_term_days >= 0)),
  CONSTRAINT business_partners_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS channels (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  channel_type VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY channels_workspace_id_code_key (workspace_id, code),
  CONSTRAINT channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT channels_channel_type_check CHECK (channel_type IN ('DINE_IN', 'TAKE_AWAY', 'OJOL', 'WHATSAPP', 'WEBSITE', 'CATERING', 'CORPORATE', 'OTHER')),
  CONSTRAINT channels_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_templates (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  industry VARCHAR(500) NOT NULL DEFAULT 'F&B',
  version INT NOT NULL DEFAULT 1,
  description TEXT,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY coa_templates_code_key (code),
  CONSTRAINT coa_templates_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_template_accounts (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  template_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  account_type VARCHAR(255) NOT NULL,
  normal_balance VARCHAR(500) NOT NULL,
  report_group VARCHAR(500) NOT NULL,
  report_subgroup VARCHAR(500),
  allow_manual_posting TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY coa_template_accounts_template_id_code_key (template_id, code),
  KEY idx_coa_template_accounts_template (template_id, sort_order),
  CONSTRAINT coa_template_accounts_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id) ON DELETE CASCADE,
  CONSTRAINT coa_template_accounts_account_type_check CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')),
  CONSTRAINT coa_template_accounts_normal_balance_check CHECK (normal_balance IN ('DEBIT', 'CREDIT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_template_asset_categories (
  template_id CHAR(36) NOT NULL,
  category_code VARCHAR(191) NOT NULL,
  category_name VARCHAR(255) NOT NULL,
  asset_account_code VARCHAR(255) NOT NULL,
  accumulated_depreciation_account_code VARCHAR(255) NOT NULL,
  depreciation_expense_account_code VARCHAR(255) NOT NULL,
  PRIMARY KEY (template_id, category_code),
  CONSTRAINT coa_template_asset_categories_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_template_important_accounts (
  template_id CHAR(36) NOT NULL,
  role_code VARCHAR(191) NOT NULL,
  label VARCHAR(255) NOT NULL,
  account_code VARCHAR(255) NOT NULL,
  PRIMARY KEY (template_id, role_code),
  CONSTRAINT coa_template_important_accounts_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_template_item_categories (
  template_id CHAR(36) NOT NULL,
  category_code VARCHAR(191) NOT NULL,
  category_name VARCHAR(255) NOT NULL,
  category_type VARCHAR(255) NOT NULL,
  inventory_account_code VARCHAR(255),
  cogs_account_code VARCHAR(255),
  sales_account_code VARCHAR(255),
  usage_account_code VARCHAR(255),
  stock_adjustment_account_code VARCHAR(255),
  PRIMARY KEY (template_id, category_code),
  CONSTRAINT coa_template_item_categories_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id) ON DELETE CASCADE,
  CONSTRAINT coa_template_item_categories_category_type_check CHECK (category_type IN ('RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED_GOOD', 'PACKAGING', 'SUPPLIES', 'NON_INVENTORY', 'SERVICE', 'ASSET_CANDIDATE', 'OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS coa_template_tax_accounts (
  template_id CHAR(36) NOT NULL,
  tax_role_code VARCHAR(191) NOT NULL,
  label VARCHAR(255) NOT NULL,
  account_code VARCHAR(255) NOT NULL,
  PRIMARY KEY (template_id, tax_role_code),
  CONSTRAINT coa_template_tax_accounts_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS company_coa_template_applications (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  template_id CHAR(36) NOT NULL,
  template_version INT NOT NULL,
  applied_by CHAR(36),
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT company_coa_template_applications_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES users (id),
  CONSTRAINT company_coa_template_applications_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT company_coa_template_applications_template_id_fkey FOREIGN KEY (template_id) REFERENCES coa_templates (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS cost_centers (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  parent_id CHAR(36),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY cost_centers_company_id_code_key (company_id, code),
  CONSTRAINT cost_centers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT cost_centers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT cost_centers_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS document_sequences (
  company_id CHAR(36) NOT NULL,
  transaction_type VARCHAR(191) NOT NULL,
  sequence_year INT NOT NULL,
  last_number INT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, transaction_type, sequence_year),
  KEY idx_document_sequences_company (company_id, transaction_type, sequence_year),
  CONSTRAINT document_sequences_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT document_sequences_last_number_check CHECK ((last_number >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS locations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  parent_id CHAR(36),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  location_type VARCHAR(255) NOT NULL,
  address TEXT,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY locations_company_id_code_key (company_id, code),
  KEY idx_locations_workspace (workspace_id),
  CONSTRAINT locations_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT locations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT locations_location_type_check CHECK (location_type IN ('HEAD_OFFICE', 'OUTLET', 'CENTRAL_KITCHEN', 'WAREHOUSE', 'PRODUCTION_KITCHEN', 'CLOUD_KITCHEN', 'BOOTH', 'OTHER')),
  CONSTRAINT locations_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS financial_accounts (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  account_kind VARCHAR(255) NOT NULL,
  coa_account_id CHAR(36) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY financial_accounts_company_id_code_key (company_id, code),
  CONSTRAINT financial_accounts_coa_account_id_fkey FOREIGN KEY (coa_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT financial_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT financial_accounts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id),
  CONSTRAINT financial_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT financial_accounts_account_kind_check CHECK (account_kind IN ('CASH', 'BANK', 'SETTLEMENT', 'EWALLET', 'CLEARING', 'OTHER')),
  CONSTRAINT financial_accounts_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS important_accounts (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  role_code VARCHAR(191) NOT NULL,
  account_id CHAR(36) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY important_accounts_company_id_role_code_key (company_id, role_code),
  CONSTRAINT important_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT important_accounts_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT important_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS inventory_balances (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  quantity_on_hand DECIMAL(20,6) NOT NULL DEFAULT 0,
  average_cost DECIMAL(20,6) NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY inventory_balances_company_id_location_id_item_id_key (company_id, location_id, item_id),
  KEY idx_inventory_balances_company_location (company_id, location_id, item_id),
  CONSTRAINT inventory_balances_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT inventory_balances_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT inventory_balances_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT inventory_balances_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_import_profiles (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  name VARCHAR(191) NOT NULL,
  provider VARCHAR(255),
  status VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  file_mode VARCHAR(255) NOT NULL DEFAULT 'WIDE',
  header_row INT NOT NULL DEFAULT 1,
  delimiter VARCHAR(255) NOT NULL DEFAULT 'AUTO',
  date_format VARCHAR(255) NOT NULL DEFAULT 'AUTO',
  number_format VARCHAR(255) NOT NULL DEFAULT 'AUTO',
  header_signature JSON NOT NULL DEFAULT ('[]'),
  column_mapping JSON NOT NULL DEFAULT ('{}'),
  settings JSON NOT NULL DEFAULT ('{}'),
  created_by CHAR(36),
  updated_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY sales_import_profiles_company_id_name_key (company_id, name),
  KEY idx_sales_import_profiles_company (company_id, status, name),
  CONSTRAINT sales_import_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT sales_import_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT sales_import_profiles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_profiles_file_mode_check CHECK (file_mode IN ('WIDE', 'VERTICAL', 'REPORT')),
  CONSTRAINT sales_import_profiles_header_row_check CHECK ((header_row > 0)),
  CONSTRAINT sales_import_profiles_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_import_batches (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  batch_number VARCHAR(191) NOT NULL,
  source_type VARCHAR(255) NOT NULL DEFAULT 'PASTE',
  source_name VARCHAR(255),
  status VARCHAR(255) NOT NULL DEFAULT 'DRAFT',
  row_count INT NOT NULL DEFAULT 0,
  invoice_count INT NOT NULL DEFAULT 0,
  total_sales DECIMAL(20,4) NOT NULL DEFAULT 0,
  total_payments DECIMAL(20,4) NOT NULL DEFAULT 0,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  verified_by CHAR(36),
  verified_at DATETIME(6),
  import_profile_id CHAR(36),
  header_signature JSON NOT NULL DEFAULT ('[]'),
  parser_metadata JSON NOT NULL DEFAULT ('{}'),
  PRIMARY KEY (id),
  UNIQUE KEY sales_import_batches_company_id_batch_number_key (company_id, batch_number),
  KEY idx_sales_import_batches_company_date (company_id, created_at DESC),
  CONSTRAINT sales_import_batches_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT sales_import_batches_import_profile_id_fkey FOREIGN KEY (import_profile_id) REFERENCES sales_import_profiles (id),
  CONSTRAINT sales_import_batches_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_batches_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES users (id),
  CONSTRAINT sales_import_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_batches_source_type_check CHECK (source_type IN ('MANUAL', 'PASTE', 'CSV')),
  CONSTRAINT sales_import_batches_status_check CHECK (status IN ('DRAFT', 'FINANCE_VERIFIED', 'VOID'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS transaction_headers (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36),
  transaction_type VARCHAR(191) NOT NULL,
  transaction_number VARCHAR(191) NOT NULL,
  transaction_date DATE NOT NULL,
  partner_id CHAR(36),
  reference_number VARCHAR(191),
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  exchange_rate DECIMAL(20,8) NOT NULL DEFAULT 1,
  workflow_status VARCHAR(255) NOT NULL DEFAULT 'DRAFT',
  operational_status VARCHAR(255) NOT NULL DEFAULT 'DRAFT',
  accounting_status VARCHAR(191) NOT NULL DEFAULT 'NOT_READY',
  payment_status VARCHAR(255) NOT NULL DEFAULT 'UNPAID',
  due_date DATE,
  notes TEXT,
  document_discount_type VARCHAR(255),
  document_discount_value DECIMAL(20,4) NOT NULL DEFAULT 0,
  gross_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  line_discount_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  document_discount_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  dpp_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  grand_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  financial_account_id CHAR(36),
  verified_by CHAR(36),
  verified_at DATETIME(6),
  payment_type VARCHAR(255),
  cash_out_type VARCHAR(255),
  payee_name VARCHAR(255),
  cash_in_type VARCHAR(255),
  source_name VARCHAR(255),
  negative_stock_override TINYINT(1) NOT NULL DEFAULT 0,
  transfer_to_location_id CHAR(36),
  sales_import_batch_id CHAR(36),
  PRIMARY KEY (id),
  UNIQUE KEY transaction_headers_company_id_transaction_type_transaction_key (company_id, transaction_type, transaction_number),
  KEY idx_transactions_company_type (company_id, transaction_type, transaction_date),
  KEY idx_transactions_financial_account (financial_account_id, transaction_date),
  KEY idx_transactions_workspace_date (workspace_id, transaction_date),
  CONSTRAINT transaction_headers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT transaction_headers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT transaction_headers_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES financial_accounts (id),
  CONSTRAINT transaction_headers_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id),
  CONSTRAINT transaction_headers_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES business_partners (id),
  CONSTRAINT transaction_headers_sales_import_batch_id_fkey FOREIGN KEY (sales_import_batch_id) REFERENCES sales_import_batches (id),
  CONSTRAINT transaction_headers_transfer_to_location_id_fkey FOREIGN KEY (transfer_to_location_id) REFERENCES locations (id),
  CONSTRAINT transaction_headers_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id),
  CONSTRAINT transaction_headers_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES users (id),
  CONSTRAINT transaction_headers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT transaction_headers_cash_in_type_check CHECK (((cash_in_type IS NULL) OR (cash_in_type IN ('BUSINESS_RECEIPT', 'OTHER_RECEIPT')))),
  CONSTRAINT transaction_headers_cash_out_type_check CHECK (((cash_out_type IS NULL) OR (cash_out_type IN ('DEBT_PAYMENT', 'OPERATIONAL_EXPENSE')))),
  CONSTRAINT transaction_headers_document_discount_type_check CHECK (document_discount_type IN ('PERCENT', 'AMOUNT')),
  CONSTRAINT transaction_headers_document_discount_value_check CHECK ((document_discount_value >= (0))),
  CONSTRAINT transaction_headers_exchange_rate_check CHECK ((exchange_rate > (0))),
  CONSTRAINT transaction_headers_payment_type_check CHECK (((payment_type IS NULL) OR (payment_type IN ('CASH', 'CREDIT'))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS tax_codes (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  tax_type VARCHAR(255) NOT NULL,
  rate DECIMAL(9,6) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL DEFAULT (CURRENT_DATE),
  effective_to DATE,
  default_inclusive TINYINT(1) NOT NULL DEFAULT 0,
  input_tax_account_id CHAR(36),
  output_tax_account_id CHAR(36),
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY tax_codes_workspace_id_code_effective_from_key (workspace_id, code, effective_from),
  CONSTRAINT tax_codes_input_tax_account_id_fkey FOREIGN KEY (input_tax_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT tax_codes_output_tax_account_id_fkey FOREIGN KEY (output_tax_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT tax_codes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT tax_codes_rate_check CHECK ((rate >= (0))),
  CONSTRAINT tax_codes_status_check CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT tax_codes_tax_type_check CHECK (tax_type IN ('VAT', 'WITHHOLDING', 'NONE', 'OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS transaction_lines (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  transaction_id CHAR(36) NOT NULL,
  line_no INT NOT NULL,
  line_type VARCHAR(255) NOT NULL,
  item_id CHAR(36),
  account_id CHAR(36),
  description TEXT,
  quantity DECIMAL(20,6) NOT NULL DEFAULT 1,
  unit_id CHAR(36),
  unit_price DECIMAL(20,4) NOT NULL DEFAULT 0,
  gross_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  discount_type VARCHAR(255),
  discount_percent DECIMAL(9,6) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  document_discount_alloc DECIMAL(20,4) NOT NULL DEFAULT 0,
  tax_code_id CHAR(36),
  tax_rate DECIMAL(9,6) NOT NULL DEFAULT 0,
  tax_included TINYINT(1) NOT NULL DEFAULT 0,
  dpp_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  line_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  location_id CHAR(36),
  cost_center_id CHAR(36),
  department_code VARCHAR(255),
  project_code VARCHAR(255),
  metadata JSON NOT NULL DEFAULT ('{}'),
  PRIMARY KEY (id),
  UNIQUE KEY transaction_lines_transaction_id_line_no_key (transaction_id, line_no),
  KEY idx_transaction_lines_tx (transaction_id),
  CONSTRAINT transaction_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT transaction_lines_cost_center_id_fkey FOREIGN KEY (cost_center_id) REFERENCES cost_centers (id),
  CONSTRAINT transaction_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT transaction_lines_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id),
  CONSTRAINT transaction_lines_tax_code_id_fkey FOREIGN KEY (tax_code_id) REFERENCES tax_codes (id),
  CONSTRAINT transaction_lines_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transaction_headers (id) ON DELETE CASCADE,
  CONSTRAINT transaction_lines_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES units (id),
  CONSTRAINT transaction_lines_check CHECK ((((line_type = 'ITEM') AND (item_id IS NOT NULL)) OR ((line_type = 'ACCOUNT') AND (account_id IS NOT NULL)) OR (line_type IN ('SERVICE', 'MEMO')))),
  CONSTRAINT transaction_lines_discount_amount_check CHECK ((discount_amount >= (0))),
  CONSTRAINT transaction_lines_discount_percent_check CHECK ((discount_percent >= (0))),
  CONSTRAINT transaction_lines_discount_type_check CHECK (discount_type IN ('PERCENT', 'AMOUNT')),
  CONSTRAINT transaction_lines_document_discount_alloc_check CHECK ((document_discount_alloc >= (0))),
  CONSTRAINT transaction_lines_line_no_check CHECK ((line_no > 0)),
  CONSTRAINT transaction_lines_line_type_check CHECK (line_type IN ('ITEM', 'ACCOUNT', 'SERVICE', 'MEMO')),
  CONSTRAINT transaction_lines_tax_rate_check CHECK ((tax_rate >= (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  location_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  source_transaction_id CHAR(36) NOT NULL,
  source_transaction_line_id CHAR(36) NOT NULL,
  movement_type VARCHAR(191) NOT NULL,
  quantity DECIMAL(20,6) NOT NULL,
  unit_cost DECIMAL(20,6) NOT NULL DEFAULT 0,
  movement_value DECIMAL(20,4) NOT NULL DEFAULT 0,
  quantity_after DECIMAL(20,6) NOT NULL,
  average_cost_after DECIMAL(20,6) NOT NULL DEFAULT 0,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY inventory_movements_source_transaction_line_id_movement_typ_key (source_transaction_line_id, movement_type),
  KEY idx_inventory_movements_item_date (company_id, item_id, created_at),
  KEY idx_inventory_movements_stock_card (company_id, location_id, item_id, created_at, id),
  CONSTRAINT inventory_movements_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT inventory_movements_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES transaction_headers (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_source_transaction_line_id_fkey FOREIGN KEY (source_transaction_line_id) REFERENCES transaction_lines (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT inventory_movements_average_cost_after_check CHECK ((average_cost_after >= (0))),
  CONSTRAINT inventory_movements_movement_type_check CHECK (movement_type IN ('PURCHASE_IN', 'USAGE_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'SALE_OUT', 'PRODUCTION_IN', 'PRODUCTION_OUT')),
  CONSTRAINT inventory_movements_movement_value_check CHECK ((movement_value >= (0))),
  CONSTRAINT inventory_movements_quantity_check CHECK ((quantity > (0))),
  CONSTRAINT inventory_movements_unit_cost_check CHECK ((unit_cost >= (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS item_account_overrides (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  inventory_account_id CHAR(36),
  cogs_account_id CHAR(36),
  sales_account_id CHAR(36),
  usage_account_id CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  stock_adjustment_account_id CHAR(36),
  PRIMARY KEY (id),
  UNIQUE KEY item_account_overrides_company_id_item_id_key (company_id, item_id),
  CONSTRAINT item_account_overrides_cogs_account_id_fkey FOREIGN KEY (cogs_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_account_overrides_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT item_account_overrides_inventory_account_id_fkey FOREIGN KEY (inventory_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_account_overrides_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT item_account_overrides_sales_account_id_fkey FOREIGN KEY (sales_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_account_overrides_stock_adjustment_account_id_fkey FOREIGN KEY (stock_adjustment_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_account_overrides_usage_account_id_fkey FOREIGN KEY (usage_account_id) REFERENCES chart_of_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS item_category_account_mappings (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  category_id CHAR(36) NOT NULL,
  inventory_account_id CHAR(36),
  cogs_account_id CHAR(36),
  sales_account_id CHAR(36),
  usage_account_id CHAR(36),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  stock_adjustment_account_id CHAR(36),
  PRIMARY KEY (id),
  UNIQUE KEY item_category_account_mappings_company_id_category_id_key (company_id, category_id),
  KEY idx_item_category_mapping_company (company_id),
  CONSTRAINT item_category_account_mappings_category_id_fkey FOREIGN KEY (category_id) REFERENCES item_categories (id) ON DELETE CASCADE,
  CONSTRAINT item_category_account_mappings_cogs_account_id_fkey FOREIGN KEY (cogs_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_category_account_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT item_category_account_mappings_inventory_account_id_fkey FOREIGN KEY (inventory_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_category_account_mappings_sales_account_id_fkey FOREIGN KEY (sales_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_category_account_mappings_stock_adjustment_account_id_fkey FOREIGN KEY (stock_adjustment_account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT item_category_account_mappings_usage_account_id_fkey FOREIGN KEY (usage_account_id) REFERENCES chart_of_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS journal_headers (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  journal_number VARCHAR(191) NOT NULL,
  journal_date DATE NOT NULL,
  journal_type VARCHAR(255) NOT NULL,
  source_transaction_id CHAR(36),
  status VARCHAR(255) NOT NULL DEFAULT 'DRAFT',
  description TEXT,
  posted_by CHAR(36),
  posted_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reviewed_by CHAR(36),
  reviewed_at DATETIME(6),
  engine_version VARCHAR(255),
  PRIMARY KEY (id),
  UNIQUE KEY journal_headers_company_id_journal_number_key (company_id, journal_number),
  KEY idx_journal_headers_company_date (company_id, journal_date),
  CONSTRAINT journal_headers_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT journal_headers_posted_by_fkey FOREIGN KEY (posted_by) REFERENCES users (id),
  CONSTRAINT journal_headers_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users (id),
  CONSTRAINT journal_headers_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES transaction_headers (id),
  CONSTRAINT journal_headers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT journal_headers_status_check CHECK (status IN ('DRAFT', 'READY', 'POSTED', 'REVERSED', 'VOID'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS journal_lines (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  journal_id CHAR(36) NOT NULL,
  line_no INT NOT NULL,
  account_id CHAR(36) NOT NULL,
  debit DECIMAL(20,4) NOT NULL DEFAULT 0,
  credit DECIMAL(20,4) NOT NULL DEFAULT 0,
  description TEXT,
  location_id CHAR(36),
  cost_center_id CHAR(36),
  partner_id CHAR(36),
  channel_id CHAR(36),
  item_id CHAR(36),
  metadata JSON NOT NULL DEFAULT ('{}'),
  source_transaction_line_id CHAR(36),
  PRIMARY KEY (id),
  UNIQUE KEY journal_lines_journal_id_line_no_key (journal_id, line_no),
  KEY idx_journal_lines_journal (journal_id),
  KEY idx_journal_source_line (source_transaction_line_id),
  CONSTRAINT journal_lines_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT journal_lines_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels (id),
  CONSTRAINT journal_lines_cost_center_id_fkey FOREIGN KEY (cost_center_id) REFERENCES cost_centers (id),
  CONSTRAINT journal_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT journal_lines_journal_id_fkey FOREIGN KEY (journal_id) REFERENCES journal_headers (id) ON DELETE CASCADE,
  CONSTRAINT journal_lines_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id),
  CONSTRAINT journal_lines_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES business_partners (id),
  CONSTRAINT journal_lines_source_transaction_line_id_fkey FOREIGN KEY (source_transaction_line_id) REFERENCES transaction_lines (id),
  CONSTRAINT journal_lines_check CHECK ((((debit > (0)) AND (credit = (0))) OR ((credit > (0)) AND (debit = (0))))),
  CONSTRAINT journal_lines_credit_check CHECK ((credit >= (0))),
  CONSTRAINT journal_lines_debit_check CHECK ((debit >= (0))),
  CONSTRAINT journal_lines_line_no_check CHECK ((line_no > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS payment_methods (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  method_type VARCHAR(255) NOT NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY payment_methods_workspace_id_code_key (workspace_id, code),
  CONSTRAINT payment_methods_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT payment_methods_method_type_check CHECK (method_type IN ('CASH', 'BANK_TRANSFER', 'QRIS', 'CARD', 'OJOL', 'EWALLET', 'CREDIT', 'OTHER')),
  CONSTRAINT payment_methods_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS production_details (
  transaction_id CHAR(36) NOT NULL,
  bom_id CHAR(36) NOT NULL,
  batch_count DECIMAL(20,6) NOT NULL DEFAULT 1,
  standard_output DECIMAL(20,6) NOT NULL DEFAULT 0,
  actual_output DECIMAL(20,6) NOT NULL DEFAULT 0,
  yield_percent DECIMAL(12,6) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (transaction_id),
  CONSTRAINT production_details_bom_id_fkey FOREIGN KEY (bom_id) REFERENCES bom_headers (id),
  CONSTRAINT production_details_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transaction_headers (id) ON DELETE CASCADE,
  CONSTRAINT production_details_actual_output_check CHECK ((actual_output >= (0))),
  CONSTRAINT production_details_batch_count_check CHECK ((batch_count > (0))),
  CONSTRAINT production_details_standard_output_check CHECK ((standard_output >= (0))),
  CONSTRAINT production_details_yield_percent_check CHECK ((yield_percent >= (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS roles (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  code VARCHAR(191) NOT NULL,
  name VARCHAR(255) NOT NULL,
  side VARCHAR(255) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY roles_code_key (code),
  CONSTRAINT roles_side_check CHECK (side IN ('CLIENT', 'AKUNTAKITA', 'SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_import_item_aliases (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  profile_id CHAR(36) NOT NULL,
  company_id CHAR(36) NOT NULL,
  external_code VARCHAR(191),
  external_name VARCHAR(191) NOT NULL DEFAULT '',
  item_id CHAR(36) NOT NULL,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_sales_import_item_aliases_profile (profile_id, item_id),
  CONSTRAINT sales_import_item_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_item_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT sales_import_item_aliases_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT sales_import_item_aliases_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES sales_import_profiles (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_item_aliases_check CHECK ((COALESCE(NULLIF(TRIM(external_code), ''), NULLIF(TRIM(external_name), '')) IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_import_payment_aliases (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  profile_id CHAR(36) NOT NULL,
  external_value VARCHAR(191) NOT NULL,
  payment_code VARCHAR(191) NOT NULL,
  created_by CHAR(36),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY sales_import_payment_aliases_profile_id_external_value_key (profile_id, external_value),
  KEY idx_sales_import_payment_aliases_profile (profile_id, payment_code),
  CONSTRAINT sales_import_payment_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT sales_import_payment_aliases_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES sales_import_profiles (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_payment_aliases_payment_code_check CHECK (payment_code IN ('CASH', 'QRIS', 'TRANSFER', 'COMPLIMENT', 'GOFOOD', 'GRABFOOD', 'SHOPEEFOOD', 'OTHER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_import_rows (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  batch_id CHAR(36) NOT NULL,
  row_no INT NOT NULL,
  sale_date DATE NOT NULL,
  invoice_number VARCHAR(191) NOT NULL,
  cashier VARCHAR(500),
  sale_type VARCHAR(255),
  item_code VARCHAR(255),
  item_name VARCHAR(255) NOT NULL,
  item_id CHAR(36),
  quantity DECIMAL(20,6) NOT NULL,
  unit_price DECIMAL(20,4) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
  line_total DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_cash DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_qris DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_transfer DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_compliment DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_gofood DECIMAL(20,4) NOT NULL DEFAULT 0,
  payment_grabfood DECIMAL(20,4) NOT NULL DEFAULT 0,
  metadata JSON NOT NULL DEFAULT ('{}'),
  PRIMARY KEY (id),
  UNIQUE KEY sales_import_rows_batch_id_row_no_key (batch_id, row_no),
  KEY idx_sales_import_rows_invoice (batch_id, sale_date, invoice_number),
  CONSTRAINT sales_import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES sales_import_batches (id) ON DELETE CASCADE,
  CONSTRAINT sales_import_rows_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id),
  CONSTRAINT sales_import_rows_discount_amount_check CHECK ((discount_amount >= (0))),
  CONSTRAINT sales_import_rows_line_total_check CHECK ((line_total >= (0))),
  CONSTRAINT sales_import_rows_payment_cash_check CHECK ((payment_cash >= (0))),
  CONSTRAINT sales_import_rows_payment_compliment_check CHECK ((payment_compliment >= (0))),
  CONSTRAINT sales_import_rows_payment_gofood_check CHECK ((payment_gofood >= (0))),
  CONSTRAINT sales_import_rows_payment_grabfood_check CHECK ((payment_grabfood >= (0))),
  CONSTRAINT sales_import_rows_payment_qris_check CHECK ((payment_qris >= (0))),
  CONSTRAINT sales_import_rows_payment_transfer_check CHECK ((payment_transfer >= (0))),
  CONSTRAINT sales_import_rows_quantity_check CHECK ((quantity > (0))),
  CONSTRAINT sales_import_rows_row_no_check CHECK ((row_no > 0)),
  CONSTRAINT sales_import_rows_unit_price_check CHECK ((unit_price >= (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS sales_payment_mappings (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  payment_code VARCHAR(191) NOT NULL,
  label VARCHAR(255) NOT NULL,
  account_id CHAR(36) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY sales_payment_mappings_company_id_payment_code_key (company_id, payment_code),
  CONSTRAINT sales_payment_mappings_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT sales_payment_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT sales_payment_mappings_payment_code_check CHECK (payment_code IN ('CASH', 'QRIS', 'TRANSFER', 'COMPLIMENT', 'GOFOOD', 'GRABFOOD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(191) NOT NULL,
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS tax_account_defaults (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  company_id CHAR(36) NOT NULL,
  tax_role_code VARCHAR(191) NOT NULL,
  label VARCHAR(255) NOT NULL,
  account_id CHAR(36) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY tax_account_defaults_company_id_tax_role_code_key (company_id, tax_role_code),
  KEY idx_tax_account_defaults_company (company_id),
  CONSTRAINT tax_account_defaults_account_id_fkey FOREIGN KEY (account_id) REFERENCES chart_of_accounts (id),
  CONSTRAINT tax_account_defaults_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS transaction_allocations (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  source_transaction_id CHAR(36) NOT NULL,
  target_transaction_id CHAR(36),
  allocation_type VARCHAR(191) NOT NULL,
  amount DECIMAL(20,4) NOT NULL,
  notes TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT transaction_allocations_source_transaction_id_fkey FOREIGN KEY (source_transaction_id) REFERENCES transaction_headers (id) ON DELETE CASCADE,
  CONSTRAINT transaction_allocations_target_transaction_id_fkey FOREIGN KEY (target_transaction_id) REFERENCES transaction_headers (id) ON DELETE CASCADE,
  CONSTRAINT transaction_allocations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT transaction_allocations_amount_check CHECK ((amount > (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS unit_conversions (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  item_id CHAR(36),
  from_unit_id CHAR(36) NOT NULL,
  to_unit_id CHAR(36) NOT NULL,
  multiplier DECIMAL(20,8) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT unit_conversions_from_unit_id_fkey FOREIGN KEY (from_unit_id) REFERENCES units (id),
  CONSTRAINT unit_conversions_item_id_fkey FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
  CONSTRAINT unit_conversions_to_unit_id_fkey FOREIGN KEY (to_unit_id) REFERENCES units (id),
  CONSTRAINT unit_conversions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT unit_conversions_multiplier_check CHECK ((multiplier > (0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id CHAR(36) NOT NULL DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role_id CHAR(36) NOT NULL,
  company_id CHAR(36),
  location_id CHAR(36),
  status VARCHAR(191) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_memberships_user_status (user_id, status),
  KEY idx_memberships_workspace_user (workspace_id, user_id),
  CONSTRAINT workspace_memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations (id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT workspace_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT workspace_memberships_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- FK ke tabel sendiri / siklus (ditambahkan setelah semua tabel ada)
ALTER TABLE chart_of_accounts ADD CONSTRAINT chart_of_accounts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES chart_of_accounts (id);
ALTER TABLE item_categories ADD CONSTRAINT item_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES item_categories (id);
ALTER TABLE cost_centers ADD CONSTRAINT cost_centers_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES cost_centers (id);
ALTER TABLE locations ADD CONSTRAINT locations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES locations (id);

-- Index PostgreSQL yang memakai ekspresi / partial WHERE (perlu penanganan manual, lihat bagian MANUAL di bawah):
--   INDEX idx_cash_in_accounting_queue ON transaction_headers (company_id, accounting_status, transaction_date) WHERE (transaction_type = 'CASH_IN'::text)
--   INDEX idx_cash_in_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'CASH_IN'::text)
--   INDEX idx_cash_out_accounting_queue ON transaction_headers (company_id, accounting_status, transaction_date) WHERE ((transaction_type = 'CASH_OUT'::text) AND (cash_out_type = 'OPERATIONAL_EXPENSE'::text))
--   INDEX idx_cash_out_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'CASH_OUT'::text)
--   INDEX idx_inventory_usage_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'STOCK_USAGE'::text)
--   INDEX idx_memberships_company ON workspace_memberships (company_id) WHERE (company_id IS NOT NULL)
--   INDEX idx_memberships_location ON workspace_memberships (location_id) WHERE (location_id IS NOT NULL)
--   INDEX idx_production_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'PRODUCTION'::text)
--   INDEX idx_purchase_invoice_due_date ON transaction_headers (company_id, due_date) WHERE ((transaction_type = 'PURCHASE_INVOICE'::text) AND (payment_status <> 'PAID'::text))
--   INDEX idx_purchase_invoice_supplier_reference ON transaction_headers (company_id, partner_id, reference_number) WHERE (transaction_type = 'PURCHASE_INVOICE'::text)
--   INDEX idx_sales_transaction_batch ON transaction_headers (sales_import_batch_id) WHERE (sales_import_batch_id IS NOT NULL)
--   INDEX idx_stock_opname_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'STOCK_OPNAME'::text)
--   INDEX idx_stock_transfer_company_date ON transaction_headers (company_id, transaction_date) WHERE (transaction_type = 'STOCK_TRANSFER'::text)
--   INDEX idx_stock_transfer_destination ON transaction_headers (transfer_to_location_id, transaction_date) WHERE (transaction_type = 'STOCK_TRANSFER'::text)
--   UNIQUE INDEX uq_active_journal_source_transaction ON journal_headers (source_transaction_id) WHERE ((source_transaction_id IS NOT NULL) AND (status <> 'VOID'::text))
--   UNIQUE INDEX uq_sales_import_item_alias_code ON sales_import_item_aliases (profile_id, upper(btrim(external_code))) WHERE ((external_code IS NOT NULL) AND (btrim(external_code) <> ''::text))
--   UNIQUE INDEX uq_sales_import_item_alias_name ON sales_import_item_aliases (profile_id, lower(btrim(external_name))) WHERE (btrim(external_name) <> ''::text)
--   UNIQUE INDEX uq_transaction_allocation_source_target_type ON transaction_allocations (source_transaction_id, target_transaction_id, allocation_type) WHERE (target_transaction_id IS NOT NULL)
--   UNIQUE INDEX uq_unit_conversion_scope ON unit_conversions (workspace_id, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_unit_id, to_unit_id)
--   UNIQUE INDEX uq_workspace_membership_scope ON workspace_memberships (workspace_id, user_id, role_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid))

-- =============================================================
-- BAGIAN MANUAL — padanan MariaDB untuk index ekspresi / partial index PostgreSQL
-- =============================================================
-- PostgreSQL mengizinkan UNIQUE INDEX atas ekspresi (COALESCE, UPPER(BTRIM())) dan
-- partial index (WHERE ...). MariaDB tidak, sehingga dipakai kolom GENERATED STORED
-- yang menormalkan nilai, lalu UNIQUE KEY biasa di atasnya. NULL pada kolom generated
-- tidak dianggap duplikat, sehingga perilaku "partial" tetap terjaga.

-- uq_workspace_membership_scope (workspace_id,user_id,role_id,COALESCE(company_id,'0..0'),COALESCE(location_id,'0..0'))
ALTER TABLE workspace_memberships
  ADD COLUMN company_scope_key CHAR(36) AS (COALESCE(RTRIM(company_id), '00000000-0000-0000-0000-000000000000')) STORED,
  ADD COLUMN location_scope_key CHAR(36) AS (COALESCE(RTRIM(location_id), '00000000-0000-0000-0000-000000000000')) STORED,
  ADD UNIQUE KEY uq_workspace_membership_scope (workspace_id, user_id, role_id, company_scope_key, location_scope_key);

-- uq_unit_conversion_scope (workspace_id,COALESCE(item_id,'0..0'),from_unit_id,to_unit_id)
ALTER TABLE unit_conversions
  ADD COLUMN item_scope_key CHAR(36) AS (COALESCE(RTRIM(item_id), '00000000-0000-0000-0000-000000000000')) STORED,
  ADD UNIQUE KEY uq_unit_conversion_scope (workspace_id, item_scope_key, from_unit_id, to_unit_id);

-- uq_active_journal_source_transaction (source_transaction_id) WHERE source_transaction_id IS NOT NULL AND status<>'VOID'
ALTER TABLE journal_headers
  ADD COLUMN active_source_key CHAR(36) AS (CASE WHEN source_transaction_id IS NOT NULL AND status <> 'VOID' THEN RTRIM(source_transaction_id) END) STORED,
  ADD UNIQUE KEY uq_active_journal_source_transaction (active_source_key);

-- uq_sales_import_item_alias_code (profile_id, UPPER(BTRIM(external_code))) WHERE external_code IS NOT NULL AND BTRIM(external_code)<>''
-- uq_sales_import_item_alias_name (profile_id, LOWER(BTRIM(external_name))) WHERE BTRIM(external_name)<>''
ALTER TABLE sales_import_item_aliases
  ADD COLUMN external_code_key VARCHAR(191) AS (CASE WHEN external_code IS NOT NULL AND TRIM(external_code) <> '' THEN UPPER(TRIM(external_code)) END) STORED,
  ADD COLUMN external_name_key VARCHAR(191) AS (CASE WHEN TRIM(external_name) <> '' THEN LOWER(TRIM(external_name)) END) STORED,
  ADD UNIQUE KEY uq_sales_import_item_alias_code (profile_id, external_code_key),
  ADD UNIQUE KEY uq_sales_import_item_alias_name (profile_id, external_name_key);

-- uq_transaction_allocation_source_target_type (...) WHERE target_transaction_id IS NOT NULL
-- NULL pada target_transaction_id otomatis tidak dianggap duplikat -> UNIQUE biasa sudah setara.
ALTER TABLE transaction_allocations
  ADD UNIQUE KEY uq_transaction_allocation_source_target_type (source_transaction_id, target_transaction_id, allocation_type);

-- Partial index per transaction_type -> index komposit biasa (transaction_type ikut sebagai kolom)
ALTER TABLE transaction_headers
  ADD KEY idx_th_company_type_accounting_status_date (company_id, transaction_type, accounting_status, transaction_date),
  ADD KEY idx_th_company_type_payment_status_due (company_id, transaction_type, payment_status, due_date),
  ADD KEY idx_th_company_type_partner_reference (company_id, transaction_type, partner_id, reference_number),
  ADD KEY idx_th_transfer_destination_date (transfer_to_location_id, transaction_date),
  ADD KEY idx_th_company_cash_out_type (company_id, cash_out_type);

-- idx_memberships_company / idx_memberships_location / idx_sales_transaction_batch:
-- sudah tercakup oleh index implisit FOREIGN KEY InnoDB.

-- =============================================================
-- VIEW ringkasan untuk phpMyAdmin
-- =============================================================
CREATE OR REPLACE VIEW v_ringkasan_data AS
SELECT 'workspaces' AS tabel, COUNT(*) AS jumlah FROM workspaces
UNION ALL SELECT 'companies', COUNT(*) FROM companies
UNION ALL SELECT 'locations', COUNT(*) FROM locations
UNION ALL SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'workspace_memberships', COUNT(*) FROM workspace_memberships
UNION ALL SELECT 'items', COUNT(*) FROM items
UNION ALL SELECT 'business_partners', COUNT(*) FROM business_partners
UNION ALL SELECT 'chart_of_accounts', COUNT(*) FROM chart_of_accounts
UNION ALL SELECT 'transaction_headers', COUNT(*) FROM transaction_headers
UNION ALL SELECT 'transaction_lines', COUNT(*) FROM transaction_lines
UNION ALL SELECT 'journal_headers', COUNT(*) FROM journal_headers
UNION ALL SELECT 'journal_lines', COUNT(*) FROM journal_lines
UNION ALL SELECT 'inventory_movements', COUNT(*) FROM inventory_movements
UNION ALL SELECT 'inventory_balances', COUNT(*) FROM inventory_balances
UNION ALL SELECT 'sales_import_batches', COUNT(*) FROM sales_import_batches
UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs;
