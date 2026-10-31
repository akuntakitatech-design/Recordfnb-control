# School Finance ERP — Keuangan Yayasan Multiunit

Aplikasi keuangan untuk **satu badan hukum yayasan** dengan banyak jenjang dan cabang.
Implementasi mengikuti **Blueprint Keuangan Yayasan Multiunit V1.2**.

Status saat ini: **Foundation (FD-01 s.d. FD-05) + audit trail**. Modul tagihan, penerimaan,
pengeluaran, dan akuntansi menyusul pada fase berikutnya.

## 1. Ruang lingkup Foundation

| Area | Isi |
|---|---|
| Organisasi | Badan hukum, jenjang, kelompok sekolah, sekolah resmi (NPSN), lokasi, tahun ajaran |
| Unit / cabang | Draft → aktif → nonaktif, kode unik per yayasan, jenjang & sekolah resmi terhubung |
| Rekening campuran | Rekening fisik `CENTRAL` / `DEDICATED`, mapping per unit (`CENTRAL_SHARED` / `UNIT_DEDICATED`), masa berlaku, default penerimaan/pengeluaran |
| Kesiapan keuangan | Checklist per unit (identitas, mapping akun, rekening aktif & terverifikasi) → `READY` / `NOT_CONFIGURED` |
| Akses | Role pusat & cabang, scope unit per pengguna, permission per aksi |
| Audit | Semua perubahan konfigurasi tercatat (`before`/`after`, aktor, alasan, IP) |

**Belum termasuk (fase berikut):** siswa & enrollment, tarif, tagihan/piutang, penerimaan &
alokasi pembayaran, pengeluaran, jurnal umum, tutup buku, laporan yayasan, integrasi bank.

## 2. Tech stack

| Lapisan | Teknologi |
|---|---|
| Frontend | React 19 + TypeScript + Vite, CSS per modul, `lucide-react` |
| Backend | Node.js 22 + Express + TypeScript (`tsx`) |
| Database | MariaDB ≥ 10.11 via `mysql2` (placeholder `?`) |
| Auth | JWT 12 jam di cookie httpOnly (`school_session`), bcrypt |
| Migrasi | SQL bernomor di `backend/db/migrations`, runner idempoten (`schema_migrations`) |
| Deploy | Docker per paket; Nginx memproksi `/api` ke backend (Coolify) |

## 3. Struktur

```
backend/
  db/migrations/001_foundation.sql        # skema organisasi, unit, rekening, akses, audit
  db/migrations/002_seed_foundation.sql   # seed contoh: Yayasan, TK/SD, TK-PANAM (Draft)
  src/index.ts                            # migrasi -> bootstrap admin -> listen
  src/db.ts · src/http.ts                 # pool & helper validasi
  src/auth.ts · src/permissions.ts        # sesi, 8 role, permission, unit scope
  src/audit.ts                            # audit trail terstruktur
  src/routes/organizationRoutes.ts        # hierarki, master, unit, readiness, assignments
  src/routes/bankRoutes.ts                # rekening fisik + verifikasi
  src/routes/userRoutes.ts                # pengguna, scope unit, audit log global
  src/routes/dashboardRoutes.ts
frontend/
  src/App.tsx                             # shell + menu per permission
  src/pages/Dashboard.tsx · Organization.tsx · Units.tsx
  src/pages/BankAccounts.tsx · Readiness.tsx · Users.tsx · Audit.tsx
tests/foundation_uat.py                   # UAT T01–T10 + T19 (blueprint)
```

## 4. Menjalankan lokal

```bash
# Database
#   buat database (mis. school_finance) + user, lalu set DATABASE_URL

cd backend && cp .env.example .env      # isi DATABASE_URL, JWT_SECRET, BOOTSTRAP_ADMIN_*
yarn install && yarn dev                # http://localhost:4100/api/health

cd frontend && yarn install && yarn dev # http://localhost:4200 (proxy /api -> :4100)
```

Migrasi dan admin awal berjalan otomatis saat backend start.
`yarn db:migrate` tersedia untuk menjalankan migrasi manual.

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
| PUT | `/api/v1/users/{id}/units` | Scope unit |
| GET | `/api/v1/audit-logs` | Jejak audit (filter entitas) |
| GET | `/api/v1/dashboard` | Ringkasan yayasan |

Error memakai kode stabil: `UNIT_CODE_DUPLICATE`, `UNIT_ACTIVATION_INCOMPLETE`,
`UNIT_FINANCE_NOT_READY`, `BANK_ACCOUNT_NOT_ALLOWED`, `BANK_ACCOUNT_DEDICATED_CONFLICT`,
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

## 8. Pengujian

```bash
# Backend & frontend
cd backend && yarn typecheck
cd frontend && yarn typecheck && CI=true yarn build

# UAT Foundation (blueprint T01–T10 + T19) — DB lokal/staging
BASE=http://127.0.0.1:4100 \
ADMIN_EMAIL=admin@sekolah.test \
ADMIN_PASSWORD='...' \
uv run --with httpx python tests/foundation_uat.py
```

Hasil terakhir: **20/20 lulus**.

## 9. Roadmap sesuai blueprint

| Fase | Cakupan |
|---|---|
| FD-01…FD-05 | ✅ Foundation (dokumen ini) |
| FD-06 | Hardening, seed master final, dokumentasi API, regresi |
| BILL-01 | Siswa, enrollment, tarif, tagihan, cicilan, piutang |
| FC-01 | Penerimaan, alokasi pembayaran, pengeluaran, kas & bank |
| ACC-01 | Jurnal umum, rekonsiliasi, tutup buku |
| RPT-01 | Dashboard cabang/jenjang/yayasan + drill-down |
