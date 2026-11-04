# API Reference — School Finance ERP

Dokumen ini merangkum kontrak API yang dipakai frontend. Semua endpoint berada di bawah `/api`,
memakai JSON, dan mengembalikan kode error stabil (bukan pesan bebas) agar mudah dipetakan ke UI.

## 1. Konvensi

| Aspek | Aturan |
|---|---|
| Base URL | `/api` (auth) dan `/api/v1` (data) |
| Autentikasi | JWT 12 jam di cookie `httpOnly` (`school_session`) |
| Otorisasi | Per-permission per role + pembatasan `unit_id` di server (bukan hanya menyembunyikan menu) |
| Nilai uang | Dikirim/diterima sebagai rupiah (desimal). Server menghitung internal dalam **sen** agar pembagian deterministik |
| Tanggal | `YYYY-MM-DD` untuk tanggal, `YYYY-MM` untuk periode fiskal |
| Pagination | `?page=1&pageSize=25` (maksimum 100). Respons: `{ rows, total, page, pageSize }` |
| Idempotency | Endpoint transaksi menerima `idempotencyKey` unik; kirim ulang key yang sama tidak membuat posting ganda |
| Pembatalan | Tidak ada hard delete transaksi: gunakan `VOID` dengan `reason` (minimal 5 karakter) |
| Periode tertutup | Posting pada periode `CLOSED` ditolak `409 PERIOD_CLOSED` |

### Rate limit login

Maksimum **5 percobaan gagal** per kombinasi IP + email dalam 15 menit. Percobaan ke-6 dst.
mengembalikan `429 TOO_MANY_ATTEMPTS` dengan header `Retry-After`. Login yang berhasil
tidak dihitung sebagai percobaan gagal.

### Header keamanan

Semua respons API mengirim `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, dan `Cache-Control: no-store`.
`X-Powered-By` dinonaktifkan. Detail error internal (`detail`) hanya dikirim saat `NODE_ENV !== production`.

## 2. Autentikasi & sesi

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` → `{ user, permissions, mustChangePassword }` |
| POST | `/api/auth/logout` | Hapus cookie sesi |
| GET | `/api/auth/me` | Sesi aktif + `unitScope` (null = semua unit) + `mustChangePassword` |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` (min. 8 karakter) — menghapus penanda wajib ganti |
| GET | `/api/health` | Status service + label database (tanpa autentikasi) |

**Kebijakan password (migrasi 007)**
- Kolom `users.must_change_password` menandai akun yang password-nya baru direset admin/go-live.
- Bila `mustChangePassword: true`, frontend **memblokir** seluruh aplikasi dan menampilkan halaman
  "Buat password baru" sampai pengguna menyimpan password sendiri.
- Penanda ini bersifat *UI-gated*: API tetap melayani sesi tersebut (dipakai suite UAT), sehingga
  integrasi lain tidak putus hanya karena password belum diganti.
- `users.password_changed_at` dicatat setiap kali password diganti.

## 3. Organisasi (FD-01…FD-05)

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/api/v1/organization/hierarchy` | `unit.view` |
| GET/PUT | `/api/v1/organization/legal-entity` | `unit.view` / `entity.manage` |
| GET/POST/PUT | `/api/v1/organization/education-levels`, `school-groups`, `official-schools`, `locations`, `academic-years` | `unit.view` / `unit.create` |
| GET/POST | `/api/v1/organization/units` | `unit.view` / `unit.create` |
| GET/PATCH | `/api/v1/organization/units/{id}` | `unit.view` / `unit.edit` |
| POST | `/api/v1/organization/units/{id}/activate`, `/deactivate` | `unit.activate` / `unit.deactivate` |
| GET | `/api/v1/organization/units/{id}/readiness` | `unit.view` |
| PUT | `/api/v1/organization/units/{id}/finance-settings` | `unit.finance` |
| POST/DELETE | `/api/v1/organization/units/{id}/bank-assignments[/{assignmentId}]` | `bank.assign` |
| PATCH | `/api/v1/organization/{education-levels,school-groups,official-schools,locations,academic-years}/{id}/status` | `entity.manage` |
| DELETE | `/api/v1/organization/{education-levels,school-groups,official-schools,locations,academic-years}/{id}` | `entity.manage` |
| GET | `/api/v1/organization/audit-logs` | `audit.view` |

