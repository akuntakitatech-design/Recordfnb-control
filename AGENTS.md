# AGENTS.md — SOP kerja agent AI (vibe coding via Emergent) untuk aplikasi Akuntakita

Berlaku untuk semua repo aplikasi Akuntakita yang dikembangkan **hanya lewat agent Emergent**:
`Adm-Perkebunan`, `Procurment-app` (KelolaKita Procurement), `Recordfnb-control` (Record F&B), dan repo berikutnya.
Tujuan dokumen ini satu: **alur kerja mulus, 0 regresi, semua perubahan masuk lewat Pull Request yang jelas dan bisa direview.**

| Aplikasi | Repo (`akuntakitatech-design/…`) | Backend | Alias jaringan Coolify | Bucket R2 | Domain |
|---|---|---|---|---|---|
| Adm-Perkebunan (Payroll) | `Adm-Perkebunan` | Node/Express | `backend-perkebunan:3000` | `media-admperkebunan` | (lihat Coolify) |
| KelolaKita Procurement | `Procurment-app` | FastAPI | `backend-procurement:8000` | `media-procurmentapp` | `proc.akuntakita.com` |
| Record F&B Control | `Recordfnb-control` | Node/Express | `backend-fnb:3000` | `media-recordfnb` | `record.akuntakita.com` |

Setiap repo punya **PAT fine-grained sendiri** (diberikan pemilik lewat file `CredProd*.txt`). Ringkasan 10 detik di §0, dua prompt standar pemilik di §6.

---

## 0. Ringkasan 10 detik

```
Bahasa Indonesia  ·  konfirmasi rencana dulu  ·  cari sumber kebenaran (repo/VPS), jangan menebak
branch dari main  ·  kerjakan  ·  uji dengan bukti angka  ·  commit rapi  ·  push  ·  PR ke main  ·  jangan merge sendiri
secret tidak pernah masuk repo/PR  ·  data production tidak diubah tanpa perintah eksplisit + backup
```

## 1. Bahasa, gaya, dan komunikasi

- Semua komunikasi, commit, PR, dokumentasi, dan teks UI dalam **Bahasa Indonesia**.
- Jawaban **singkat dan konkret**: angka, status code, nama file, tautan PR. Hindari ulasan panjang tanpa data.
- Sebelum eksplorasi/mengubah kode untuk tugas baru: **konfirmasi rencana** dengan pemilik (1 pesan, poin bernomor, pilihan a/b/c). Setelah "gas"/"ya", jalankan **sampai tuntas tanpa konfirmasi ulang** kecuali menemukan keputusan yang mengubah data production atau arah produk.
- Kalau ada temuan yang mengubah asumsi awal (contoh: ternyata ada versi aplikasi lebih baru di VPS), **laporkan dulu** dengan bukti (path, commit, jumlah perbedaan), baru lanjut setelah pemilik memilih.
- Pemilik tidak selalu tahu env/arsitektur lama (aplikasi hasil vibe coding). Tugas agent: **menemukan dan menjelaskan**, bukan bertanya balik "env-nya apa".

## 2. Sumber kebenaran (source of truth) — wajib diverifikasi

Pelajaran nyata (2026-09): migrasi pertama Procurement memakai versi lama (`/opt/procurement`) padahal versi yang berjalan adalah KelolaKita (`/home/ubuntu/procurement-tenant-test`, 193 commit lebih baru). Jangan terulang.

Sebelum menyentuh kode, pastikan **versi mana yang benar-benar dipakai**:
1. `docker ps` di VPS → cocokkan container yang melayani port/domain yang disebut pemilik (`docker inspect` label `com.docker.compose.project.working_dir`).
2. Bandingkan branding/fitur di UI yang pemilik tunjukkan (screenshot) dengan source (`grep` nama brand, halaman, route).
3. Bandingkan `git log` / jumlah commit antar kandidat source; laporkan mana yang terbaru dan perbedaannya (file baru, layer baru).
4. Env lama diambil dari **container yang berjalan** (`docker exec <c> env`), bukan dari `.env.example` — itu satu-satunya daftar env yang pasti lengkap.
5. Data lama: cek **isi sebenarnya** (jumlah dokumen/baris per koleksi/tabel, isi volume upload) sebelum memutuskan migrasi. "0 file" juga temuan yang harus dilaporkan.

## 3. Identitas, akses, dan rahasia

