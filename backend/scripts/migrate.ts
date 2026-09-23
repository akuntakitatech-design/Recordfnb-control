/**
 * Jalankan migrasi skema MariaDB secara manual (idempoten).
 * Pakai: yarn db:migrate   (butuh DATABASE_URL di env / .env)
 * Catatan: backend juga menjalankan migrasi otomatis saat start.
 */
import 'dotenv/config';
import { runMigrations } from '../server/migrate.js';
import { pool } from '../server/db.js';

runMigrations()
  .then(async () => {
    console.log('[migration] selesai');
    await pool.end();
  })
  .catch(async err => {
    console.error('[migration] gagal:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
