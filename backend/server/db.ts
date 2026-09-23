/**
 * db.ts — lapisan akses database MariaDB dengan API yang kompatibel dengan `pg`.
 *
 * Seluruh route/engine aplikasi ditulis untuk PostgreSQL (`pool.query(sql, params)` dengan
 * placeholder `$1`, `RETURNING`, `ON CONFLICT`, cast `::type`, `= ANY($n)`, dsb).
 * Modul ini menerjemahkan dialek tersebut ke MariaDB 10.11+/11.x secara deterministik
 * sehingga logika bisnis tidak perlu diubah dan perilaku tetap identik:
 *
 *   - `$1..$n`                      -> `?` (parameter yang dipakai berulang diduplikasi urut)
 *   - `expr::text|uuid|jsonb|int…`  -> cast dibuang (MariaDB dynamic typing), `$n::date` -> DATE(?)
 *   - `col = ANY($n)` (array)       -> `col IN (?, ?, …)`  (array kosong -> `IN (NULL)`)
 *   - `ON CONFLICT(..) DO NOTHING`  -> `ON DUPLICATE KEY UPDATE col=col` (no-op; rowCount 0 saat duplikat)
 *   - `… DO NOTHING RETURNING`      -> `INSERT IGNORE … RETURNING` (hanya baris yang benar-benar masuk)
 *   - `ON CONFLICT(..) DO UPDATE SET a=EXCLUDED.a` -> `ON DUPLICATE KEY UPDATE a=VALUES(a)`
 *   - `INSERT/DELETE … RETURNING`   -> native MariaDB (10.5+)
 *   - `FOR UPDATE OF t`             -> `FOR UPDATE`
 *   - `BTRIM()`                     -> `TRIM()`
 *   - `BEGIN`                       -> `START TRANSACTION`
 *   - boolean TINYINT(1) -> true/false, kolom JSON -> object, DECIMAL -> string (sama seperti pg)
 *
 * Hasil query dikembalikan sebagai `{ rows, rowCount }` seperti `pg.QueryResult`.
 */
import mysql from 'mysql2/promise';
import type { Pool as MysqlPool, PoolConnection, FieldPacket } from 'mysql2/promise';

export type QueryResultRow = Record<string, any>;
export interface QueryResult<T extends QueryResultRow = any> {
  rows: T[];
  rowCount: number;
  fields?: FieldPacket[];
}

/** Kolom bertipe JSON di skema (lihat database/mariadb/001_schema.sql) + alias hasil agregasi JSON. */
export const JSON_COLUMNS = new Set<string>([
  'metadata', 'before_data', 'after_data', 'column_mapping', 'header_signature', 'settings', 'parser_metadata',
  // alias hasil JSON_ARRAYAGG/JSON_OBJECT pada query manual
  'lines', 'components',
]);

