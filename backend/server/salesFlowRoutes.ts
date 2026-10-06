/**
 * salesFlowRoutes.ts — /api/sales-flow (Phase 2).
 *   /payment-methods       master metode pembayaran (HANYA Accounting yang mengubah; Finance/Owner melihat)
 *   /pos-codes             registry kode pembayaran POS (baca semua; Accounting menambah kode baru)
 *   /variance-accounts     akun Selisih Kas & Selisih Settlement (Accounting)
 *   /cash-drawers/*        Cash Drawer outlet (Outlet + Accounting tulis; Finance/Owner baca)
 *   /reconciliations/*     Rekonsiliasi POS vs Aktual, penyelesaian selisih, Verifikasi Penjualan (Finance/Accounting)
 *   /settlements/*         Outstanding & penerimaan settlement (Finance/Accounting)
 *   /evidence              Bukti foto/dokumen per metode / resolusi / settlement
 * Guard area di index.ts; cek company/location di setiap route.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import { query } from './db.js';
import { requireAuth } from './auth.js';
import {
  canAccessAccountingCompany, canAccessLocation, canCreateFinanceTransaction, canReadCashDrawer, canReadFinanceCompany,
  canVerifyTransaction, canWriteCashDrawer,
} from './access.js';
import { storage } from './storage.js';
import {
  REASONS, VARIANCE_ROLES, cancelSettlement, computeReconciliation, loadLocationMethods, outstandingSettlements, publicRecon, recordSettlement,
  reopenReconciliation, resolveDifference, verifyReconciliation,
} from './salesFlowEngine.js';
import { invalidatePosCodes, loadPosCodes } from './posPaymentCodes.js';

export const salesFlowRouter = Router();
salesFlowRouter.use(requireAuth);

const text = (v: unknown) => String(v ?? '').trim();
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const uid = (req: any) => req.sessionUser!.id as string;
const fail = (res: any, e: unknown, fallback: string) => {
  const msg = e instanceof Error ? e.message : fallback;
  const status = /ALREADY_VERIFIED|LOCKED|NOT_READY|CONFIRMATION_REQUIRED|ALREADY_MAPPED|DUPLICATE|REOPEN_|ALREADY_CANCELLED|PERIOD_/.test(msg) ? 409 : 400;
  if (status === 400 && !/^[A-Z_]+/.test(msg)) console.error('[sales-flow]', e);
  return res.status(status).json({ error: msg });
};

/** Kode POS yang bisa dipetakan ke metode outlet = registry aktif yang ikut rekonsiliasi (Compliment tidak). */
async function reconcilableCodes() { return (await loadPosCodes()).filter(c => c.include_in_reconciliation); }

async function companyWorkspace(companyId: string) {
  const r = await query<{ workspace_id: string }>(`SELECT workspace_id FROM companies WHERE id=$1`, [companyId]);
  return r.rows[0]?.workspace_id || null;
}