**Aturan penting**
- `POST /units` menyederhanakan setup: `unitCode` opsional (otomatis `<kode jenjang>-<urut>`),
  `operationalStatus` default `ACTIVE` (`DRAFT` hanya bila dikirim eksplisit), `officialSchoolId` /
  `locationId` / `defaultAcademicYearId` dibuat otomatis bila kosong, `effectiveStart` default hari ini.
  `unit_finance_settings` ikut dibuat dengan akun default `1-1200` (piutang) dan `1-1100` (kas) bila ada di CoA.
- `POST /official-schools` — `verificationStatus` default `VERIFIED` (tidak lagi diminta di UI).
- `PATCH /units/{id}` menolak perubahan `educationLevelId`/`officialSchoolId` bila unit sudah punya
  transaksi → `409 UNIT_IDENTITY_LOCKED` (VAL-08).
- `readiness` mengembalikan checklist lengkap (`status` + `checks[]`), bukan hanya boolean.
- Mode rekening `MIXED` butuh minimal satu rekening `CENTRAL` dan satu `DEDICATED` aktif & terverifikasi.

**Kelola master (jenjang, kelompok, sekolah resmi, lokasi, tahun ajaran)**
- `PATCH .../{id}/status` body `{ status: "ACTIVE" | "INACTIVE" }` — menonaktifkan tanpa menghapus data.
  Dipakai untuk master yang sudah terlanjur dipakai unit/tarif/tagihan. Audit: `<MASTER>_STATUS`.
  **UI tidak lagi menampilkan tombol aktif/nonaktif**; endpoint dipertahankan untuk kompatibilitas data lama.
- `DELETE .../{id}` — hanya berhasil bila master **belum dipakai**. Jika masih dipakai, respons
  `409 MASTER_IN_USE` dengan rincian `references: [{ label, count }]` (mis. 31 unit, 1 kelompok sekolah).
  Audit: `<MASTER>_DELETE` berisi snapshot data sebelum dihapus.
- `PUT /organization/academic-years/{id}` melengkapi CRUD tahun ajaran (sebelumnya hanya create).

## 4. Rekening bank

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST/PUT | `/api/v1/bank-accounts` | `bank.view` / `bank.manage` |
| POST | `/api/v1/bank-accounts/{id}/verify`, `/deactivate` | `bank.manage` |

## 5. Pengguna & akses

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST/PATCH | `/api/v1/users` | `user.manage` |
| POST | `/api/v1/users/{id}/reset-password` | `user.manage` |
| PUT | `/api/v1/users/{id}/units` | `user.manage` |
| GET | `/api/v1/audit-logs` | `audit.view` |

**Reset password oleh admin**
- `POST /api/v1/users/{id}/reset-password` body `{ password }` (min. 8 karakter) menetapkan password
  sementara dan menyalakan `must_change_password`, sehingga pengguna wajib menggantinya saat login berikutnya.
- Nilai password tidak pernah ditulis ke log; audit mencatat `USER_PASSWORD_RESET`.
- Pengguna baru (`POST /api/v1/users`) otomatis dibuat dengan `must_change_password = 1`.
- Go-live: `BOOTSTRAP_ADMIN_RESET_PASSWORD=true` di env backend akan mereset password admin dari
  `BOOTSTRAP_ADMIN_PASSWORD` + menyalakan penanda. **Hapus flag itu setelah satu kali start**, karena
  selama aktif password admin direset ulang pada setiap restart.