// ---------------------------------------------------------------------------
// Konfigurasi koneksi
// ---------------------------------------------------------------------------
function buildPoolConfig(): mysql.PoolOptions {
  const url = process.env.DATABASE_URL || process.env.MARIADB_URL || '';
  const base: mysql.PoolOptions = {
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0,
    timezone: 'Z',              // simpan & baca DATETIME sebagai UTC (padanan timestamptz)
    dateStrings: false,         // DATE/DATETIME -> objek Date (seperti pg)
    decimalNumbers: false,      // DECIMAL -> string (seperti numeric di pg)
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    namedPlaceholders: false,
    charset: 'utf8mb4',
    typeCast: typeCastRow,
    connectTimeout: 15000,
  };
  if (url) {
    const u = new URL(url.replace(/^(mysql|mariadb)(\+\w+)?:\/\//, 'mysql://'));
    return {
      ...base,
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      ssl: u.searchParams.get('ssl') === 'true' ? { rejectUnauthorized: false } : undefined,
    };
  }
  return {
    ...base,
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'default',
  };
}

function typeCastRow(field: any, next: () => any) {
  // BOOLEAN / TINYINT(1) -> boolean (pg mengembalikan boolean asli)
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v === '1';
  }
  // JSON (MariaDB mengirim sebagai LONGTEXT) -> object
  if (JSON_COLUMNS.has(field.name) && (field.type === 'BLOB' || field.type === 'VAR_STRING' || field.type === 'STRING' || field.type === 'JSON')) {
    const v = field.string();
    if (v === null || v === undefined) return null;
    try { return JSON.parse(v); } catch { return v; }
  }
  return next();
}

const mysqlPool: MysqlPool = mysql.createPool(buildPoolConfig());

// Pastikan setiap koneksi baru memakai sql_mode & time_zone yang konsisten.
mysqlPool.on('connection', (conn: any) => {
  conn.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,PIPES_AS_CONCAT', time_zone='+00:00'");
});

// ---------------------------------------------------------------------------
// Translasi SQL PostgreSQL -> MariaDB
// ---------------------------------------------------------------------------
const CAST_RE = /::(?:text\[\]|uuid\[\]|numeric\[\]|int\[\]|integer\[\]|text|uuid|jsonb|json|numeric(?:\([^)]*\))?|int|integer|bigint|smallint|boolean|bool|timestamptz|timestamp|bpchar|varchar|char)\b/g;

export function translateSql(sql: string, params: any[] = []): { sql: string; params: any[] } {
  let out = sql;

  // 1) $n::date -> DATE(?) ; NOW()::date -> CURRENT_DATE
  out = out.replace(/\$(\d+)::date\b/g, 'DATE($$$1)');
  out = out.replace(/\bNOW\(\)::date\b/gi, 'CURRENT_DATE');
  out = out.replace(/\bCURRENT_DATE::date\b/gi, 'CURRENT_DATE');

  // 1b) merge jsonb:  col || $n::jsonb  ->  JSON_MERGE_PATCH(col, $n)
  out = out.replace(/([\w.]+)\s*\|\|\s*\$(\d+)::jsonb\b/g, 'JSON_MERGE_PATCH($1, $$$2)');

  // 1c) expr::text -> CAST(expr AS CHAR) agar tipe hasil tetap string (numeric/date/uuid) seperti di PostgreSQL
  out = castTextToChar(out);

  // 2) = ANY($n) dengan parameter array -> IN (?, ?, ...)
  out = out.replace(/(=|<>|!=)\s*ANY\s*\(\s*\$(\d+)(?:::[a-z]+\[\])?\s*\)/gi, (_m, op: string, idx: string) => {
    const i = Number(idx) - 1;
    const arr = params[i];
    if (!Array.isArray(arr)) return `${op} $${idx}`;
    const kw = op === '=' ? ' IN' : ' NOT IN';
    if (arr.length === 0) return `${kw} (NULL)`;
    return `${kw} (${arr.map(() => `$${idx}`).join(', ')})`;
  });

  // 3) buang cast ::type
  out = out.replace(CAST_RE, '');

  // 3b) operator JSON PostgreSQL  expr->>'key'  ->  JSON_VALUE(expr,'$.key')
  out = out.replace(/([\w.]+)\s*->>\s*'([^']+)'/g, "JSON_VALUE($1,'$.$2')");

  // 4) FOR UPDATE OF alias -> FOR UPDATE ; FOR SHARE -> LOCK IN SHARE MODE
  out = out.replace(/\bFOR UPDATE OF \w+/gi, 'FOR UPDATE');
  out = out.replace(/\bFOR SHARE\b/gi, 'LOCK IN SHARE MODE');

  // 4b) ORDER BY expr NULLS LAST|FIRST -> MariaDB (NULL diurutkan lebih dulu pada ASC)
  out = out.replace(/([\w.]+(?:\s+(?:ASC|DESC))?)\s+NULLS\s+LAST\b/gi, (_m, e: string) => `(${e.replace(/\s+(ASC|DESC)$/i, '')} IS NULL), ${e}`);
  out = out.replace(/([\w.]+(?:\s+(?:ASC|DESC))?)\s+NULLS\s+FIRST\b/gi, (_m, e: string) => `(${e.replace(/\s+(ASC|DESC)$/i, '')} IS NOT NULL), ${e}`);

  // 5) BTRIM -> TRIM
  out = out.replace(/\bBTRIM\s*\(/gi, 'TRIM(');

  // 6) ON CONFLICT ...
  out = translateOnConflict(out);

  // 7) BEGIN -> START TRANSACTION
  if (/^\s*BEGIN\s*;?\s*$/i.test(out)) out = 'START TRANSACTION';

  // 8) $n -> ? dengan pemetaan ulang parameter (dukung array yang di-expand)
  const newParams: any[] = [];
  const arrayCursor = new Map<number, number>();
  out = out.replace(/\$(\d+)/g, (_m, idx: string) => {
    const i = Number(idx) - 1;
    let v = params[i];
    if (Array.isArray(v)) {
      const c = arrayCursor.get(i) ?? 0;
      arrayCursor.set(i, c + 1);
      v = v[c];
    }
    newParams.push(normalizeParam(v));
    return '?';
  });

  return { sql: out, params: newParams };
}

