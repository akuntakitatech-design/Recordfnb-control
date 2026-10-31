/**
 * Rate limiter sederhana berbasis memori untuk percobaan login gagal.
 *
 * Hanya kegagalan yang dihitung, sehingga login yang berhasil berulang
 * (mis. skrip UAT) tidak pernah terkena limit.
 *
 * Catatan: penghitung bersifat per-proses. Untuk deployment multi-instance,
 * gunakan penyimpanan bersama (Redis) atau rate limit di reverse proxy.
 */
type Bucket = { failures: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, SWEEP_INTERVAL_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

/** Sisa detik sampai percobaan berikutnya diizinkan; 0 = tidak diblokir. */
export function blockedFor(key: string, limit: number): number {
  const bucket = buckets.get(key);
  if (!bucket) return 0;
  if (bucket.resetAt <= Date.now()) {
    buckets.delete(key);
    return 0;
  }
  return bucket.failures >= limit ? Math.ceil((bucket.resetAt - Date.now()) / 1000) : 0;
}

export function recordFailure(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { failures: 1, resetAt: now + windowMs });
    return;
  }
  bucket.failures = Math.min(limit + 1, bucket.failures + 1);
}

export function clearFailures(key: string): void {
  buckets.delete(key);
}

export function loginLimitKey(ip: string, email: string): string {
  return `login:${ip}:${email.toLowerCase()}`;
}

export const LOGIN_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
