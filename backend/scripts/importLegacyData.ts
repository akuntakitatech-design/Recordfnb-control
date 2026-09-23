/**
 * Import data operasional dari PostgreSQL lama (VPS) ke MariaDB.
 * Sumber: database/legacy-data/fnb_legacy_data.sql (INSERT IGNORE -> idempoten, aman diulang).
 * Pakai: yarn db:import-legacy   (butuh DATABASE_URL di env / .env)
 *
 * Skema harus sudah ada (jalankan yarn db:migrate atau start backend sekali). Skrip ini
 * memanggil runMigrations() dulu agar bisa dijalankan pada database kosong sekalipun.
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations, runSqlFile } from '../server/migrate.js';
import { pool, query, databaseLabel } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '../database/legacy-data/fnb_legacy_data.sql');

async function main() {
  console.log(`[legacy-import] database ${databaseLabel()}`);
  await runMigrations();
  const count = await runSqlFile(file);
  console.log(`[legacy-import] ${count} statement dijalankan dari ${path.basename(file)}`);
  const summary = await query<{ users: number; workspaces: number; companies: number; locations: number; memberships: number; profiles: number }>(
    `SELECT (SELECT COUNT(*) FROM users) users,
            (SELECT COUNT(*) FROM workspaces) workspaces,
            (SELECT COUNT(*) FROM companies) companies,
            (SELECT COUNT(*) FROM locations) locations,
            (SELECT COUNT(*) FROM workspace_memberships) memberships,
            (SELECT COUNT(*) FROM sales_import_profiles) profiles`,
  );
  console.log('[legacy-import] ringkasan:', summary.rows[0]);
}

main()
  .then(() => pool.end())
  .catch(async err => {
    console.error('[legacy-import] gagal:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
