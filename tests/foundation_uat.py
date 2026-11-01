#!/usr/bin/env python3
"""
UAT Foundation (blueprint V1.2) — FD-01..FD-05.
Menguji T01..T10 + T19 lewat API. HANYA untuk DB lokal/staging.

Env:
  BASE            default http://127.0.0.1:4100
  ADMIN_EMAIL     wajib
  ADMIN_PASSWORD  wajib
  RUN_SUFFIX      opsional (4 karakter) untuk kode unik per run

Jalankan:
  uv run --with httpx python tests/foundation_uat.py
"""
import os
import sys
import time

import httpx

BASE = os.environ.get("BASE", "http://127.0.0.1:4100")
EMAIL = os.environ["ADMIN_EMAIL"]
PASSWORD = os.environ["ADMIN_PASSWORD"]
SUFFIX = os.environ.get("RUN_SUFFIX") or str(int(time.time()))[-4:]

results: list[tuple[str, bool]] = []


def check(label: str, ok: bool, detail="") -> None:
    results.append((label, bool(ok)))
    print(f"[{'OK ' if ok else 'ERR'}] {label} {str(detail)[:140]}")


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=30)
    r = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", r.status_code == 200, r.status_code)
    if r.status_code != 200:
        return 1

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    levels = {level["code"]: level["id"] for level in hierarchy["levels"]}
    location = hierarchy["locations"][0]["id"]
    academic_year = hierarchy["academicYears"][0]["id"]
    check("seed hierarki TK/SD tersedia", "TK" in levels and "SD" in levels, list(levels))

    # T03 — jenjang baru tanpa perubahan schema
    r = admin.post("/api/v1/organization/education-levels", json={
        "code": f"SMP{SUFFIX}", "name": "Sekolah Menengah Pertama", "sortOrder": 30,
    })
    check("T03 tambah jenjang baru", r.status_code == 201, r.status_code)

    # T05 — NPSN duplikat
    npsn = f"{SUFFIX}0000"[:8]
    r = admin.post("/api/v1/organization/official-schools", json={
        "name": "SD Harapan", "educationLevelId": levels["SD"], "npsn": npsn,
    })
    check("sekolah resmi SD dibuat", r.status_code == 201, r.text[:90])
    if r.status_code != 201:
        return summary()
    sd_school = r.json()["id"]
    r = admin.post("/api/v1/organization/official-schools", json={
        "name": "SD Duplikat", "educationLevelId": levels["SD"], "npsn": npsn,
    })
    check("T05 NPSN duplikat ditolak", r.status_code == 409 and r.json().get("error") == "NPSN_DUPLICATE", r.status_code)

    # T01 — buat unit Draft
    unit_payload = {
        "unitCode": f"SD-CAB{SUFFIX}", "unitName": "SD Harapan Cabang 01",
        "educationLevelId": levels["SD"], "officialSchoolId": sd_school,
        "locationId": location, "defaultAcademicYearId": academic_year,
        "address": "Jl. Panam, Pekanbaru", "effectiveStart": "2026-07-01",
    }
    r = admin.post("/api/v1/organization/units", json=unit_payload)
    check("T01 unit draft tersimpan", r.status_code == 201 and r.json().get("operational_status") == "DRAFT", r.text[:90])
    if r.status_code != 201:
        return summary()
    unit_id = r.json()["id"]

    # T02 — kode unit duplikat
    r = admin.post("/api/v1/organization/units", json={
        "unitCode": unit_payload["unitCode"], "unitName": "Duplikat", "educationLevelId": levels["SD"],
    })
    check("T02 kode unit duplikat ditolak", r.status_code == 409 and r.json().get("error") == "UNIT_CODE_DUPLICATE", r.status_code)

    # T04 — dua cabang pada satu sekolah resmi
    r = admin.post("/api/v1/organization/units", json={
        **unit_payload, "unitCode": f"SD-CAB2{SUFFIX}", "unitName": "SD Harapan Cabang 02",
    })
    check("T04 dua cabang satu sekolah resmi", r.status_code == 201, r.status_code)

    # T06 — aktivasi tanpa identitas lengkap
    r = admin.post("/api/v1/organization/units", json={
        "unitCode": f"XX{SUFFIX}", "unitName": "Unit Tanpa Lokasi", "educationLevelId": levels["TK"],
    })
    incomplete_unit = r.json()["id"]
    r = admin.post(f"/api/v1/organization/units/{incomplete_unit}/activate")
    check("T06 aktivasi tanpa lokasi ditolak", r.status_code == 400 and r.json().get("error") == "UNIT_ACTIVATION_INCOMPLETE", r.text[:90])

    # T07 — MIXED tanpa dua jenis rekening (pakai unit baru agar tidak bergantung data run sebelumnya)
    fresh_unit = admin.post("/api/v1/organization/units", json={
        "unitCode": f"RD{SUFFIX}", "unitName": "Unit Cek Kesiapan",
        "educationLevelId": levels["TK"], "locationId": location,
        "defaultAcademicYearId": academic_year, "effectiveStart": "2026-07-01",
    })
    check("unit baru untuk cek kesiapan", fresh_unit.status_code == 201, fresh_unit.text[:90])
    if fresh_unit.status_code != 201:
        return summary()
    tk_unit = next(unit["id"] for unit in hierarchy["units"] if unit["unit_code"] == "TK-PANAM")
    body = admin.get(f"/api/v1/organization/units/{fresh_unit.json()['id']}/readiness").json()
    fields = [item["field"] for item in body.get("checks", [])]
    check("T07 MIXED tanpa rekening => Not Ready",
          body.get("status") == "NOT_CONFIGURED" and "central_bank_account" in fields and "dedicated_bank_account" in fields,
          body.get("status"))

    # T08 — hubungkan rekening pusat + khusus, lalu mapping akun
    central = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Pusat", "accountNumber": f"10{SUFFIX}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    }).json()["id"]
    dedicated = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"20{SUFFIX}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    }).json()["id"]
    admin.post(f"/api/v1/bank-accounts/{central}/verify")
    admin.post(f"/api/v1/bank-accounts/{dedicated}/verify")

    assign_central = admin.post(f"/api/v1/organization/units/{tk_unit}/bank-assignments", json={
        "bankAccountId": central, "usageType": "CENTRAL_SHARED", "effectiveStart": "2026-07-01",
    })
    assign_dedicated = admin.post(f"/api/v1/organization/units/{tk_unit}/bank-assignments", json={
        "bankAccountId": dedicated, "usageType": "UNIT_DEDICATED", "effectiveStart": "2026-07-01",
    })
    check("T08 rekening pusat + khusus terhubung",
          assign_central.status_code == 201 and assign_dedicated.status_code == 201,
          (assign_central.status_code, assign_dedicated.status_code))

    r = admin.put(f"/api/v1/organization/units/{tk_unit}/finance-settings", json={
        "accountMode": "MIXED", "receivableAccountCode": "1-1200",
        "cashAccountCode": "1-1100", "revenueAccountCode": "4-1100",
    })
    check("mapping akun keuangan tersimpan", r.status_code == 200, r.status_code)
    body = admin.get(f"/api/v1/organization/units/{tk_unit}/readiness").json()
    check("unit MIXED siap setelah konfigurasi", body.get("status") == "READY", body.get("status"))

    # T09 — rekening khusus dipakai cabang lain
    r = admin.post(f"/api/v1/organization/units/{unit_id}/bank-assignments", json={
        "bankAccountId": dedicated, "usageType": "UNIT_DEDICATED", "effectiveStart": "2026-07-01",
    })
    check("T09 rekening khusus lintas cabang ditolak",
          r.status_code == 409 and r.json().get("error") == "BANK_ACCOUNT_DEDICATED_CONFLICT", r.status_code)

    # Aktivasi unit lengkap
    r = admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT aktivasi"})
    check("aktivasi unit lengkap", r.status_code == 200, r.text[:90])

    # T10 — bendahara hanya boleh unit sendiri
    staff_email = f"bendahara{SUFFIX}@sekolah.test"
    r = admin.post("/api/v1/users", json={
        "fullName": "Bendahara SD 01", "email": staff_email, "password": "Bendahara2026!",
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("pengguna bendahara dengan scope unit", r.status_code == 201, r.text[:90])

    staff = httpx.Client(base_url=BASE, timeout=30)
    staff.post("/api/auth/login", json={"email": staff_email, "password": "Bendahara2026!"})
    r = staff.get(f"/api/v1/organization/units/{tk_unit}")
    check("T10 akses unit lain ditolak", r.status_code == 403 and r.json().get("error") == "UNIT_FORBIDDEN", r.status_code)
    r = staff.get(f"/api/v1/organization/units/{unit_id}")
    check("akses unit sendiri diizinkan", r.status_code == 200, r.status_code)
    r = staff.get("/api/v1/users")
    check("role cabang tidak boleh kelola pengguna", r.status_code == 403, r.status_code)

    # T21 — reset password oleh admin + wajib ganti saat login
    pw_email = f"pwchange{SUFFIX}@sekolah.test"
    temp_password = "Sementara2026!"
    new_password = "Permanen2026!"
    created_pw_user = admin.post("/api/v1/users", json={
        "fullName": "Pengguna Ganti Password", "email": pw_email, "password": temp_password,
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("T21 pengguna uji ganti password dibuat", created_pw_user.status_code == 201, created_pw_user.status_code)
    if created_pw_user.status_code == 201:
        pw_user_id = created_pw_user.json()["id"]
        pw_client = httpx.Client(base_url=BASE, timeout=30)
        first = pw_client.post("/api/auth/login", json={"email": pw_email, "password": temp_password})
        check("T21 login pertama wajib ganti password",
              first.status_code == 200 and first.json().get("mustChangePassword") is True,
              (first.status_code, first.json().get("mustChangePassword")))

        changed = pw_client.post("/api/auth/change-password",
                                 json={"currentPassword": temp_password, "newPassword": new_password})
        check("T21 password berhasil diganti", changed.status_code == 200, changed.text[:80])
        me = pw_client.get("/api/auth/me").json()
        check("T21 kewajiban ganti password hilang", me.get("mustChangePassword") is False,
              me.get("mustChangePassword"))

        relogin = httpx.Client(base_url=BASE, timeout=30)
        new_login = relogin.post("/api/auth/login", json={"email": pw_email, "password": new_password})
        check("T21 login dengan password baru",
              new_login.status_code == 200 and new_login.json().get("mustChangePassword") is False,
              new_login.status_code)

        reset = admin.post(f"/api/v1/users/{pw_user_id}/reset-password", json={"password": temp_password})
        check("T21 admin reset password pengguna", reset.status_code == 200, reset.status_code)
        reset_client = httpx.Client(base_url=BASE, timeout=30)
        after_reset = reset_client.post("/api/auth/login", json={"email": pw_email, "password": temp_password})
        check("T21 setelah reset wajib ganti lagi",
              after_reset.status_code == 200 and after_reset.json().get("mustChangePassword") is True,
              after_reset.status_code)

    # T16 — ubah identitas akademik unit yang sudah bertransaksi harus ditolak (VAL-08)
    tk_unit = next(unit["id"] for unit in hierarchy["units"] if unit["unit_code"] == "TK-PANAM")
    locked = admin.patch(f"/api/v1/organization/units/{tk_unit}", json={"educationLevelId": levels["SD"]})
    check("T16 ubah jenjang unit bertransaksi ditolak",
          locked.status_code == 409 and locked.json().get("error") == "UNIT_IDENTITY_LOCKED",
          (locked.status_code, locked.text[:70]))
    notes_update = admin.patch(f"/api/v1/organization/units/{tk_unit}", json={"notes": f"UAT T16 {SUFFIX}"})
    check("T16 edit catatan unit tetap diizinkan", notes_update.status_code == 200, notes_update.status_code)

    # T19 — audit trail (termasuk perubahan mapping rekening default)
    actions = {row["action"] for row in admin.get("/api/v1/audit-logs?limit=100").json()}
    check("T19 audit trail tercatat",
          {"UNIT_CREATE", "BANK_ACCOUNT_VERIFY", "UNIT_BANK_ASSIGNMENT_CREATE", "USER_PASSWORD_RESET"} <= actions,
          sorted(actions)[:8])

    return summary()


def summary() -> int:
    failed = [label for label, ok in results if not ok]
    print()
    print(f"RINGKASAN: {len(results) - len(failed)}/{len(results)} lulus")
    if failed:
        print("GAGAL:", failed)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