// =============================================================================================
// Master metode pembayaran
// =============================================================================================
salesFlowRouter.get('/payment-methods', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId || !(await canReadFinanceCompany(uid(req), companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  const accounting = await canAccessAccountingCompany(uid(req), companyId);
  const r = await query(
    `SELECT pm.id,pm.code,pm.name,pm.method_type,pm.pos_payment_code,pm.evidence_policy,pm.destination_behavior,pm.financial_account_id,fa.name financial_account_name,
            pm.reconcile_required,pm.sort_order,pm.status,pm.clearing_account_id,ca.code clearing_account_code,ca.name clearing_account_name,
            pm.fee_account_id,fe.code fee_account_code,fe.name fee_account_name
       FROM payment_methods pm
       LEFT JOIN financial_accounts fa ON fa.id=pm.financial_account_id
       LEFT JOIN chart_of_accounts ca ON ca.id=pm.clearing_account_id
       LEFT JOIN chart_of_accounts fe ON fe.id=pm.fee_account_id
      WHERE pm.company_id=$1 ORDER BY pm.status,pm.sort_order,pm.name`, [companyId]);
  const locs = await query(
    `SELECT pml.payment_method_id,pml.location_id,l.name location_name FROM payment_method_locations pml JOIN locations l ON l.id=pml.location_id
      JOIN payment_methods pm ON pm.id=pml.payment_method_id WHERE pm.company_id=$1`, [companyId]);
  res.json({
    canMapAccounts: accounting,
    rows: r.rows.map(m => {
      const locations = locs.rows.filter(l => l.payment_method_id === m.id).map(l => ({ id: l.location_id, name: l.location_name }));
      // Mapping akun hanya terlihat Accounting. Finance cukup melihat status "sudah/belum diatur Accounting".
      const mappingReady = m.destination_behavior === 'SETTLEMENT' ? Boolean(m.clearing_account_id) : Boolean(m.financial_account_id);
      const base = { ...m, locations, mapping_ready: mappingReady };
      if (accounting) return base;
      const { clearing_account_id, clearing_account_code, clearing_account_name, fee_account_id, fee_account_code, fee_account_name, ...rest } = base;
      return rest;
    }),
  });
});

async function savePaymentMethod(req: any, res: any, id: string | null) {
  const b = req.body || {};
  const companyId = text(b.companyId);
  // Master metode pembayaran (outlet aktif, behavior, bukti, kode POS, mapping akun) = wewenang Accounting saja.
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'PAYMENT_METHOD_ACCOUNTING_ONLY' });
  const accounting = true;
  const touchesMapping = b.clearingAccountId !== undefined || b.feeAccountId !== undefined;
  const codes = await reconcilableCodes();
  const name = text(b.name);
  const posCode = text(b.posPaymentCode).toUpperCase();
  const evidence = text(b.evidencePolicy || 'OPTIONAL').toUpperCase();
  const destination = text(b.destinationBehavior).toUpperCase();
  const financialAccountId = text(b.financialAccountId) || null;
  const locationIds: string[] = Array.isArray(b.locationIds) ? b.locationIds.map(text).filter(Boolean) : [];
  const status = text(b.status || 'ACTIVE').toUpperCase();
  if (!name || !codes.some(c => c.code === posCode) || !['REQUIRED', 'OPTIONAL'].includes(evidence) || !['CASH_DIRECT', 'BANK_DIRECT', 'SETTLEMENT'].includes(destination) || !['ACTIVE', 'INACTIVE'].includes(status)) {
    return res.status(400).json({ error: 'PAYMENT_METHOD_FIELDS_REQUIRED' });
  }
  if (!locationIds.length) return res.status(400).json({ error: 'PAYMENT_METHOD_LOCATION_REQUIRED' });
  if (destination !== 'SETTLEMENT') {
    const fa = await query(`SELECT account_kind FROM financial_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [financialAccountId, companyId]);
    if (!fa.rowCount) return res.status(400).json({ error: 'DESTINATION_ACCOUNT_REQUIRED' });
    if (destination === 'CASH_DIRECT' && fa.rows[0].account_kind !== 'CASH') return res.status(400).json({ error: 'CASH_DESTINATION_MUST_BE_CASH' });
    if (destination === 'BANK_DIRECT' && !['BANK', 'EWALLET'].includes(fa.rows[0].account_kind)) return res.status(400).json({ error: 'BANK_DESTINATION_MUST_BE_BANK' });
  } else if (financialAccountId) {
    const fa = await query(`SELECT 1 FROM financial_accounts WHERE id=$1 AND company_id=$2`, [financialAccountId, companyId]);
    if (!fa.rowCount) return res.status(400).json({ error: 'DESTINATION_ACCOUNT_REQUIRED' });
  }
  const locCheck = await query(`SELECT id FROM locations WHERE company_id=$1 AND id=ANY($2::uuid[])`, [companyId, locationIds]);
  if (locCheck.rowCount !== locationIds.length) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
  for (const accId of [b.clearingAccountId, b.feeAccountId].map(text).filter(Boolean)) {
    const ok = await query(`SELECT 1 FROM chart_of_accounts coa WHERE coa.id=$1 AND coa.company_id=$2 AND coa.status='ACTIVE'`, [accId, companyId]).catch(() => ({ rowCount: 0 }));
    if (!ok.rowCount) return res.status(400).json({ error: 'INVALID_MAPPING_ACCOUNT' });
  }
  // 1 kode POS = 1 metode per outlet — cek sebelum menulis apa pun (hindari metode yatim tanpa outlet).
  if (status === 'ACTIVE') {
    const clash = await query(`SELECT pml.location_id FROM payment_method_locations pml JOIN payment_methods pm ON pm.id=pml.payment_method_id
      WHERE pml.pos_payment_code=$1 AND pml.location_id=ANY($2::uuid[]) AND pml.payment_method_id<>$3`, [posCode, locationIds, id || '']);
    if (clash.rowCount) return res.status(409).json({ error: 'POS_CODE_ALREADY_MAPPED_AT_LOCATION' });
  }
  const workspaceId = await companyWorkspace(companyId);
  const before = id ? (await query(`SELECT * FROM payment_methods WHERE id=$1 AND company_id=$2`, [id, companyId])).rows[0] : null;
  if (id && !before) return res.status(404).json({ error: 'PAYMENT_METHOD_NOT_FOUND' });
  try {
    let methodId = id;
    if (!id) {
      const code = text(b.code).toUpperCase() || `PM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const ins = await query<{ id: string }>(
        `INSERT INTO payment_methods(workspace_id,company_id,code,name,method_type,pos_payment_code,evidence_policy,destination_behavior,financial_account_id,
           clearing_account_id,fee_account_id,sort_order,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [workspaceId, companyId, code, name, codes.find(c => c.code === posCode)!.method_type, posCode, evidence, destination, financialAccountId,
         accounting ? text(b.clearingAccountId) || null : null, accounting ? text(b.feeAccountId) || null : null, Number(b.sortOrder || 0), status]);
      methodId = ins.rows[0].id;
    } else {
      await query(
        `UPDATE payment_methods SET name=$1,method_type=$2,pos_payment_code=$3,evidence_policy=$4,destination_behavior=$5,financial_account_id=$6,sort_order=$7,status=$8,updated_at=NOW(),
                clearing_account_id=CASE WHEN $9 THEN $10 ELSE clearing_account_id END, fee_account_id=CASE WHEN $9 THEN $11 ELSE fee_account_id END
          WHERE id=$12`,
        [name, codes.find(c => c.code === posCode)!.method_type, posCode, evidence, destination, financialAccountId, Number(b.sortOrder || 0), status,
         accounting && touchesMapping, text(b.clearingAccountId) || null, text(b.feeAccountId) || null, id]);
      await query(`DELETE FROM payment_method_locations WHERE payment_method_id=$1`, [id]);
    }
    if (status === 'ACTIVE') {
      for (const locationId of locationIds) {
        await query(`INSERT INTO payment_method_locations(payment_method_id,location_id,pos_payment_code) VALUES($1,$2,$3)`, [methodId, locationId, posCode]);
      }
    }
    await query(
      `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,'PAYMENT_METHOD',$3,$4,$5::jsonb,$6::jsonb)`,
      [workspaceId, uid(req), methodId, id ? 'UPDATE_PAYMENT_METHOD' : 'CREATE_PAYMENT_METHOD', JSON.stringify(before || {}), JSON.stringify({ ...b, companyId })]);
    res.status(id ? 200 : 201).json({ id: methodId });
  } catch (e: any) {
    if (e?.code === '23505') return res.status(409).json({ error: 'POS_CODE_ALREADY_MAPPED_AT_LOCATION' });
    throw e;
  }
}
salesFlowRouter.post('/payment-methods', (req, res, next) => { savePaymentMethod(req, res, null).catch(next); });
salesFlowRouter.put('/payment-methods/:id', (req, res, next) => { savePaymentMethod(req, res, text(req.params.id)).catch(next); });

// Registry kode pembayaran POS — kode baru cukup ditambah di sini (parser, import & rekonsiliasi membaca registry).
salesFlowRouter.get('/pos-codes', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId || !(await canReadFinanceCompany(uid(req), companyId))) return res.status(403).json({ error: 'FORBIDDEN_COMPANY' });
  res.json((await loadPosCodes(undefined, true)).map(c => ({ code: c.code, label: c.label, aliases: c.aliases, method_type: c.method_type,
    include_in_reconciliation: c.include_in_reconciliation, settlement_module: c.settlement_module, status: c.status, dedicated_column: Boolean(c.legacy_column) })));
});

const METHOD_TYPES = ['CASH', 'QRIS', 'BANK_TRANSFER', 'CARD', 'OJOL', 'EWALLET', 'OTHER'];
salesFlowRouter.post('/pos-codes', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId);
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'POS_CODE_ACCOUNTING_ONLY' });
  const code = text(b.code).toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const label = text(b.label);
  const methodType = text(b.methodType || 'OTHER').toUpperCase();
  const aliases = (Array.isArray(b.aliases) ? b.aliases : text(b.aliases).split(',')).map((a: unknown) => text(a).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  if (code.length < 2 || code.length > 32 || !label || !METHOD_TYPES.includes(methodType)) return res.status(400).json({ error: 'POS_CODE_FIELDS_REQUIRED' });
  const existing = await loadPosCodes(undefined, true);
  if (existing.some(c => c.code === code)) return res.status(409).json({ error: 'POS_CODE_ALREADY_EXISTS' });
  const clash = aliases.find((a: string) => existing.some(c => c.code === a || c.aliases.includes(a)));
  if (clash) return res.status(409).json({ error: `POS_ALIAS_ALREADY_USED_${clash}` });
  const module = methodType === 'CASH' ? 'CASH' : methodType === 'BANK_TRANSFER' ? 'BANK_TRANSFER' : methodType === 'QRIS' ? 'QRIS_SETTLEMENT' : methodType === 'CARD' ? 'EDC_SETTLEMENT' : methodType === 'OJOL' ? 'OJOL_SETTLEMENT' : 'CHANNEL_SETTLEMENT';
  await query(`INSERT INTO pos_payment_codes(code,label,aliases,method_type,include_in_reconciliation,settlement_module,sort_order) VALUES($1,$2,$3,$4,1,$5,$6)`,
    [code, label, [code, ...aliases].join(','), methodType, module, 100 + existing.length]);
  invalidatePosCodes();
  const workspaceId = await companyWorkspace(companyId);
  await query(`INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,'POS_PAYMENT_CODE',$3,'CREATE_POS_PAYMENT_CODE',$4::jsonb)`,
    [workspaceId, uid(req), companyId, JSON.stringify({ code, label, aliases, methodType })]);
  res.status(201).json({ code });
});

// Akun selisih terpisah: Selisih Kas (Cash Drawer) & Selisih Settlement. MDR tetap di akun biaya per metode.
salesFlowRouter.get('/variance-accounts', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'ACCOUNTING_ROLE_REQUIRED' });
  const r = await query(`SELECT ia.role_code,ia.account_id,coa.code,coa.name FROM important_accounts ia JOIN chart_of_accounts coa ON coa.id=ia.account_id
    WHERE ia.company_id=$1 AND ia.role_code IN ('CASH_DRAWER_VARIANCE','SETTLEMENT_VARIANCE')`, [companyId]);
  res.json(Object.entries(VARIANCE_ROLES).map(([role, label]) => {
    const hit = r.rows.find(x => x.role_code === role);
    return { role_code: role, label, account_id: hit?.account_id || null, account_code: hit?.code || null, account_name: hit?.name || null };
  }));
});

salesFlowRouter.put('/variance-accounts', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId); const role = text(b.roleCode); const accountId = text(b.accountId);
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'ACCOUNTING_ROLE_REQUIRED' });
  if (!(role in VARIANCE_ROLES) || !accountId) return res.status(400).json({ error: 'VARIANCE_ACCOUNT_FIELDS_REQUIRED' });
  const ok = await query(`SELECT 1 FROM chart_of_accounts WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [accountId, companyId]);
  if (!ok.rowCount) return res.status(400).json({ error: 'INVALID_MAPPING_ACCOUNT' });
  const workspaceId = await companyWorkspace(companyId);
  const before = await query(`SELECT account_id FROM important_accounts WHERE company_id=$1 AND role_code=$2`, [companyId, role]);
  await query(`INSERT INTO important_accounts(workspace_id,company_id,role_code,account_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,role_code) DO UPDATE SET account_id=EXCLUDED.account_id`,
    [workspaceId, companyId, role, accountId]);
  await query(`INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,'IMPORTANT_ACCOUNT',$3,'SET_VARIANCE_ACCOUNT',$4::jsonb,$5::jsonb)`,
    [workspaceId, uid(req), companyId, JSON.stringify(before.rows[0] || {}), JSON.stringify({ role, accountId })]);
  res.json({ ok: true });
});

