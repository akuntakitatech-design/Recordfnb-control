import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';
import { bootstrapAdmin } from './bootstrap.js';
import { runMigrations } from './migrate.js';
import { clearSessionCookie, requireAuth, setSessionCookie, signSession } from './auth.js';
import { masterRouter } from './masterRoutes.js';
import { financeMasterRouter } from './financeMasterRoutes.js';
import { transactionRouter } from './transactionRoutes.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', async (_req, res) => {
  const db = await query<{ now: string }>('SELECT NOW()::text AS now');
  res.json({ ok: true, service: 'akuntakita-fnb-control', databaseTime: db.rows[0]?.now });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'EMAIL_PASSWORD_REQUIRED' });

  const result = await query<{ id: string; email: string; password_hash: string; full_name: string; status: string }>(
    'SELECT id,email,password_hash,full_name,status FROM users WHERE email=$1 LIMIT 1',
    [email],
  );
  const user = result.rows[0];
  if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
  }

  const session = { id: user.id, email: user.email, fullName: user.full_name };
  setSessionCookie(res, signSession(session));
  res.json({ user: session });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const memberships = await query<{
    workspace_id: string;
    workspace_name: string;
    company_id: string | null;
    company_name: string | null;
    location_id: string | null;
    location_name: string | null;
    role_code: string;
    role_name: string;
    side: string;
  }>(
    `SELECT wm.workspace_id, w.name workspace_name, wm.company_id, c.name company_name,
            wm.location_id, l.name location_name, r.code role_code, r.name role_name, r.side
       FROM workspace_memberships wm
       JOIN workspaces w ON w.id=wm.workspace_id
       JOIN roles r ON r.id=wm.role_id
       LEFT JOIN companies c ON c.id=wm.company_id
       LEFT JOIN locations l ON l.id=wm.location_id
      WHERE wm.user_id=$1 AND wm.status='ACTIVE'
      ORDER BY w.name, r.side, r.name`,
    [req.sessionUser!.id],
  );
  res.json({ user: req.sessionUser, memberships: memberships.rows });
});

app.get('/api/foundation/summary', requireAuth, async (_req, res) => {
  const result = await query<{
    workspaces: number;
    companies: number;
    locations: number;
    items: number;
    partners: number;
    transactions: number;
  }>(`SELECT
       (SELECT COUNT(*)::int FROM workspaces) workspaces,
       (SELECT COUNT(*)::int FROM companies) companies,
       (SELECT COUNT(*)::int FROM locations) locations,
       (SELECT COUNT(*)::int FROM items) items,
       (SELECT COUNT(*)::int FROM business_partners) partners,
       (SELECT COUNT(*)::int FROM transaction_headers) transactions`);
  res.json(result.rows[0]);
});

app.get('/api/master/workspaces', requireAuth, async (_req, res) => {
  const result = await query('SELECT id,code,name,status FROM workspaces ORDER BY name');
  res.json(result.rows);
});

app.post('/api/master/workspaces', requireAuth, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  if (!code || !name) return res.status(400).json({ error: 'CODE_NAME_REQUIRED' });
  const result = await query(
    `INSERT INTO workspaces(code,name) VALUES($1,$2)
     RETURNING id,code,name,status`,
    [code, name],
  );
  res.status(201).json(result.rows[0]);
});

app.get('/api/master/companies', requireAuth, async (_req, res) => {
  const result = await query(
    `SELECT c.id,c.code,c.name,c.status,c.workspace_id,w.name workspace_name
       FROM companies c JOIN workspaces w ON w.id=c.workspace_id
      ORDER BY w.name,c.name`,
  );
  res.json(result.rows);
});

app.post('/api/master/companies', requireAuth, async (req, res) => {
  const workspaceId = String(req.body?.workspaceId || '');
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  if (!workspaceId || !code || !name) return res.status(400).json({ error: 'WORKSPACE_CODE_NAME_REQUIRED' });
  const result = await query(
    `INSERT INTO companies(workspace_id,code,name) VALUES($1,$2,$3)
     RETURNING id,workspace_id,code,name,status`,
    [workspaceId, code, name],
  );
  res.status(201).json(result.rows[0]);
});

app.get('/api/master/locations', requireAuth, async (_req, res) => {
  const result = await query(
    `SELECT l.id,l.code,l.name,l.location_type,l.status,l.company_id,c.name company_name
       FROM locations l JOIN companies c ON c.id=l.company_id
      ORDER BY c.name,l.name`,
  );
  res.json(result.rows);
});

app.post('/api/master/locations', requireAuth, async (req, res) => {
  const companyId = String(req.body?.companyId || '');
  const code = String(req.body?.code || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  const locationType = String(req.body?.locationType || 'OUTLET');
  if (!companyId || !code || !name) return res.status(400).json({ error: 'COMPANY_CODE_NAME_REQUIRED' });
  const ws = await query<{ workspace_id: string }>('SELECT workspace_id FROM companies WHERE id=$1', [companyId]);
  if (!ws.rowCount) return res.status(404).json({ error: 'COMPANY_NOT_FOUND' });
  const result = await query(
    `INSERT INTO locations(workspace_id,company_id,code,name,location_type)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id,company_id,code,name,location_type,status`,
    [ws.rows[0].workspace_id, companyId, code, name, locationType],
  );
  res.status(201).json(result.rows[0]);
});

app.use('/api/master', masterRouter);
app.use('/api/master', financeMasterRouter);
app.use('/api/transactions', transactionRouter);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(rootDir, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(rootDir, 'dist', 'index.html')));
}

runMigrations()
  .then(() => bootstrapAdmin())
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`F&B Control listening on :${port}`)))
  .catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
