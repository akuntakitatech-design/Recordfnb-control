import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, pool, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { PERMISSION_CATALOG, refreshRoleCache, requireAnyPermission, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { text, upper } from '../http.js';

/**
 * Role & kewenangan.
 *
 * Daftar role dan kewenangannya disimpan di tabel `roles` + `role_permissions`,
 * sehingga admin bisa membuat jabatan baru dan mengatur centang kewenangannya.
 * Katalog permission mengikuti fitur aplikasi (lihat `PERMISSION_CATALOG`).
 */
export const roleRouter = Router();
roleRouter.use(requireAuth);

async function activeEntityId(): Promise<string | null> {
  const entity = await one<{ id: string }>("SELECT id FROM legal_entities WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  return entity?.id || null;
}

const PERMISSION_CODES = new Set(PERMISSION_CATALOG.map(item => item.code as string));

function normalizeCode(value: unknown): string {
  return upper(value).replace(/[^A-Z0-9_]/g, '_').slice(0, 32);
}

function permissionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(value => text(value)).filter(Boolean))];
}

async function grantsOf(roleId: string): Promise<string[]> {
  const rows = await query<{ permission: string }>(
    'SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission', [roleId],
  );
  return rows.map(row => row.permission);
}

/**
 * Pastikan masih ada minimal satu pengguna aktif yang memegang `role.manage`.
 * Mencegah admin mengunci dirinya sendiri keluar dari menu Akses.
 */
async function roleManageSurvivors(): Promise<number> {
  const rows = await query<{ total: number }>(
    `SELECT COUNT(DISTINCT u.id) total
       FROM users u
       JOIN roles r ON r.code=u.role AND r.status='ACTIVE'
       JOIN role_permissions rp ON rp.role_id=r.id AND rp.permission='role.manage'
      WHERE u.status='ACTIVE'`,
  );
  return Number(rows[0]?.total || 0);
}

roleRouter.get('/permissions', requirePermission('role.manage'), async (_req, res) => {
  const rows = await query<any>('SELECT code,group_name,label,description FROM permissions ORDER BY group_name,code');
  const byGroup = new Map<string, any[]>();
  for (const row of rows) {
    const list = byGroup.get(row.group_name) || [];
    list.push({ code: row.code, label: row.label, description: row.description });
    byGroup.set(row.group_name, list);
  }
  res.json({
    total: rows.length,
    groups: [...byGroup.entries()].map(([group, permissions]) => ({ group, permissions })),
  });
});

roleRouter.get('/roles', requireAnyPermission(['role.manage', 'user.manage']), async (_req, res) => {
  const rows = await query<any>(
    `SELECT r.id,r.code,r.name,r.description,r.is_system,r.is_global,r.status,r.sort_order,
            (SELECT COUNT(*) FROM users u WHERE u.role=r.code) user_count,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id=r.id) permission_count
       FROM roles r ORDER BY r.sort_order, r.name`,
  );
  res.json(rows.map(row => ({
    ...row,
    is_system: Boolean(row.is_system),
    is_global: Boolean(row.is_global),
    user_count: Number(row.user_count),
    permission_count: Number(row.permission_count),
  })));
});

