# School Finance ERP — Keuangan Yayasan Multiunit

Aplikasi keuangan untuk **satu badan hukum yayasan** dengan banyak jenjang dan cabang.
Implementasi mengikuti **Blueprint Keuangan Yayasan Multiunit V1.2**.

Status saat ini: **seluruh fase blueprint selesai** — Foundation (FD-01…FD-06), BILL-01, FC-01,
ACC-01, dan RPT-01. Sisa fitur di luar fase awal: transfer antar rekening, anggaran & unit cost,
pengakuan pendapatan `DEFERRED`.

## 1. Ruang lingkup Foundation

| Area | Isi |
|---|---|
| Organisasi | Badan hukum, jenjang, kelompok sekolah, sekolah resmi (NPSN), lokasi, tahun ajaran |
| Unit / cabang | Draft → aktif → nonaktif, kode unik per yayasan, jenjang & sekolah resmi terhubung |
| Rekening campuran | Rekening fisik `CENTRAL` / `DEDICATED`, mapping per unit (`CENTRAL_SHARED` / `UNIT_DEDICATED`), masa berlaku, default penerimaan/pengeluaran |
| Kesiapan keuangan | Checklist per unit (identitas, mapping akun, rekening aktif & terverifikasi) → `READY` / `NOT_CONFIGURED` |
| Akses | Role pusat & cabang, scope unit per pengguna, permission per aksi |
| Audit | Semua perubahan konfigurasi tercatat (`before`/`after`, aktor, alasan, IP) |
| Siswa & penempatan | Master siswa per yayasan, riwayat penempatan unit/tahun ajaran (pernah pindah unit tetap tercatat) |
| Tarif | Jenis biaya (+akun pendapatan, mode pengakuan), tarif per unit/tahun ajaran dengan masa berlaku, frekuensi, dan jumlah angsuran |
| Tagihan & piutang | Generate tagihan per unit + periode (idempoten), rincian per jenis biaya, angsuran, daftar tagihan, pembatalan (VOID), piutang + aging |
| Penerimaan | Kwitansi bernomor per tanggal + unit, metode bayar, rekening penerimaan sesuai mapping unit, alokasi ke satu/beberapa tagihan, sisa sebagai uang belum dialokasikan, pembatalan (VOID) yang memulihkan tagihan, idempotency key |
| Kas & bank | Saldo per rekening dari mutasi (masuk/keluar), daftar mutasi dengan filter rekening & tanggal, total masuk/keluar, pembatasan rekening per scope unit |
| Pengeluaran | Jenis biaya (wajib akun beban), vendor, pengajuan dengan unit penanggung beban, alur Draft → Diajukan → Disetujui/Ditolak → Dibayar, pembayaran sebagian/penuh dari rekening berizin bayar, pembatalan pembayaran (VOID) dengan mutasi balik, idempotency key, maker-checker |
| Akuntansi | Bagan akun (CoA) dengan tipe & saldo normal, jurnal otomatis dari tagihan/penerimaan/pengeluaran, jurnal manual, jurnal pembalik (reversal), neraca saldo, buku besar, rekonsiliasi subledger vs GL, periode fiskal bulanan + tutup/buka kembali (ACC-01/02/03) |
| Laporan | Ringkasan cabang & jenjang (tagihan, penerimaan, pengeluaran, surplus, piutang, siswa), aging, status closing, posisi keuangan, aktivitas pendapatan–beban, arus kas per sumber, dan **drill-down** ke dokumen sumber — semua dibatasi scope unit pengguna |
| Hardening | Rate limit login (5 gagal / 15 menit), header keamanan, detail error tidak dibocorkan di production, proteksi VAL-08 untuk identitas unit, dokumentasi API & traceability UAT, skrip verifikasi satu perintah |

**Belum termasuk (fase berikut):** pengakuan pendapatan `DEFERRED`, lampiran/bukti dokumen,
alokasi biaya bersama antarunit, anggaran & unit cost, integrasi & rekonsiliasi bank otomatis,
transfer antarunit sebagai perpindahan kas, ekspor Excel/PDF.

## 2. Tech stack

