# UPDATED PLAN — PHASE 2: Sales → Cash Drawer → Reconciliation → Verification → Settlement → Accounting Source

> Baseline: **Phase 1 — Foundation & Role V2** sudah **LOCKED**. Phase 2 **tidak mengubah** struktur role/navigation Phase 1 kecuali bila benar‑benar diperlukan untuk integrasi fitur ini.
>
> Repo: `/app` (Node/TS Express backend + React/Vite frontend + MariaDB).
>
> Branching: **`feat/phase2-sales-settlement`** dibuat dari baseline Phase 1 commit `bf995c4`.
> - **Local commit only** (tidak push, tidak PR) sampai user mengetik **"SAVE"**.
>
> Environment preview: **tetap pakai DB lokal** `fnb_local` + **storage local** sampai Phase 2 selesai UAT dan kita **LOCK**. **Produksi jangan disentuh**.

---

## 0) Status saat ini (progress / done)

### Sudah selesai (sebelum Phase 2)
- Phase 1 Role V2 foundation: role separation backend + nav frontend, lulus test suite (agent-tested).
- Local MariaDB `fnb_local` tersedia dan dipakai untuk regression.
- Supervisor: backend & frontend running.
- Commit Phase 1 (local):
  - `d0ecf88` (Role V2 Foundation)
  - `bf995c4` (Kas&Bank flows role-aware)

### Phase 2 — sudah dikerjakan (agent-tested lokal)

#### A. Schema / migrations
- **Migration 005 (aditif)** sudah dibuat & diaplikasikan di DB lokal (cash drawer + reconciliation + settlement allocation + extend payment methods + kolom POS baru, dll).
- **Migration 006 (aditif)** sudah dibuat & **applied lokal**:
  - `pos_payment_codes` registry (kode pembayaran POS extensible)
  - `sales_import_rows.payment_extra` (JSON) untuk metode baru tanpa tambah kolom
  - `sales_reconciliations.status` tambah `REOPENED` + reopen meta
  - `sales_reconciliation_lines` tambah `verification_round`, `line_status` (ACTIVE/VOID) + unique per round
  - `sales_settlement_allocations` tambah `status` (ACTIVE/REVERSED) + `fee_amount` + `difference_amount` + `previous_status`

> Catatan audit migrasi (penting): migrasi bersifat aditif terhadap data transaksi; tidak ada TRUNCATE/DELETE. Ada DROP constraint/index *IF EXISTS* untuk mengganti CHECK constraint agar kompatibel perubahan Phase 2.

#### B. POS import engine (reuse, extended; tidak rewrite)
- POS import tetap via `sales_import_batches`/`sales_import_rows` + preview/verify engine existing.
- `salesImportEngine.ts` kini **registry-driven**:
  - daftar kode pembayaran POS dibaca dari `pos_payment_codes` (bukan union hard-coded)
  - nilai per kode dibaca dari kolom legacy `payment_*` atau `payment_extra`
  - duplicate invoice check ignore transaksi `VOID/CANCELLED`
  - transaksi `SALES_INVOICE` dari verifikasi memiliki `source_module` & `source_reference_id`.
- `clientSalesRoutes.ts`:
  - import POS hanya Finance/Accounting (Outlet tidak bisa)
  - split otomatis menjadi **1 batch per tanggal**
  - prevent duplicate import (outlet + tanggal + invoice)
  - block verify batch langsung jika outlet punya metode pembayaran aktif (harus via rekonsiliasi)
  - **void DRAFT batch** (`POST /sales-batches/:id/void`) untuk koreksi setelah reopen (status → VOID; histori tetap)
  - `sales-context` mengembalikan `posCodes` dari registry

#### C. Payment method + reconciliation + settlement backend (Phase 2)
- Backend Phase 2 dibuat:
  - `backend/server/salesFlowEngine.ts`
  - `backend/server/salesFlowRoutes.ts` (**mounted** di `/api/sales-flow`)
  - `backend/server/posPaymentCodes.ts`
- Payment Method Master:
  - **Accounting-only** untuk create/update, termasuk:
    - metode aktif per outlet
    - behavior: CASH_DIRECT / BANK_DIRECT / SETTLEMENT
    - evidence REQUIRED/OPTIONAL
    - mapping kode POS
    - mapping accounting (clearing + fee)
  - Finance/Owner read-only.