- Commit memakai identitas agent (`git config user.name/email`) yang disepakati; cek `git log -1 --format=%an` sebelum push.
- Push/PR memakai **GitHub fine-grained PAT** dari pemilik lewat HTTPS `https://x-access-token:<TOKEN>@github.com/<org>/<repo>.git`, disimpan hanya di variabel shell sesaat / file di luar repo (mis. `/root/creds/`).
- PAT tiap repo bisa berbeda dan bisa **tanpa scope `workflow`** → file `.github/workflows/*.yml` akan ditolak saat push. Solusi: simpan sebagai `.github/ci.yml.example` + catatan di PR, jangan memaksa.
- Semua kredensial yang dikirim pemilik lewat chat/file (`Cred*.txt`) dianggap **terekspos**: pakai untuk bekerja, jangan pernah salin ke repo, README, PR body, commit message, atau ringkasan. Sarankan rotasi saat go-live.
- File kredensial dari Windows sering **CRLF** — selalu `tr -d '\r'` sebelum dipakai; nilai ber-spasi (mis. `DEFAULT_TENANT_NAME=PT REAL`) tidak boleh di-`source` langsung di bash (pakai `set -a; source` dengan nilai dikutip, atau baca lewat Python).
- Sebelum push, wajib scan: `git grep -n -I -E "<potongan password/secret/token>"` → harus kosong.

## 4. Larangan keras

- Tidak ada push langsung ke `main`. Tidak ada `--force` ke branch yang PR-nya sudah dibuka (kecuali merapikan commit sendiri sebelum direview, dengan `--force-with-lease`).
- Tidak commit: `.env*` (kecuali `.env.example`), dump data (`*.sql.gz`, `*.archive`, mongodump), key, `node_modules/`, `build/`, `dist/`, `__pycache__/`, folder upload, `test_reports/`, `memory/`, `.emergent/`.
- Tidak menghapus/menimpa data production tanpa perintah eksplisit **dan** backup (dump) yang lokasinya dilaporkan.
- Tidak membuat mock/data palsu agar "terlihat jalan". Fitur tanpa kredensial → tampil *unavailable* apa adanya dan ditulis **MOCKED/UNAVAILABLE** dengan huruf kapital di ringkasan.
- Tidak menyatakan "selesai/fixed" tanpa bukti uji (§7). Tidak menutup tugas dengan bug yang diketahui belum diperbaiki.
- Tidak mengubah `REACT_APP_BACKEND_URL` (frontend) dan `MONGO_URL`/`DATABASE_URL` preview di `.env` Emergent tanpa alasan infrastruktur.

## 5. Arsitektur standar (semua aplikasi Akuntakita di Coolify)

```
repo (monorepo)
├── backend/    FastAPI (Python) atau Node/Express (TS) · Dockerfile · .env.example · .dockerignore
├── frontend/   React (CRA/Vite) → build statis di Nginx · Dockerfile · nginx/default.conf.template (+ *.envsh)
├── README.md · README-COOLIFY.md (panduan deploy) · AGENTS.md (dokumen ini)
└── legacy/     compose/skrip lama sebagai referensi (tidak dipakai deploy)
```

- **Database: MariaDB** (Coolify, ≥ 10.11; produksi saat ini 11.8). Aplikasi lama Mongo → shim Motor-kompatibel (`mariadb_motor.py`); aplikasi lama PostgreSQL → adapter `pg`-kompatibel (`server/db.ts`). Skema dibuat/diverifikasi **otomatis saat start** (idempoten). Jangan menulis ulang query bisnis kalau adapter bisa menanganinya.
- **Storage: Cloudflare R2** (S3-compatible, bucket privat per aplikasi, file dialirkan lewat backend; `STORAGE_DRIVER=s3|r2`, fallback `local` hanya untuk dev). Key objek deterministik dan disimpan di DB.
- **Jaringan Coolify:** frontend = satu-satunya yang punya domain publik; Nginx memproksi `/api/*` ke backend lewat **network alias** (`backend-procurement:8000`, `backend-fnb:3000`, dst.). Backend tanpa domain publik. `proxy_pass` memakai variabel + `resolver` agar frontend tidak gagal start saat backend belum hidup (balas JSON 502 `BACKEND_UNAVAILABLE`, pulih otomatis).
- **Cookie/sesi:** `COOKIE_SECURE=auto` (ikuti `X-Forwarded-Proto`) + `trust proxy`. Frontend memanggil path relatif `/api` — tidak ada URL backend yang di-bake saat build.
- **Multi-tenant (KelolaKita):** `DEFAULT_TENANT_ID/COMPANY_ID/SLUG/NAME` harus **konsisten dengan data yang ada di DB**; nilai berbeda = tenant kosong kedua dan data lama "hilang" dari UI. `PLATFORM_ADMIN_*` wajib (backend fail-fast bila kosong). Dokumen dengan `id` sama di beberapa tenant disimpan dengan `pk = "<tenant_id>:<id>"`.
- **Env:** semua env dan artinya dicatat di `backend/.env.example` (placeholder) dan tabel di `README-COOLIFY.md`. Env **opsional** (SMTP, `MAX_UPLOAD_MB`, dsb.) ditandai opsional beserta default-nya, supaya pemilik tidak bingung "kok ada SMTP".