| Lapisan | Teknologi |
|---|---|
| Frontend | React 19 + TypeScript + Vite, CSS per modul, `lucide-react` |
| Backend | Node.js 22 + Express + TypeScript — dev `tsx`, produksi `node dist/index.js` |
| Database | MariaDB ≥ 10.11 via `mysql2` (placeholder `?`) |
| Auth | JWT 12 jam di cookie httpOnly (`school_session`), bcrypt |
| Migrasi | SQL bernomor di `backend/db/migrations`, runner idempoten (`schema_migrations`) |
| Deploy | Docker per paket; Nginx memproksi `/api` ke backend (Coolify) |

## 3. Struktur

```
backend/
  db/migrations/001_foundation.sql        # skema organisasi, unit, rekening, akses, audit
  db/migrations/002_seed_foundation.sql   # seed contoh: Yayasan, TK/SD, TK-PANAM (Draft)
  db/migrations/003_billing.sql           # siswa, enrollment, tarif, tagihan, angsuran
  db/migrations/004_receipts.sql          # penerimaan, alokasi, mutasi kas & bank
  db/migrations/005_disbursements.sql     # kategori biaya, vendor, pengajuan, pembayaran
  db/migrations/006_accounting.sql        # CoA, periode fiskal, jurnal + seed 9 akun
  db/migrations/007_password_policy.sql   # penanda wajib ganti password + waktu ganti password
  src/index.ts                            # migrasi -> bootstrap admin -> listen
  src/db.ts · src/http.ts                 # pool & helper validasi
  src/auth.ts · src/permissions.ts        # sesi, 8 role, permission, unit scope
  src/audit.ts                            # audit trail terstruktur
  src/rateLimit.ts                        # rate limit percobaan login (in-memory)
  src/accounting.ts                       # mesin jurnal: periode, posting, reversal, mapping
  src/routes/organizationRoutes.ts        # hierarki, master, unit, readiness, assignments
  src/routes/bankRoutes.ts                # rekening fisik + verifikasi
  src/routes/userRoutes.ts                # pengguna, scope unit, audit log global
  src/routes/studentRoutes.ts             # siswa + penempatan unit
  src/routes/feeRoutes.ts                 # jenis biaya + tarif per unit
  src/routes/billingRoutes.ts             # billing run, invoice, void
  src/routes/receivableRoutes.ts          # piutang + aging
  src/routes/receiptRoutes.ts             # penerimaan, alokasi, pembatalan
  src/routes/cashBankRoutes.ts            # saldo & mutasi kas/bank
  src/routes/expenseRoutes.ts             # kategori, vendor, pengajuan, pembayaran, void
  src/routes/accountingRoutes.ts          # CoA, periode, jurnal, neraca saldo, rekonsiliasi, backfill
  src/routes/reportRoutes.ts              # ringkasan, posisi, aktivitas, arus kas, drill-down
  src/routes/dashboardRoutes.ts
  tsconfig.build.json                     # emit TypeScript ke dist/ untuk image production
frontend/
  src/App.tsx                             # shell + menu per permission
  src/pages/Login.tsx · ForcePasswordChange.tsx
  src/pages/Dashboard.tsx · Organization.tsx · Units.tsx
  src/pages/BankAccounts.tsx · Readiness.tsx · Users.tsx · Audit.tsx
  src/pages/Students.tsx · Fees.tsx · Billing.tsx · Receivables.tsx
  src/pages/Receipts.tsx · CashBank.tsx · Expenses.tsx · Accounting.tsx · Reports.tsx
tests/foundation_uat.py                   # UAT T01–T10, T19 (blueprint) + T21 reset password
tests/billing_uat.py                      # UAT BILL-01 (tagihan & piutang)
tests/receipt_uat.py                      # UAT FC-01 (penerimaan & kas/bank)
tests/expense_uat.py                      # UAT FC-01 (pengeluaran & maker-checker)
tests/accounting_uat.py                   # UAT ACC-01 (jurnal, rekonsiliasi, tutup buku)
tests/report_uat.py                        # UAT RPT-01 (agregasi & drill-down)
docs/API.md                               # kontrak API, permission matrix, kode error
docs/UAT.md                               # traceability T01–T20 + hasil uji
scripts/verify.sh                         # typecheck + build + semua suite UAT
```