- **Akun selisih dipisah (tanpa fallback CASH_BANK_VARIANCE)**:
  - `CASH_DRAWER_VARIANCE` (Selisih Kas)
  - `SETTLEMENT_VARIANCE` (Selisih Settlement)
  - MDR/Admin Fee tetap di `fee_account_id` per payment method.
  - Endpoint Accounting-only: `/api/sales-flow/variance-accounts`.
- Settlement:
  - hanya boleh 1 payment method + 1 outlet per transaksi settlement
  - validasi “single method/outlet” dilakukan **sebelum** cek selisih agar error deterministik
  - `SALES_SETTLEMENT` dibuat sekali, alokasi menyimpan gross+fee+selisih proporsional
- Bukti/attachments:
  - Cash Drawer: image-only JPG/JPEG/PNG/WEBP, max 7MB (backend enforce via `/api/sales-flow/evidence`)
  - Settlement & Resolution: image/PDF

#### D. Reopen/Cancel rules (Accounting Control, controlled; histori tidak dihapus)
- Reopen verifikasi setelah Finance Verified:
  - **Hanya Accounting** (`/api/sales-flow/reconciliations/reopen`)
  - **alasan wajib**, audit trail
  - **diblokir bila ada settlement aktif** → harus cancel settlement dulu
  - setelah reopen, wajib verifikasi ulang (round `-R2`, `-R3`, ...)
- Cancel settlement:
  - **Hanya Accounting** (`POST /api/sales-flow/settlements/:id/cancel`)
  - alasan wajib
  - transaksi settlement menjadi `CANCELLED`
  - jurnal settlement di-VOID atau dibuat jurnal REVERSAL (READY) bila journal sudah POSTED
  - alokasi settlement jadi REVERSED, outstanding kembali
- Saat reopen:
  - transaksi `SALES_INVOICE` dan `SALES_DIFFERENCE` yang terbentuk dari verifikasi sebelumnya di-set `VOID`
  - jurnal di-VOID / dibuat reversal
  - stok dibalik via inventory movement `ADJUSTMENT_IN` (moving average dipulihkan)
  - batch POS kembali `DRAFT` agar bisa di-verify ulang
  - snapshot reconciliation line status `VOID`

#### E. Kas & Bank + Accounting Source integration
- `cashBankRoutes.ts` MUTATIONS extended untuk membaca:
  - `SALES_VERIFICATION` (actual cash/bank direct) hanya untuk reconciliation lines ACTIVE
  - `SALES_SETTLEMENT` (net masuk bank) hanya transaksi yang tidak VOID/CANCELLED
- `accountingControlRoutes.ts` ditambah label/kind + info sumber untuk:
  - SALES_INVOICE (via SALES_VERIFICATION)
  - SALES_DIFFERENCE
  - SALES_SETTLEMENT

#### F. Technical audit (sesuai instruksi user — harus sebelum lanjut frontend)
**Audit teknis sudah dijalankan dan PASS (agent-tested lokal):**
- `git diff --stat bf995c4`: perubahan terinventarisir (file list tercatat di laporan audit internal sesi ini).
- Route Phase 2 dipastikan **ter-mount** dan guard `requireArea` terpasang di `backend/server/index.ts`.
- Audit route end-to-end:
  - script baru `tests/phase2/route_audit.py` PASS **168/168**
  - memastikan tidak ada endpoint `/api/sales-flow/*` yang bisa diakses tanpa auth / tanpa scope company/location.
- Evidence hardening (server-side):
  - magic-byte sniff (JPG/PNG/WEBP/PDF) → tidak percaya ekstensi / MIME dari client
  - reject mismatch MIME vs isi file vs ekstensi
  - enforce max 7MB (cek pre-decode + buffer)
  - route-specific JSON limit untuk evidence (`/api/sales-flow/evidence` 10mb) + handler 413 JSON
  - storage path pattern mengandung: workspace/company/location/cash-drawer/date/shift/drawer/method/line
  - akses lintas outlet ditolak (berdasar `canAccessLocation`)
  - replace evidence tercatat audit trail (`ADD_EVIDENCE` / `REPLACE_EVIDENCE`)
