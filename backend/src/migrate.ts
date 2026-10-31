import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databaseLabel, exec, pool, query } from './db.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');

/** Pisahkan file SQL menjadi statement; abaikan baris komentar dan hormati string literal. */
export function splitStatements(sql: string): string[] {
  const clean = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quote) {
      current += ch;
      if (ch === quote && clean[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
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

/** Jalankan migrasi yang belum tercatat di schema_migrations (idempoten). */
export async function runMigrations() {
  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(191) NOT NULL PRIMARY KEY,
    applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const files = (await fs.readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort();
  console.log(`[migration] database ${databaseLabel()} — ${files.length} file migrasi`);

  for (const file of files) {
    const applied = await query('SELECT 1 FROM schema_migrations WHERE version=?', [file]);
    if (applied.length) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    try {
      for (const statement of splitStatements(sql)) await pool.query(statement);
      await exec('INSERT INTO schema_migrations(version) VALUES(?)', [file]);
      console.log(`[migration] applied ${file}`);
    } catch (error) {
      console.error(`[migration] GAGAL pada ${file}:`, (error as Error).message);
      throw error;
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runMigrations()
    .then(() => pool.end())
    .then(() => console.log('[migration] selesai'))
    .catch(error => {
      console.error('[migration] gagal:', error);
      process.exit(1);
    });
}