## 4. Menjalankan lokal

```bash
# Database
#   buat database (mis. school_finance) + user, lalu set DATABASE_URL

cd backend && cp .env.example .env      # isi DATABASE_URL, JWT_SECRET, BOOTSTRAP_ADMIN_*
yarn install && yarn dev                # http://localhost:4100/api/health
yarn build                              # kompilasi ke dist/ (yang dipakai container production)
yarn start                              # jalankan hasil build: node dist/index.js

cd frontend && yarn install && yarn dev # http://localhost:4200 (proxy /api -> :4100)
```

Migrasi dan admin awal berjalan otomatis saat backend start.
`yarn db:migrate` tersedia untuk menjalankan migrasi manual.

**Lupa password / ambil alih akun admin**

```bash
# 1) set di backend/.env
export BOOTSTRAP_ADMIN_EMAIL=admin@sekolah.test
export BOOTSTRAP_ADMIN_PASSWORD='<password sementara>'
export BOOTSTRAP_ADMIN_RESET_PASSWORD=true

# 2) restart backend satu kali, lalu HAPUS BOOTSTRAP_ADMIN_RESET_PASSWORD
#    (selama aktif, password admin direset ulang pada setiap restart)
```

Setelah reset, login dengan password sementara langsung menampilkan halaman **"Buat password baru"** dan
seluruh aplikasi terblokir sampai pengguna menyimpan password sendiri. Admin juga bisa mereset pengguna
lain lewat tombol **Reset password** di menu Pengguna (`POST /api/v1/users/{id}/reset-password`).

## 5. Role & permission

| Role | Cakupan |
|---|---|
| Pimpinan Yayasan | Monitoring semua cabang, approval (tanpa ubah jurnal) |
| Admin Yayasan | Organisasi, pengguna, rekening, unit |
| Finance Pusat | Rekening & mapping seluruh unit |
| Accounting Pusat | Mapping akun & kesiapan keuangan |
| Kepala Jenjang | Monitoring jenjang yang ditetapkan |
| Kepala Cabang | Monitoring/approval unit sendiri |
| Bendahara Cabang | Input pada unit sendiri |
| Auditor | Read-only + audit trail |

Role pusat (`PIMPINAN`, `ADMIN_YAYASAN`, `FINANCE_PUSAT`, `ACCOUNTING_PUSAT`, `AUDITOR`) melihat
seluruh unit. Role cabang dibatasi `user_unit_access` dan **dicek di server** pada setiap endpoint.

## 6. API utama

