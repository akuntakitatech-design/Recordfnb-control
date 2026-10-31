import { exec } from './db.js';

export type AuditEntry = {
  legalEntityId?: string | null;
  unitId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
};

/** Catat jejak audit terstruktur (before/after JSON). */
export async function writeAudit(entry: AuditEntry) {
  await exec(
    `INSERT INTO audit_logs(legal_entity_id,unit_id,user_id,action,entity_type,entity_id,before_data,after_data,reason,ip)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      entry.legalEntityId ?? null,
      entry.unitId ?? null,
      entry.userId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      entry.ip ?? null,
    ],
  );
}

export function parseAuditRow(row: any) {
  return {
    ...row,
    before_data: parseJson(row.before_data),
    after_data: parseJson(row.after_data),
  };
}

function parseJson(value: unknown) {
  if (typeof value !== 'string' || !value) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
