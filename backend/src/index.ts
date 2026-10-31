import 'dotenv/config';
import express from 'express';
import 'express-async-errors';
import cookieParser from 'cookie-parser';
import { databaseLabel, query } from './db.js';
import { bootstrapAdmin } from './bootstrap.js';
import { runMigrations } from './migrate.js';
import { authRouter } from './routes/authRoutes.js';
import { organizationRouter } from './routes/organizationRoutes.js';
import { bankRouter } from './routes/bankRoutes.js';
import { userRouter } from './routes/userRoutes.js';
import { dashboardRouter } from './routes/dashboardRoutes.js';
import { studentRouter } from './routes/studentRoutes.js';
import { feeRouter } from './routes/feeRoutes.js';
import { billingRouter } from './routes/billingRoutes.js';
import { receivableRouter } from './routes/receivableRoutes.js';
import { receiptRouter } from './routes/receiptRoutes.js';
import { cashBankRouter } from './routes/cashBankRoutes.js';

const app = express();
app.set('trust proxy', true);
const port = Number(process.env.PORT || 4100);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', async (_req, res) => {
  const rows = await query<{ now: string }>('SELECT CAST(NOW(6) AS CHAR) AS now');
  res.json({ ok: true, service: 'school-finance-erp', database: databaseLabel(), databaseTime: rows[0]?.now });
});

app.use('/api/auth', authRouter);
app.use('/api/v1/organization', organizationRouter);
app.use('/api/v1', bankRouter);
app.use('/api/v1', userRouter);
app.use('/api/v1', dashboardRouter);
app.use('/api/v1', studentRouter);
app.use('/api/v1', feeRouter);
app.use('/api/v1', billingRouter);
app.use('/api/v1', receivableRouter);
app.use('/api/v1', receiptRouter);
app.use('/api/v1', cashBankRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' }));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
  const duplicate = err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
  const foreignKey = err?.code === 'ER_NO_REFERENCED_ROW_2' || err?.errno === 1452;
  const status = duplicate ? 409 : foreignKey ? 400 : 500;
  if (status === 500) console.error('[api] unhandled error:', err);
  res.status(status).json({
    error: duplicate ? 'DUPLICATE_ENTRY' : foreignKey ? 'FOREIGN_KEY_VIOLATION' : 'INTERNAL_ERROR',
    detail: err?.sqlMessage || err?.message || String(err),
  });
});

runMigrations()
  .then(() => bootstrapAdmin())
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`School Finance ERP listening on :${port}`)))
  .catch(error => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
