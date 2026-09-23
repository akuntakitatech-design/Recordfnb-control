ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_system_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_memberships_user_status
  ON workspace_memberships(user_id, status);

CREATE INDEX IF NOT EXISTS idx_memberships_workspace_user
  ON workspace_memberships(workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_memberships_company
  ON workspace_memberships(company_id)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_location
  ON workspace_memberships(location_id)
  WHERE location_id IS NOT NULL;