- Tambahan security/perimeter:
  - `/api/sales-flow/pos-codes` GET kini butuh `companyId` dan `canReadFinanceCompany`
  - cancel settlement & reopen sekarang cek location access saat applicable

#### G. Frontend Phase 2 (UI sudah dibuat & diverifikasi screenshot)
- UI pages sudah dibuat & terintegrasi:
  - `frontend/src/CashDrawerPage.tsx`
  - `frontend/src/SalesReconciliationPage.tsx`
  - `frontend/src/SalesSettlementPage.tsx`
  - `frontend/src/PaymentMethodCenter.tsx`
  - `frontend/src/salesFlowShared.ts` + `frontend/src/salesFlow.css`
- UI evidence Cash Drawer:
  - **dua input**: tombol **Kamera** (`capture`) + tombol **Pilih file**
  - pre-check client untuk format image; validasi final tetap di server
- UI gating per role (screenshot PASS, agent-tested):
  - Outlet: hanya 1 outlet (assignment), hanya Cash Drawer outlet sendiri; menu Finance tidak muncul
  - Finance: Payment Methods read-only (tanpa add/edit/poscode add), Cash Drawer read-only
  - Accounting: bisa edit Payment Methods, variance accounts, pos code registry; modal muncul

#### H. Tests + build (lokal) — rerun setelah audit fixes
- Phase 2 E2E: `tests/phase2/sales_flow_e2e.py` PASS **132/132** (termasuk evidence size/type/mismatch + cross-outlet denial + path checks + reopen/cancel/registry/variance split).
- Phase 2 route audit: `tests/phase2/route_audit.py` PASS **168/168**.
- Role matrix regression (Phase 1): `tests/role_v2/role_matrix_e2e.py` PASS **132/132**.
- Kas & Bank regression: `tests/kasbank/flows_e2e.py` dijalankan pada 3 role (Finance, Finance Staff, Accounting) → **0 failed**.
- Backend typecheck: PASS.
- Frontend typecheck: PASS.
- Backend unit tests: PASS (parser test suite sekarang 6 tests).
- Frontend build (`yarn build`): PASS.

#### I. Local test residue (tidak dihapus)
- Ada beberapa payment method “TEST Dup QRIS” status INACTIVE (hasil uji duplikasi). Ini **tidak dihapus** (sesuai prinsip no deletion). Untuk DB lokal UAT, bisa dibersihkan lewat mekanisme non-destruktif (mis. set INACTIVE/rename), bukan delete.

### Belum dikerjakan (Phase 2 remaining)
- Jalankan **testing agent** dan laporkan **15 skenario wajib** satu-per-satu (bukan hanya total PASS), termasuk bukti upload validation matrix.
- Dokumentasi final:
  - update `memory/PRD.md` (keputusan Phase 2 final, khususnya evidence hardening & permission)
  - rapihkan `plan.md` (dokumen ini) dan catatan audit ringkas
- Local commits Phase 2 (dipisah per area: migrations/backend, frontend UI, tests/docs) — **belum dilakukan**.

---

## 1) Scope & Objectives (Phase 2)

### Objective utama
Membangun alur harian F&B dari POS sampai uang benar-benar masuk Kas/Bank dan menghasilkan Accounting Source **tanpa input ganda**:

**POS Sales Import → Cash Drawer Outlet → Rekonsiliasi POS vs Aktual → Penyelesaian Selisih → Finance Verification → (Kas/Bank atau Settlement) → Accounting Source**

### Invariants / constraints (tetap dipatuhi)
- **Jangan rewrite** engine accounting, inventory, POS import, Kas & Bank existing bila masih bisa di-extend.
- **Jangan ubah ulang** struktur Role V2 foundation/navigation (kecuali perlu untuk Phase 2 flow).
- **Tidak menghapus data** dan **tidak memodifikasi transaksi historis** (koreksi memakai VOID/REVERSAL/REOPENED; histori settlement tetap).
- Finance **tidak memilih COA** di operational UI.
- Multi outlet isolation wajib.
- Stop setelah Phase 2; tunggu review; push/PR menunggu **SAVE**.
- Preview tetap lokal DB + lokal storage; produksi tidak disentuh.

---

## 2) Functional Requirements → Implementasi target