## 6. Siswa & tarif (BILL-01)

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST/PATCH | `/api/v1/students[/{id}]` | `student.view` / `student.manage` |
| POST | `/api/v1/students/{id}/enrollments` | `student.manage` |
| GET/POST/PATCH | `/api/v1/fee-types[/{id}]` | `fee.view` / `fee.manage` |
| GET/POST/PATCH | `/api/v1/fee-schemes[/{id}]` | `fee.view` / `fee.manage` |
| GET | `/api/v1/billing-runs` | `billing.view` |
| POST | `/api/v1/billing-runs/preview` | `billing.view` |
| POST | `/api/v1/billing-runs/generate` | `billing.generate` |
| GET | `/api/v1/invoices`, `/api/v1/invoices/{id}` | `billing.view` |
| POST | `/api/v1/invoices/{id}/void` | `invoice.void` |
| GET | `/api/v1/receivables` | `receivable.view` |

`revenueAccountCode` pada jenis biaya wajib ada di CoA bertipe `REVENUE` → `400 ACCOUNT_MAPPING_MISSING`.

## 7. Penerimaan & kas/bank (FC-01)

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST | `/api/v1/receipts` | `receipt.view` / `receipt.create` |
| GET | `/api/v1/receipts/{id}` | `receipt.view` |
| POST | `/api/v1/receipts/{id}/void` | `receipt.void` |
| GET | `/api/v1/cash-bank/balances` | `cashbank.view` |
| GET | `/api/v1/cash-bank/mutations` | `cashbank.view` |

Contoh body penerimaan:

```json
{
  "unitId": "…",
  "bankAccountId": "…",
  "receiptDate": "2026-09-10",
  "method": "TRANSFER",
  "payerName": "Wali Murid",
  "totalAmount": 2000000,
  "idempotencyKey": "rcpt-2026-09-10-001",
  "allocations": [
    { "invoiceId": "…", "amount": 800000 },
    { "invoiceId": "…", "amount": 1000000 }
  ]
}
```

Sisa `totalAmount − Σ alokasi` dicatat sebagai **uang belum dialokasikan** (kredit akun `2-1200`).
Alokasi ke tagihan unit lain diperbolehkan selama pengguna punya akses ke unit tersebut.

`cash-bank/balances` mengembalikan `receipt_unit_ids` dan `disbursement_unit_ids` agar UI hanya
menampilkan rekening yang berizin untuk unit terpilih. Daftar rekening dibatasi scope unit pengguna.

## 8. Pengeluaran (FC-01)

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST/PATCH | `/api/v1/expense-categories[/{id}]` | `expense.view` / `expense.manage` |
| GET/POST/PATCH | `/api/v1/vendors[/{id}]` | `expense.view` / `expense.manage` |
| GET/POST | `/api/v1/expenses` | `expense.view` / `expense.create` |
| GET/PATCH/DELETE | `/api/v1/expenses/{id}` | `expense.view` / `expense.create` / `transaction.delete` |
| POST | `/api/v1/expenses/{id}/submit`, `/cancel` | `expense.create` |
| POST | `/api/v1/expenses/{id}/approve`, `/reject` | `expense.approve` |
| GET | `/api/v1/expense-payments` | `expense.view` |
| POST | `/api/v1/expenses/{id}/payments` | `expense.pay` |
| POST | `/api/v1/expense-payments/{id}/void` | `expense.void` |
| GET/POST | `/api/v1/payment-requests` | `expense.view` / `payment_request.create` |
| GET/PATCH/DELETE | `/api/v1/payment-requests/{id}` | `expense.view` / `payment_request.create` / `transaction.delete` |
| POST | `/api/v1/payment-requests/{id}/submit`, `/cancel` | `payment_request.create` |
| POST | `/api/v1/payment-requests/{id}/approve`, `/reject` | `payment_request.approve` |
| POST | `/api/v1/payment-requests/{id}/post` | `expense.pay` |

**Alur status pengajuan pembelian**: `DRAFT → SUBMITTED → APPROVED → PAID` (dengan cabang `REJECTED`, `CANCELLED`).

