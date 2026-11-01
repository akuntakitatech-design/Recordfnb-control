# Deploy School Finance ERP di Coolify (MariaDB + Nginx)

Monorepo ini dideploy sebagai **2 aplikasi Coolify** dari repo yang sama, plus 1 MariaDB:

| Komponen | Base directory | Build pack | Port | Domain publik |
|---|---|---|---|---|
| Frontend (React + Vite → Nginx, proxy `/api`) | `/frontend` | Dockerfile | 80 | ya |
| Backend (Express + tsx) | `/backend` | Dockerfile | 3000 | tidak |
| MariaDB 11.x (resource Coolify) | – | – | 3306 | tidak |

Browser → Traefik (Coolify) → Nginx frontend → `/api/*` diproksi ke backend lewat network alias.

## 1. Backend (aplikasi Coolify #1)

- **Base Directory**: `/backend`, **Build Pack**: Dockerfile, **Port**: `3000`.
- Image multi-stage: stage `build` meng-compile TypeScript (`yarn build` → `dist/`), stage runtime
  hanya berisi `dependencies` produksi + `dist/` + `db/migrations`. Tidak ada `tsx`/`typescript`
  di image runtime; container menjalankan `node dist/index.js` sebagai user non-root `node`.
- Tanpa domain publik. Catat nama container/alias (mis. `backend-school`) untuk `BACKEND_URL` frontend.

Environment:

```env
NODE_ENV=production
PORT=3000
DATABASE_URL=mysql://user:password@<service-mariadb>:3306/school_local
JWT_SECRET=<string acak >= 32 karakter>
COOKIE_NAME=school_session
COOKIE_SECURE=auto
BOOTSTRAP_ADMIN_EMAIL=<email admin>
BOOTSTRAP_ADMIN_PASSWORD=<password kuat>
BOOTSTRAP_ADMIN_NAME=Administrator Sekolah
```

- Skema dibuat otomatis saat start (idempoten). Admin awal dibuat dari env; password lama dipertahankan kecuali `BOOTSTRAP_ADMIN_RESET_PASSWORD=true` (hapus env itu setelah dipakai).
- Healthcheck: `GET /api/health` → `{ ok: true, database, databaseTime }`.

## 2. Frontend (aplikasi Coolify #2)

- **Base Directory**: `/frontend`, **Build Pack**: Dockerfile, **Port**: `80`. Pasang domain + HTTPS.

Environment:

```env
BACKEND_URL=http://backend-school:3000
```

- Frontend memanggil path relatif `/api`; tidak ada URL backend yang dibakar saat build.
- Pastikan frontend & backend satu network Docker.
- Healthcheck: `GET /healthz` → `ok`.

## 3. MariaDB

- Resource MariaDB ≥ 10.11 (disarankan 11.x).
- Buat database (mis. `school_local`) dan user aplikasi dengan hak penuh pada database tersebut.
- Migrasi berjalan saat backend start; tidak perlu import SQL manual.

## 4. Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| 502 `BACKEND_UNAVAILABLE` | `BACKEND_URL` salah / beda network | Samakan dengan alias container backend |
| Login sukses tapi langsung logout | Cookie `Secure` tidak cocok | Biarkan `COOKIE_SECURE=auto`, pastikan HTTPS di domain |
| `ER_ACCESS_DENIED` / `ECONNREFUSED` | `DATABASE_URL` salah | Gunakan host internal MariaDB |
| Migrasi gagal | Versi MariaDB terlalu lama | Pakai MariaDB 10.11 / 11.x |
| Container restart: `tsx: not found` | Start command memakai tool dev padahal image production tanpa devDependencies | Jalankan dari hasil build (`yarn build` + `node dist/index.js`), jangan `tsx` di runtime |