### A. POS / Penjualan (existing engine preserved)
- Tetap gunakan flow existing: `sales_import_batches` + `sales_import_rows` + `previewSalesBatch`/`verifySalesBatch`.
- Perubahan Phase 2:
  1. **Role:** upload/import POS hanya **Finance/Accounting** (Outlet user tidak boleh).
  2. **Extensible payment codes via registry**: `pos_payment_codes` menjadi sumber kebenaran kode pembayaran POS.
     - Legacy columns tetap (`payment_cash`, `payment_qris`, dst).
     - Kode baru bisa disimpan di `payment_extra` tanpa ubah schema lagi.
  3. **Multi-date file:** backend split menjadi **1 batch per tanggal**.
  4. **Imported/unverified:** batch status `DRAFT` = imported.
  5. **Duplicate import:** defendable via outlet+tanggal+invoice; ignore transaksi VOID/CANCELLED.
  6. **Hard rule:** jika outlet sudah punya konfigurasi payment methods aktif, **verifikasi batch langsung diblok** (409) dan diarahkan ke workflow **rekonsiliasi**.
  7. **Void DRAFT batch:** untuk membatalkan file salah sebelum diverifikasi (status → VOID; histori tetap).

> UI Note: pada Phase 2, halaman **Penjualan / Import POS** tetap terlihat untuk Outlet (karena nav operational Phase 1), namun **import disabled** dan menampilkan informasi “Finance-only import” (agar tidak mengubah baseline nav secara agresif tetapi tetap aman).

### B. Cash Drawer (Outlet User)
- Outlet user membuat Cash Drawer untuk **outlet assignment** saja.
- Granularity: **per outlet + business date**, **shift opsional**; multi shift dijumlah.
- Field per payment method:
  - nominal aktual
  - bukti per metode (attachment per line)
- Evidence policy per payment method: `REQUIRED` / `OPTIONAL`.
- Audit trail perubahan nominal & bukti.
- File types cash drawer evidence: **JPG/JPEG/PNG/WEBP**; max **7MB**.
- UX upload: **Kamera (capture)** dan **Pilih file**.

### C. Payment Method Master (Accounting only)
- `payment_methods` + `payment_method_locations`:
  - metode pembayaran aktif per outlet
  - mapping 1 POS code → 1 payment method per outlet
  - destination behavior: `CASH_DIRECT` / `BANK_DIRECT` / `SETTLEMENT`
  - evidence policy
  - mapping accounting:
    - direct: `financial_account_id` → debit COA via `financial_accounts.coa_account_id`
    - settlement: `clearing_account_id` + `fee_account_id`
- **Accounting saja** boleh create/update.
- Finance hanya melihat/menggunakan konfigurasi.

### D. Rekonsiliasi POS vs Cash Drawer
- Finance view per **date + outlet**:
  - POS vs Aktual vs Selisih per payment method
  - invoice drill-down (dari preview)
- Status ringkas:
  - Belum ada data / Menunggu POS / Menunggu Cash Drawer
  - Ada Selisih / Selisih Diselesaikan / Cocok
  - Finance Verified / Menunggu Settlement / Settled
- COMPLIMENT:
  - tercatat di penjualan
  - **tidak masuk rekonsiliasi, cash drawer, Kas/Bank** (registry `include_in_reconciliation=0`).

### E. Penyelesaian Selisih
- Selisih wajib alasan + catatan (LAINNYA wajib notes), audit trail.
- Lampiran optional.
- Resolusi append-only (tidak menghapus jejak selisih awal).
- Selisih Kas diposting ke akun role **CASH_DRAWER_VARIANCE**.

### F. Finance Verification
- Preconditions:
  - POS data ada
  - cash drawer ada
  - semua POS code yang muncul sudah dikonfigurasi untuk outlet
  - selisih = 0 atau ada resolusi valid
  - evidence required terpenuhi
- Action “Verifikasi Penjualan”:
  - verify invoice via engine existing (membuat SALES_INVOICE + jurnal + stok)
  - buat snapshot reconciliation lines (round)
  - buat transaksi `SALES_DIFFERENCE` bila selisih kas
  - lock cash drawer

### G. Settlement
- Outstanding settlement hanya untuk metode behavior `SETTLEMENT`.
- Finance mencatat penerimaan settlement bank:
  - full/partial
  - MDR/admin fee
  - selisih settlement (wajib konfirmasi)
  - reference + tanggal + bukti
