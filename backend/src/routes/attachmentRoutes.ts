import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { one, query } from '../db.js';
import { requireAuth } from '../auth.js';
import { canAccessUnit, hasPermission, requirePermission } from '../permissions.js';
import { writeAudit } from '../audit.js';
import { text, upper } from '../http.js';

/**
 * Lampiran dokumen — dipakai semua transaksi (pengajuan pembelian, MCM, tagihan,
 * penerimaan, pembayaran, jurnal).
 *
 * Upload memakai JSON base64 agar tidak perlu dependensi multipart:
 *   POST /api/v1/attachments
 *   { entityType, entityId, files: [{ name, mimeType, dataBase64 }] }
 */
export const attachmentRouter = Router();
attachmentRouter.use(requireAuth);

const MAX_FILES = 10;
const MAX_BYTES = 5 * 1024 * 1024;

const ENTITY_TABLE: Record<string, { table: string; unitColumn: string | null }> = {
  EXPENSE_REQUEST: { table: 'expense_requests', unitColumn: 'unit_id' },
  PAYMENT_REQUEST: { table: 'payment_requests', unitColumn: 'unit_id' },
  INVOICE: { table: 'invoices', unitColumn: 'unit_id' },
  RECEIPT: { table: 'receipts', unitColumn: 'unit_id' },
  EXPENSE_PAYMENT: { table: 'expense_payments', unitColumn: 'unit_id' },
  JOURNAL: { table: 'journal_entries', unitColumn: null },
};

async function targetOf(entityType: string, entityId: string) {
  const config = ENTITY_TABLE[entityType];
  if (!config) return null;
  const select = config.unitColumn ? `id,legal_entity_id,${config.unitColumn} unit_id` : 'id,legal_entity_id';
  const row = await one<any>(`SELECT ${select} FROM ${config.table} WHERE id=?`, [entityId]);
  return row ? { ...row, unitColumn: config.unitColumn } : null;
}

attachmentRouter.get('/attachments', requireAuth, async (req, res) => {
  const entityType = upper(req.query.entityType);
  const entityId = text(req.query.entityId);
  if (!ENTITY_TABLE[entityType] || !entityId) return res.status(400).json({ error: 'ATTACHMENT_TARGET_INVALID' });
  const target = await targetOf(entityType, entityId);
  if (!target) return res.status(404).json({ error: 'ATTACHMENT_TARGET_NOT_FOUND' });
  if (target.unitColumn && !(await canAccessUnit(req.user!, target.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }
  res.json(await query(
    `SELECT a.id,a.file_name,a.mime_type,a.size_bytes,a.created_at,u.full_name uploaded_by_name
       FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by
      WHERE a.entity_type=? AND a.entity_id=? ORDER BY a.created_at`,
    [entityType, entityId],
  ));
});

attachmentRouter.post('/attachments', requirePermission('attachment.upload'), async (req, res) => {
  const entityType = upper(req.body?.entityType);
  const entityId = text(req.body?.entityId);
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!ENTITY_TABLE[entityType] || !entityId) return res.status(400).json({ error: 'ATTACHMENT_TARGET_INVALID' });
  if (files.length === 0) return res.status(400).json({ error: 'ATTACHMENT_FILES_REQUIRED' });
  if (files.length > MAX_FILES) return res.status(400).json({ error: 'ATTACHMENT_TOO_MANY_FILES' });

  const target = await targetOf(entityType, entityId);
  if (!target) return res.status(404).json({ error: 'ATTACHMENT_TARGET_NOT_FOUND' });
  if (target.unitColumn && !(await canAccessUnit(req.user!, target.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }

  const prepared: { name: string; mime: string; buffer: Buffer }[] = [];
  for (const file of files) {
    const name = text(file?.name).slice(0, 200);
    const mime = (text(file?.mimeType) || 'application/octet-stream').slice(0, 120);
    const raw = typeof file?.dataBase64 === 'string' ? file.dataBase64 : '';
    if (!name || !raw) return res.status(400).json({ error: 'ATTACHMENT_FILE_INVALID', file: name || null });
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'ATTACHMENT_FILE_INVALID', file: name });
    if (buffer.length > MAX_BYTES) return res.status(400).json({ error: 'ATTACHMENT_FILE_TOO_LARGE', file: name });
    prepared.push({ name, mime, buffer });
  }

  const created: string[] = [];
  for (const file of prepared) {
    const id = randomUUID();
    await query(
      `INSERT INTO attachments(id,legal_entity_id,entity_type,entity_id,file_name,mime_type,size_bytes,content,uploaded_by)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [id, target.legal_entity_id, entityType, entityId, file.name, file.mime, file.buffer.length, file.buffer, req.user!.id],
    );
    created.push(id);
  }

  await writeAudit({
    legalEntityId: target.legal_entity_id, unitId: target.unit_id || null, userId: req.user!.id, ip: req.ip || null,
    action: 'ATTACHMENT_UPLOAD', entityType, entityId,
    after: { files: prepared.map(file => ({ name: file.name, size: file.buffer.length })) },
  });
  res.status(201).json({ ok: true, count: created.length, ids: created });
});

attachmentRouter.get('/attachments/:id/download', requireAuth, async (req, res) => {
  const row = await one<any>(
    'SELECT a.*, e.id entity_exists FROM attachments a JOIN legal_entities e ON e.id=a.legal_entity_id WHERE a.id=?',
    [text(req.params.id)],
  );
  if (!row) return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
  const target = await targetOf(row.entity_type, row.entity_id);
  if (target && target.unitColumn && !(await canAccessUnit(req.user!, target.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name).replace(/"/g, '')}"`);
  res.setHeader('Content-Length', String(row.size_bytes));
  res.end(row.content);
});

attachmentRouter.delete('/attachments/:id', requireAuth, async (req, res) => {
  const row = await one<any>('SELECT * FROM attachments WHERE id=?', [text(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
  const target = await targetOf(row.entity_type, row.entity_id);
  if (target && target.unitColumn && !(await canAccessUnit(req.user!, target.unit_id))) {
    return res.status(403).json({ error: 'UNIT_FORBIDDEN' });
  }
  const canDelete = hasPermission(req.user!.role, 'transaction.delete') || row.uploaded_by === req.user!.id;
  if (!canDelete) return res.status(403).json({ error: 'PERMISSION_DENIED', permission: 'transaction.delete' });

  await query('DELETE FROM attachments WHERE id=?', [row.id]);
  await writeAudit({
    legalEntityId: row.legal_entity_id, unitId: target?.unit_id || null, userId: req.user!.id, ip: req.ip || null,
    action: 'ATTACHMENT_DELETE', entityType: row.entity_type, entityId: row.entity_id,
    before: { file_name: row.file_name, size: row.size_bytes },
  });
  res.json({ ok: true });
});