// =============================================================================================
// Cash Drawer
// =============================================================================================
async function drawerScope(req: any, res: any, companyId: string, locationId: string, write: boolean) {
  if (!companyId || !locationId) { res.status(400).json({ error: 'COMPANY_LOCATION_REQUIRED' }); return false; }
  const allowed = write ? await canWriteCashDrawer(uid(req), companyId) : await canReadCashDrawer(uid(req), companyId);
  if (!allowed) { res.status(403).json({ error: write ? 'CASH_DRAWER_OUTLET_ONLY' : 'FORBIDDEN_COMPANY' }); return false; }
  const loc = await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2`, [locationId, companyId]);
  if (!loc.rowCount) { res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' }); return false; }
  if (!(await canAccessLocation(uid(req), locationId))) { res.status(403).json({ error: 'LOCATION_FORBIDDEN' }); return false; }
  return true;
}

salesFlowRouter.get('/cash-drawers/context', async (req, res) => {
  const companyId = text(req.query.companyId); const locationId = text(req.query.locationId);
  if (!(await drawerScope(req, res, companyId, locationId, false))) return;
  const methods = await loadLocationMethods({ query } as any, locationId);
  res.json({ methods: methods.map(m => ({ id: m.id, name: m.name, pos_payment_code: m.pos_payment_code, evidence_policy: m.evidence_policy })), canWrite: await canWriteCashDrawer(uid(req), companyId) });
});

salesFlowRouter.get('/cash-drawers', async (req, res) => {
  const companyId = text(req.query.companyId); const locationId = text(req.query.locationId);
  if (!(await drawerScope(req, res, companyId, locationId, false))) return;
  const from = isDate(text(req.query.from)) ? text(req.query.from) : '';
  const to = isDate(text(req.query.to)) ? text(req.query.to) : '';
  const d = await query(
    `SELECT d.id,d.business_date::text business_date,d.shift_label,d.status,d.notes,d.created_at,d.updated_at,cu.full_name created_by_name,uu.full_name updated_by_name
       FROM cash_drawers d LEFT JOIN users cu ON cu.id=d.created_by LEFT JOIN users uu ON uu.id=d.updated_by
      WHERE d.location_id=$1 AND ($2='' OR d.business_date>=$2::date) AND ($3='' OR d.business_date<=$3::date)
      ORDER BY d.business_date DESC,d.shift_label LIMIT 200`, [locationId, from, to]);
  const ids = d.rows.map(x => x.id);
  const lines = ids.length ? await query(
    `SELECT dl.id,dl.cash_drawer_id,dl.payment_method_id,pm.name method_name,pm.evidence_policy,dl.actual_amount::text actual_amount,
            (SELECT a.id FROM attachments a WHERE a.entity_type='CASH_DRAWER_LINE' AND a.entity_id=dl.id ORDER BY a.uploaded_at DESC LIMIT 1) evidence_id,
            (SELECT a.file_name FROM attachments a WHERE a.entity_type='CASH_DRAWER_LINE' AND a.entity_id=dl.id ORDER BY a.uploaded_at DESC LIMIT 1) evidence_name,
            (SELECT COUNT(*) FROM attachments a WHERE a.entity_type='CASH_DRAWER_LINE' AND a.entity_id=dl.id) evidence_count
       FROM cash_drawer_lines dl JOIN payment_methods pm ON pm.id=dl.payment_method_id WHERE dl.cash_drawer_id=ANY($1::uuid[]) ORDER BY pm.sort_order,pm.name`, [ids]) : { rows: [] as any[] };
  res.json(d.rows.map(x => ({ ...x, lines: lines.rows.filter(l => l.cash_drawer_id === x.id).map(l => ({ ...l, evidence_count: Number(l.evidence_count || 0) })) })));
});

salesFlowRouter.get('/cash-drawers/:id/history', async (req, res) => {
  const d = await query(`SELECT company_id,location_id FROM cash_drawers WHERE id=$1`, [text(req.params.id)]);
  if (!d.rowCount) return res.status(404).json({ error: 'CASH_DRAWER_NOT_FOUND' });
  if (!(await drawerScope(req, res, d.rows[0].company_id, d.rows[0].location_id, false))) return;
  const h = await query(
    `SELECT a.action,a.before_data,a.after_data,a.created_at,u.full_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity_type='CASH_DRAWER' AND a.entity_id=$1 ORDER BY a.created_at DESC`, [text(req.params.id)]);
  res.json(h.rows);
});

/** Simpan Cash Drawer (upsert per outlet + tanggal + shift). Terkunci setelah Verifikasi Penjualan. */
salesFlowRouter.post('/cash-drawers', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId); const locationId = text(b.locationId); const date = text(b.businessDate);
  const shift = text(b.shiftLabel).slice(0, 100);
  if (!(await drawerScope(req, res, companyId, locationId, true))) return;
  if (!isDate(date)) return res.status(400).json({ error: 'BUSINESS_DATE_REQUIRED' });
  const rawLines: any[] = Array.isArray(b.lines) ? b.lines : [];
  const methods = await loadLocationMethods({ query } as any, locationId);
  if (!methods.length) return res.status(400).json({ error: 'PAYMENT_METHODS_NOT_CONFIGURED' });
  const lines = rawLines.map(l => ({ paymentMethodId: text(l.paymentMethodId), amount: Number(l.actualAmount ?? 0) }));
  if (lines.some(l => !methods.some(m => m.id === l.paymentMethodId))) return res.status(400).json({ error: 'PAYMENT_METHOD_NOT_ACTIVE_FOR_OUTLET' });
  if (lines.some(l => !Number.isFinite(l.amount) || l.amount < 0)) return res.status(400).json({ error: 'INVALID_ACTUAL_AMOUNT' });
  const recon = await query(`SELECT status FROM sales_reconciliations WHERE location_id=$1 AND business_date=$2::date`, [locationId, date]);
  if (recon.rows[0]?.status === 'VERIFIED') return res.status(409).json({ error: 'CASH_DRAWER_LOCKED' });
  const workspaceId = await companyWorkspace(companyId);
  const existing = await query(`SELECT id,status FROM cash_drawers WHERE location_id=$1 AND business_date=$2::date AND shift_label=$3`, [locationId, date, shift]);
  if (existing.rows[0]?.status === 'LOCKED') return res.status(409).json({ error: 'CASH_DRAWER_LOCKED' });
  let drawerId = existing.rows[0]?.id as string | undefined;
  const before = drawerId ? (await query(`SELECT payment_method_id,actual_amount::text actual_amount FROM cash_drawer_lines WHERE cash_drawer_id=$1`, [drawerId])).rows : [];
  if (!drawerId) {
    const ins = await query<{ id: string }>(
      `INSERT INTO cash_drawers(workspace_id,company_id,location_id,business_date,shift_label,notes,created_by,updated_by) VALUES($1,$2,$3,$4::date,$5,$6,$7,$7) RETURNING id`,
      [workspaceId, companyId, locationId, date, shift, text(b.notes) || null, uid(req)]);
    drawerId = ins.rows[0].id;
  } else {
    await query(`UPDATE cash_drawers SET notes=$1,updated_by=$2,updated_at=NOW() WHERE id=$3`, [text(b.notes) || null, uid(req), drawerId]);
  }
  for (const l of lines) {
    await query(
      `INSERT INTO cash_drawer_lines(cash_drawer_id,payment_method_id,actual_amount,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(cash_drawer_id,payment_method_id) DO UPDATE SET actual_amount=EXCLUDED.actual_amount,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [drawerId, l.paymentMethodId, l.amount, uid(req)]);
  }
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,before_data,after_data) VALUES($1,$2,'CASH_DRAWER',$3,$4,$5::jsonb,$6::jsonb)`,
    [workspaceId, uid(req), drawerId, existing.rowCount ? 'UPDATE_CASH_DRAWER' : 'CREATE_CASH_DRAWER', JSON.stringify({ lines: before }),
     JSON.stringify({ businessDate: date, shift, lines: lines.map(l => ({ payment_method_id: l.paymentMethodId, actual_amount: l.amount })) })]);
  const saved = await query(`SELECT id,payment_method_id FROM cash_drawer_lines WHERE cash_drawer_id=$1`, [drawerId]);
  res.status(existing.rowCount ? 200 : 201).json({ id: drawerId, lines: saved.rows });
});

// =============================================================================================
// Bukti (foto per metode / resolusi / settlement)
// =============================================================================================
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOC_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);
export const MAX_EVIDENCE = 7 * 1024 * 1024;
const EXT_BY_MIME: Record<string, string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'application/pdf': ['pdf'] };

/** Deteksi tipe file dari isi (magic bytes) — tidak percaya ekstensi / MIME dari browser. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}
const slug = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function evidenceTarget(userId: string, entityType: string, entityId: string, write: boolean) {
  if (entityType === 'CASH_DRAWER_LINE') {
    const r = await query(
      `SELECT d.workspace_id,d.company_id,d.location_id,d.status,d.business_date::text business_date,d.shift_label,dl.cash_drawer_id,pm.code method_code,pml.pos_payment_code
         FROM cash_drawer_lines dl JOIN cash_drawers d ON d.id=dl.cash_drawer_id JOIN payment_methods pm ON pm.id=dl.payment_method_id
         LEFT JOIN payment_method_locations pml ON pml.payment_method_id=pm.id AND pml.location_id=d.location_id
        WHERE dl.id=$1`, [entityId]);
    const t = r.rows[0]; if (!t) return { error: 'EVIDENCE_TARGET_NOT_FOUND', status: 404 };
    const ok = (write ? await canWriteCashDrawer(userId, t.company_id) : await canReadCashDrawer(userId, t.company_id)) && await canAccessLocation(userId, t.location_id);
    if (!ok) return { error: 'LOCATION_FORBIDDEN', status: 403 };
    if (write && t.status === 'LOCKED') return { error: 'CASH_DRAWER_LOCKED', status: 409 };
    // company / outlet / cash-drawer / tanggal / shift / metode / baris
    const prefix = [t.workspace_id, t.company_id, t.location_id, 'cash-drawer', String(t.business_date).slice(0, 10), slug(t.shift_label) || 'harian',
      t.cash_drawer_id, slug(t.pos_payment_code || t.method_code) || 'metode', entityId].join('/');
    return { workspaceId: t.workspace_id, types: IMAGE_TYPES, prefix, audit: { type: 'CASH_DRAWER', id: t.cash_drawer_id } };
  }
  if (entityType === 'SALES_RECON_RESOLUTION') {
    const r = await query(`SELECT sr.workspace_id,sr.company_id,sr.location_id,sr.status,sr.business_date::text business_date,sr.id reconciliation_id
      FROM sales_reconciliation_resolutions x JOIN sales_reconciliations sr ON sr.id=x.reconciliation_id WHERE x.id=$1`, [entityId]);
    const t = r.rows[0]; if (!t) return { error: 'EVIDENCE_TARGET_NOT_FOUND', status: 404 };
    const ok = (write ? await canVerifyTransaction(userId, t.company_id) : await canReadFinanceCompany(userId, t.company_id)) && await canAccessLocation(userId, t.location_id);
    if (!ok) return { error: 'FORBIDDEN', status: 403 };
    if (write && t.status === 'VERIFIED') return { error: 'RECONCILIATION_ALREADY_VERIFIED', status: 409 };
    const prefix = [t.workspace_id, t.company_id, t.location_id, 'sales-reconciliation', String(t.business_date).slice(0, 10), t.reconciliation_id, 'resolution', entityId].join('/');
    return { workspaceId: t.workspace_id, types: DOC_TYPES, prefix, audit: { type: 'SALES_RECONCILIATION', id: t.reconciliation_id } };
  }
  if (entityType === 'SALES_SETTLEMENT') {
    const r = await query(`SELECT workspace_id,company_id,location_id,transaction_date::text transaction_date FROM transaction_headers WHERE id=$1 AND transaction_type='SALES_SETTLEMENT'`, [entityId]);
    const t = r.rows[0]; if (!t) return { error: 'EVIDENCE_TARGET_NOT_FOUND', status: 404 };
    const ok = (write ? await canCreateFinanceTransaction(userId, t.company_id) : await canReadFinanceCompany(userId, t.company_id))
      && (!t.location_id || await canAccessLocation(userId, t.location_id));
    if (!ok) return { error: 'FORBIDDEN', status: 403 };
    const prefix = [t.workspace_id, t.company_id, t.location_id || 'multi-outlet', 'sales-settlement', String(t.transaction_date).slice(0, 10), entityId].join('/');
    return { workspaceId: t.workspace_id, types: DOC_TYPES, prefix, audit: { type: 'TRANSACTION', id: entityId }, storeAs: 'TRANSACTION' };
  }
  return { error: 'INVALID_EVIDENCE_TARGET', status: 400 };
}

salesFlowRouter.post('/evidence', async (req, res) => {
  const entityType = text(req.body?.entityType); const entityId = text(req.body?.entityId);
  if (!entityType || !entityId) return res.status(400).json({ error: 'INVALID_EVIDENCE_TARGET' });
  const target: any = await evidenceTarget(uid(req), entityType, entityId, true);
  if (target.error) return res.status(target.status).json({ error: target.error });
  const typeError = target.types === IMAGE_TYPES ? 'EVIDENCE_IMAGE_ONLY' : 'EVIDENCE_INVALID_TYPE';
  const fileName = path.basename(text(req.body?.fileName)) || 'bukti';
  const declared = text(req.body?.mimeType).toLowerCase();
  const data = text(req.body?.dataBase64).replace(/^data:[^;]+;base64,/, '');
  if (!data) return res.status(400).json({ error: 'EVIDENCE_FILE_REQUIRED' });
  // Batas ukuran dicek dari panjang base64 dulu (hindari decode file raksasa), lalu dari buffer asli.
  if (Math.floor(data.length * 3 / 4) > MAX_EVIDENCE + 3) return res.status(400).json({ error: 'EVIDENCE_MAX_7MB' });
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) return res.status(400).json({ error: 'EVIDENCE_FILE_REQUIRED' });
  if (buffer.length > MAX_EVIDENCE) return res.status(400).json({ error: 'EVIDENCE_MAX_7MB' });
  // Validasi server: tipe dari isi file (magic bytes) wajib diizinkan DAN sama dengan MIME yang dideklarasikan; ekstensi harus cocok.
  const sniffed = sniffMime(buffer);
  if (!sniffed || !target.types.has(sniffed)) return res.status(400).json({ error: typeError });
  if (declared && declared !== sniffed && !(declared === 'image/jpg' && sniffed === 'image/jpeg')) return res.status(400).json({ error: 'EVIDENCE_TYPE_MISMATCH' });
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (fileName.includes('.') && !EXT_BY_MIME[sniffed].includes(ext)) return res.status(400).json({ error: 'EVIDENCE_TYPE_MISMATCH' });
  const storedEntity = target.storeAs || entityType;
  const safeName = fileName.includes('.') ? fileName.replace(/[^a-zA-Z0-9._-]+/g, '_') : `${fileName.replace(/[^a-zA-Z0-9._-]+/g, '_')}.${EXT_BY_MIME[sniffed][0]}`;
  const key = `${target.prefix}/${crypto.randomUUID()}-${safeName}`;
  try { await storage.put(key, buffer, sniffed); } catch (err) { console.error('[evidence] upload gagal', err); return res.status(502).json({ error: 'ATTACHMENT_STORAGE_UNAVAILABLE' }); }
  const prev = await query(`SELECT COUNT(*) n FROM attachments WHERE entity_type=$1 AND entity_id=$2`, [storedEntity, entityId]);
  const ins = await query(
    `INSERT INTO attachments(workspace_id,entity_type,entity_id,file_name,storage_path,mime_type,file_size,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,file_name,mime_type,file_size,uploaded_at`, [target.workspaceId, storedEntity, entityId, safeName, key, sniffed, buffer.length, uid(req)]);
  // Penggantian bukti tidak menghapus file lama (histori tetap) — tercatat REPLACE_EVIDENCE di audit trail.
  await query(
    `INSERT INTO audit_logs(workspace_id,user_id,entity_type,entity_id,action,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [target.workspaceId, uid(req), target.audit.type, target.audit.id, Number(prev.rows[0]?.n || 0) ? 'REPLACE_EVIDENCE' : 'ADD_EVIDENCE',
     JSON.stringify({ entityType, entityId, attachmentId: ins.rows[0]?.id, fileName: safeName, mimeType: sniffed, size: buffer.length, previousCount: Number(prev.rows[0]?.n || 0) })]);
  res.status(201).json(ins.rows[0]);
});

