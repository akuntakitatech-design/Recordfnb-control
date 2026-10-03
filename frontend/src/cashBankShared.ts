// Helper bersama halaman Kas & Bank (format angka, pesan error bahasa bisnis, unduh Excel, upload bukti).
export type Company = { id: string; workspace_id: string; name: string };
export type Location = { id: string; company_id: string; name: string };
export type CashAccount = {
  id: string; code: string; name: string; account_kind: 'CASH' | 'BANK' | 'EWALLET'; location_id: string | null; location_name: string | null;
  coa_code: string; coa_name: string; total_in: string; total_out: string; balance: string; draft_count: number; mutation_count: number;
  last_reconciliation_status: string | null; last_reconciliation_date: string | null;
};
export type Totals = { cash: string; bank: string; ewallet: string; total: string };
export type LedgerRow = {
  id: string; transaction_id: string; transaction_number: string; transaction_date: string; transaction_type: string; kind: string;
  financial_account_id: string; financial_account_name: string; account_kind: string; amount_in: string; amount_out: string;
  counterparty: string | null; description: string | null; category_name: string | null; location_name: string | null;
  workflow_status: string; accounting_status: string; reference_number: string | null; attachment_count: number; balance: string;
};
export type Ledger = { opening_balance: string; closing_balance: string; total_in: string; total_out: string; rows: LedgerRow[] };
export type Payable = {
  id: string; transaction_number: string; transaction_date: string; reference_number: string | null; due_date: string | null; grand_total: string;
  workflow_status: string; payment_status: string; partner_id: string; supplier_name: string | null; location_name: string | null;
  paid_verified: string; paid_pending: string; remaining: string; paid_total: string; attachment_count: number;
  status: 'LUNAS' | 'DIBAYAR_SEBAGIAN' | 'BELUM_DIBAYAR'; overdue: boolean; payable: boolean;
};
export type ExpenseCategory = { id: string; code: string; name: string; status: string; account_id: string | null; account_code: string | null; account_name: string | null };
export type Supplier = { id: string; code: string; name: string; partner_type: string };

