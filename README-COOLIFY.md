# Deploy Akuntakita F&B Control (Recordfnb) di Coolify — MariaDB + Cloudflare R2

Monorepo ini dideploy sebagai **2 aplikasi Coolify** dari repo yang sama, plus 1 MariaDB (dan phpMyAdmin opsional):

| Komponen | Base directory | Build pack | Port | Domain publik |
|---|---|---|---|---|
| Frontend (React + Vite → Nginx, proxy `/api`) | `/frontend` | Dockerfile | 80 | **ya** (mis. `fnb.akuntakita.com`) |
| Backend (Express + tsx, MariaDB, R2) | `/backend` | Dockerfile | 3000 | **tidak** (internal saja) |
| MariaDB 11.x (resource Coolify) | – | – | 3306 | tidak |
| phpMyAdmin (service Coolify, opsional) | – | – | 80 | ya (proteksi login) |

Arsitektur: browser → Traefik (Coolify) → **Nginx frontend** → `/api/*` diproksi ke **backend** lewat nama container/alias di jaringan internal Coolify. Backend tidak pernah diekspos ke internet. Lampiran transaksi disimpan di **Cloudflare R2** (bucket privat `media-recordfnb`, file dialirkan lewat backend).

---

## 1) MariaDB

- Buat resource **MariaDB** (versi ≥ 10.5, disarankan 11.x — kode memakai `INSERT ... RETURNING`).
- Catat URL internal, contoh: `mysql://mariadb:PASSWORD@<nama-service-mariadb>:3306/default`.
- Skema dibuat **otomatis** saat backend start (`schema_migrations`, idempoten). Tidak perlu import SQL manual.
- Data lama dari PostgreSQL (2 user, workspace MEATNIGHT, company/location, profil import Quinos) sudah dikonversi di `backend/database/legacy-data/fnb_legacy_data.sql` dan **sudah diimport** ke MariaDB Coolify. Bila perlu diulang (aman, `INSERT IGNORE`):
  ```bash
  cd backend && DATABASE_URL='mysql://...' yarn db:import-legacy
  ```

## 2) Backend (aplikasi Coolify #1)

- **Source**: repo ini, branch `main`. **Base Directory**: `/backend`. **Build Pack**: Dockerfile. **Port**: `3000`.
- Jangan pasang domain publik. Catat **nama container / network alias** (mis. `backend-fnb`) — dipakai frontend.
- Environment (lihat `backend/.env.example`):

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=mysql://mariadb:PASSWORD@<nama-service-mariadb>:3306/default
JWT_SECRET=<string acak >= 32 karakter>
COOKIE_NAME=fnb_session
COOKIE_SECURE=auto
BOOTSTRAP_ADMIN_EMAIL=agustrnt@gmail.com
BOOTSTRAP_ADMIN_PASSWORD=<password kuat>
BOOTSTRAP_ADMIN_NAME=Akuntakita Admin
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=<account id cloudflare>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=media-recordfnb
R2_PREFIX=attachments
```

- Urutan start: migrasi skema → bootstrap admin → verifikasi akses bucket R2 → listen `:3000`. Log yang sehat:
  `[migration] ...`, `[bootstrap] admin ... sudah ada; password lama dipertahankan`, `[storage] attachment storage: r2 (...)`, `F&B Control listening on :3000`.
- Healthcheck: `GET /api/health` → `{ ok: true, databaseTime }`.
- **Password admin**: akun `agustrnt@gmail.com` dibawa dari PostgreSQL lama **beserta password lamanya**. Jika lupa, set `BOOTSTRAP_ADMIN_RESET_PASSWORD=true` sekali (password diganti ke `BOOTSTRAP_ADMIN_PASSWORD`), redeploy, lalu hapus env tersebut.

## 3) Frontend (aplikasi Coolify #2)

- **Source**: repo ini, branch `main`. **Base Directory**: `/frontend`. **Build Pack**: Dockerfile. **Port**: `80`. Pasang domain publik + HTTPS.
- Environment:

```env
BACKEND_URL=http://backend-fnb:3000
NGINX_PORT=80
CLIENT_MAX_BODY_SIZE=20m
```

- Pastikan frontend & backend berada di **network Docker yang sama** (Coolify: satu project/environment, atau aktifkan *Connect to Predefined Network*). `BACKEND_URL` memakai nama container/alias backend.
- Frontend selalu memanggil path relatif `/api` — tidak ada URL backend yang di-bake saat build.
- Nginx memakai `resolver` + variabel pada `proxy_pass`, sehingga bila backend restart/berganti IP, proxy pulih otomatis (sementara membalas JSON 502 `BACKEND_UNAVAILABLE`).
- Healthcheck: `GET /healthz` → `ok`.

## 4) Cloudflare R2

- Bucket privat `media-recordfnb`. API token: **Object Read & Write** untuk bucket tersebut.
- Key objek: `attachments/<workspace_id>/<transaction_id>/<uuid>-<nama-file>`; kolom `attachments.storage_path` menyimpan key ini.
- Storage lama di VPS (`/data/uploads`) sudah dicek: **0 file**, tidak ada yang perlu dimigrasi.
- Dev/fallback tanpa R2: `STORAGE_DRIVER=local` + `UPLOAD_DIR`.

## 5) phpMyAdmin (opsional)

Tambahkan service **phpMyAdmin** di project yang sama; `PMA_HOST=<nama-service-mariadb>`, `PMA_PORT=3306`. Login dengan user MariaDB.

## 6) Pengembangan lokal

```bash
# backend
cd backend && cp .env.example .env   # isi DATABASE_URL MariaDB lokal, STORAGE_DRIVER=local
yarn install && yarn dev              # :3000 (atau PORT)
# frontend
cd frontend && yarn install && yarn dev   # :3000 Vite, /api diproksi ke VITE_DEV_API_TARGET (default http://localhost:8001)
# tes
cd backend && yarn test && yarn typecheck
cd frontend && yarn typecheck && yarn build
python3 backend/tests/e2e_api.py http://localhost:8001 <email> <password>   # smoke test seluruh API (butuh DB kosong/dummy)
```

## 7) Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Frontend 502 `BACKEND_UNAVAILABLE` | `BACKEND_URL` salah / beda network | Samakan dengan nama container backend, cek network |
| Backend crash `STORAGE_DRIVER=r2 tetapi env R2_* belum lengkap` | Env R2 kurang | Lengkapi `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| Backend crash saat `HeadBucket` | Token R2 tidak punya akses bucket | Buat token *Object Read & Write* untuk `media-recordfnb` |
| Login sukses tapi langsung logout | Cookie `Secure` tidak cocok | Biarkan `COOKIE_SECURE=auto`; pastikan domain frontend HTTPS |
| `ER_ACCESS_DENIED` / `ECONNREFUSED` DB | `DATABASE_URL` salah | Pakai host internal MariaDB, bukan IP publik |
| Migrasi gagal | Versi MariaDB < 10.5 | Pakai MariaDB 10.11 / 11.x |
