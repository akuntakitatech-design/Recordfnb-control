import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { exec, one } from './db.js';

/**
 * Admin awal dari env BOOTSTRAP_ADMIN_* dengan role ADMIN_YAYASAN.
 * Password lama dipertahankan kecuali BOOTSTRAP_ADMIN_RESET_PASSWORD=true.
 */
export async function bootstrapAdmin() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
  const fullName = process.env.BOOTSTRAP_ADMIN_NAME || 'Admin Yayasan';
  if (!email || !password) return;

  const existing = await one<{ id: string }>('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
  if (existing) {
    const reset = /^(1|true|yes)$/i.test(process.env.BOOTSTRAP_ADMIN_RESET_PASSWORD || '');
    if (reset) {
      const passwordHash = await bcrypt.hash(password, 12);
      await exec(
        "UPDATE users SET password_hash=?, role='ADMIN_YAYASAN', status='ACTIVE', must_change_password=1 WHERE id=?",
        [passwordHash, existing.id],
      );
      console.log(`[bootstrap] admin ${email}: password direset dari env (wajib ganti saat login; hapus BOOTSTRAP_ADMIN_RESET_PASSWORD)`);
      return;
    }
    await exec("UPDATE users SET role='ADMIN_YAYASAN', status='ACTIVE' WHERE id=?", [existing.id]);
    console.log(`[bootstrap] admin ${email} sudah ada; password lama dipertahankan`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await exec(
    "INSERT INTO users(id,email,password_hash,full_name,role,must_change_password) VALUES(?,?,?,?,'ADMIN_YAYASAN',1)",
    [randomUUID(), email, passwordHash, fullName],
  );
  console.log(`[bootstrap] admin ${email} dibuat (ADMIN_YAYASAN, wajib ganti password saat login pertama)`);
}
