import bcrypt from 'bcryptjs';
import { query } from './db.js';

export async function bootstrapAdmin() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME || 'Super Admin';
  if (!email || !password) return;

  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email=$1 LIMIT 1', [email]);
  if (existing.rowCount) {
    // Default: password lama dipertahankan. Set BOOTSTRAP_ADMIN_RESET_PASSWORD=true (sekali, lalu hapus)
    // bila password admin lama perlu diganti dengan BOOTSTRAP_ADMIN_PASSWORD.
    const reset = /^(1|true|yes)$/i.test(process.env.BOOTSTRAP_ADMIN_RESET_PASSWORD || '');
    if (reset) {
      const passwordHash = await bcrypt.hash(password, 12);
      await query(`UPDATE users SET is_system_admin=TRUE, status='ACTIVE', password_hash=$1, updated_at=NOW() WHERE id=$2`, [passwordHash, existing.rows[0].id]);
      console.log(`[bootstrap] admin ${email}: password direset dari BOOTSTRAP_ADMIN_PASSWORD (hapus BOOTSTRAP_ADMIN_RESET_PASSWORD setelah ini)`);
      return;
    }
    await query(
      `UPDATE users
          SET is_system_admin=TRUE, updated_at=NOW()
        WHERE id=$1`,
      [existing.rows[0].id],
    );
    console.log(`[bootstrap] admin ${email} sudah ada; password lama dipertahankan`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await query(
    `INSERT INTO users(email, password_hash, full_name, is_system_admin)
     VALUES ($1,$2,$3,TRUE)`,
    [email, passwordHash, fullName],
  );
  console.log(`[bootstrap] admin user created for ${email}`);
}