salesFlowRouter.get('/evidence/:id', async (req, res) => {
  const a = await query(`SELECT entity_type,entity_id,storage_path,mime_type,file_name FROM attachments WHERE id=$1`, [text(req.params.id)]);
  const att = a.rows[0]; if (!att) return res.status(404).json({ error: 'EVIDENCE_NOT_FOUND' });
  const type = att.entity_type === 'TRANSACTION' ? 'SALES_SETTLEMENT' : att.entity_type;
  const target: any = await evidenceTarget(uid(req), type, att.entity_id, false);
  if (target.error) return res.status(target.status).json({ error: target.error });
  try {
    const obj = await storage.get(att.storage_path);
    res.setHeader('Content-Type', att.mime_type || obj.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(att.file_name).replace(/"/g, '')}"`);
    obj.body.pipe(res);
  } catch { res.status(404).json({ error: 'EVIDENCE_FILE_MISSING' }); }
});

// =============================================================================================
// Rekonsiliasi & Verifikasi Penjualan
// =============================================================================================
async function reconScope(req: any, res: any, companyId: string, locationId: string, write: boolean) {
  if (!companyId) { res.status(400).json({ error: 'COMPANY_REQUIRED' }); return false; }
  const ok = write ? await canVerifyTransaction(uid(req), companyId) : await canReadFinanceCompany(uid(req), companyId);
  if (!ok) { res.status(403).json({ error: write ? 'FINANCE_VERIFY_ROLE_REQUIRED' : 'FORBIDDEN_COMPANY' }); return false; }
  if (locationId && !(await canAccessLocation(uid(req), locationId))) { res.status(403).json({ error: 'LOCATION_FORBIDDEN' }); return false; }
  return true;
}

/** Daftar outlet x tanggal (14 hari default) dengan status ringkas. */
salesFlowRouter.get('/reconciliations', async (req, res) => {
  const companyId = text(req.query.companyId); const locationId = text(req.query.locationId);
  if (!(await reconScope(req, res, companyId, locationId, false))) return;
  const to = isDate(text(req.query.to)) ? text(req.query.to) : new Date().toISOString().slice(0, 10);
  const from = isDate(text(req.query.from)) ? text(req.query.from) : new Date(Date.parse(to) - 30 * 86400000).toISOString().slice(0, 10);
  const keys = await query(
    `SELECT DISTINCT x.location_id,x.d FROM (
       SELECT b.location_id,r.sale_date d FROM sales_import_batches b JOIN sales_import_rows r ON r.batch_id=b.id WHERE b.company_id=$1 AND b.status='DRAFT'
       UNION SELECT location_id,business_date FROM cash_drawers WHERE company_id=$1
       UNION SELECT location_id,business_date FROM sales_reconciliations WHERE company_id=$1
     ) x JOIN locations l ON l.id=x.location_id
     WHERE ($2='' OR x.location_id=$2) AND x.d BETWEEN $3::date AND $4::date
     ORDER BY x.d DESC LIMIT 120`, [companyId, locationId, from, to]);
  const rows = [];
  for (const k of keys.rows) {
    if (!(await canAccessLocation(uid(req), k.location_id))) continue;
    const date = k.d instanceof Date ? k.d.toISOString().slice(0, 10) : String(k.d).slice(0, 10);
    const r = await computeReconciliation({ query } as any, companyId, k.location_id, date);
    rows.push({ location_id: k.location_id, location_name: r.location.name, date, status: r.status, status_label: r.status_label, totals: r.totals,
      reconciliation_number: r.header?.reconciliation_number || null, can_verify: r.can_verify, blocker_count: r.blockers.length });
  }
  res.json({ from, to, rows });
});

salesFlowRouter.get('/reconciliations/detail', async (req, res) => {
  const companyId = text(req.query.companyId); const locationId = text(req.query.locationId); const date = text(req.query.date);
  if (!locationId || !isDate(date)) return res.status(400).json({ error: 'LOCATION_DATE_REQUIRED' });
  if (!(await reconScope(req, res, companyId, locationId, false))) return;
  try { res.json({ ...publicRecon(await computeReconciliation({ query } as any, companyId, locationId, date)), reasons: REASONS }); }
  catch (e) { fail(res, e, 'RECONCILIATION_FAILED'); }
});

salesFlowRouter.post('/reconciliations/resolve', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId); const locationId = text(b.locationId); const date = text(b.date);
  if (!locationId || !isDate(date)) return res.status(400).json({ error: 'LOCATION_DATE_REQUIRED' });
  if (!(await reconScope(req, res, companyId, locationId, true))) return;
  if (!text(b.notes) && text(b.reasonCode) === 'LAINNYA') return res.status(400).json({ error: 'RESOLUTION_NOTES_REQUIRED' });
  try { res.status(201).json(await resolveDifference(companyId, locationId, date, text(b.paymentMethodId), text(b.reasonCode), text(b.notes), uid(req))); }
  catch (e) { fail(res, e, 'RESOLVE_FAILED'); }
});

salesFlowRouter.post('/reconciliations/verify', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId); const locationId = text(b.locationId); const date = text(b.date);
  if (!locationId || !isDate(date)) return res.status(400).json({ error: 'LOCATION_DATE_REQUIRED' });
  if (!(await reconScope(req, res, companyId, locationId, true))) return;
  const allowBelowZero = Boolean(b.allowBelowZero);
  if (allowBelowZero && !(await canCreateFinanceTransaction(uid(req), companyId))) return res.status(403).json({ error: 'INVENTORY_OVERRIDE_MANAGER_REQUIRED' });
  try { res.json({ ok: true, ...(await verifyReconciliation(companyId, locationId, date, uid(req), allowBelowZero)) }); }
  catch (e) { fail(res, e, 'VERIFY_SALES_FAILED'); }
});

/**
 * Reopen setelah Finance Verified — HANYA Accounting Control, alasan wajib, audit trail.
 * Diblokir bila masih ada settlement aktif (batalkan settlement dulu). Setelah reopen wajib Verifikasi Penjualan ulang.
 */
salesFlowRouter.post('/reconciliations/reopen', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId); const locationId = text(b.locationId); const date = text(b.date); const reason = text(b.reason);
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'REOPEN_ACCOUNTING_ONLY' });
  if (!locationId || !isDate(date)) return res.status(400).json({ error: 'LOCATION_DATE_REQUIRED' });
  if (reason.length < 5) return res.status(400).json({ error: 'REOPEN_REASON_REQUIRED' });
  const loc = await query(`SELECT 1 FROM locations WHERE id=$1 AND company_id=$2`, [locationId, companyId]);
  if (!loc.rowCount) return res.status(400).json({ error: 'LOCATION_OUTSIDE_COMPANY' });
  if (!(await canAccessLocation(uid(req), locationId))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try { res.json({ ok: true, ...(await reopenReconciliation(companyId, locationId, date, reason, uid(req))) }); }
  catch (e) { fail(res, e, 'REOPEN_FAILED'); }
});

salesFlowRouter.get('/reconciliations/history', async (req, res) => {
  const companyId = text(req.query.companyId); const locationId = text(req.query.locationId); const date = text(req.query.date);
  if (!locationId || !isDate(date)) return res.status(400).json({ error: 'LOCATION_DATE_REQUIRED' });
  if (!(await reconScope(req, res, companyId, locationId, false))) return;
  const h = await query(`SELECT id FROM sales_reconciliations WHERE company_id=$1 AND location_id=$2 AND business_date=$3::date`, [companyId, locationId, date]);
  if (!h.rowCount) return res.json([]);
  const r = await query(
    `SELECT a.action,a.after_data,a.created_at,u.full_name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity_type='SALES_RECONCILIATION' AND a.entity_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [h.rows[0].id]);
  res.json(r.rows);
});

// =============================================================================================
// Settlement
// =============================================================================================
salesFlowRouter.get('/settlements/outstanding', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!(await reconScope(req, res, companyId, '', false))) return;
  const rows = await outstandingSettlements({ query } as any, companyId, { paymentMethodId: text(req.query.paymentMethodId), locationId: text(req.query.locationId) });
  const visible = [];
  for (const r of rows) if (await canAccessLocation(uid(req), r.location_id)) visible.push(r);
  res.json(visible);
});

