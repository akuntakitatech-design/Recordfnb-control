// Helper bersama Phase 2 (Cash Drawer, Rekonsiliasi, Settlement, Metode Pembayaran). Bahasa operasional, tanpa istilah COA.
import { api } from './api';
export { rupiah, today, qs } from './cashBankShared';

export type Company = { id: string; workspace_id: string; name: string };
export type Location = { id: string; company_id: string; name: string };

export async function loadOrg() {
  const [companies, locations] = await Promise.all([api<Company[]>('/api/master/companies'), api<Location[]>('/api/master/locations')]);
  return { companies, locations };
}

export const statusTone: Record<string, string> = {
  BELUM_ADA_DATA: 'muted', MENUNGGU_POS: 'warn', MENUNGGU_CASH_DRAWER: 'warn', ADA_SELISIH: 'bad', SELISIH_DISELESAIKAN: 'info',
  COCOK: 'good', FINANCE_VERIFIED: 'good', MENUNGGU_SETTLEMENT: 'info', SETTLED: 'good', OUTSTANDING: 'warn', PARTIAL: 'info', NOT_REQUIRED: 'muted',
};
export const settlementLabel: Record<string, string> = { OUTSTANDING: 'Belum diterima', PARTIAL: 'Diterima sebagian', SETTLED: 'Lunas', NOT_REQUIRED: '—' };
export const destinationLabel: Record<string, string> = { CASH_DIRECT: 'Langsung ke Kas', BANK_DIRECT: 'Langsung ke Bank', SETTLEMENT: 'Settlement (uang masuk belakangan)' };

export function flowError(raw: unknown): string {
  const code = raw instanceof Error ? raw.message : String(raw || '');
  const fixed: Record<string, string> = {
    CASH_DRAWER_LOCKED: 'Cash Drawer tanggal ini sudah terkunci karena penjualan sudah diverifikasi Finance.',
    CASH_DRAWER_OUTLET_ONLY: 'Cash Drawer diisi oleh outlet. Finance hanya dapat melihat dan mereview.',
    LOCATION_FORBIDDEN: 'Anda tidak memiliki akses ke outlet ini.',
    PAYMENT_METHODS_NOT_CONFIGURED: 'Metode pembayaran outlet belum diatur Accounting.',
    EVIDENCE_MAX_7MB: 'Ukuran bukti maksimal 7 MB.', EVIDENCE_IMAGE_ONLY: 'Bukti harus berupa foto JPG / PNG / WEBP.',
    EVIDENCE_TYPE_MISMATCH: 'Isi file tidak sesuai dengan format/ekstensinya. Gunakan foto JPG / PNG / WEBP asli.',
    EVIDENCE_INVALID_TYPE: 'Lampiran harus berupa foto JPG / PNG / WEBP atau PDF.', EVIDENCE_FILE_REQUIRED: 'File bukti kosong / tidak terbaca.',
    RECONCILIATION_ALREADY_VERIFIED: 'Penjualan tanggal ini sudah diverifikasi.',
    REOPEN_ACCOUNTING_ONLY: 'Reopen hanya dapat dilakukan Accounting Control.', REOPEN_REASON_REQUIRED: 'Alasan reopen wajib diisi (min. 5 karakter).',
    REOPEN_BLOCKED_ACTIVE_SETTLEMENT: 'Sudah ada settlement untuk penjualan ini. Batalkan settlement terlebih dahulu (menu Settlement), lalu reopen.',
    REOPEN_ONLY_VERIFIED: 'Hanya penjualan yang sudah diverifikasi yang dapat dibuka kembali.',
    CANCEL_SETTLEMENT_ACCOUNTING_ONLY: 'Pembatalan settlement hanya oleh Accounting.', CANCEL_REASON_REQUIRED: 'Alasan pembatalan wajib diisi (min. 5 karakter).',
    SETTLEMENT_ALREADY_CANCELLED: 'Settlement ini sudah dibatalkan.', PAYMENT_METHOD_ACCOUNTING_ONLY: 'Master metode pembayaran hanya dapat diubah Accounting.',
    POS_CODE_ALREADY_EXISTS: 'Kode POS sudah ada di registry.', POS_CODE_FIELDS_REQUIRED: 'Kode (2–32 huruf/angka) dan label wajib diisi.',
    INVALID_MAPPING_ACCOUNT: 'Akun tidak valid / tidak aktif.', SALES_VERIFY_VIA_RECONCILIATION: 'Outlet ini memakai Rekonsiliasi Penjualan. Verifikasi dari menu Rekonsiliasi Penjualan.',
    DUPLICATE_POS_IMPORT: 'Invoice POS ini sudah pernah diimport untuk outlet & tanggal yang sama.', SALES_DATE_ALREADY_VERIFIED: 'Tanggal ini sudah diverifikasi. Minta Accounting reopen bila perlu koreksi.',
    INVENTORY_SHORTAGE_CONFIRMATION_REQUIRED: 'Stok akan minus. Finance Manager perlu mengizinkan stok minus.',
    POS_CODE_ALREADY_MAPPED_AT_LOCATION: 'Outlet tersebut sudah punya metode untuk kode POS ini.',
    ACCOUNTING_MAPPING_ONLY: 'Mapping akun hanya dapat diatur Accounting.',
    DESTINATION_ACCOUNT_REQUIRED: 'Pilih rekening Kas/Bank tujuan.', CASH_DESTINATION_MUST_BE_CASH: 'Tujuan "Langsung ke Kas" harus rekening Kas.',
    BANK_DESTINATION_MUST_BE_BANK: 'Tujuan "Langsung ke Bank" harus rekening Bank.', PAYMENT_METHOD_LOCATION_REQUIRED: 'Pilih minimal satu outlet.',
    PAYMENT_METHOD_FIELDS_REQUIRED: 'Nama, kode POS dan tujuan uang wajib diisi.',
    SETTLEMENT_SINGLE_METHOD_REQUIRED: 'Satu penerimaan settlement hanya untuk satu metode pembayaran.',
    SETTLEMENT_SINGLE_OUTLET_REQUIRED: 'Satu penerimaan settlement hanya untuk satu outlet.',
    SETTLEMENT_AMOUNT_INVALID: 'Isi nominal diterima bank dan/atau MDR.', SETTLEMENT_BANK_ACCOUNT_REQUIRED: 'Pilih rekening bank penerima.',
    SETTLEMENT_FIELDS_REQUIRED: 'Tanggal dan rekening bank penerima wajib diisi.', RESOLUTION_NOTES_REQUIRED: 'Isi catatan untuk alasan lain.',
    FINANCE_VERIFY_ROLE_REQUIRED: 'Anda tidak memiliki hak Verifikasi Penjualan.', ACCOUNTING_PERIOD_SOFT_CLOSED: 'Periode sudah SOFT CLOSE.',
    ACCOUNTING_PERIOD_HARD_CLOSED: 'Periode sudah HARD CLOSE.', OWNER_READ_ONLY: 'Owner hanya dapat melihat.',
  };
  if (fixed[code]) return fixed[code];
  let m = code.match(/^RECONCILIATION_NOT_READY:(.*)$/); if (m) return `Belum bisa diverifikasi: ${m[1]}`;
  m = code.match(/^SETTLEMENT_DIFFERENCE_CONFIRMATION_REQUIRED:(.*)$/); if (m) return `Ada selisih settlement Rp${Number(m[1]).toLocaleString('id-ID')}. Centang "catat sebagai selisih settlement" bila memang begitu.`;
  m = code.match(/^POS_ALIAS_ALREADY_USED_(.*)$/); if (m) return `Alias ${m[1]} sudah dipakai kode lain.`;
  m = code.match(/^SETTLEMENT_EXCEEDS_OUTSTANDING_(.*)$/); if (m) return `Nominal melebihi sisa outstanding (${m[1].replace(/_/g, ' ')}).`;
  return code || 'Terjadi kesalahan. Coba lagi.';
}