roleRouter.get('/roles/:id', requirePermission('role.manage'), async (req, res) => {
  const row = await one<any>('SELECT * FROM roles WHERE id=?', [text(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'ROLE_NOT_FOUND' });
  res.json({
    ...row,
    is_system: Boolean(row.is_system),
    is_global: Boolean(row.is_global),
    permissions: await grantsOf(row.id),
  });
});

roleRouter.post('/roles', requirePermission('role.manage'), async (req, res) => {
  const code = normalizeCode(req.body?.code || req.body?.name);
  const name = text(req.body?.name);
  if (!name) return res.status(400).json({ error: 'ROLE_NAME_REQUIRED' });
  if (code.length < 2) return res.status(400).json({ error: 'ROLE_CODE_INVALID' });
  if (await one('SELECT id FROM roles WHERE code=?', [code])) return res.status(409).json({ error: 'ROLE_CODE_DUPLICATE' });

  const permissions = permissionList(req.body?.permissions);
  const unknown = permissions.filter(permission => !PERMISSION_CODES.has(permission));
  if (unknown.length > 0) return res.status(400).json({ error: 'ROLE_PERMISSION_INVALID', permissions: unknown });

  const id = randomUUID();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO roles(id,code,name,description,is_system,is_global,status,sort_order,seeded_at)
       VALUES(?,?,?,?,0,?,?,?,NOW(6))`,
      [id, code, name, text(req.body?.description) || null, req.body?.isGlobal === true ? 1 : 0,
        'ACTIVE', Number(req.body?.sortOrder) || 500],
    );
    for (const permission of permissions) {
      await conn.query('INSERT INTO role_permissions(role_id,permission) VALUES(?,?)', [id, permission]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await refreshRoleCache();
  await writeAudit({
    legalEntityId: await activeEntityId(), userId: req.user!.id, ip: req.ip || null,
    action: 'ROLE_CREATE', entityType: 'ROLE', entityId: id,
    after: { code, name, permissions: permissions.length },
  });
  res.status(201).json({ ...(await one<any>('SELECT * FROM roles WHERE id=?', [id])), permissions });
});

roleRouter.patch('/roles/:id', requirePermission('role.manage'), async (req, res) => {
  const id = text(req.params.id);
  const before = await one<any>('SELECT * FROM roles WHERE id=?', [id]);
  if (!before) return res.status(404).json({ error: 'ROLE_NOT_FOUND' });
  const isSystem = Boolean(before.is_system);

  const name = text(req.body?.name) || before.name;
  const description = req.body?.description === undefined ? before.description : (text(req.body?.description) || null);
  let isGlobal = before.is_global;
  let status = before.status;
  if (!isSystem) {
    if (req.body?.isGlobal !== undefined) isGlobal = req.body.isGlobal === true ? 1 : 0;
    if (req.body?.status !== undefined) {
      status = upper(req.body.status);
      if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ error: 'ROLE_STATUS_INVALID' });
    }
  }

  const nextPermissions = req.body?.permissions === undefined ? null : permissionList(req.body.permissions);
  if (nextPermissions) {
    const unknown = nextPermissions.filter(permission => !PERMISSION_CODES.has(permission));
    if (unknown.length > 0) return res.status(400).json({ error: 'ROLE_PERMISSION_INVALID', permissions: unknown });
  }
  const beforeGrants = await grantsOf(id);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE roles SET name=?,description=?,is_global=?,status=? WHERE id=?',
      [name, description, isGlobal ? 1 : 0, status, id],
    );
    if (nextPermissions) {
      await conn.query('DELETE FROM role_permissions WHERE role_id=?', [id]);
      for (const permission of nextPermissions) {
        await conn.query('INSERT INTO role_permissions(role_id,permission) VALUES(?,?)', [id, permission]);
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  await refreshRoleCache();

  // Jangan sampai tidak ada lagi pengguna aktif yang bisa mengatur role.
  if ((await roleManageSurvivors()) === 0) {
    const conn2 = await pool.getConnection();
    try {
      await conn2.beginTransaction();
      await conn2.query(
        'UPDATE roles SET name=?,description=?,is_global=?,status=? WHERE id=?',
        [before.name, before.description, before.is_global, before.status, id],
      );
      await conn2.query('DELETE FROM role_permissions WHERE role_id=?', [id]);
      for (const permission of beforeGrants) {
        await conn2.query('INSERT IGNORE INTO role_permissions(role_id,permission) VALUES(?,?)', [id, permission]);
      }
      await conn2.commit();
    } finally {
      conn2.release();
    }
    await refreshRoleCache();
    return res.status(409).json({ error: 'ROLE_MANAGE_REQUIRED' });
  }

  await writeAudit({
    legalEntityId: await activeEntityId(), userId: req.user!.id, ip: req.ip || null,
    action: 'ROLE_UPDATE', entityType: 'ROLE', entityId: id,
    before: { name: before.name, status: before.status, is_global: before.is_global },
    after: { name, status, is_global: isGlobal, permissions: nextPermissions?.length ?? undefined },
  });
  res.json({
    ...(await one<any>('SELECT * FROM roles WHERE id=?', [id])),
    is_system: isSystem,
    is_global: Boolean(isGlobal),
    permissions: await grantsOf(id),
  });
});

roleRouter.delete('/roles/:id', requirePermission('role.manage'), async (req, res) => {
  const id = text(req.params.id);
  const role = await one<any>('SELECT * FROM roles WHERE id=?', [id]);
  if (!role) return res.status(404).json({ error: 'ROLE_NOT_FOUND' });
  if (role.is_system) return res.status(409).json({ error: 'ROLE_SYSTEM_LOCKED' });

  const used = await one<{ total: number }>('SELECT COUNT(*) total FROM users WHERE role=?', [role.code]);
  if (Number(used?.total || 0) > 0) return res.status(409).json({ error: 'ROLE_IN_USE', users: Number(used?.total || 0) });

  const grants = await grantsOf(id);
  await query('DELETE FROM roles WHERE id=?', [id]);
  await refreshRoleCache();
  if ((await roleManageSurvivors()) === 0) {
    // Kembalikan role bila penghapusan membuat tidak ada pengelola role tersisa.
    await query(
      `INSERT INTO roles(id,code,name,description,is_system,is_global,status,sort_order,seeded_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [role.id, role.code, role.name, role.description, role.is_system, role.is_global, role.status,
        role.sort_order, role.seeded_at],
    );
    for (const permission of grants) {
      await query('INSERT IGNORE INTO role_permissions(role_id,permission) VALUES(?,?)', [id, permission]);
    }
    await refreshRoleCache();
    return res.status(409).json({ error: 'ROLE_MANAGE_REQUIRED' });
  }

  await writeAudit({
    legalEntityId: await activeEntityId(), userId: req.user!.id, ip: req.ip || null,
    action: 'ROLE_DELETE', entityType: 'ROLE', entityId: id,
    before: { code: role.code, name: role.name, permissions: grants.length },
  });
  res.json({ ok: true, deleted: id });
});