- Sistem membentuk `SALES_SETTLEMENT` + jurnal auto:
  - Dr Bank (net)
  - Dr MDR/Admin Fee (fee_account_id)
  - Dr/Cr Selisih Settlement (SETTLEMENT_VARIANCE) bila acceptDifference
  - Cr Clearing (clearing_account_id)
- Satu settlement transaksi hanya boleh **1 payment method + 1 outlet**.

### H. Kas & Bank (reuse existing)
- Tidak buat ledger baru.
- Extend derivation MUTATIONS untuk:
  - `SALES_VERIFICATION` (cash/bank direct)
  - `SALES_SETTLEMENT` (net masuk bank)
- Filter out data VOID/CANCELLED dan reconciliation_lines VOID.

### I. Accounting Source
- Accounting Control menampilkan sumber untuk:
  - `SALES_INVOICE` (source_module SALES_VERIFICATION)
  - `SALES_DIFFERENCE`
  - `SALES_SETTLEMENT` (source_module dari registry: QRIS_SETTLEMENT/EDC_SETTLEMENT/OJOL_SETTLEMENT/...) 
- Status bucket minimal: AUTO_OK / NEEDS_REVIEW / ERROR.

---

## 3) Data Model & Migration Plan (additive, local first)

### Migration runner & constraints
- Additive only: CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS.
- Jalankan hanya di DB lokal selama development.
- File migrasi Phase 2:
  - `005_sales_cash_drawer_settlement.sql` (sudah applied lokal)
  - `006_phase2_registry_variance_reopen.sql` (sudah applied lokal)

### 005 Schema changes (implemented)
- Extend `payment_methods` + `payment_method_locations`.
- Extend `sales_import_rows`: `payment_card`, `payment_shopeefood`.
- Tambah tables:
  - `cash_drawers`, `cash_drawer_lines`
  - `sales_reconciliations`, `sales_reconciliation_lines`, `sales_reconciliation_resolutions`
  - `sales_settlement_allocations`
- Extend `transaction_headers`:
  - `source_module`, `source_reference_id` (tracking workflow)

### 006 Schema changes (implemented)
- `pos_payment_codes` registry + seed default codes:
  - CASH/QRIS/TRANSFER/CARD/GOFOOD/GRABFOOD/SHOPEEFOOD/COMPLIMENT
  - CARD aliases mencakup DEBIT/EDC/KARTU dll.
- `sales_import_rows.payment_extra` (JSON string)
- Reopen & round tracking:
  - `sales_reconciliations`: status REOPENED + reopen metadata + verification_round
  - `sales_reconciliation_lines`: verification_round + line_status + unique per round
  - `sales_settlement_allocations`: status ACTIVE/REVERSED + fee/difference allocation

---

## 4) Backend Implementation Plan

### 4.1 Extend POS import endpoints (minimal changes)
Files:
- `backend/server/clientSalesRoutes.ts`
- `backend/server/salesImportEngine.ts`
- `backend/server/posPaymentCodes.ts`

Status:
- Done (registry-driven + `payment_extra` + split by date + duplicate import guard + void DRAFT batch + block verify batch jika outlet sudah memakai metode pembayaran Phase 2).

### 4.2 Payment method configuration API (Accounting-only master)
Files:
- `backend/server/salesFlowRoutes.ts`

Endpoints:
- `GET /api/sales-flow/payment-methods?companyId=...` (Finance read-only, Accounting full)
- `POST/PUT /api/sales-flow/payment-methods` (Accounting only)

Status:
- Done.

### 4.3 POS payment code registry API
Endpoints:
- `GET /api/sales-flow/pos-codes?companyId=...` (scoped; auth required)
- `POST /api/sales-flow/pos-codes` (Accounting only)

Status:
- Done.

### 4.4 Cash Drawer API
Endpoints:
- `GET /api/sales-flow/cash-drawers/context`
- `GET /api/sales-flow/cash-drawers`
- `POST /api/sales-flow/cash-drawers`
- Evidence upload:
  - `POST /api/sales-flow/evidence`
  - `GET /api/sales-flow/evidence/:id`

