#!/usr/bin/env python3
"""
UAT kelola master organisasi (T22) — edit, nonaktifkan, dan hapus master.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional)
Jalankan: uv run --with httpx python tests/organization_master_uat.py
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
        return summary()

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    levels = {level["code"]: level["id"] for level in hierarchy["levels"]}

    # T22 — master yang belum dipakai boleh dihapus; yang sudah dipakai ditolak 409.
    level = admin.post("/api/v1/organization/education-levels", json={
        "code": f"SMK{SUFFIX}", "name": f"SMK UAT {SUFFIX}", "sortOrder": 40,
    })
    check("T22 jenjang uji dibuat", level.status_code == 201, level.text[:90])
    if level.status_code != 201:
        return summary()

    level_id = level.json()["id"]
    group = admin.post("/api/v1/organization/school-groups", json={
        "code": f"GRP{SUFFIX}", "name": f"Kelompok UAT {SUFFIX}", "educationLevelId": level_id,
    })
    check("T22 kelompok sekolah dibuat", group.status_code == 201, group.text[:90])
    group_id = group.json()["id"] if group.status_code == 201 else None

    in_use = admin.delete(f"/api/v1/organization/education-levels/{level_id}")
    check("T22 hapus jenjang yang masih dipakai ditolak",
          in_use.status_code == 409 and in_use.json().get("error") == "MASTER_IN_USE",
          (in_use.status_code, in_use.text[:90]))

    off = admin.patch(f"/api/v1/organization/education-levels/{level_id}/status", json={"status": "INACTIVE"})
    check("T22 jenjang bisa dinonaktifkan",
          off.status_code == 200 and off.json().get("status") == "INACTIVE",
          (off.status_code, off.json().get("status")))
    on = admin.patch(f"/api/v1/organization/education-levels/{level_id}/status", json={"status": "ACTIVE"})
    check("T22 jenjang bisa diaktifkan kembali",
          on.status_code == 200 and on.json().get("status") == "ACTIVE",
          (on.status_code, on.json().get("status")))

    if group_id:
        removed_group = admin.delete(f"/api/v1/organization/school-groups/{group_id}")
        check("T22 hapus kelompok sekolah", removed_group.status_code == 200, removed_group.status_code)

    removed_level = admin.delete(f"/api/v1/organization/education-levels/{level_id}")
    check("T22 hapus jenjang yang tidak dipakai", removed_level.status_code == 200, removed_level.text[:80])

    tk_level = levels.get("TK")
    if tk_level:
        used = admin.delete(f"/api/v1/organization/education-levels/{tk_level}")
        check("T22 hapus jenjang terpakai unit ditolak",
              used.status_code == 409 and used.json().get("error") == "MASTER_IN_USE", used.status_code)

    # Tahun ajaran: create -> edit (PUT yang sebelumnya belum ada) -> hapus.
    year = admin.post("/api/v1/organization/academic-years", json={
        "name": f"TA{SUFFIX}", "startDate": "2027-07-01", "endDate": "2028-06-30",
    })
    check("T22 tahun ajaran dibuat", year.status_code == 201, year.text[:90])
    if year.status_code == 201:
        year_id = year.json()["id"]
        edited = admin.put(f"/api/v1/organization/academic-years/{year_id}", json={
            "name": f"TA{SUFFIX}B", "startDate": "2027-07-01", "endDate": "2028-06-30",
        })
        check("T22 edit tahun ajaran tersimpan",
              edited.status_code == 200 and edited.json().get("name") == f"TA{SUFFIX}B",
              (edited.status_code, edited.json().get("name")))
        deleted_year = admin.delete(f"/api/v1/organization/academic-years/{year_id}")
        check("T22 hapus tahun ajaran yang tidak dipakai", deleted_year.status_code == 200, deleted_year.status_code)

    actions = {row["action"] for row in admin.get("/api/v1/audit-logs?limit=100").json()}
    check("T22 perubahan master tercatat di audit",
          {"LEVEL_STATUS", "LEVEL_DELETE", "ACADEMIC_YEAR_UPDATE"} <= actions, sorted(actions)[:8])

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
