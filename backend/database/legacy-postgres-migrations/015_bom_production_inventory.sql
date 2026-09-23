-- BOM + Production + Inventory Control v0.15
-- Company-specific recipes, production snapshots and stock-card foundation.

CREATE TABLE IF NOT EXISTS bom_headers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bom_type TEXT NOT NULL CHECK (bom_type IN ('MENU','PRODUCTION')),
  output_item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  output_quantity NUMERIC(20,6) NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
  output_unit_id UUID NOT NULL REFERENCES units(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,bom_type,output_item_id)
);

CREATE TABLE IF NOT EXISTS bom_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id UUID NOT NULL REFERENCES bom_headers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  component_item_id UUID NOT NULL REFERENCES items(id),
  quantity NUMERIC(20,6) NOT NULL CHECK (quantity > 0),
  unit_id UUID NOT NULL REFERENCES units(id),
  waste_percent NUMERIC(9,4) NOT NULL DEFAULT 0 CHECK (waste_percent >= 0 AND waste_percent <= 100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(bom_id,line_no),
  UNIQUE(bom_id,component_item_id)
);

CREATE TABLE IF NOT EXISTS production_details (
  transaction_id UUID PRIMARY KEY REFERENCES transaction_headers(id) ON DELETE CASCADE,
  bom_id UUID NOT NULL REFERENCES bom_headers(id),
  batch_count NUMERIC(20,6) NOT NULL DEFAULT 1 CHECK (batch_count > 0),
  standard_output NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (standard_output >= 0),
  actual_output NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (actual_output >= 0),
  yield_percent NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK (yield_percent >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;

ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN (
    'PURCHASE_IN','USAGE_OUT','TRANSFER_IN','TRANSFER_OUT',
    'ADJUSTMENT_IN','ADJUSTMENT_OUT','SALE_OUT',
    'PRODUCTION_IN','PRODUCTION_OUT'
  ));

CREATE INDEX IF NOT EXISTS idx_bom_headers_company_type
ON bom_headers(company_id,bom_type,status,output_item_id);

CREATE INDEX IF NOT EXISTS idx_bom_lines_bom
ON bom_lines(bom_id,line_no);

CREATE INDEX IF NOT EXISTS idx_production_company_date
ON transaction_headers(company_id,transaction_date)
WHERE transaction_type='PRODUCTION';

CREATE INDEX IF NOT EXISTS idx_inventory_movements_stock_card
ON inventory_movements(company_id,location_id,item_id,created_at,id);
