import mysql from 'mysql2/promise';

function connectionConfig() {
  const url = process.env.DATABASE_URL || process.env.MARIADB_URL || '';
  if (url) {
    const u = new URL(url.replace(/^(mysql|mariadb)(\+\w+)?:\/\//, 'mysql://'));
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  }
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'school_local',
  };
}

export const pool = mysql.createPool({
  ...connectionConfig(),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  decimalNumbers: false,
  supportBigNumbers: true,
  connectTimeout: 15000,
});

pool.on('connection', (conn: any) => {
  conn.query("SET SESSION time_zone='+00:00', sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function one<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function exec(sql: string, params: any[] = []): Promise<mysql.ResultSetHeader> {
  const [result] = await pool.query(sql, params);
  return result as mysql.ResultSetHeader;
}

export function databaseLabel() {
  const cfg = connectionConfig();
  return `${cfg.host}:${cfg.port}/${cfg.database}`;
}
