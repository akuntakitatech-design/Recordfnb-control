import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, rawExec, databaseLabel } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../database/mariadb');

/**
 * Pecah file SQL menjadi statement per statement.
 * - Baris komentar `--` diabaikan.
 * - Jika file mengandung `BEGIN ... END` (trigger/procedure), seluruh file dianggap satu statement.
 * - Pemisah statement adalah `;` di akhir baris (di luar string literal).
 */
export function splitSqlStatements(sql: string): string[] {
  const noComments = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  if (/\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|PROCEDURE|FUNCTION)\b/i.test(noComments)) {
    return [noComments.trim().replace(/;\s*$/, '')].filter(Boolean);
  }
  const statements: string[] = [];
  let current = '';
  let inString: string | null = null;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      current += ch;
      if (ch === inString && noComments[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function runSqlFile(filePath: string) {
  const sql = await fs.readFile(filePath, 'utf8');
  const statements = splitSqlStatements(sql);
  for (const statement of statements) {
    await rawExec(statement);
  }
  return statements.length;
}

/**
 * Runner migrasi MariaDB.
 * Tabel `schema_migrations` menyimpan nama file yang sudah diterapkan (idempoten).
 * Catatan: DDL di MariaDB bersifat auto-commit, sehingga migrasi tidak dibungkus transaksi;
 * seluruh DDL memakai `IF NOT EXISTS`/`INSERT IGNORE` agar aman dijalankan ulang.
 */
export async function runMigrations() {
  await rawExec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(191) NOT NULL PRIMARY KEY,
      applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
  console.log(`[migration] database ${databaseLabel()} — ${files.length} file migrasi`);
  for (const file of files) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (exists.rowCount) continue;
    try {
      const count = await runSqlFile(path.join(migrationsDir, file));
      await pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      console.log(`[migration] applied ${file} (${count} statement)`);
    } catch (error) {
      console.error(`[migration] GAGAL pada ${file}:`, (error as Error).message);
      throw error;
    }
  }
}