**Rincian barang & ongkos kirim**: `POST /expenses` menerima `lines: [{ itemName, qty, uom, unitPrice }]`
(nama barang diketik manual) dan `shippingCost`. Bila `lines` diisi, total dihitung server:
`Σ(qty × unitPrice) + shippingCost`; nilai `amount` dari klien diabaikan. Tanpa `lines`, `amount` dipakai
seperti sebelumnya (kompatibel).

**MCM (pengajuan pembayaran)**: `DRAFT → SUBMITTED → APPROVED → POSTED` (cabang `REJECTED`, `CANCELLED`).
Dibuat Finance (`payment_request.create`), disetujui Ketua Yayasan (`payment_request.approve`, maker-checker:
pembuat tidak boleh menyetujui sendiri), lalu diposting Finance (`expense.pay`) → membuat pembayaran,
mutasi kas keluar, jurnal Dr beban / Cr kas, dan menaikkan `paid_amount` pengajuan. Nominal MCM ≤ sisa
pengajuan; satu pengajuan boleh punya beberapa MCM (DP lalu pelunasan). Idempotency key `MCM:<id>`.

**Alur status**: `DRAFT → SUBMITTED → APPROVED → PAID` (dengan cabang `REJECTED`, `CANCELLED`).

**Maker-checker**: pembuat pengajuan tidak boleh menyetujui/menolaknya sendiri
→ `403 EXPENSE_SELF_APPROVAL_FORBIDDEN`.

**Pembayaran**: hanya dari rekening `ACTIVE` + terverifikasi + `allow_disbursement=1` untuk unit
pengajuan pada tanggal bayar. Total pembayaran ≤ sisa pengajuan → `409 PAYMENT_EXCEEDS_REMAINING`.
Unit penanggung beban tetap unit pengajuan meskipun rekeningnya rekening pusat.

`expenseAccountCode` pada jenis biaya wajib ada di CoA bertipe `EXPENSE` → `400 EXPENSE_ACCOUNT_MAPPING_MISSING`.

### 8.1 Prioritas & batas waktu pembayaran

`POST /expenses` dan `PATCH /expenses/{id}` menerima:

| Field | Nilai | Keterangan |
|---|---|---|
| `priority` | `NORMAL` (default) · `TINGGI` · `MENDESAK` | nilai lain → `400 EXPENSE_PRIORITY_INVALID` |
| `paymentDueAt` | `YYYY-MM-DD HH:MM` atau `YYYY-MM-DDTHH:MM` | `null` = tanpa batas waktu; format salah → `400 EXPENSE_PAYMENT_DUE_INVALID` |

Keduanya dikembalikan pada detail **dan** daftar pengajuan (`priority`, `payment_due_at`), sehingga UI
bisa menampilkan badge prioritas + hitung mundur batas bayar (`Lewat batas:` bila sudah lewat, diabaikan
untuk status `PAID`/`CANCELLED`/`REJECTED`).

### 8.2 Edit & hapus permanen

- `PATCH /expenses/{id}` — hanya status `DRAFT`/`REJECTED`; boleh mengganti kategori, vendor, tanggal,
rincian `lines[]` (diganti seluruhnya bila dikirim), ongkir, prioritas, dan batas bayar. Status lain →
`409 EXPENSE_INVALID_STATUS`. Total tetap dihitung server.
- `PATCH /payment-requests/{id}` — hanya `DRAFT`/`REJECTED`; mengganti rekening, tanggal, metode, nominal,
catatan. Nominal tetap ≤ sisa pengajuan (`409 PAYMENT_EXCEEDS_REMAINING`).
- `DELETE /expenses/{id}` — **hapus permanen** (`transaction.delete`, hanya `ADMIN_YAYASAN`). Menghapus
rincian, MCM, dan lampiran. Ditolak bila sudah ada pembayaran (`409 EXPENSE_HAS_PAYMENT`) atau MCM
(`409 EXPENSE_HAS_PAYMENT_REQUEST`). Audit `EXPENSE_REQUEST_DELETE` menyimpan nomor, nominal, status, dan alasan.
- `DELETE /payment-requests/{id}` — hapus permanen MCM (`transaction.delete`). Status `POSTED` ditolak
`409 PAYMENT_REQUEST_POSTED`; lampiran MCM ikut terhapus.

