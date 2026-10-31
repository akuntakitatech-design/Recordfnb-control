import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { exec, one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { requirePermission } from '../permissions.js';
import { parseAuditRow, writeAudit } from '../audit.js';
import { nullableText, text, upper } from '../http.js';

export const bankRouter = Router();
bankRouter.use(requireAuth);

function normalizeAccountNumber(value: unknown): string {
  return text(value).replace(/[\s-]/g, '');
}

async function activeEntityId(): Promise<string | null> {
  const entity = await one<{ id: string }>("SELECT id FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  return entity?.id || null;
}

async function refreshUnitsOfAccount(accountId: string) {
  const units = await query<{ unit_id: string }>(
    "SELECT DISTINCT unit_id FROM unit_bank_account_assignments WHERE bank_account_id=? AND status='ACTIVE'",
    [accountId],
  );
  for (const row of units) {
    await exec(
      `UPDATE organization_units u
          SET finance_status = CASE
            WHEN (SELECT COUNT(*) FROM unit_bank_account_assignments a
                    JOIN bank_accounts b ON b.id=a.bank_account_id
                   WHERE a.unit_id=u.id AND a.status='ACTIVE' AND b.status='ACTIVE' AND b.verified_at IS NOT NULL
                     AND a.usage_type='CENTRAL_SHARED') > 0
             AND (SELECT COUNT(*) FROM unit_bank_account_assignments a
                    JOIN bank_accounts b ON b.id=a.bank_account_id
                   WHERE a.unit_id=u.id AND a.status='ACTIVE' AND b.status='ACTIVE' AND b.verified_at IS NOT NULL
                     AND a.usage_type='UNIT_DEDICATED') > 0
            THEN 'READY' ELSE 'NOT_CONFIGURED' END
        WHERE u.id=?`,
      [row.unit_id],
    );
  }
  return units.length;
}

bankRouter.get('/bank-accounts', async (req, res) => {
  const usage = upper(req.query.usage);
  const status = upper(req.query.status);
  const conditions: string[] = [];
  const params: any[] = [];
  if (usage) { conditions.push('b.account_usage=?'); params.push(usage); }
  if (status) { conditions.push('b.status=?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  res.json(await query(
    `SELECT b.id,b.bank_name,b.account_number,b.account_holder,b.account_usage,b.currency,b.gl_account_code,
            b.status,b.verified_at,b.created_at,
            (SELECT COUNT(*) FROM unit_bank_account_assignments a WHERE a.bank_account_id=b.id AND a.status='ACTIVE') unit_count
       FROM bank_accounts b ${where} ORDER BY b.bank_name,b.account_number`,
    params,
  ));
});

bankRouter.post('/bank-accounts', requirePermission('bank.manage'), async (req, res) => {
  const entityId = await activeEntityId();
  if (!entityId) return res.status(404).json({ error: 'LEGAL_ENTITY_NOT_FOUND' });

  const bankName = text(req.body?.bankName);
  const accountNumber = normalizeAccountNumber(req.body?.accountNumber);
  const accountHolder = text(req.body?.accountHolder);
  const usage = upper(req.body?.accountUsage) || 'CENTRAL';
  if (!bankName || !accountNumber || !accountHolder) return res.status(400).json({ error: 'BANK_FIELDS_REQUIRED' });
  if (!/^\d{6,30}$/.test(accountNumber)) return res.status(400).json({ error: 'ACCOUNT_NUMBER_INVALID' });
  if (!['CENTRAL', 'DEDICATED'].includes(usage)) return res.status(400).json({ error: 'ACCOUNT_USAGE_INVALID' });
  if (await one('SELECT id FROM bank_accounts WHERE legal_entity_id=? AND bank_name=? AND account_number=?', [entityId, bankName, accountNumber])) {
    return res.status(409).json({ error: 'BANK_ACCOUNT_DUPLICATE' });
  }

  const id = randomUUID();
  await exec(
    `INSERT INTO bank_accounts(id,legal_entity_id,bank_name,account_number,account_holder,account_usage,currency,gl_account_code)
     VALUES(?,?,?,?,?,?,?,?)`,
    [id, entityId, bankName, accountNumber, accountHolder, usage, upper(req.body?.currency) || 'IDR',
      nullableText(req.body?.glAccountCode)],
  );
  const after = await one('SELECT * FROM bank_accounts WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: entityId, userId: req.user!.id, ip: req.ip || null,
    action: 'BANK_ACCOUNT_CREATE', entityType: 'BANK_ACCOUNT', entityId: id, after,
  });
  res.status(201).json(after);
});

bankRouter.put('/bank-accounts/:id', requirePermission('bank.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM bank_accounts WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'BANK_ACCOUNT_NOT_FOUND' });

  const bankName = text(req.body?.bankName);
  const accountNumber = normalizeAccountNumber(req.body?.accountNumber);
  const accountHolder = text(req.body?.accountHolder);
  const usage = upper(req.body?.accountUsage) || before.account_usage;
  if (!bankName || !accountNumber || !accountHolder) return res.status(400).json({ error: 'BANK_FIELDS_REQUIRED' });
  if (!/^\d{6,30}$/.test(accountNumber)) return res.status(400).json({ error: 'ACCOUNT_NUMBER_INVALID' });
  if (!['CENTRAL', 'DEDICATED'].includes(usage)) return res.status(400).json({ error: 'ACCOUNT_USAGE_INVALID' });
  const duplicate = await one(
    'SELECT id FROM bank_accounts WHERE legal_entity_id=? AND bank_name=? AND account_number=? AND id<>?',
    [before.legal_entity_id, bankName, accountNumber, id],
  );
  if (duplicate) return res.status(409).json({ error: 'BANK_ACCOUNT_DUPLICATE' });

  await exec(
    'UPDATE bank_accounts SET bank_name=?, account_number=?, account_holder=?, account_usage=?, currency=?, gl_account_code=? WHERE id=?',
    [bankName, accountNumber, accountHolder, usage, upper(req.body?.currency) || before.currency,
      nullableText(req.body?.glAccountCode), id],
  );
  const after = await one('SELECT * FROM bank_accounts WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, userId: req.user!.id, ip: req.ip || null,
    action: 'BANK_ACCOUNT_UPDATE', entityType: 'BANK_ACCOUNT', entityId: id, before, after,
  });
  res.json(after);
});

