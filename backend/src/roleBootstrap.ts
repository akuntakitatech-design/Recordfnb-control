import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { PERMISSION_CATALOG, ROLE_DEFINITIONS, refreshRoleCache } from './permissions.js';

/**
 * Sinkronisasi role & kewenangan saat backend start.
 *
 * Aturan (idempoten):
 * 1. Katalog permission di-`upsert` dari kode → permission baru otomatis terdaftar.
 * 2. Role bawaan di-`upsert` (nama, deskripsi, cakupan) tanpa menimpa role buatan admin.
 * 3. Kewenangan:
 *    - role bawaan yang baru pertama kali dibuat → dapat semua default-nya;
 *    - role bawaan yang sudah ada → hanya dapat permission yang BARU muncul
 *      (pencabutan manual oleh admin tidak dibatalkan);
 *    - role buatan admin tidak pernah otomatis, admin mencentang sendiri.
 */
export async function bootstrapRoles(): Promise<void> {
  const existingPermissions = new Set(
    (await query<{ code: string }>('SELECT code FROM permissions')).map(row => row.code),
  );

  for (const item of PERMISSION_CATALOG) {
    await query(
      `INSERT INTO permissions(code,group_name,label,description) VALUES(?,?,?,?)
       ON DUPLICATE KEY UPDATE group_name=VALUES(group_name),label=VALUES(label),description=VALUES(description)`,
      [item.code, item.group, item.label, item.description],
    );
  }
  const newPermissions = new Set(
    PERMISSION_CATALOG.filter(item => !existingPermissions.has(item.code)).map(item => item.code),
  );

  const existingRoles = new Set((await query<{ code: string }>('SELECT code FROM roles')).map(row => row.code));

  for (const definition of ROLE_DEFINITIONS) {
    await query(
      `INSERT INTO roles(id,code,name,description,is_system,is_global,sort_order,status)
       VALUES(?,?,?,?,1,?,?,'ACTIVE')
       ON DUPLICATE KEY UPDATE
         name=VALUES(name),
         description=VALUES(description),
         is_system=1,
         is_global=VALUES(is_global),
         sort_order=VALUES(sort_order)`,
      [randomUUID(), definition.code, definition.name, definition.description,
        definition.isGlobal ? 1 : 0, definition.sortOrder],
    );
  }

  const roles = await query<{ id: string; code: string; seeded_at: string | null }>(
    'SELECT id,code,seeded_at FROM roles',
  );
  const roleByCode = new Map(roles.map(role => [role.code, role]));

  for (const definition of ROLE_DEFINITIONS) {
    const role = roleByCode.get(definition.code);
    if (!role) continue;
    const isNewRole = !existingRoles.has(definition.code);
    const needsInitialSeed = !role.seeded_at;
    const grants = isNewRole || needsInitialSeed
      ? definition.permissions
      : definition.permissions.filter(permission => newPermissions.has(permission));
    if (grants.length === 0) continue;

    const values = grants.map(() => '(?,?)').join(',');
    const params = grants.flatMap(permission => [role.id, permission]);
    await query(
      `INSERT IGNORE INTO role_permissions(role_id,permission) VALUES ${values}`,
      params,
    );
    if (isNewRole || needsInitialSeed) {
      await query('UPDATE roles SET seeded_at=NOW(6) WHERE id=?', [role.id]);
      console.log(`[roles] ${definition.code}: ${grants.length} kewenangan awal`);
    } else {
      console.log(`[roles] ${definition.code}: +${grants.length} kewenangan baru (${grants.join(', ')})`);
    }
  }

  // Integritas: role user harus selalu ada di tabel roles. Ditambahkan di sini agar idempoten.
  const foreignKey = await query<any>(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND CONSTRAINT_NAME='fk_users_role'`,
  );
  if (foreignKey.length === 0) {
    await query(
      'ALTER TABLE users ADD CONSTRAINT fk_users_role FOREIGN KEY (role) REFERENCES roles (code) ON UPDATE CASCADE ON DELETE RESTRICT',
    );
  }

  await refreshRoleCache();
  console.log(`[roles] ${roles.length} role, ${PERMISSION_CATALOG.length} permission`);
}