Evidence validation (server-side, audited):
- Sniff magic bytes untuk tipe file (JPG/PNG/WEBP/PDF)
- Enforce tipe sesuai entityType (Cash Drawer image-only; Resolution/Settlement allow PDF)
- Enforce max 7MB (pre-decode + buffer)
- Reject MIME/ext mismatch
- Storage key mengandung scope: workspace/company/location/date/shift/drawer/method/line

Status:
- Done.

### 4.5 Reconciliation API
Endpoints:
- `GET /api/sales-flow/reconciliations`
- `GET /api/sales-flow/reconciliations/detail`
- `POST /api/sales-flow/reconciliations/resolve`
- `POST /api/sales-flow/reconciliations/verify`
- `GET /api/sales-flow/reconciliations/history`
- `POST /api/sales-flow/reconciliations/reopen` (Accounting only + reason + location scope)

Status:
- Done.

### 4.6 Settlement handling
Endpoints:
- `GET /api/sales-flow/settlements/outstanding`
- `GET /api/sales-flow/settlements`
- `POST /api/sales-flow/settlements`
- `POST /api/sales-flow/settlements/:id/cancel` (Accounting only + reason + location scope)

Status:
- Done.

### 4.7 Kas & Bank + Accounting Control integration
Files:
- `backend/server/cashBankRoutes.ts`
- `backend/server/accountingControlRoutes.ts`

Status:
- Done (MUTATIONS extended + Accounting Source fields/labels).

---

## 5) Frontend Implementation Plan

> Target UI Phase 2 sekarang **sudah tersedia** dan sudah dilakukan screenshot verification per role.

### 5.1 POS Import UI updates (dynamic registry)
Files:
- `frontend/src/ClientSalesImportPage.tsx`
- `frontend/shared/quinosInvoiceParser.ts`

Tasks (status):
- **DONE (partial / safety UI):** Outlet tidak bisa import POS; UI menampilkan info Finance-only.
- Remaining (enhancement; tidak memblokir audit keamanan):
  - pastikan payload import mendukung `{ payments: { [code]: number } }` untuk kode registry baru end-to-end dari UI.

### 5.2 Cash Drawer page (Outlet)
- Component: `frontend/src/CashDrawerPage.tsx`.
- UX:
  - outlet fixed sesuai assignment
  - pilih tanggal bisnis + optional shift
  - list metode pembayaran aktif (auto) + input nominal
  - upload bukti per metode:
    - Kamera (capture)
    - Pilih file
  - status LOCKED setelah verifikasi

Status:
- Done.

### 5.3 Rekonsiliasi Penjualan page (Finance)
- Component: `frontend/src/SalesReconciliationPage.tsx`.

Status:
- Done.

### 5.4 Settlement page (Finance)
- Component: `frontend/src/SalesSettlementPage.tsx`.
- Cancel settlement UI: Accounting-only.

Status:
- Done.

### 5.5 Master Metode Pembayaran (Accounting)
- Component: `frontend/src/PaymentMethodCenter.tsx`.
- Termasuk:
  - CRUD metode pembayaran outlet (Accounting-only)
  - variance accounts (Accounting-only)
  - POS payment code registry add (Accounting-only)

Status:
- Done.

### 5.6 Navigation integration (Phase 1 preserved)
- Update `frontend/src/App.tsx`:
  - Outlet area: add menu “Cash Drawer”
  - Finance area: add “Rekonsiliasi Penjualan” + “Settlement”
  - Master Operasional: “Metode Pembayaran” (Finance read-only, Accounting edit)

Status:
- Done.

---

## 6) Access Control & Security

- Import POS:
  - backend: only Finance/Accounting (`canCreateFinanceTransaction`)
  - UI: Outlet import disabled + explanation.
- Payment method master + variance accounts + pos code registry:
  - **Accounting only write**.
  - Finance/Owner read-only.
- Cash Drawer:
  - create/edit: Outlet (assigned location) + Accounting
  - view: Finance/Accounting/Owner
  - locked after verification
- Reconciliation:
  - resolve/verify: Finance/Accounting
  - reopen: Accounting only (reason mandatory; blocked if active settlement)
- Settlement:
  - create: Finance/Accounting
  - cancel: Accounting only (reason mandatory)