bankRouter.post('/bank-accounts/:id/verify', requirePermission('bank.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM bank_accounts WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'BANK_ACCOUNT_NOT_FOUND' });

  await exec("UPDATE bank_accounts SET verified_at=NOW(6), status='ACTIVE' WHERE id=?", [id]);
  const after = await one('SELECT * FROM bank_accounts WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, userId: req.user!.id, ip: req.ip || null,
    action: 'BANK_ACCOUNT_VERIFY', entityType: 'BANK_ACCOUNT', entityId: id, before, after,
  });
  const affected = await refreshUnitsOfAccount(id);
  res.json({ ok: true, account: after, unitsRefreshed: affected });
});

bankRouter.post('/bank-accounts/:id/deactivate', requirePermission('bank.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM bank_accounts WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'BANK_ACCOUNT_NOT_FOUND' });
  const reason = text(req.body?.reason);
  if (reason.length < 5) return res.status(400).json({ error: 'DEACTIVATE_REASON_REQUIRED' });

  await exec("UPDATE bank_accounts SET status='INACTIVE' WHERE id=?", [id]);
  const after = await one('SELECT * FROM bank_accounts WHERE id=?', [id]);
  await writeAudit({
    legalEntityId: before.legal_entity_id, userId: req.user!.id, ip: req.ip || null,
    action: 'BANK_ACCOUNT_DEACTIVATE', entityType: 'BANK_ACCOUNT', entityId: id, before, after, reason,
  });
  await refreshUnitsOfAccount(id);
  res.json({ ok: true, account: after });
});

bankRouter.get('/bank-accounts/:id', async (req, res) => {
  const id = text(req.params.id);
  const account = await one('SELECT * FROM bank_accounts WHERE id=?', [id]);
  if (!account) return res.status(404).json({ error: 'BANK_ACCOUNT_NOT_FOUND' });
  const assignments = await query(
    `SELECT a.id,a.usage_type,a.status,a.effective_start,a.effective_end,
            u.unit_code,u.unit_name,u.operational_status
       FROM unit_bank_account_assignments a JOIN organization_units u ON u.id=a.unit_id
      WHERE a.bank_account_id=? ORDER BY a.created_at DESC`, [id],
  );
  res.json({ ...account, assignments });
});

bankRouter.get('/bank-accounts/:id/audit-logs', async (req, res) => {
  const id = text(req.params.id);
  const rows = await query(
    `SELECT id,action,entity_type,entity_id,before_data,after_data,reason,created_at,user_id
       FROM audit_logs WHERE entity_type='BANK_ACCOUNT' AND entity_id=? ORDER BY created_at DESC LIMIT 50`, [id],
  );
  res.json(rows.map(parseAuditRow));
});