/** Ubah `operand::text` menjadi `CAST(operand AS CHAR)`; operand bisa berupa kolom, $n, literal, atau ekspresi berkurung/fungsi. */
function castTextToChar(sql: string): string {
  let idx = sql.indexOf('::text');
  let guard = 0;
  while (idx >= 0 && guard++ < 1000) {
    // lewati ::text[] (array) — ditangani oleh translasi ANY
    if (sql.startsWith('::text[]', idx)) { idx = sql.indexOf('::text', idx + 8); continue; }
    let start = idx;
    if (sql[start - 1] === ')') {
      let depth = 0;
      for (let i = start - 1; i >= 0; i--) {
        if (sql[i] === ')') depth++;
        else if (sql[i] === '(') { depth--; if (depth === 0) { start = i; break; } }
      }
      // sertakan nama fungsi di depan kurung, mis. COALESCE(...)
      let j = start - 1;
      while (j >= 0 && /[\w.]/.test(sql[j])) j--;
      start = j + 1;
    } else if (sql[start - 1] === "'") {
      let i = start - 2;
      while (i >= 0 && sql[i] !== "'") i--;
      start = i;
    } else {
      let j = start - 1;
      while (j >= 0 && /[\w.$]/.test(sql[j])) j--;
      start = j + 1;
    }
    const operand = sql.slice(start, idx);
    let replacement = `CAST(${operand} AS CHAR)`;
    // Jika kolom polos tanpa alias (diikuti koma/FROM/kurung tutup), tambahkan alias nama kolom
    // agar nama field hasil tetap sama seperti PostgreSQL (`t.total::text` -> field `total`).
    const tail = sql.slice(idx + 6);
    const noAlias = /^\s*(,|\)|$)/.test(tail) || /^\s*(FROM|UNION|ORDER|GROUP|WHERE|LIMIT|HAVING)\b/i.test(tail);
    if (noAlias && /^[\w.]+$/.test(operand) && !operand.startsWith('$') && !/^\d/.test(operand)) {
      replacement += ` AS ${operand.split('.').pop()}`;
    }
    sql = sql.slice(0, start) + replacement + sql.slice(idx + 6);
    idx = sql.indexOf('::text', start + replacement.length);
  }
  return sql;
}

function normalizeParam(v: any) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v)) return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v); // objek -> JSON (seperti pg)
  return v;
}