## 6. Alur kerja wajib (setiap tugas) — sistem "Load by token → kerja → Save via PR by token"

Pemilik memakai **dua prompt standar** di Emergent (dan platform AI lain). Agent wajib mengenali dan menjalankannya persis:

### 6.1 Prompt LOAD — "hubungkan ke repository GitHub saya…"
> *"Hubungkan ke repository GitHub saya dan cek seluruh commit akhir-akhir yang telah saya kerjakan, install dependencies dan jalankan app web saya di live preview Emergent. github_pat: … Repo: …"*

Yang harus dilakukan, berurutan:
1. Clone via PAT: `git clone https://x-access-token:<PAT>@github.com/akuntakitatech-design/<Repo>.git` (PAT hanya di variabel shell). Set identitas commit agent.
2. **Cek riwayat**: `git log --oneline -15`, PR terbuka (`GET /repos/…/pulls?state=open`), dan branch terakhir yang di-push. Laporkan ke pemilik: commit terakhir, PR yang masih terbuka, apakah `main` sudah memuat PR terakhir.
3. Baca `AGENTS.md`, `README-COOLIFY.md`, `backend/.env.example` → susun `.env` dev preview (DB MariaDB lokal atau Coolify sesuai instruksi; **jangan** menebak env — tanya bila kredensial tidak ada).
4. Install dependencies (`yarn install` frontend; `pip install -r requirements.txt` / `yarn install` backend), arahkan supervisor ke runtime yang benar, start, cek healthcheck + login, screenshot 1 halaman utama.
5. Laporkan status singkat: apa yang jalan, apa yang MOCKED/unavailable, dan tanyakan tugas berikutnya.

### 6.2 Prompt SAVE — "Buatkan saya Pull request seluruh perubahan code…"
> *"Buatkan saya Pull request seluruh perubahan code yang berubah dari Emergent sesi chat ini ke repository GitHub saya, mulai dari PR #1; jika sudah ada PR, sesuaikan di PR terakhir."*