Dokumentasi lengkap (kontrak, permission matrix, kode error, contoh payload): **[`docs/API.md`](docs/API.md)**.

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/v1/organization/hierarchy` | Struktur organisasi + ringkasan unit |
| GET/PUT | `/api/v1/organization/legal-entity` | Profil badan hukum |
| GET/POST/PUT | `/api/v1/organization/education-levels`, `school-groups`, `official-schools`, `locations`, `academic-years` | Master organisasi |
| GET/POST | `/api/v1/organization/units` | List (filter jenjang/status/cari) & buat Draft |
| GET/PATCH | `/api/v1/organization/units/{id}` | Detail (settings, assignments, readiness, audit) & edit |
| POST | `/api/v1/organization/units/{id}/activate`, `/deactivate` | Lifecycle terkontrol |
| GET | `/api/v1/organization/units/{id}/readiness` | Checklist kesiapan keuangan |
| PUT | `/api/v1/organization/units/{id}/finance-settings` | Mode rekening + mapping akun |
| POST/DELETE | `/api/v1/organization/units/{id}/bank-assignments[/{assignmentId}]` | Mapping rekening unit |
| GET/POST/PUT | `/api/v1/bank-accounts` | Rekening fisik |
| POST | `/api/v1/bank-accounts/{id}/verify`, `/deactivate` | Verifikasi & nonaktif |
| GET/POST/PATCH | `/api/v1/users` | Pengguna + role |
| POST | `/api/v1/users/{id}/reset-password` | Reset password (wajib ganti saat login) |
| PUT | `/api/v1/users/{id}/units` | Scope unit |
| GET | `/api/v1/audit-logs` | Jejak audit (filter entitas) |
| GET | `/api/v1/dashboard` | Ringkasan yayasan |
| GET/POST/PATCH | `/api/v1/students[/{id}]` | Siswa + penempatan unit |
| POST | `/api/v1/students/{id}/enrollments` | Pindah unit / tahun ajaran (histori tetap) |
| GET/POST/PATCH | `/api/v1/fee-types[/{id}]` | Jenis biaya |
| GET/POST/PATCH | `/api/v1/fee-schemes[/{id}]` | Tarif per unit & tahun ajaran |
| GET | `/api/v1/billing-runs` | Riwayat generate tagihan |
| POST | `/api/v1/billing-runs/preview` | Pratinjau tagihan (siswa, tarif, total) |
| POST | `/api/v1/billing-runs/generate` | Terbitkan tagihan (idempoten per unit+tahun+periode) |
| GET | `/api/v1/invoices`, `/api/v1/invoices/{id}` | Daftar & rincian tagihan |
| POST | `/api/v1/invoices/{id}/void` | Batalkan tagihan (alasan wajib, tanpa hapus data) |
| GET | `/api/v1/receivables` | Piutang + aging per unit |
| GET/POST | `/api/v1/receipts` | Daftar (filter unit/tanggal/status/cari) & catat penerimaan + alokasi |
| GET | `/api/v1/receipts/{id}` | Rincian penerimaan + alokasi per tagihan |
| POST | `/api/v1/receipts/{id}/void` | Batalkan penerimaan (tagihan kembali, mutasi keluar tercatat) |
| GET | `/api/v1/cash-bank/balances` | Saldo per rekening (masuk − keluar) + unit penerima |
| GET | `/api/v1/cash-bank/mutations` | Mutasi kas & bank + total masuk/keluar terfilter |
| GET/POST/PATCH | `/api/v1/expense-categories[/{id}]` | Jenis biaya keluar + akun beban (CoA) |
| GET/POST/PATCH | `/api/v1/vendors[/{id}]` | Vendor/penerima pembayaran |
| GET/POST | `/api/v1/expenses` | Daftar (filter unit/status/tanggal/cari) & buat pengajuan |
| GET | `/api/v1/expenses/{id}` | Rincian pengajuan + riwayat pembayaran |
| POST | `/api/v1/expenses/{id}/submit`, `/approve`, `/reject`, `/cancel` | Alur pengajuan (maker-checker) |
| GET | `/api/v1/expense-payments` | Daftar pembayaran pengeluaran |
| POST | `/api/v1/expenses/{id}/payments` | Catat pembayaran (sebagian/penuh, idempotent) |
| POST | `/api/v1/expense-payments/{id}/void` | Batalkan pembayaran + mutasi masuk balik |
| GET/POST/PATCH | `/api/v1/accounts[/{id}]` | Bagan akun (CoA) + tipe, saldo normal, postable |
| GET | `/api/v1/fiscal-periods` | Periode fiskal bulanan (dibuat otomatis saat posting) |
| POST | `/api/v1/fiscal-periods/{id}/close`, `/reopen` | Tutup/buka kembali periode (alasan wajib saat buka) |
| GET | `/api/v1/journal-entries`, `/journal-entries/{id}` | Daftar & rincian jurnal |
| POST | `/api/v1/journal-entries` | Jurnal manual (debit = kredit) |
| POST | `/api/v1/journal-entries/{id}/reverse` | Jurnal pembalik (tanpa menimpa jurnal asli) |
| GET | `/api/v1/accounting/trial-balance` | Neraca saldo per akun |
| GET | `/api/v1/accounting/general-ledger` | Buku besar per akun |
| GET | `/api/v1/accounting/reconciliation` | Piutang, uang muka, dan kas: subledger vs GL |
| POST | `/api/v1/accounting/backfill` | Posting jurnal untuk transaksi lama (idempoten) |
| GET | `/api/v1/reports/overview` | Ringkasan KPI + per cabang + per jenjang + aging + status closing |
| GET | `/api/v1/reports/position` | Posisi keuangan (aset, liabilitas, aset neto, surplus) |
| GET | `/api/v1/reports/activity` | Pendapatan & beban per akun + surplus |
| GET | `/api/v1/reports/cash-flow` | Arus kas: saldo awal, mutasi per sumber, saldo akhir |
| GET | `/api/v1/reports/drilldown` | Daftar dokumen sumber (`billed`/`collected`/`expense`/`outstanding`) |

Error memakai kode stabil: `UNIT_CODE_DUPLICATE`, `UNIT_ACTIVATION_INCOMPLETE`,
`UNIT_FINANCE_NOT_READY`, `BANK_ACCOUNT_NOT_ALLOWED`, `BANK_ACCOUNT_DEDICATED_CONFLICT`,
`BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT`, `ALLOCATION_EXCEEDS_OUTSTANDING`,
`ALLOCATION_EXCEEDS_RECEIPT`, `RECEIPT_ALREADY_VOID`, `EXPENSE_SELF_APPROVAL_FORBIDDEN`,
`EXPENSE_ACCOUNT_MAPPING_MISSING`, `PAYMENT_EXCEEDS_REMAINING`, `EXPENSE_NOT_APPROVED`,
`JOURNAL_NOT_BALANCED`, `JOURNAL_NOT_REVERSIBLE`, `ACCOUNT_MAPPING_MISSING`, `PERIOD_CLOSED`,
`PERMISSION_DENIED`, dan seterusnya.

## 7. Aturan validasi yang sudah diterapkan

- **VAL-01/02** kode & nama unit wajib, kode unik per yayasan dan tidak dipakai ulang.
- **VAL-03** jenjang/kelompok/sekolah/lokasi harus milik badan hukum yang sama.
- **VAL-04** aktivasi ditolak bila jenjang sekolah resmi tidak sesuai jenjang unit.
- **VAL-05** NPSN unik; format 8 karakter alfanumerik.
- **VAL-06** provinsi tanpa kota ditolak; kode pos 5 angka.
- **VAL-09** tidak ada hapus fisik; unit dinonaktifkan/diarsipkan.
- **BANK-01** mode `MIXED` butuh rekening `CENTRAL` dan `DEDICATED` aktif & terverifikasi.
- **BANK-02/03** rekening khusus tidak boleh dipakai dua unit pada periode tumpang tindih; rekening wajib aktif & terverifikasi.
- **BANK-04** default penerimaan/pengeluaran tidak boleh ganda pada periode yang sama.
- **ACC-01** mapping akun piutang & pendapatan wajib untuk status `READY`.
- **Audit** perubahan konfigurasi mencatat before/after, aktor, alasan, IP.
- **BILL-01** tagihan hanya untuk unit `ACTIVE` + `finance_status=READY`; duplikat unit+tahun+periode ditolak; pembatalan hanya bila belum ada pembayaran; nilai uang dihitung dalam sen agar pembagian angsuran deterministik.
- **FC-01** penerimaan hanya ke rekening `ACTIVE` + terverifikasi **dan** dipetakan ke unit pada tanggal transaksi; alokasi tidak boleh melebihi sisa tagihan (`ALLOCATION_EXCEEDS_OUTSTANDING`) maupun nilai penerimaan; `idempotencyKey` mencegah posting ganda; pembatalan tidak menghapus data (status `VOID` + mutasi keluar), tagihan/angsuran dihitung ulang dari alokasi yang masih `POSTED`; semua nilai diproses dalam sen.
- **FC-01 pengeluaran** unit harus `ACTIVE` + `READY`; jenis biaya wajib punya akun beban (**ACC-01**); pengaju **tidak boleh** menyetujui/menolak pengajuannya sendiri (maker-checker); pembayaran hanya dari rekening `ACTIVE` + terverifikasi + `allow_disbursement` untuk unit pada tanggal bayar (**BANK-03/BANK-05**); total pembayaran tidak boleh melebihi nilai pengajuan (**BANK-07**); `idempotencyKey` membuat dua permintaan identik hanya menghasilkan satu posting (**T20**); VOID mencatat mutasi masuk balik dan menghitung ulang sisa.
- **ACC-01** akun pada mapping tarif/jenis biaya/rekening harus ada di CoA dan bertipe sesuai (**ACC-01**); jurnal hanya seimbang debit = kredit (**ACC-02**); posting ke periode `CLOSED` ditolak dan pembukaan kembali wajib alasan + audit (**ACC-03**); koreksi memakai jurnal pembalik, jurnal posted tidak ditimpa; setiap sumber transaksi punya idempotency key (`INVOICE:<id>`, `RECEIPT:<id>`, `EXPENSE_PAYMENT:<id>`) sehingga backfill aman diulang.
- **Rekonsiliasi** piutang subledger vs GL `1-1200`, uang muka vs penerimaan belum dialokasikan, dan kas GL vs mutasi bank + jurnal manual; selisih yang tidak dapat dijelaskan dilaporkan apa adanya.
- **RPT-01** setiap angka ringkasan harus sama dengan hasil drill-down pada rentang & unit yang sama (tagihan, penerimaan, pengeluaran, piutang); aging wajib menjumlah ke total piutang; agregasi jenjang = agregasi unit; saldo kas laporan = saldo akun kas di buku besar; role cabang hanya menerima unit dalam scope-nya (`UNIT_FORBIDDEN` bila meminta unit lain).
- **Hardening (FD-06)** maksimum 5 percobaan login gagal per IP+email dalam 15 menit (`429 TOO_MANY_ATTEMPTS`); login berhasil tidak dihitung; respons API memakai header keamanan dan `Cache-Control: no-store`; `detail` error hanya dikirim saat `NODE_ENV !== production`; perubahan jenjang/sekolah resmi unit yang sudah bertransaksi ditolak `409 UNIT_IDENTITY_LOCKED` (VAL-08).

## 8. Pengujian

Verifikasi satu perintah (typecheck + build + semua suite UAT):

```bash
ADMIN_EMAIL=admin@sekolah.test ADMIN_PASSWORD='...' bash scripts/verify.sh
```

Tanpa kredensial, skrip hanya menjalankan typecheck dan build. Rincian skenario dan
hasil per asersi ada di **[`docs/UAT.md`](docs/UAT.md)**.

Menjalankan manual:

```bash
cd backend && yarn typecheck
cd frontend && yarn typecheck && CI=true yarn build

