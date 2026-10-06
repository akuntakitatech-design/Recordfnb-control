# Role V2 — Foundation (Phase 1)

Pemisahan area kerja per role memakai role engine existing (`roles` + `workspace_memberships`), **tanpa role baru, tanpa tabel/kolom baru, tanpa migrasi schema**.

## Kelompok role

| Area | Role (kode existing) |
|---|---|
| Finance Control | `CLIENT_FINANCE_MANAGER`, `CLIENT_FINANCE_STAFF` |
| Accounting Control | `AK_SUPER_ADMIN`, `AK_ACCOUNTING_REVIEWER`, `AK_ACCOUNTING_STAFF` |
| Owner (read-only) | `CLIENT_OWNER` |
| Outlet | `CLIENT_OUTLET_USER` (dibatasi `location_id` membership) |
| System Admin | flag `users.is_system_admin` — administrasi teknis saja, **tidak** otomatis akses bisnis/Accounting |

Scope tetap mengikuti `company_id` / `location_id` membership (1 company = 1 pembukuan, multi location/outlet).

## Permission matrix (backend)

| Area / endpoint | Finance | Accounting | Owner | Outlet | System Admin (tanpa membership) |
|---|---|---|---|---|---|
| Accounting: `/api/journals`, `/api/accounting-control`, `/api/accounting-periods`, `/api/accounting-cash-ins`, `/api/accounting-cash-outs`, `/api/master/coa-standard`, `GET /api/master/accounts`, `/api/transactions` (recent, drafts) | 403 | ✔ (scope company) | 403 | 403 | 403 |
| `POST /api/transactions/:id/verify` (verifikasi invoice pembelian) | ✔ | ✔ | 403 | 403 | 403 |
| Kas & Bank `/api/cash-bank/*` | ✔ | ✔ | baca saja | 403 | 403 |
| Pembelian, Kas Masuk/Keluar, Hutang, Produksi (`/api/client-transactions/purchase-invoices`, `cash-ins`, `cash-outs`, `financial-accounts`, `open-payables`, `productions`, `inventory-control`, `stock-card`) | ✔ | ✔ | baca saja | 403 | 403 |
| Penjualan/POS, Pemakaian, Transfer, Stock Opname (`sales-*`, `item-usage*`, `stock-transfer*`, `stock-opname*`) | ✔ | ✔ | baca saja | ✔ hanya location assignment | 403 |
| Verifikasi Finance transaksi | ✔ | ✔ | 403 | 403 | 403 |
| BOM/Resep `GET /boms`, `/bom-context` | lihat | lihat | lihat | 403 | 403 |
| BOM/Resep `POST /boms` (create / edit = versi baru), `DELETE /boms/:id` (nonaktif) | 403 | ✔ | 403 | 403 | 403 |
| Master operasional (`/api/client-master/items`, `partners`) | ✔ | ✔ | 403 | 403 | 403 |
| Master accounting/setup (unit, kategori, akun, pajak, rekening, kategori biaya) | 403 | ✔ | 403 | 403 | 403 |
| Organisasi (`/api/master/workspaces`, `companies`, `locations`) | baca | ✔ | baca | baca (scope) | ✔ |
| User & Akses (`/api/access/*`) | 403 | `AK_SUPER_ADMIN` | 403 | 403 | ✔ |

Kode error: `ACCOUNTING_ROLE_REQUIRED`, `OWNER_READ_ONLY`, `OUTLET_AREA_FORBIDDEN`, `BOM_ACCOUNTING_ONLY`, `LOCATION_FORBIDDEN` (existing), `FORBIDDEN_COMPANY` (existing).

Implementasi: `backend/server/access.ts` (`requireArea`, `AREA.*`, `canCreateFinanceTransaction`, `canAccessAccountingCompany`, `canManageBom`), dipasang di `backend/server/index.ts` sebagai guard per router (lapis pertama); cek scope company/location tetap di masing-masing route.

## Menu per role (frontend `App.tsx`)

- **Finance**: Dashboard · Finance Control (Penjualan, Kas & Bank, Pembelian, Hutang Supplier) · Inventory (Pemakaian, Transfer, Stock Opname, Kontrol & Kartu Stok, Produksi) · Master Operasional (Barang/Item, Supplier & Relasi) · Pengaturan
- **Accounting**: semua menu Finance + Accounting Control (Control Center, Accounting Source, COA & Mapping, Jurnal/Engine, BOM/Resep, Periode & Closing, Finance Master, Barang & Inventory) + Organisasi (+ User & Akses untuk `AK_SUPER_ADMIN`)
- **Owner**: Dashboard read-only · Pengaturan
- **Outlet**: Dashboard outlet · Penjualan · Pemakaian · Transfer · Stock Opname · Pengaturan
- **System Admin**: Dashboard teknis · User & Akses · Organisasi · Pengaturan
- Menu lama *Kas / Bank Masuk* dan *Kas / Bank Keluar* dilipat ke Kas & Bank (tab **Penerimaan Lain** dan **Pengeluaran Rinci**); engine & data tidak berubah.

## Uji

```
python3 tests/role_v2/seed_local.py        # DB LOKAL saja: outlet QA2 + user qa.* per role (ALLOW_SEED=1)
python3 tests/role_v2/role_matrix_e2e.py   # permission matrix + regression transaksi per role
```
