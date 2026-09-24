# Akuntakita F&B Control (Recordfnb)

[![frontend record.akuntakita.com](https://img.shields.io/badge/frontend-record.akuntakita.com-1f6feb?style=flat-square&logo=globe&logoColor=white)](https://record.akuntakita.com) [![api record.akuntakita.com/api](https://img.shields.io/badge/api-record.akuntakita.com%2Fapi-2ea043?style=flat-square&logo=serverless&logoColor=white)](https://record.akuntakita.com/api) ![media Cloudflare R2](https://img.shields.io/badge/media-Cloudflare%20R2-f38020?style=flat-square&logo=cloudflare&logoColor=white) ![workflow PR only · emergent-agent](https://img.shields.io/badge/workflow-PR%20only%20%C2%B7%20emergent--agent-8957e5?style=flat-square&logo=github&logoColor=white)

![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white) ![Express 4](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white) ![TypeScript 5.7](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white) ![MariaDB 11](https://img.shields.io/badge/MariaDB-11-003545?style=flat-square&logo=mariadb&logoColor=white) ![React 19](https://img.shields.io/badge/React-19-20232a?style=flat-square&logo=react&logoColor=61dafb) ![Vite 6](https://img.shields.io/badge/Vite-6-646cff?style=flat-square&logo=vite&logoColor=white) ![Nginx 1.27](https://img.shields.io/badge/Nginx-1.27-009639?style=flat-square&logo=nginx&logoColor=white) ![Docker Coolify](https://img.shields.io/badge/Docker-Coolify-2496ed?style=flat-square&logo=docker&logoColor=white)


## 1. Overview Project

**F&B Control** adalah platform *finance control & accounting* untuk bisnis F&B (restoran/kafe/dapur produksi) yang berjalan **multi-workspace → multi-company → multi-location**. Aplikasi ini menjembatani operasional outlet (klien) dengan tim akuntansi (Akuntakita):

- **Sisi klien (outlet)**: input faktur pembelian, kas keluar/masuk, pemakaian bahan, transfer & opname stok, produksi berbasis BOM, import penjualan dari POS (Quinos), master item/partner per company.
- **Sisi akuntansi**: antrean verifikasi kas masuk/keluar, mesin jurnal otomatis (auto-journal engine) dari setiap transaksi, review & posting jurnal, template COA standar, kontrol akses per workspace/company/lokasi.
- **Lampiran** dokumen (nota, foto) tersimpan di Cloudflare R2; **data** di MariaDB.

Deploy produksi memakai **Coolify** (2 aplikasi: frontend Nginx + backend Node) — panduan lengkap di [README-COOLIFY.md](README-COOLIFY.md). Aturan kerja agent AI/kontributor di [AGENTS.md](AGENTS.md).

## 2. Tech Stack

| Lapisan | Teknologi | Catatan |
|---|---|---|
| Frontend | **React 18 + TypeScript + Vite** | SPA; build statis disajikan **Nginx 1.27** yang memproksi `/api/*` ke backend. Styling CSS murni per modul (`*.css`), ikon `lucide-react`. |
| Backend | **Node.js 22 + Express + TypeScript (tsx)** | REST API di `/api/*`, port 3000. Tidak ada build step — `tsx` menjalankan TS langsung. |
| Database | **MariaDB ≥ 10.11** (produksi 11.8) via `mysql2` | Adapter `server/db.ts` memberi API mirip `pg` (`query`, `pool.connect`, `$1` → `?`, `RETURNING`, `->>`, `ON CONFLICT`). Skema & seed dijalankan otomatis saat start (`server/migrate.ts`, tabel `schema_migrations`). |
| Auth | **JWT (12 jam) di cookie httpOnly** `fnb_session` | `bcryptjs` untuk password; otorisasi berbasis **role per workspace membership** (`server/access.ts`: `canAccessCompany`, `canCreateTransaction`, `canPostJournal`, …). `COOKIE_SECURE=auto` mengikuti `X-Forwarded-Proto`. |
| Storage | **Cloudflare R2** (S3-compatible, `@aws-sdk/client-s3`) | `server/storage.ts` — driver `r2` (produksi) / `local` (dev). File dialirkan lewat backend (bucket privat). |
| Perhitungan bersama | `shared/transactionMath.ts`, `shared/bomMath.ts`, `shared/quinosInvoiceParser.ts` | Kode **identik** di `backend/shared` dan `frontend/shared` agar angka di UI = angka di server. `decimal.js` untuk presisi uang. |
| Uji | `node:test` (unit), `tests/e2e_api.py` (smoke seluruh API) | Lihat §6. |
| Deploy | Docker (Dockerfile per paket), Coolify, MariaDB + phpMyAdmin (opsional) | Nginx `proxy_pass` dengan resolver runtime → frontend tetap hidup saat backend restart. |

## 3. Folder Structure

```
Recordfnb-control/
├── backend/                         # API Express (Node 22, TypeScript via tsx)
│   ├── server/
│   │   ├── index.ts                 # bootstrap app: middleware, mount router /api/*, urutan start (migrasi → admin → R2 → listen)
│   │   ├── db.ts                    # adapter pg-like di atas mysql2 (translasi SQL, transaksi, pool)
│   │   ├── migrate.ts               # runner SQL idempoten untuk database/mariadb/*.sql
│   │   ├── auth.ts                  # JWT + cookie sesi, requireAuth, hashing password
│   │   ├── access.ts                # otorisasi role per workspace/company/location (can*/has*)
│   │   ├── bootstrap.ts             # pembuatan/penjagaan admin sistem dari env BOOTSTRAP_ADMIN_*
│   │   ├── storage.ts               # driver lampiran: r2 | local (put/get/remove/verifyStorage)
│   │   ├── *Routes.ts               # HTTP layer per modul (validasi input → panggil engine/query → respons JSON)
│   │   │   masterRoutes, financeMasterRoutes, clientMasterRoutes, clientTransactionRoutes (+ attachments),
│   │   │   clientCashIn/OutRoutes, clientItemUsageRoutes, clientStockTransfer/OpnameRoutes,
│   │   │   clientBomProductionRoutes, clientSalesRoutes, clientSalesImportProfileRoutes,
│   │   │   transactionRoutes, journalRoutes, accountingCashIn/OutRoutes, coaTemplateRoutes, accessRoutes
│   │   └── *Engine.ts               # logika bisnis murni dalam transaksi DB (tanpa HTTP):
│   │       journalEngine (auto-journal), cashIn/cashOutEngine, itemUsageEngine, stockTransferEngine,
│   │       stockOpnameEngine, productionEngine (BOM), salesImportEngine (POS Quinos)
│   ├── shared/                      # matematika & parser yang dibagi dengan frontend (salinan identik)
│   ├── database/
│   │   ├── mariadb/                 # 001_schema.sql (51 tabel, FK), 002_seed_roles_and_coa_templates.sql, 003_trigger_*.sql
│   │   ├── legacy-data/             # data operasional lama dari PostgreSQL (INSERT IGNORE, idempoten)
│   │   └── legacy-postgres-migrations/  # 16 migrasi PG asli — referensi historis, tidak dijalankan
│   ├── scripts/                     # migrate.ts (yarn db:migrate), importLegacyData.ts (yarn db:import-legacy)
│   ├── tests/                       # *.test.ts (node:test) + e2e_api.py (smoke seluruh API)
│   ├── Dockerfile · .dockerignore · .env.example · package.json · tsconfig.json
├── frontend/                        # SPA React + Vite
│   ├── src/
│   │   ├── main.tsx · App.tsx       # entry, routing, shell menu (grup Klien / Akuntansi / Master / Pengaturan)
│   │   ├── api.ts                   # helper fetch (credentials: include, error → Error(body.error))
│   │   ├── Client*.tsx              # halaman sisi klien (PurchaseInvoice, CashIn/Out, ItemUsage, StockTransfer, StockOpname,
│   │   │                            #   BomProduction, SalesImport*, ItemCenter, PartnerCenter, InventoryControl)
│   │   ├── Accounting*Queue.tsx     # antrean verifikasi akuntansi
│   │   ├── JournalCenter.tsx · StandardCoaCenter.tsx · MasterFinanceCenter.tsx · MasterItemCenter.tsx
│   │   ├── UserAccessCenter.tsx · SettingsSecurity.tsx
│   │   ├── TransactionForm.tsx · SearchSelect.tsx   # komponen bersama
│   │   └── *.css                    # style per modul (+ foundation.css, styles.css, menuGroups.css)
│   ├── shared/                      # salinan identik backend/shared
│   ├── nginx/                       # default.conf.template + *.envsh (normalisasi BACKEND_URL, resolver fallback)
│   ├── Dockerfile · .dockerignore · vite.config.ts · package.json · tsconfig.json
├── docs/                            # catatan fitur (mis. v0.16a flexible POS import)
├── legacy/                          # docker-compose & Dockerfile single-container versi lama (referensi)
├── .github/                         # ci.yml.example (workflow CI; aktifkan dengan memindahkan ke workflows/)
├── AGENTS.md                        # SOP kerja agent AI (Load by token → kerja → Save via PR)
├── README-COOLIFY.md                # panduan deploy Coolify: env, alias jaringan, MariaDB, R2, troubleshooting
└── README.md
```

## 4. Data Flow

### 4.1 Alur request umum

```
Browser (React SPA, cookie fnb_session)
   │  fetch('/api/…', credentials: 'include')          ← path relatif, tanpa URL absolut
   ▼
Nginx (container frontend, :80, domain publik)
   │  location /api/ → proxy_pass http://backend-fnb:3000 (alias jaringan Coolify)
   │  meneruskan X-Forwarded-Proto/Host; 502 JSON BACKEND_UNAVAILABLE jika backend belum siap
   ▼
Express (backend, :3000, tanpa domain publik)
   │  cookieParser → requireAuth (verifikasi JWT → req.sessionUser)
   │  *Routes.ts: validasi & normalisasi input → access.ts (cek role di workspace/company/location)
   │  *Engine.ts: logika bisnis dalam 1 transaksi DB (pool.connect → BEGIN … COMMIT/ROLLBACK)
   ▼
db.ts (adapter pg-like) ── SQL diterjemahkan ($1→?, RETURNING, ->>, ON CONFLICT) ──▶ MariaDB
   │
   └─ storage.ts ──(lampiran: put/get/remove)──▶ Cloudflare R2 (bucket privat, key: attachments/<workspace>/<tx>/<uuid>-<nama>)
```

### 4.2 Alur bisnis utama: transaksi klien → jurnal akuntansi

```
1. Klien membuat dokumen (mis. Purchase Invoice)  → POST /api/client-transactions
   • transactionMath (shared) menghitung subtotal/diskon/pajak/total — sama di UI dan server
   • header + lines disimpan (transaction_headers, transaction_lines), nomor dokumen dari document_sequences
   • lampiran → POST /api/client-transactions/:id/attachments → R2 + tabel attachments
2. Kas keluar/masuk, pemakaian bahan, transfer/opname stok, produksi BOM, import penjualan POS
   → engine masing-masing menulis mutasi stok (inventory) & transaksi keuangan
3. journalEngine (auto-journal) membentuk journal_headers + journal_lines dari aturan pemetaan akun
   (chart_of_accounts, payment/sales mapping) — status DRAFT
4. Akuntansi: antrean verifikasi (/api/accounting-cash-ins|outs) → review jurnal (/api/journals)
   → posting oleh role yang berwenang (canReviewJournal / canPostJournal)
5. Laporan & pusat jurnal membaca data terposting (JournalCenter, MasterFinanceCenter)
```

### 4.3 Siklus hidup backend saat start

`runMigrations()` (skema/seed idempoten) → `bootstrapAdmin()` (admin dari env; password lama dipertahankan) → `verifyStorage()` (HeadBucket R2, *fail fast* bila env kurang) → `app.listen(3000)`. Healthcheck: `GET /api/health` → `{ ok, databaseTime }`.

## 5. Coding Conventions

### 5.1 Bahasa & penamaan
- **Bahasa**: teks UI, pesan error yang dibaca pengguna, commit, PR, dan dokumentasi dalam **Bahasa Indonesia**. Kode error API berupa konstanta `UPPER_SNAKE_CASE` (`TRANSACTION_NOT_FOUND`, `FORBIDDEN`, `ATTACHMENT_STORAGE_UNAVAILABLE`) — frontend menerjemahkannya ke teks.
- **File backend**: `camelCase.ts` dengan sufiks peran — `<modul>Routes.ts` (HTTP), `<modul>Engine.ts` (logika bisnis), infrastruktur tanpa sufiks (`db.ts`, `auth.ts`, `access.ts`, `storage.ts`). Awalan `client` = fitur sisi outlet, `accounting` = sisi akuntansi.
- **File frontend**: komponen/halaman `PascalCase.tsx` (satu halaman satu file), style pendamping `camelCase.css` dengan nama sama (`ClientCashOut.tsx` ↔ `clientCashOut.css`), util `camelCase.ts` (`api.ts`).
- **Variabel/fungsi**: `camelCase`; tipe/interface `PascalCase`; konstanta modul `UPPER_SNAKE_CASE`. Fungsi otorisasi berawalan `can*`/`has*`. Kolom database & JSON API **`snake_case`** (mengikuti skema: `workspace_id`, `file_name`, `uploaded_at`) — jangan mengubah ke camelCase di response.
- **Identifier**: UUID string untuk semua primary key; waktu dalam UTC ISO-8601 (`created_at`, `updated_at`).

### 5.2 Backend
- Route hanya: baca & validasi input (`text()`/`num()` helper), cek akses via `access.ts`, panggil engine/query, kirim JSON + status yang tepat (`201` create, `204` delete, `400` validasi, `403` akses, `404` tidak ada, `502` layanan luar). Tidak ada logika bisnis di route.
- Operasi multi-tabel selalu dalam **satu transaksi** (`const client = await pool.connect(); BEGIN … COMMIT; ROLLBACK di catch; release di finally`).
- Tulis SQL gaya PostgreSQL (`$1`, `RETURNING`) — `db.ts` menerjemahkan ke MariaDB. Hindari fitur PG yang tidak didukung adapter (array literal, `jsonb_*`, CTE rekursif); jika perlu fitur baru, tambahkan di `db.ts` **beserta unit test**, jangan tulis SQL MariaDB mentah di route.
- Perubahan skema = file baru bernomor di `database/mariadb/NNN_deskripsi.sql`, idempoten (`IF NOT EXISTS`, `INSERT IGNORE`); jangan mengubah file migrasi yang sudah pernah jalan.
- Konfigurasi hanya lewat `process.env` dengan default aman untuk dev; setiap env baru dicatat di `.env.example` dan `README-COOLIFY.md` (wajib vs opsional + default).
- Log ke `console` dengan awalan modul dalam kurung siku: `[migration]`, `[bootstrap]`, `[storage]`, `[attachments]`. Tidak ada `console.log` debug tersisa di PR.
- `import … from './x.js'` (ESM, ekstensi `.js` walau sumber `.ts`), `node:` prefix untuk modul inti.

### 5.3 Frontend
- Komponen fungsi + hooks; state lokal per halaman, tanpa state manager global. Semua pemanggilan API lewat `api<T>()` di `api.ts` (bukan `fetch` langsung) dan path **relatif** `/api/...`.
- Perhitungan angka **wajib** memakai `shared/*` (jangan hitung ulang di komponen) agar sama dengan server.
- Elemen interaktif dan data penting memakai `data-testid` kebab-case (`purchase-invoice-submit`, `attachment-list`).
- Style: CSS per modul dengan kelas berprefiks nama modul (`.cash-out__table`), token warna/spasi di `foundation.css`; tidak menambah library UI/ikon baru tanpa persetujuan.
- Perubahan di `shared/` dilakukan **di kedua salinan** (`backend/shared` dan `frontend/shared`) dalam commit yang sama.

### 5.4 Pengujian & kualitas
- Unit: `node:test` di `backend/tests/*.test.ts` untuk `shared/*` dan logika murni. Smoke API: `python3 backend/tests/e2e_api.py <base_url> <email> <password>` (menjalankan hampir semua route termasuk lampiran R2) → harus `gagal: 0`.
- Sebelum PR: `cd backend && yarn test && yarn typecheck`; `cd frontend && yarn typecheck && yarn build`. Frontend harus lulus build dengan `CI=true`.
- Format: TypeScript `strict`, 2 spasi, kutip tunggal, titik koma; ikuti gaya file yang sedang diedit.

### 5.5 Git
- Branch `feat/…`, `fix/…`, `docs/…`, `chore/…`, `refactor/…`; commit **Conventional Commits** (`feat(storage): …`); satu PR = satu tujuan, base `main`, tidak merge sendiri. Detail alur (Load by token → kerja → Save via PR) di [AGENTS.md](AGENTS.md).
- Jangan commit `.env*` (kecuali `.env.example`), dump data, `node_modules/`, `dist/`, folder upload.

## 6. Menjalankan secara lokal

```bash
# Backend (butuh MariaDB lokal; STORAGE_DRIVER=local untuk tanpa R2)
cd backend && cp .env.example .env && yarn install && yarn dev        # http://localhost:3000/api/health

# Frontend (Vite dev server; /api diproksi ke VITE_DEV_API_TARGET, default http://localhost:8001)
cd frontend && yarn install && yarn dev

# Uji
cd backend  && yarn test && yarn typecheck
cd frontend && yarn typecheck && yarn build
python3 backend/tests/e2e_api.py http://localhost:3000 <email> <password>

# Migrasi & data lama (opsional)
cd backend && yarn db:migrate && yarn db:import-legacy
```

Login awal: `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` dari `.env` (dibuat saat backend pertama start).
