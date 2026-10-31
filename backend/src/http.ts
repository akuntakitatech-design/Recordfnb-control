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