## 8A. Lampiran dokumen

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/api/v1/attachments?entityType=&entityId=` | login + scope unit |
| POST | `/api/v1/attachments` | `attachment.upload` |
| GET | `/api/v1/attachments/{id}/download` | login + scope unit |
| DELETE | `/api/v1/attachments/{id}` | `transaction.delete` atau pengunggah |

`entityType`: `EXPENSE_REQUEST`, `PAYMENT_REQUEST`, `INVOICE`, `RECEIPT`, `EXPENSE_PAYMENT`, `JOURNAL`.
Unggah memakai JSON base64 agar tidak butuh multipart:

```json
{ "entityType": "EXPENSE_REQUEST", "entityId": "<uuid>",
  "files": [{ "name": "nota.pdf", "mimeType": "application/pdf", "dataBase64": "..." }] }
```

Batas: **10 file per permintaan**, **5 MB per file** → `400 ATTACHMENT_TOO_MANY_FILES` /
`400 ATTACHMENT_FILE_TOO_LARGE` / `400 ATTACHMENT_FILE_INVALID`. Body route ini memakai limit 60 MB.
Isi file disimpan di kolom `MEDIUMBLOB` tabel `attachments` (rencana lanjut: object storage R2).

## 9. Akuntansi (ACC-01)

| Method | Endpoint | Permission |
|---|---|---|
| GET/POST/PATCH | `/api/v1/accounts[/{id}]` | `accounting.view` / `coa.manage` |
| GET | `/api/v1/fiscal-periods` | `accounting.view` |
| POST | `/api/v1/fiscal-periods/{id}/close`, `/reopen` | `period.close` |
| GET | `/api/v1/journal-entries`, `/api/v1/journal-entries/{id}` | `accounting.view` |
| POST | `/api/v1/journal-entries` | `journal.post` |
| POST | `/api/v1/journal-entries/{id}/reverse` | `journal.post` |
| GET | `/api/v1/accounting/trial-balance` | `accounting.view` |
| GET | `/api/v1/accounting/general-ledger` | `accounting.view` |
| GET | `/api/v1/accounting/reconciliation` | `accounting.view` |
| POST | `/api/v1/accounting/backfill` | `journal.post` |

Contoh jurnal manual:

```json
{
  "entryDate": "2026-09-30",
  "description": "Koreksi beban listrik",
  "unitId": "…",
  "lines": [
    { "accountCode": "5-2100", "debit": 150000, "description": "Beban listrik" },
    { "accountCode": "1-1100", "credit": 150000, "description": "Kas keluar" }
  ]
}
```

Jurnal otomatis (idempotency key per sumber):

| Kejadian | Debit | Kredit | Key |
|---|---|---|---|
| Tagihan terbit | `1-1200` Piutang | akun pendapatan jenis biaya | `INVOICE:{id}` |
| Penerimaan | akun kas/bank | `1-1200` + `2-1200` (belum dialokasikan) | `RECEIPT:{id}` |
| Pembayaran pengeluaran | akun beban jenis biaya | akun kas/bank | `EXPENSE_PAYMENT:{id}` |
| Pembatalan | kebalikan jurnal asli | — | `REV:JE:{entryId}` |

Akun kas/bank diambil dari `bank_accounts.gl_account_code`, lalu `unit_finance_settings.cash_account_code`,
lalu default `1-1100`.

`reconciliation` membandingkan piutang subledger vs GL `1-1200`, uang muka vs penerimaan belum
dialokasikan, dan kas GL vs mutasi bank. Selisih yang berasal dari jurnal manual dilaporkan
terpisah (`manualAdjustments`), sehingga `unexplained` harus 0.

## 10. Laporan (RPT-01)

| Method | Endpoint | Permission |
|---|---|---|
| GET | `/api/v1/reports/overview` | `report.view` |
| GET | `/api/v1/reports/position` | `report.view` |
| GET | `/api/v1/reports/activity` | `report.view` |
| GET | `/api/v1/reports/cash-flow` | `report.view` |
| GET | `/api/v1/reports/drilldown` | `report.view` |

Parameter umum: `from`, `to`, `unitId` (opsional). Default rentang = awal bulan berjalan s/d hari ini.

`drilldown` menerima `metric` = `billed` | `collected` | `expense` | `outstanding` dan mengembalikan
dokumen sumber dengan `document_number`, `document_date`, `amount`, `party`, `reference`, `unit_*`.

## 11. Matriks permission per role

| Grup permission | PIMPINAN | ADMIN | FINANCE | ACCOUNTING | KEPALA JENJANG | KEPALA CABANG | BENDAHARA | PURCHASING | AUDITOR |
|---|---|---|---|---|---|---|---|---|---|
| Struktur & master unit | view | kelola | view | view | view | view | view | view | view |
| Rekening & mapping | view | kelola | kelola | view | – | – | – | – | view |
| Siswa & tarif | view | kelola | view | kelola tarif | view | view | siswa | view | view |
| Tagihan | view | generate, void | generate, void | void | view | view | generate | view | view |
| Penerimaan | view | create, void | create, void | void | view | view | create | view | view |
| Pengeluaran | view, approve | penuh | penuh | approve, void | approve | create, approve | create, pay | create | view |
| Lampiran | view | unggah, hapus | unggah | view | view | unggah | unggah | unggah | view |
| Hapus permanen transaksi | – | ya | – | – | – | – | – | – | – |
| Akuntansi | view | view + CoA | view | penuh | view | view | view | – | view |
| Laporan | view | view | view | view | view | view | view | view | view |
| Pengguna & audit | audit | penuh | – | audit | – | – | – | – | audit |

Role pusat (`PIMPINAN`, `ADMIN_YAYASAN`, `FINANCE_PUSAT`, `ACCOUNTING_PUSAT`, `AUDITOR`) melihat semua unit.
Role cabang (`KEPALA_JENJANG`, `KEPALA_CABANG`, `BENDAHARA_CABANG`, `PURCHASING`) dibatasi `user_unit_access`.

**Hapus permanen** (`transaction.delete`) hanya dimiliki `ADMIN_YAYASAN` — dipakai untuk pengajuan pembelian
dan MCM. Role lain harus memakai pembatalan (VOID/CANCEL) agar jejak audit tetap ada.

## 12. Daftar kode error

| Kode | HTTP | Arti |
|---|---|---|
| `UNAUTHENTICATED` / `INVALID_SESSION` | 401 | Belum login / sesi kedaluwarsa |
| `INVALID_CREDENTIALS` | 401 | Email atau password salah |
| `TOO_MANY_ATTEMPTS` | 429 | Rate limit login (5 gagal / 15 menit) |
| `PERMISSION_DENIED` | 403 | Role tidak punya permission |
| `UNIT_FORBIDDEN` | 403 | Unit di luar scope pengguna |
| `UNIT_NOT_ACTIVE` | 400 | Unit belum aktif |
| `UNIT_NOT_READY_FOR_BILLING` / `..._FOR_EXPENSE` | 400 | Kesiapan keuangan belum READY |
| `UNIT_IDENTITY_LOCKED` | 409 | Ubah jenjang/sekolah unit yang sudah bertransaksi (VAL-08) |
| `MASTER_IN_USE` | 409 | Master (jenjang/kelompok/sekolah/lokasi/tahun ajaran) masih dipakai — nonaktifkan saja |
| `UNIT_CODE_DUPLICATE` / `NPSN_DUPLICATE` | 409 | Duplikasi identitas master |
| `BANK_ACCOUNT_NOT_ALLOWED` / `NOT_READY` / `NOT_ASSIGNED_TO_UNIT` | 400/403 | Rekening tidak memenuhi syarat transaksi |
| `BANK_ACCOUNT_DEDICATED_CONFLICT` | 409 | Rekening khusus dipakai unit lain pada periode tumpang tindih |
| `BILLING_RUN_DUPLICATE` | 409 | Tagihan unit+tahun+periode sudah dibuat |
| `NO_ACTIVE_FEE_SCHEME` / `NO_ACTIVE_STUDENT` | 400 | Prasyarat generate tagihan tidak terpenuhi |
| `ALLOCATION_EXCEEDS_OUTSTANDING` | 409 | Alokasi melebihi sisa tagihan |
| `ALLOCATION_EXCEEDS_RECEIPT` | 400 | Total alokasi melebihi nilai penerimaan |
| `RECEIPT_ALREADY_VOID` / `INVOICE_ALREADY_VOID` | 409 | Dokumen sudah dibatalkan |
| `EXPENSE_SELF_APPROVAL_FORBIDDEN` | 403 | Maker-checker: pengaju tidak boleh menyetujui sendiri |
| `EXPENSE_NOT_APPROVED` | 409 | Pembayaran sebelum persetujuan |
| `PAYMENT_EXCEEDS_REMAINING` | 409 | Pembayaran melebihi sisa pengajuan |
| `EXPENSE_HAS_PAYMENT` | 409 | Pengajuan berbayar tidak bisa dibatalkan / dihapus |
| `EXPENSE_HAS_PAYMENT_REQUEST` | 409 | Pengajuan sudah punya MCM — hapus MCM dulu |
| `EXPENSE_INVALID_STATUS` | 409 | Status tidak mendukung edit (bukan Draft/Ditolak) |
| `EXPENSE_PRIORITY_INVALID` | 400 | Prioritas bukan `NORMAL`/`TINGGI`/`MENDESAK` |
| `EXPENSE_PAYMENT_DUE_INVALID` | 400 | Format `paymentDueAt` salah |
| `PAYMENT_REQUEST_POSTED` | 409 | MCM sudah diposting — batalkan pembayarannya, bukan dihapus |
| `ATTACHMENT_TARGET_INVALID` / `NOT_FOUND` | 400/404 | Entitas lampiran tidak dikenal / tidak ada |
| `ATTACHMENT_FILES_REQUIRED` / `TOO_MANY_FILES` | 400 | Tidak ada file / lebih dari 10 file |
| `ATTACHMENT_FILE_INVALID` / `FILE_TOO_LARGE` | 400 | Base64 rusak / file > 5 MB |
| `ACCOUNT_MAPPING_MISSING` | 400 | Akun tidak ada di CoA / tidak postable |
| `JOURNAL_NOT_BALANCED` | 409 | Debit ≠ kredit |
| `JOURNAL_NOT_REVERSIBLE` | 409 | Jurnal sudah dibalik / bukan ORIGINAL |
| `PERIOD_CLOSED` | 409 | Posting ke periode tertutup (ACC-03) |
| `PAYLOAD_TOO_LARGE` | 413 | Body melebihi 2 MB |
| `DUPLICATE_ENTRY` / `FOREIGN_KEY_VIOLATION` | 409/400 | Constraint database |
| `INTERNAL_ERROR` | 500 | Kesalahan tak terduga (detail hanya di non-production) |

## 13. Contoh alur end-to-end

```
1. POST /api/v1/billing-runs/generate       → tagihan + jurnal Dr Piutang / Cr Pendapatan
2. POST /api/v1/receipts                    → penerimaan + alokasi + mutasi kas masuk + jurnal
3. POST /api/v1/expenses (submit)           → pengajuan
4. POST /api/v1/expenses/{id}/approve       → persetujuan (pengguna berbeda)
5. POST /api/v1/expenses/{id}/payments      → mutasi kas keluar + jurnal Dr Beban / Cr Kas
6. GET  /api/v1/accounting/trial-balance    → neraca saldo seimbang
7. GET  /api/v1/accounting/reconciliation   → selisih 0
8. GET  /api/v1/reports/overview            → agregasi cabang/jenjang
9. GET  /api/v1/reports/drilldown           → dokumen sumber
```
