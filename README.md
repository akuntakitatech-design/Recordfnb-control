# Akuntakita F&B Control (Recordfnb)

Finance Control & Accounting platform untuk bisnis F&B multi-company dan multi-location.

Monorepo siap deploy di **Coolify** (MariaDB + Cloudflare R2). Panduan deploy lengkap: [README-COOLIFY.md](README-COOLIFY.md).

```
backend/    Express + TypeScript (tsx) — MariaDB (mysql2) + Cloudflare R2 — port 3000
frontend/   React + Vite — disajikan Nginx, /api diproksi ke backend — port 80
legacy/     referensi docker-compose & Dockerfile single-container versi lama
docs/       catatan fitur
```

## Ringkasan migrasi (PostgreSQL -> MariaDB, local disk -> R2)

- `backend/server/db.ts`: adapter `pg`-like di atas `mysql2` — translasi otomatis `$n` -> `?`, cast `::type`, `->>`, `= ANY()`, `ON CONFLICT`, `RETURNING`, dst. Route bisnis tidak diubah.
- `backend/database/mariadb/*.sql`: skema MariaDB hasil konsolidasi 16 migrasi PG (51 tabel, FK, trigger seed payment mapping), dijalankan otomatis saat backend start.
- `backend/database/legacy-data/fnb_legacy_data.sql`: data operasional lama (user, workspace, company, location, membership, profil import) — `yarn db:import-legacy`.
- `backend/server/storage.ts`: driver lampiran `r2` (default produksi) / `local` (dev).
- `frontend/nginx/*`: reverse proxy `/api` dengan resolver runtime (pulih otomatis saat backend restart).

## Perintah

```bash
cd backend  && yarn install && yarn dev        # API
cd frontend && yarn install && yarn dev        # UI (Vite, proxy /api -> VITE_DEV_API_TARGET)
cd backend  && yarn test && yarn typecheck
cd frontend && yarn typecheck && yarn build
```