function translateOnConflict(sql: string): string {
  const start = sql.search(/\bON CONFLICT\b/i);
  if (start < 0) return sql;
  // cari daftar kolom target dengan kurung berimbang (bisa mengandung fungsi bersarang)
  let i = sql.indexOf('(', start);
  if (i < 0) return sql;
  let depth = 0;
  for (; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (depth === 0) break; }
  }
  const rest = sql.slice(i + 1);
  const dm = /^\s*(?:WHERE\s+[\s\S]*?)?\s*DO\s+(NOTHING|UPDATE\s+SET)\b/i.exec(rest);
  if (!dm) return sql;
  const before = sql.slice(0, start);
  let after = rest.slice(dm[0].length);
  const action = dm[1].toUpperCase();

  // Nama kolom pertama pada INSERT INTO t(col1, ...) untuk no-op update
  const colsMatch = /INSERT\s+INTO\s+(\w+)\s*\(\s*([\w]+)/i.exec(before);
  const table = colsMatch ? colsMatch[1] : '';
  // dikualifikasi nama tabel agar tidak ambigu pada INSERT ... SELECT dari tabel lain
  const firstCol = colsMatch ? `${table}.${colsMatch[2]}` : 'id';

  if (action === 'NOTHING') {
    const hasReturning = /\bRETURNING\b/i.test(after);
    if (hasReturning) {
      // hanya baris yang benar-benar tersisip yang dikembalikan (setara PG DO NOTHING RETURNING)
      return before.replace(/INSERT\s+INTO/i, 'INSERT IGNORE INTO') + after;
    }
    return `${before} ON DUPLICATE KEY UPDATE ${firstCol}=${firstCol}${after}`;
  }
  // DO UPDATE SET a=EXCLUDED.a, ...  ->  ON DUPLICATE KEY UPDATE a=VALUES(a), ...
  after = after.replace(/\bEXCLUDED\.(\w+)/gi, 'VALUES($1)');
  return `${before} ON DUPLICATE KEY UPDATE ${after}`;
}

// ---------------------------------------------------------------------------
// Eksekusi
// ---------------------------------------------------------------------------
async function run<T extends QueryResultRow>(
  executor: { query: (sql: string, params?: any[]) => Promise<any> },
  text: string,
  params: any[] = [],
): Promise<QueryResult<T>> {
  const t = translateSql(text, params);
  try {
    const [result, fields] = await executor.query(t.sql, t.params);
    if (Array.isArray(result)) {
      return { rows: result as T[], rowCount: result.length, fields };
    }
    const header = result as mysql.ResultSetHeader;
    return { rows: [] as T[], rowCount: header?.affectedRows ?? 0 };
  } catch (err: any) {
    // Samakan kode error supaya handler bergaya pg (`e.code==='23505'`) tetap bekerja
    if (err && (err.errno === 1062 || err.code === 'ER_DUP_ENTRY')) err.code = '23505';
    if (err && (err.errno === 1452 || err.errno === 1451)) err.code = '23503';
    if (err && err.errno === 4025) err.code = '23514'; // CHECK constraint
    if (process.env.DB_DEBUG === '1') console.error('[db] gagal:', t.sql, t.params, err?.message);
    throw err;
  }
}

/** Padanan `pg.PoolClient` (dipakai untuk transaksi). */
export class PoolClient {
  constructor(private conn: PoolConnection) {}
  query<T extends QueryResultRow = any>(text: string, params: any[] = []) {
    return run<T>(this.conn as any, text, params);
  }
  release() {
    this.conn.release();
  }
}

/** Padanan `pg.Pool` yang dipakai aplikasi: `pool.query()` dan `pool.connect()`. */
export const pool = {
  query<T extends QueryResultRow = any>(text: string, params: any[] = []) {
    return run<T>(mysqlPool as any, text, params);
  },
  async connect(): Promise<PoolClient> {
    const conn = await mysqlPool.getConnection();
    return new PoolClient(conn);
  },
  end() {
    return mysqlPool.end();
  },
};

export async function query<T extends QueryResultRow = any>(text: string, params: any[] = []) {
  return pool.query<T>(text, params);
}

/** Eksekusi satu statement mentah tanpa translasi (dipakai runner migrasi). */
export async function rawExec(sql: string, params: any[] = []) {
  return mysqlPool.query(sql, params);
}

export function databaseLabel() {
  const cfg = buildPoolConfig();
  return `${cfg.host}:${cfg.port}/${cfg.database}`;
}