salesFlowRouter.get('/settlements', async (req, res) => {
  const companyId = text(req.query.companyId);
  if (!(await reconScope(req, res, companyId, '', false))) return;
  const r = await query(
    `SELECT t.id,t.transaction_number,t.transaction_date::text transaction_date,t.reference_number,t.gross_amount::text gross_amount,t.grand_total::text net_amount,
            t.source_module,t.source_name,t.accounting_status,fa.name financial_account_name,l.name location_name,
            (SELECT tl.line_total FROM transaction_lines tl WHERE tl.transaction_id=t.id AND JSON_VALUE(tl.metadata,'$.kind')='FEE' LIMIT 1) fee_amount,
            (SELECT tl.line_total FROM transaction_lines tl WHERE tl.transaction_id=t.id AND JSON_VALUE(tl.metadata,'$.kind')='DIFFERENCE' LIMIT 1) difference_amount,
            (SELECT COUNT(*) FROM attachments a WHERE a.entity_type='TRANSACTION' AND a.entity_id=t.id) attachment_count,
            t.workflow_status,t.location_id,
            (SELECT GROUP_CONCAT(CONCAT(srl.business_date,' ',srl.method_name) SEPARATOR ', ') FROM sales_settlement_allocations sa
               JOIN sales_reconciliation_lines srl ON srl.id=sa.reconciliation_line_id WHERE sa.settlement_transaction_id=t.id) allocation_summary
       FROM transaction_headers t LEFT JOIN financial_accounts fa ON fa.id=t.financial_account_id LEFT JOIN locations l ON l.id=t.location_id
      WHERE t.company_id=$1 AND t.transaction_type='SALES_SETTLEMENT' ORDER BY t.transaction_date DESC,t.created_at DESC LIMIT 200`, [companyId]);
  const visible = [];
  for (const x of r.rows) if (!x.location_id || await canAccessLocation(uid(req), x.location_id)) visible.push({ ...x, attachment_count: Number(x.attachment_count || 0) });
  res.json(visible);
});