- Backend enforce:
  - `requireAuth` for all `/api/sales-flow/*`
  - `companyId` scope + `canAccessLocation` untuk isolasi outlet
  - Evidence: server-side type/size validation (magic bytes) + local storage safe path + audit.

---

## 7) Testing Plan (mandatory + regression)

### 7.1 Phase 2 E2E tests
- File: `tests/phase2/sales_flow_e2e.py`.
- Status: **PASS 132/132 (lokal)**.
- Coverage includes:
  - cash cocok/selisih
  - QRIS matched, settlement full, MDR, partial
  - OJOL settlement + selisih wajib konfirmasi
  - multi payment methods, multi outlet
  - outlet isolation, finance blocked from accounting endpoint
  - duplicate POS import
  - registry extensibility (pos code baru) end-to-end
  - reopen blocked by active settlement, cancel settlement, reopen + reverify round R2
  - variance split (cash vs settlement) + MDR bukan variance
  - evidence audit: allowed types, reject mismatch, size max 7MB, cross-outlet access denied, local storage path checks

### 7.2 Route audit tests (baru)
- File: `tests/phase2/route_audit.py`.
- Status: **PASS 168/168 (lokal)**.
- Fungsi: memastikan semua route `/api/sales-flow/*` ter-guard auth + scope + role.

### 7.3 Regression suite (wajib sebelum laporan akhir)
Status sekarang (sudah dijalankan ulang):
- `tests/role_v2/role_matrix_e2e.py` PASS 132/132
- `tests/kasbank/flows_e2e.py` (Finance, Finance Staff, Accounting) 0 failed
- backend: `yarn typecheck` PASS
- backend: `yarn test` PASS
- frontend: `yarn typecheck` PASS
- frontend: `yarn build` PASS
- Visual checks: screenshot Accounting / Finance / Outlet PASS
- Log checks: tidak ada unhandled error fatal; catatan `INVOICE_ALREADY_PAID` berasal dari test kasbank flow (expected log pattern)

---

## 8) Delivery / Reporting Requirements (end of Phase 2)

Setelah implementasi Phase 2:
- STOP (tidak lanjut Phase 3).
- Laporan wajib mencakup:
  - arsitektur workflow + state transitions (OPEN/VERIFIED/REOPENED, round Rn, settlement status)
  - file yang diubah
  - schema/migrations: 005 + 006
  - registry pos payment codes + extensibility rule
  - payment method master (Accounting-only) + variance accounts
  - cash drawer evidence + audit trail + server-side MIME sniff + 7MB enforcement
  - reconciliation/resolution/verification logic
  - settlement logic (full/partial/fee/difference) + cancel rules
  - reopen rules (VOID/REVERSAL/stock restore) + audit trail
  - permission matrix
  - hasil tes wajib + regression + build
  - risiko/tech debt (mis. journal reversal status READY, data uji duplikasi di DB lokal)
- Tidak push/PR tanpa perintah **SAVE**.

---

## 9) Execution Order (step-by-step)

1. **(DONE)** Migration 005 (local only).
2. **(DONE)** Migration 006 (registry + reopen + variance structures).
3. **(DONE)** Backend: registry-driven POS import + cash drawer/recon/settlement + variance split + cancel/reopen.
4. **(DONE)** Technical audit per instruksi user:
   - git diff vs baseline + file change inventory
   - route mounting & per-route security
   - evidence audit server-side + storage path + cross-outlet denial
   - retest full suite
5. **(DONE)** Frontend UI Phase 2:
   - Cash Drawer (Outlet)
   - Rekonsiliasi/Verifikasi (Finance)
   - Settlement (Finance) + cancel (Accounting)
   - Master Metode Pembayaran (Accounting) + Variance accounts + POS code registry
   - POS Import UI: Outlet import disabled + hint
6. **NEXT (required)** Testing agent: 15 skenario wajib + evidence validation matrix, dilaporkan satu-per-satu.
7. **NEXT** Update dokumentasi:
   - `memory/PRD.md` (keputusan Phase 2 final)
   - rapihkan `plan.md` (final snapshot untuk review)
8. **NEXT** Commit **lokal saja** (rapihkan commit per area: migrations+backend, frontend UI, tests/docs).
9. Final report Phase 2. Stop. Tunggu review user & perintah **SAVE** sebelum push/PR.
