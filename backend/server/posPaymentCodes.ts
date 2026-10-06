/**
 * Registry kode pembayaran POS (tabel pos_payment_codes, migration 006).
 * Menambah metode pembayaran POS baru = menambah 1 baris registry (alias header/nilai, tipe, modul settlement);
 * tidak perlu mengubah parser, constraint DB, atau engine. Kode dengan legacy_column disimpan di kolom lama
 * sales_import_rows.payment_*; kode lain disimpan di sales_import_rows.payment_extra (JSON).
 */
import { query } from './db.js';

export type PosPaymentCode = {
  code: string; label: string; aliases: string[]; method_type: string; include_in_reconciliation: boolean;
  settlement_module: string; legacy_column: string | null; sort_order: number; status: string;
};

let cache: { at: number; rows: PosPaymentCode[] } | null = null;

export async function loadPosCodes(exec?: { query: typeof query }, includeInactive = false): Promise<PosPaymentCode[]> {
  if (!cache || Date.now() - cache.at > 30_000) {
    const r = await (exec?.query || query)<any>(
      `SELECT code,label,aliases,method_type,include_in_reconciliation,settlement_module,legacy_column,sort_order,status FROM pos_payment_codes ORDER BY sort_order,code`);
    cache = {
      at: Date.now(),
      rows: r.rows.map((x: any) => ({
        ...x, include_in_reconciliation: Boolean(Number(x.include_in_reconciliation)), sort_order: Number(x.sort_order || 0),
        aliases: String(x.aliases || '').split(',').map((a: string) => a.trim().toUpperCase()).filter(Boolean),
      })),
    };
  }
  return includeInactive ? cache.rows : cache.rows.filter(c => c.status === 'ACTIVE');
}

export function invalidatePosCodes() { cache = null; }

/** Nilai pembayaran baris import untuk satu kode: kolom lama atau payment_extra JSON. */
export function rowPaymentValue(row: Record<string, any>, code: PosPaymentCode) {
  if (code.legacy_column && row[code.legacy_column] !== undefined) return row[code.legacy_column];
  if (!row.payment_extra) return '0';
  try {
    const extra = typeof row.payment_extra === 'string' ? JSON.parse(row.payment_extra) : row.payment_extra;
    return extra?.[code.code] ?? '0';
  } catch { return '0'; }
}