/** Batal settlement terkontrol — HANYA Accounting Control, alasan wajib. Histori tetap (CANCELLED + jurnal VOID/REVERSAL). */
salesFlowRouter.post('/settlements/:id/cancel', async (req, res) => {
  const companyId = text(req.body?.companyId); const reason = text(req.body?.reason);
  if (!companyId || !(await canAccessAccountingCompany(uid(req), companyId))) return res.status(403).json({ error: 'CANCEL_SETTLEMENT_ACCOUNTING_ONLY' });
  if (reason.length < 5) return res.status(400).json({ error: 'CANCEL_REASON_REQUIRED' });
  const st = await query(`SELECT location_id FROM transaction_headers WHERE id=$1 AND company_id=$2 AND transaction_type='SALES_SETTLEMENT'`, [text(req.params.id), companyId]);
  if (!st.rowCount) return res.status(404).json({ error: 'SETTLEMENT_NOT_FOUND' });
  if (st.rows[0].location_id && !(await canAccessLocation(uid(req), st.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  try { res.json({ ok: true, ...(await cancelSettlement(companyId, text(req.params.id), reason, uid(req))) }); }
  catch (e) { fail(res, e, 'CANCEL_SETTLEMENT_FAILED'); }
});

salesFlowRouter.post('/settlements', async (req, res) => {
  const b = req.body || {};
  const companyId = text(b.companyId);
  if (!companyId || !(await canCreateFinanceTransaction(uid(req), companyId))) return res.status(403).json({ error: 'FORBIDDEN' });
  const date = text(b.settlementDate);
  if (!isDate(date) || !text(b.financialAccountId)) return res.status(400).json({ error: 'SETTLEMENT_FIELDS_REQUIRED' });
  const allocations = (Array.isArray(b.allocations) ? b.allocations : []).map((a: any) => ({ lineId: text(a.lineId), grossAmount: Number(a.grossAmount || 0) }));
  for (const a of allocations) {
    const loc = await query(`SELECT location_id FROM sales_reconciliation_lines WHERE id=$1`, [a.lineId]);
    if (loc.rows[0] && !(await canAccessLocation(uid(req), loc.rows[0].location_id))) return res.status(403).json({ error: 'LOCATION_FORBIDDEN' });
  }
  try {
    res.status(201).json(await recordSettlement({
      companyId, financialAccountId: text(b.financialAccountId), settlementDate: date, reference: text(b.reference), notes: text(b.notes),
      netAmount: Number(b.netAmount || 0), feeAmount: Number(b.feeAmount || 0), acceptDifference: Boolean(b.acceptDifference), allocations,
    }, uid(req)));
  } catch (e) { fail(res, e, 'SETTLEMENT_FAILED'); }
});