# UAT (DB lokal/staging)
BASE=http://127.0.0.1:4100 \
ADMIN_EMAIL=admin@sekolah.test \
ADMIN_PASSWORD='...' \
uv run --with httpx python tests/foundation_uat.py   # FD-01…FD-05
# ganti nama file: billing_uat.py · receipt_uat.py · expense_uat.py
#                  accounting_uat.py · report_uat.py
```

Hasil terakhir: Foundation **30/30**, BILL-01 **25/25**, FC-01 penerimaan **51/51**,
FC-01 pengeluaran **52/52**, ACC-01 **45/45**, RPT-01 **31/31** — total **234/234 lulus**.
Semua suite bersifat rerun-safe (kode unik per `RUN_SUFFIX`, periode unik) dan hanya untuk DB
lokal/staging. UAT ACC-01 membuat user `ACCOUNTING_PUSAT` sendiri karena izin `journal.post`
tidak diberikan ke Admin Yayasan (pemisahan tugas, blueprint §08).

## 9. Roadmap sesuai blueprint

| Fase | Cakupan |
|---|---|
| FD-01…FD-05 | ✅ Foundation (dokumen ini) |
| FD-06 | ✅ Hardening: rate limit login, header keamanan, VAL-08, `docs/API.md`, `docs/UAT.md`, `scripts/verify.sh` |
| BILL-01 | ✅ Siswa, enrollment, tarif, tagihan, cicilan, piutang |
| FC-01 | ✅ Penerimaan & alokasi, kas & bank, pengeluaran (maker-checker) |
| ACC-01 | ✅ CoA, jurnal otomatis & manual, reversal, rekonsiliasi, tutup buku |
| RPT-01 | ✅ Ringkasan cabang/jenjang/yayasan, posisi, aktivitas, arus kas, drill-down — anggaran & unit cost menyusul |