/** Kompres foto (kamera HP) agar ≤ ~1.5 MB tanpa membuat bukti tidak terbaca (sisi terpanjang 2000px, JPEG 0.85). */
export async function prepareImage(file: File): Promise<{ name: string; type: string; base64: string; size: number }> {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('EVIDENCE_IMAGE_ONLY');
  const read = (blob: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Gagal membaca file')); r.readAsDataURL(blob); });
  if (file.size <= 1.5 * 1024 * 1024) return { name: file.name, type: file.type, base64: await read(file), size: file.size };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('compress'))), 'image/jpeg', 0.85));
    if (blob.size < file.size) return { name: file.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', base64: await read(blob), size: blob.size };
  } catch { /* fallback ke file asli */ }
  if (file.size > 7 * 1024 * 1024) throw new Error('EVIDENCE_MAX_7MB');
  return { name: file.name, type: file.type, base64: await read(file), size: file.size };
}

export async function uploadEvidence(entityType: string, entityId: string, file: File, imageOnly = true) {
  const prepared = imageOnly || file.type.startsWith('image/') ? await prepareImage(file)
    : await new Promise<{ name: string; type: string; base64: string; size: number }>((res, rej) => { if (file.size > 7 * 1024 * 1024) return rej(new Error('EVIDENCE_MAX_7MB')); const r = new FileReader(); r.onload = () => res({ name: file.name, type: file.type, base64: String(r.result).split(',')[1] || '', size: file.size }); r.onerror = () => rej(new Error('Gagal membaca file')); r.readAsDataURL(file); });
  return api('/api/sales-flow/evidence', { method: 'POST', body: JSON.stringify({ entityType, entityId, fileName: prepared.name, mimeType: prepared.type, dataBase64: prepared.base64 }) });
}

export const evidenceUrl = (id: string) => `/api/sales-flow/evidence/${id}`;
