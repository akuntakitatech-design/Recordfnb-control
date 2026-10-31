export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string; errors?: { field: string; message: string }[] }));
    const error = new Error(body.error || `HTTP_${res.status}`) as Error & { details?: unknown };
    error.details = body;
    throw error;
  }
  return res.json() as Promise<T>;
}

const MESSAGES: Record<string, string> = {
  EMAIL_PASSWORD_REQUIRED: 'Email dan password wajib diisi.',
  INVALID_CREDENTIALS: 'Email atau password belum sesuai.',
  UNAUTHENTICATED: 'Sesi berakhir, silakan masuk kembali.',
  INVALID_SESSION: 'Sesi tidak valid, silakan masuk kembali.',
  USER_INACTIVE: 'Akun tidak aktif.',
  PERMISSION_DENIED: 'Role Anda tidak berwenang untuk aksi ini.',
  ROLE_FORBIDDEN: 'Role Anda tidak berwenang untuk aksi ini.',
  CURRENT_AND_NEW_PASSWORD_REQUIRED: 'Password lama dan baru wajib diisi.',
  NEW_PASSWORD_TOO_SHORT: 'Password baru minimal 8 karakter.',
  NEW_PASSWORD_MUST_BE_DIFFERENT: 'Password baru harus berbeda dari password lama.',
  CURRENT_PASSWORD_INVALID: 'Password lama tidak sesuai.',

  LEGAL_ENTITY_NOT_FOUND: 'Badan hukum belum tersedia.',
  ENTITY_NAME_CODE_REQUIRED: 'Nama dan kode badan hukum wajib diisi.',
  LEVEL_CODE_NAME_REQUIRED: 'Kode dan nama jenjang wajib diisi.',
  LEVEL_CODE_DUPLICATE: 'Kode jenjang sudah dipakai.',
  LEVEL_NOT_FOUND: 'Jenjang tidak ditemukan.',
  LEVEL_OUTSIDE_ENTITY: 'Jenjang bukan milik badan hukum ini.',
  LEVEL_INACTIVE: 'Jenjang tidak aktif.',
  GROUP_FIELDS_REQUIRED: 'Kode, nama, dan jenjang kelompok wajib diisi.',
  GROUP_CODE_DUPLICATE: 'Kode kelompok sudah dipakai.',
  GROUP_NOT_FOUND: 'Kelompok sekolah tidak ditemukan.',
  GROUP_OUTSIDE_ENTITY: 'Kelompok bukan milik badan hukum ini.',
  SCHOOL_FIELDS_REQUIRED: 'Nama dan jenjang sekolah wajib diisi.',
  SCHOOL_NOT_FOUND: 'Sekolah resmi tidak ditemukan.',
  SCHOOL_OUTSIDE_ENTITY: 'Sekolah resmi bukan milik badan hukum ini.',
  NPSN_INVALID: 'NPSN harus 8 karakter alfanumerik.',
  NPSN_DUPLICATE: 'NPSN sudah dipakai sekolah resmi lain.',
  VERIFICATION_STATUS_INVALID: 'Status verifikasi tidak valid.',
  LOCATION_NAME_REQUIRED: 'Nama lokasi wajib diisi.',
  LOCATION_NOT_FOUND: 'Lokasi tidak ditemukan.',
  LOCATION_OUTSIDE_ENTITY: 'Lokasi bukan milik badan hukum ini.',
  LOCATION_REGION_INCOMPLETE: 'Jika provinsi diisi, kota/kabupaten wajib diisi.',
  POSTAL_CODE_INVALID: 'Kode pos harus 5 angka.',
  ACADEMIC_YEAR_FIELDS_REQUIRED: 'Nama, tanggal mulai, dan tanggal selesai wajib diisi.',
  ACADEMIC_YEAR_RANGE_INVALID: 'Tanggal selesai harus setelah tanggal mulai.',
  ACADEMIC_YEAR_OUTSIDE_ENTITY: 'Tahun ajaran bukan milik badan hukum ini.',

  UNIT_CODE_INVALID: 'Kode unit 2–20 karakter: A-Z, 0-9, tanda hubung.',
  UNIT_CODE_DUPLICATE: 'Kode unit sudah dipakai pada yayasan ini.',
  UNIT_NAME_INVALID: 'Nama unit harus 3–150 karakter.',
  UNIT_LEVEL_REQUIRED: 'Jenjang unit wajib dipilih.',
  UNIT_TYPE_INVALID: 'Jenis unit tidak valid.',
  UNIT_NOT_FOUND: 'Unit tidak ditemukan.',
  UNIT_FORBIDDEN: 'Anda tidak punya akses ke unit ini.',
  UNIT_ACTIVATION_INCOMPLETE: 'Identitas operasional unit belum lengkap.',
  UNIT_FINANCE_NOT_READY: 'Konfigurasi keuangan unit belum lengkap.',
  EFFECTIVE_START_INVALID: 'Tanggal mulai tidak valid.',
  EFFECTIVE_END_INVALID: 'Tanggal berakhir tidak valid.',
  EFFECTIVE_RANGE_INVALID: 'Tanggal berakhir sebelum tanggal mulai.',
  HEAD_USER_NOT_FOUND: 'Kepala unit tidak ditemukan.',
  ACCOUNT_MODE_INVALID: 'Mode rekening tidak valid.',
  DEACTIVATE_REASON_REQUIRED: 'Alasan minimal 5 karakter.',

  BANK_FIELDS_REQUIRED: 'Nama bank, nomor rekening, dan pemilik rekening wajib diisi.',
  ACCOUNT_NUMBER_INVALID: 'Nomor rekening 6–30 angka.',
  ACCOUNT_USAGE_INVALID: 'Jenis rekening tidak valid.',
  BANK_ACCOUNT_DUPLICATE: 'Rekening yang sama sudah terdaftar.',
  BANK_ACCOUNT_NOT_FOUND: 'Rekening tidak ditemukan.',
  BANK_ACCOUNT_NOT_ALLOWED: 'Rekening tidak tersedia untuk unit ini.',
  BANK_ACCOUNT_NOT_READY: 'Rekening belum aktif/terverifikasi.',
  BANK_ACCOUNT_USAGE_MISMATCH: 'Jenis rekening tidak sesuai dengan tipe pemakaian.',
  BANK_ACCOUNT_DEDICATED_CONFLICT: 'Rekening khusus sudah dipakai unit lain pada periode yang sama.',
  DEFAULT_RECEIPT_DUPLICATE: 'Sudah ada rekening default penerimaan pada periode ini.',
  DEFAULT_DISBURSEMENT_DUPLICATE: 'Sudah ada rekening default pengeluaran pada periode ini.',
  USAGE_TYPE_INVALID: 'Tipe pemakaian rekening tidak valid.',
  BANK_ACCOUNT_REQUIRED: 'Rekening wajib dipilih.',
  ASSIGNMENT_NOT_FOUND: 'Mapping rekening tidak ditemukan.',

  USER_FIELDS_REQUIRED: 'Nama dan email wajib diisi.',
  EMAIL_INVALID: 'Format email tidak valid.',
  EMAIL_DUPLICATE: 'Email sudah dipakai.',
  PASSWORD_TOO_SHORT: 'Password minimal 8 karakter.',
  ROLE_INVALID: 'Role tidak valid.',
  USER_STATUS_INVALID: 'Status pengguna tidak valid.',
  USER_NOT_FOUND: 'Pengguna tidak ditemukan.',
  UNIT_SCOPE_REQUIRED: 'Role ini wajib punya minimal satu unit.',
  UNIT_OUTSIDE_ENTITY: 'Unit bukan milik badan hukum ini.',
  CANNOT_CHANGE_OWN_ACCESS: 'Tidak dapat mengubah role/status akun sendiri.',
  AUDIT_ID_INVALID: 'ID audit tidak valid.',
  AUDIT_NOT_FOUND: 'Audit tidak ditemukan.',

  STUDENT_NIS_NAME_REQUIRED: 'NIS dan nama siswa wajib diisi.',
  STUDENT_NIS_DUPLICATE: 'NIS sudah dipakai siswa lain di yayasan ini.',
  STUDENT_UNIT_YEAR_REQUIRED: 'Unit dan tahun ajaran wajib dipilih.',
  STUDENT_NOT_FOUND: 'Siswa tidak ditemukan.',
  INVALID_GENDER: 'Jenis kelamin harus L atau P.',
  INVALID_BIRTH_DATE: 'Tanggal lahir tidak valid.',
  ENROLLMENT_DUPLICATE: 'Penempatan siswa pada unit, tahun ajaran, dan tanggal itu sudah ada.',

  FEE_TYPE_FIELDS_REQUIRED: 'Kode dan nama jenis biaya wajib diisi.',
  FEE_TYPE_CODE_DUPLICATE: 'Kode jenis biaya sudah dipakai.',
  FEE_TYPE_NOT_FOUND: 'Jenis biaya tidak ditemukan.',
  FEE_TYPE_OUTSIDE_ENTITY: 'Jenis biaya bukan milik badan hukum ini.',
  RECOGNITION_MODE_INVALID: 'Mode pengakuan tidak valid.',
  FEE_SCHEME_FIELDS_REQUIRED: 'Unit, tahun ajaran, jenis biaya, dan nama tarif wajib diisi.',
  FEE_SCHEME_DUPLICATE: 'Tarif dengan tanggal efektif yang sama sudah ada.',
  FEE_SCHEME_NOT_FOUND: 'Tarif tidak ditemukan.',
  FEE_AMOUNT_INVALID: 'Nominal tarif harus lebih dari 0.',
  FEE_FREQUENCY_INVALID: 'Frekuensi tarif tidak valid.',
  INSTALLMENT_COUNT_INVALID: 'Jumlah angsuran harus 1 sampai 12.',
  DUE_DAY_INVALID: 'Tanggal jatuh tempo harus 1 sampai 28.',

  BILLING_FIELDS_REQUIRED: 'Unit, tahun ajaran, dan periode wajib diisi.',
  PERIOD_LABEL_INVALID: 'Format periode tidak valid (contoh 2026-07).',
  BILLING_DATES_INVALID: 'Tanggal tagihan dan jatuh tempo tidak valid.',
  BILLING_DUE_BEFORE_INVOICE: 'Jatuh tempo tidak boleh sebelum tanggal tagihan.',
  UNIT_NOT_ACTIVE: 'Unit belum aktif.',
  UNIT_NOT_READY_FOR_BILLING: 'Kesiapan keuangan unit belum READY.',
  NO_ACTIVE_FEE_SCHEME: 'Belum ada tarif aktif untuk unit dan periode ini.',
  NO_ACTIVE_STUDENT: 'Belum ada siswa aktif di unit dan tahun ajaran ini.',
  BILLING_RUN_DUPLICATE: 'Tagihan untuk unit dan periode ini sudah pernah dibuat.',
  INVOICE_NOT_FOUND: 'Tagihan tidak ditemukan.',
  INVOICE_ALREADY_VOID: 'Tagihan sudah dibatalkan.',
  INVOICE_HAS_PAYMENT: 'Tagihan yang sudah menerima pembayaran tidak bisa dibatalkan.',
  VOID_REASON_REQUIRED: 'Alasan pembatalan minimal 5 karakter.',

  DUPLICATE_ENTRY: 'Data sudah ada.',
  FOREIGN_KEY_VIOLATION: 'Referensi data tidak valid.',
  PAYLOAD_TOO_LARGE: 'Data terlalu besar.',
  INTERNAL_ERROR: 'Terjadi kesalahan di server.',
};

export function errorLabel(code: string): string {
  return MESSAGES[code] || `Terjadi kesalahan (${code}).`;
}

export function messageOf(error: unknown): string {
  const err = error as Error & { details?: { errors?: { message: string }[] } };
  const details = err?.details;
  if (details?.errors?.length) {
    return `${errorLabel(err.message)} ${details.errors.map(item => item.message).join('; ')}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  return errorLabel(raw);
}
