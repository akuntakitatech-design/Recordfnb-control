# UAT & Traceability — Blueprint V1.2

Matriks ini memetakan skenario UAT blueprint (T01–T20) ke otomasi yang ada di `tests/`.
Semua suite hanya untuk **DB lokal/staging** (membuat data uji nyata, bukan mock).

## Cara menjalankan

```bash
# 1. Backend + DB lokal aktif
curl -s http://127.0.0.1:4100/api/health

# 2. Jalankan seluruh suite
export ADMIN_EMAIL=admin@sekolah.test
export ADMIN_PASSWORD='...'
cd tests
for suite in foundation billing receipt expense accounting report; do
  uv run --with httpx python ${suite}_uat.py
done
```

Atau cukup `./scripts/verify.sh` (typecheck + build + semua suite).

Suite bersifat **rerun-safe**: memakai `RUN_SUFFIX` unik, kode unik, dan periode unik sehingga dapat
dijalankan berulang pada DB yang sama.

## Hasil terakhir

| Suite | Fokus | Hasil |
|---|---|---|
| `tests/foundation_uat.py` | FD-01…FD-05 + reset password | **30/30 lulus** |
| `tests/billing_uat.py` | BILL-01 | **25/25 lulus** |
| `tests/receipt_uat.py` | FC-01 penerimaan | **51/51 lulus** |
| `tests/expense_uat.py` | FC-01 pengeluaran | **52/52 lulus** |
| `tests/accounting_uat.py` | ACC-01 | **45/45 lulus** |
| `tests/report_uat.py` | RPT-01 | **31/31 lulus** |
| **Total** | | **234/234 lulus** |

## Matriks T01–T20

| ID | Skenario blueprint | Status | Bukti / asersi |
|---|---|---|---|
| T01 | Buat TK Panam sebagai Draft | ✅ | `foundation_uat` — "T01 unit draft tersimpan" (201, `operational_status=DRAFT`) |
| T02 | Buat kode unit yang sama dua kali | ✅ | "T02 kode unit duplikat ditolak" → `409 UNIT_CODE_DUPLICATE` |
| T03 | Tambah jenjang baru tanpa ubah schema | ✅ | "T03 tambah jenjang baru" (201 pada `education-levels`) |
| T04 | Dua cabang di bawah sekolah resmi sama | ✅ | "T04 dua cabang satu sekolah resmi" (201) |
| T05 | NPSN duplikat | ✅ | "T05 NPSN duplikat ditolak" → `409 NPSN_DUPLICATE` |
| T06 | Aktivasi tanpa lokasi/identitas wajib | ✅ | "T06 aktivasi tanpa lokasi ditolak" → `400 UNIT_ACTIVATION_INCOMPLETE` |
| T07 | MIXED tanpa dua jenis rekening | ✅ | "T07 MIXED tanpa rekening => Not Ready" (unit baru, checklist `central_bank_account` + `dedicated_bank_account`) |
| T08 | Hubungkan rekening pusat + dedicated | ✅ | "T08 rekening pusat + khusus terhubung" (201+201), lalu readiness `READY` |
| T09 | Rekening dedicated dipakai cabang lain | ✅ | "T09 rekening khusus lintas cabang ditolak" → `409 BANK_ACCOUNT_DEDICATED_CONFLICT` |
| T10 | Bendahara akses data cabang lain | ✅ | "T10 akses unit lain ditolak" → `403 UNIT_FORBIDDEN`; unit sendiri 200 |
| T11 | Penerimaan TK melalui rekening pusat | ✅ | `receipt_uat` — "T11 penerimaan lewat rekening pusat diterima" (201), sisa 100.000 sebagai uang belum dialokasikan, mutasi `IN` di rekening pusat |
| T12 | Satu transfer untuk siswa dua cabang | ✅ | "T12 satu penerimaan untuk dua cabang" (201), "alokasi mencakup dua unit berbeda (2)", "kedua tagihan lunas (PAID, PAID)" |
| T13 | Transfer bank pusat → dedicated bukan pendapatan | ⛔ belum | Fitur **transfer antar rekening** belum ada; jurnal `ACC-04` belum dapat diuji. Tercatat sebagai backlog |
| T14 | Pengeluaran pusat untuk cabang | ✅ | `expense_uat` — "T14 beban cabang dibayar dari rekening pusat" (201), rekening `CENTRAL`, unit beban tetap `TK-PANAM`, mutasi `OUT` di rekening pusat |
| T15 | Laporan TK dan yayasan | ✅ | `report_uat` — drill-down = agregat untuk tagihan/penerimaan/pengeluaran/piutang (selisih 0), agregasi jenjang = agregasi unit |
| T16 | Ubah jenjang unit yang sudah bertransaksi | ✅ | `foundation_uat` — "T16 ubah jenjang unit bertransaksi ditolak" → `409 UNIT_IDENTITY_LOCKED`; edit catatan tetap 200 |
| T17 | Posted transaction di periode tutup | ✅ | `accounting_uat` — "posting pada periode tertutup ditolak" → `409 PERIOD_CLOSED`; buka kembali dengan alasan → posting 201 |
| T18 | Rekonsiliasi piutang subledger vs GL | ✅ | "GL piutang = subledger tagihan" selisih **0**; kas `unexplained` 0; posisi keuangan `balanced` |
| T19 | Perubahan rekening default terekam audit | ✅ | `foundation_uat` — "T19 audit trail tercatat" memuat `UNIT_CREATE`, `BANK_ACCOUNT_VERIFY`, `UNIT_BANK_ASSIGNMENT_CREATE` |
| T20 | Dua permintaan pembayaran identik | ✅ | `expense_uat` — replay `idempotencyKey` mengembalikan pembayaran sama (`idempotent: true`) dan `paid_amount` tidak dobel |