export const today = () => new Date().toISOString().slice(0, 10);
export const money = (value: string | number | null | undefined) => Number(value || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
export const rupiah = (value: string | number | null | undefined) => { const n = Number(value || 0); return `${n < 0 ? '-' : ''}Rp${money(Math.abs(n))}`; };

export const workflowLabel: Record<string, string> = { DRAFT: 'Draft', FINANCE_VERIFIED: 'Finance Verified', POSTED: 'Posted', CANCELLED: 'Dibatalkan' };
export const accountKindLabel: Record<string, string> = { CASH: 'Kas', BANK: 'Bank', EWALLET: 'E-Wallet' };
export const payableStatusLabel: Record<string, string> = { LUNAS: 'LUNAS', DIBAYAR_SEBAGIAN: 'PARTIAL', BELUM_DIBAYAR: 'BELUM DIBAYAR' };
export const typeLabel: Record<string, string> = {
  CASH_OUT: 'Kas Keluar', CASH_IN: 'Kas Masuk', CASH_TRANSFER: 'Pindah Uang', PURCHASE_INVOICE: 'Invoice Pembelian',
};

/** Pesan error backend → kalimat yang dipahami user Finance. */
export function errorText(raw: unknown): string {
  const code = raw instanceof Error ? raw.message : String(raw || '');
  const fixed: Record<string, string> = {
    ACCOUNTING_PERIOD_HARD_CLOSED: 'Periode akuntansi untuk tanggal ini sudah HARD CLOSE (dikunci permanen). Transaksi tidak bisa dibuat, diverifikasi, atau dibatalkan. Koreksi hanya lewat jurnal adjustment/reversal di periode yang masih terbuka.',
    ACCOUNTING_PERIOD_SOFT_CLOSED: 'Periode akuntansi untuk tanggal ini sudah SOFT CLOSE. Finance tidak bisa menambah atau membatalkan transaksi — hubungi Accounting untuk membuka kembali periode.',
    ACCOUNTING_PERIOD_OVERLAP: 'Periode tersebut bertabrakan dengan periode yang sudah ada.',
    PERIOD_HAS_UNPOSTED_JOURNALS: 'Masih ada jurnal Draft/Ready di periode ini. Posting atau selesaikan dulu sebelum Hard Close.',
    TRANSFER_ACCOUNTS_MUST_DIFFER: 'Rekening asal dan tujuan harus berbeda.',
    POSITIVE_TRANSFER_AMOUNT_REQUIRED: 'Nominal pindah uang harus lebih dari 0.',
    TRANSFER_HEADER_REQUIRED: 'Tanggal, rekening asal dan rekening tujuan wajib diisi.',
    INVALID_EXPENSE_CATEGORY: 'Kategori pengeluaran tidak valid atau sudah nonaktif.',
    EXPENSE_DESCRIPTION_REQUIRED: 'Isi kategori atau keterangan untuk setiap baris pengeluaran.',
    ONLY_DRAFT_CAN_BE_CANCELLED: 'Hanya transaksi Draft yang bisa dibatalkan. Transaksi terverifikasi dikoreksi lewat jurnal reversal.',
    ONLY_CASH_TRANSACTIONS_CAN_BE_CANCELLED: 'Hanya transaksi kas/bank yang bisa dibatalkan dari halaman ini.',
    FINANCE_VERIFY_ROLE_REQUIRED: 'Anda tidak memiliki hak Finance Verified.',
    ACCOUNTING_REVIEW_ROLE_REQUIRED: 'Hanya Accounting yang dapat mengubah periode.',
    ACCOUNTING_REVIEWER_REQUIRED: 'Hard Close hanya dapat dilakukan Accounting Reviewer.',
    RECONCILIATION_FIELDS_REQUIRED: 'Rekening, tanggal dan saldo aktual wajib diisi.',
    ATTACHMENT_MAX_5MB: 'Bukti transaksi maksimal 5 MB.',
    ATTACHMENT_STORAGE_UNAVAILABLE: 'Penyimpanan bukti (R2) sedang tidak tersedia. Transaksi tersimpan tanpa bukti.',
    INVALID_ATTACHMENT: 'Format bukti tidak didukung (PDF/JPG/PNG/WEBP).',
    FORBIDDEN: 'Anda tidak memiliki akses untuk aksi ini.',
    CASH_OUT_HEADER_REQUIRED: 'Company, lokasi, tanggal dan kas/bank wajib diisi.',
    INVALID_PAYMENT_ALLOCATION: 'Alokasi pembayaran invoice tidak valid.',
  };
  if (fixed[code]) return fixed[code];
  let m = code.match(/^PAYMENT_EXCEEDS_OUTSTANDING_(.+)$/);
  if (m) return `Nominal pembayaran melebihi sisa hutang invoice ${m[1]}.`;
  m = code.match(/^INVOICE_ALREADY_PAID_(.+)$/);
  if (m) return `Invoice ${m[1]} sudah LUNAS — tidak bisa dibayar lagi.`;
  return code || 'Terjadi kesalahan. Coba lagi.';
}

export async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Gagal membaca file'));
    reader.readAsDataURL(file);
  });
}

/** Unduh file (Excel) dari endpoint backend dengan cookie sesi. */
export async function downloadFile(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP_${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const name = disposition.match(/filename="?([^";]+)"?/)?.[1] || fallbackName;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/** Endpoint verifikasi Finance sesuai jenis transaksi (memakai endpoint existing). */
export function verifyUrl(transactionType: string, id: string) {
  if (transactionType === 'CASH_OUT') return `/api/client-transactions/cash-outs/${id}/verify`;
  if (transactionType === 'CASH_IN') return `/api/client-transactions/cash-ins/${id}/verify`;
  if (transactionType === 'CASH_TRANSFER') return `/api/cash-bank/transfers/${id}/verify`;
  return `/api/transactions/${id}/verify`;
}

export function qs(params: Record<string, string>) {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) s.set(k, v); });
  return s.toString();
}