Aturannya:
1. **Repo kosong** → push dulu **baseline** (riwayat asli aplikasi) ke `main`, baru branch fitur; agar diff PR = perubahan sesi ini saja.
2. **Belum ada PR terbuka dari sesi ini** → branch baru dari `main` (`feat/…`, `fix/…`, `docs/…`), push, buat PR baru dengan base `main` → nomornya melanjutkan urutan repo (PR #1, #2, …).
3. **Sudah ada PR terbuka dari sesi ini** → **jangan** buat PR baru; commit ke branch PR itu, push, lalu **perbarui judul/body PR** agar mencerminkan seluruh isi (edit via `PATCH /pulls/<n>`). Satu sesi = satu PR berjalan sampai di-merge pemilik.
4. **PR terakhir sudah di-merge** → sinkron `main`, branch baru, PR baru (nomor berikutnya).
5. Squash commit `wip:`; pesan commit tidak boleh berisi teks chat. Body PR memakai template §9. Sebelum push: scan secret (§3).
6. Balas pemilik dengan **tautan PR**, ringkasan +/~/−, env yang berubah (nama saja), urutan redeploy.
7. **Jangan merge sendiri.** Setelah pemilik merge, hapus branch remote, dan sesi berikutnya mulai dari `main` terbaru.

### 6.3 Langkah kerja di antara LOAD dan SAVE

```
0. Konfirmasi rencana (ask_human) → dapat "gas"
1. Sinkron        git fetch origin && git checkout main && git pull --ff-only origin main
2. Branch         baru dari main, atau lanjut di branch PR sesi ini (§6.2)
3. Verifikasi     sumber kebenaran (§2) sebelum mengubah apa pun
4. Kerjakan       perubahan sekecil mungkin untuk satu tujuan; hormati arsitektur yang ada
5. Uji            sesuai §7; catat angka nyata
6. Review diri    git status && git diff --stat → tidak ada secret/file sampah/console.log debug
7. Commit         Conventional Commits (§8)
8. SAVE           §6.2
```

- Base PR selalu `main`; tidak ada stacked PR (PR ber-base branch fitur lain). Kalau bergantung pada PR yang belum di-merge: tunggu.
- Setelah PR di-merge, hapus branch remote-nya.

## 7. Standar pengujian — "0 regresi" harus dibuktikan

| Area | Minimal yang dijalankan (tulis hasil nyata di PR) |
|---|---|
| Backend Python | start via supervisor tanpa error; `curl /api/_healthcheck` 200; endpoint yang disentuh di-curl |
| Backend Node/TS | `yarn typecheck`, `yarn test`; start tanpa error; `/api/health` 200 |
| Migrasi DB (Mongo/PG → MariaDB) | skrip migrasi dengan laporan **jumlah per koleksi/tabel cocok** (mis. "47/47 koleksi cocok") |
| Kesetaraan perilaku setelah ganti DB | **differential test**: backend lama (DB lama) vs baru (MariaDB) dengan data identik, bandingkan respons GET (mis. `scripts/poc_diff_endpoints.py` → "72/75 identik, sisanya timestamp startup") |
| Test milik penulis aplikasi (`*_test.py`, `tests/`) | jalankan **semua** terhadap DB kosong khusus uji (mis. `scripts/run_integrity_tests_mariadb.sh` → "13/13 lulus"); test yang butuh env khusus (mis. `MAX_UPLOAD_MB=1`, `DEFAULT_TENANT_ID` tertentu) disamakan dengan compose aslinya, **bukan** dilewati |
| Alur API end-to-end | skrip smoke lintas modul (`tests/e2e_api.py`) → "gagal: 0" |
| Frontend | `CI=true yarn build` **lulus** (warning ESLint = error di Coolify); halaman yang diubah dibuka minimal sekali (screenshot desktop 1920×800 + mobile 390×844 untuk perubahan layout) |
| Storage R2 | upload → list → download → hapus via API, lalu verifikasi objek di bucket benar-benar ada/hilang |
| Bug yang dilaporkan pemilik / fitur lintas modul | reproduksi dulu, perbaiki, lalu **testing agent** Emergent (`test_reports/iteration_N.json`) — screenshot sendiri tidak cukup |
| Dockerfile | bila Docker tidak tersedia di sandbox: tulis eksplisit "build image belum diverifikasi", dan pastikan `yarn install --production` tidak membuang modul runtime (cek import vs `dependencies`) |

Jangan menekan `eslint-disable` sembarangan; perbaiki dependensi hook dengan `useCallback`, atau letakkan komentar disable **pada baris yang benar** (bukan satu baris dengan array dependensi). Refactor hook yang membaca state lain harus dipertimbangkan risikonya — kalau ragu, pertahankan perilaku asli.

## 8. Format commit

```
<tipe>(<scope>): <ringkasan imperatif ≤ 72 karakter>

- apa yang ditambah
- apa yang diubah (perilaku lama → baru, alasan)
- apa yang dihapus dan mengapa aman
- verifikasi: angka nyata (koleksi cocok, test lulus, build OK)
```
Tipe: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`. Scope: `db`, `storage`, `auth`, `tenant`, `frontend`, `deploy`, `nginx`, `scripts`.
Commit `wip:` boleh selama bekerja, tetapi **di-squash** sebelum PR dibuka/diserahkan. Pesan commit tidak boleh berisi teks chat.

## 9. Template PR (wajib semua bagian)

```markdown
## Tujuan
Masalah/fitur apa dan mengapa (1–2 kalimat). Sebutkan versi source yang menjadi basis (path VPS/commit) bila relevan.

## Ditambah (+)
## Diubah (~)
## Dihapus (−)

## Dampak
- Env baru/berubah: nama saja (nilai TIDAK ditulis), tandai wajib/opsional + default
- Database/schema: tidak ada | ada (langkah migrasi, idempoten?, sudah dijalankan di DB mana + tanggal)
- Data production yang disentuh: tidak ada | ada (apa, kapan, backup di mana)
- Breaking change: tidak | ya
- Perlu redeploy: backend | frontend | keduanya (urutan)

## Pengujian
- [ ] perintah + hasil nyata (mis. "migrasi 47/47 koleksi cocok", "diff API 72/75 identik", "13/13 test lulus", "CI=true build OK")
- [ ] yang TIDAK diuji dan alasannya (mis. "build image Docker: tidak ada Docker di sandbox")

## Checklist
- [ ] Tidak ada secret/file sampah dalam diff (sudah di-grep)
- [ ] README-COOLIFY.md / .env.example diperbarui
- [ ] Base PR = main, tidak ada stacked PR, tidak ada push ke main
```

## 10. Bekerja dengan data & database production

- Sandbox Emergent bisa menjangkau MariaDB Coolify lewat **port publik**; deploy Coolify memakai host **internal**. Sadari bahwa semua perintah tulis dari sandbox = tulis ke production.
- Urutan cut-over data lama → MariaDB: (1) dump/backup sumber, (2) migrasi ke **DB lokal** dulu + semua uji §7, (3) baru ke DB Coolify, dengan laporan jumlah per koleksi. Truncate hanya bila diminta dan setelah backup.
- Startup aplikasi yang melakukan **backfill massal** (mis. tenant_id ke ribuan dokumen) dari sandbox lewat WAN bisa lambat/lock-wait: jalankan **satu proses saja**, pantau, matikan proses gagal dengan `kill -9` dan pastikan tidak ada transaksi menggantung sebelum mengulang. Optimalkan jalur batch (executemany) bila perlu — itu juga mempercepat deploy.
- Password user **tidak pernah direset diam-diam**. Hash lama dibawa apa adanya; opsi reset hanya lewat env eksplisit (`BOOTSTRAP_ADMIN_RESET_PASSWORD=true`) dan dilaporkan. Jika pemilik bertanya "password-nya apa", jelaskan hash tidak bisa dibalik dan tawarkan reset.
- Akun uji yang dibuat di production (mis. `qa.*@…test`) **dicatat** dan disarankan dihapus sebelum go-live; jangan menghapus tanpa perintah.
- Perubahan kosmetik data (nama tenant, nama admin) yang terbawa dari env lokal harus dirapikan dan dilaporkan.

## 11. Lingkungan Emergent (preview)

- Layanan dikelola `supervisorctl` (`backend`, `frontend`); env dev di `/app/backend/.env` dan `/app/frontend/.env` (jangan commit). Preview URL diberikan sistem — jangan hardcode.
- Untuk berpindah project dalam satu sesi: pindahkan working tree lama ke `/root/gh-work/<proyek>/` (pastikan sudah di-push), lalu `/app` dijadikan working tree repo aktif; sesuaikan `command` supervisor bila runtime berbeda (uvicorn ↔ tsx). Catat di `plan.md`.
- Kredensial dan file kerja (dump, tarball source, env final) disimpan di **luar repo** (`/root/proc/`, `/root/srcs/`, `/root/creds/`), dan nama filenya dilaporkan ke pemilik agar tidak hilang.
- Selalu perbarui `/app/plan.md` (fase, status, PR, lokasi file penting) — konteks chat bisa terpotong; dokumen itu adalah memori agent.
- Gunakan bulk file writer untuk banyak file, `search_replace` untuk perubahan kecil; `yarn` (bukan `npm`); `requirements.txt` hanya lewat `pip freeze` setelah `pip install`.

## 12. Hal yang sering ditanya pemilik — jawab dengan pola ini

| Pertanyaan | Jawaban yang diharapkan |
|---|---|
| "env-nya apa aja?" | Daftar **lengkap** per aplikasi Coolify (backend/frontend/service), dipisah *wajib* vs *opsional (+default)*, nilai rahasia disamarkan, nilai yang sudah pasti ditulis jelas. Sertakan file env final di luar repo. |
| "cek file env saya" | Diff otomatis terhadap env final: KURANG / BEDA / EKSTRA, lalu vonis "sudah bisa ditempel" atau daftar koreksi. |
| "JWT direset gpp?" | Aman: hanya sesi yang logout; password (bcrypt) tidak terpengaruh; sebut apa yang bergantung pada secret itu (undangan? tidak). |
| "data lama ada?" | Angka per koleksi/tabel + isi storage; kalau 0, katakan 0 dan biarkan. |
| "kok ada X (SMTP dsb.)?" | Jelaskan by design dari kode (file/layer mana), wajib/opsional, dampak bila kosong. |
| "dah beres?" | Ringkasan: apa yang jalan (dengan bukti), apa yang MOCKED/belum, langkah deploy, next steps 3–4 poin. |

## 13. Checklist cepat sebelum SAVE (`git push` + PR)

```
[ ] Sumber kebenaran sudah diverifikasi (versi source, env container, isi data)
[ ] Branch bukan main; base PR = main
[ ] git status bersih dari .env, dump, key, uploads, build, __pycache__
[ ] git grep secret → kosong
[ ] Uji §7 dijalankan; angka dicatat
[ ] README-COOLIFY.md + .env.example diperbarui (env wajib/opsional, langkah deploy, status cut-over)
[ ] Commit rapi (wip di-squash), author benar
[ ] PR body sesuai §9
[ ] plan.md diperbarui; file kerja penting di luar repo disebutkan ke pemilik
```