**Skor: 19/20 skenario blueprint lulus otomatis; T13 menunggu fitur transfer antar rekening.**

## Uji tambahan di luar blueprint

| Area | Asersi kunci |
|---|---|
| BILL-01 | pratinjau = Σ tarif aktif; generate ganda 409; rincian baris = jumlah skema; angsuran = `installmentCount`; void invoice mengembalikan piutang |
| FC-01 penerimaan | pelunasan penuh → `PAID`; alokasi > sisa tagihan 409; alokasi > nilai penerimaan 400; VOID mengembalikan `ISSUED` + mutasi `OUT`; rekening tanpa mapping 400 |
| FC-01 pengeluaran | ACC-01 mapping akun beban; self-approval 403; pembayaran > sisa 409; VOID mengembalikan `APPROVED` + mutasi `IN`; cancel pengajuan berbayar 409; unit DRAFT 400 |
| ACC-01 | jurnal otomatis seimbang; jurnal tak seimbang 409; akun di luar CoA 400; reversal (bukan overwrite); backfill idempoten; `journal.post` hanya Accounting Pusat |
| RPT-01 | aging Σ = piutang; surplus = penerimaan − pengeluaran; `closing = opening + netChange`; saldo kas laporan = akun `1-1100`; bendahara hanya unitnya |
| Hardening | rate limit login 5 gagal → 429 `TOO_MANY_ATTEMPTS`; header keamanan; `UNIT_IDENTITY_LOCKED` (VAL-08) |
| Reset password & wajib ganti (**T21**) | `foundation_uat` — user baru login → `mustChangePassword: true`; ganti password 200 → `/auth/me` `false`; login password baru 200; `POST /users/{id}/reset-password` 200 → login berikutnya wajib ganti lagi; audit mencatat `USER_PASSWORD_RESET` |

## Yang sengaja tidak diuji di otomasi

| Item | Alasan |
|---|---|
| Build image Docker | Docker tidak tersedia di sandbox pengembangan |
| Browser lintas perangkat | Smoke UI hanya desktop Chrome 1440×900 |
| Beban/kinerja (load test) | Belum ada target SLA; dijadwalkan sebelum go-live |
| T13 transfer antar rekening | Fitur belum diimplementasikan |
