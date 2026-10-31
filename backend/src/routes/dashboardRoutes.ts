import { Router } from 'express';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { allowedUnitIds } from '../permissions.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

dashboardRouter.get('/dashboard', async (req, res) => {
  const entity = await one<{ id: string; code: string; name: string }>(
    'SELECT id,code,name FROM legal_entities ORDER BY created_at LIMIT 1',
  );
  if (!entity) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const allowed = await allowedUnitIds(req.user!);
  const scopeClause = allowed === null
    ? ''
    : allowed.length
      ? ' AND u.id IN (?)'
      : ' AND 1=0';
  const scopeParams: any[] = allowed === null || allowed.length === 0 ? [] : [allowed];

  const unitsByStatus = await query<{ status: string; total: number }>(
    `SELECT u.operational_status status, COUNT(*) total
       FROM organization_units u WHERE u.legal_entity_id=?${scopeClause}
      GROUP BY u.operational_status`,
    [entity.id, ...scopeParams],
  );
  const financeByStatus = await query<{ status: string; total: number }>(
    `SELECT u.finance_status status, COUNT(*) total
       FROM organization_units u WHERE u.legal_entity_id=?${scopeClause}
      GROUP BY u.finance_status`,
    [entity.id, ...scopeParams],
  );

  const [banks, users] = await Promise.all([
    one<{ total: number }>("SELECT COUNT(*) total FROM bank_accounts WHERE status='ACTIVE'"),
    one<{ total: number }>("SELECT COUNT(*) total FROM users WHERE status='ACTIVE'"),
  ]);

  const needConfig = await query(
    `SELECT u.id,u.unit_code,u.unit_name,u.operational_status,u.finance_status
       FROM organization_units u
      WHERE u.legal_entity_id=? AND u.finance_status<>'READY'${scopeClause}
      ORDER BY u.unit_name LIMIT 5`,
    [entity.id, ...scopeParams],
  );

  const recentAudit = await query(
    `SELECT a.id,a.action,a.entity_type,a.entity_id,a.created_at,u.full_name user_name
       FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      ORDER BY a.created_at DESC LIMIT 8`,
  );

  const unitsTotal = unitsByStatus.reduce((total, row) => total + Number(row.total), 0);
  const ready = financeByStatus.find(row => row.status === 'READY');

  res.json({
    legalEntity: entity,
    unitsTotal,
    unitsByStatus,
    financeByStatus,
    readyUnits: Number(ready?.total || 0),
    counts: { banks: Number(banks?.total || 0), users: Number(users?.total || 0) },
    needConfig,
    recentAudit,
  });
});
