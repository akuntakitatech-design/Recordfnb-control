/** Helper validasi/normalisasi input agar route tetap ramping. */

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function nullableText(value: unknown): string | null {
  const s = text(value);
  return s ? s : null;
}

export function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : NaN;
}

export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function upper(value: unknown): string {
  return text(value).toUpperCase();
}

export type Paging = { page: number; pageSize: number; offset: number };

export function paging(queryPage: unknown, querySize: unknown): Paging {
  const rawPage = Math.floor(toNumber(queryPage));
  const rawSize = Math.floor(toNumber(querySize));
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Number.isFinite(rawSize) ? Math.min(100, Math.max(10, rawSize)) : 25;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/* ------------------------------------------------------------------ Uang & tanggal (BILL-01) */

/** Nilai uang disimpan sebagai integer sen agar penjumlahan/pembagian deterministik. */
export function toCents(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(parsed)) return NaN;
  return Math.round(parsed * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Tambah bulan dengan pengaman akhir bulan (31 Jan + 1 bulan = 28/29 Feb). */
export function addMonths(dateOnly: string, months: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
