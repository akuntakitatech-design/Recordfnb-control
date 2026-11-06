#!/usr/bin/env python3
"""
UAT ROLE-01 — role dinamis & kewenangan per jabatan.

Yang diuji:
  katalog permission mengikuti fitur -> role buatan admin -> kewenangan berlaku
  seketika pada API -> pengaman (role bawaan, role terpakai, anti-lockout).

HANYA untuk DB lokal/staging.
Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional, 4 karakter)
Jalankan: uv run --with httpx python tests/role_uat.py
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
    print(f"[{'OK ' if ok else 'ERR'}] {label} {str(detail)[:150]}")


def summary() -> int:
    failed = [label for label, ok in results if not ok]
    print(f"\nRINGKASAN: {len(results) - len(failed)}/{len(results)} lulus")
    if failed:
        print("Gagal:", "; ".join(failed[:8]))
    return 0 if not failed else 1


def ensure_ready_unit(admin: httpx.Client, unit_id: str) -> bool:
    """Aktifkan unit bila masih Draft dan lengkapi rekening + mapping agar READY."""
    if admin.get(f"/api/v1/organization/units/{unit_id}").json().get("operational_status") == "DRAFT":
        if admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT ROLE-01"}).status_code != 200:
            return False
    if admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY":
        return True

    suffix = str(int(time.time()))[-4:]
    admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Pusat", "accountNumber": f"71{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"72{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    })
    accounts = admin.get("/api/v1/bank-accounts").json()
    central_id = next(a["id"] for a in accounts if a["account_number"] == f"71{suffix}00")
    dedicated_id = next(a["id"] for a in accounts if a["account_number"] == f"72{suffix}00")
    admin.post(f"/api/v1/bank-accounts/{central_id}/verify")
    admin.post(f"/api/v1/bank-accounts/{dedicated_id}/verify")
    admin.post(f"/api/v1/organization/units/{unit_id}/bank-assignments", json={
        "bankAccountId": central_id, "usageType": "CENTRAL_SHARED", "effectiveStart": "2026-07-01",
    })
    admin.post(f"/api/v1/organization/units/{unit_id}/bank-assignments", json={
        "bankAccountId": dedicated_id, "usageType": "UNIT_DEDICATED", "effectiveStart": "2026-07-01",
    })
    admin.put(f"/api/v1/organization/units/{unit_id}/finance-settings", json={
        "accountMode": "MIXED", "receivableAccountCode": "1-1200",
        "cashAccountCode": "1-1100", "revenueAccountCode": "4-1100",
    })
    return admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY"


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=40)
    logged = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", logged.status_code == 200, logged.status_code)
    if logged.status_code != 200:
        return summary()
    admin.permissions = logged.json()["permissions"]
    check("admin punya role.manage", "role.manage" in admin.permissions)
    check("login mengembalikan nama role", bool(logged.json()["user"].get("roleName")),
          logged.json()["user"].get("roleName"))

    # --- 1. Katalog permission mengikuti fitur
    catalog = admin.get("/api/v1/permissions")
    check("katalog permission dapat dibaca", catalog.status_code == 200, catalog.status_code)
    catalog_body = catalog.json()
    codes = {item["code"] for group in catalog_body["groups"] for item in group["permissions"]}
    check("katalog berisi >= 40 kewenangan", len(codes) >= 40, len(codes))
    check("katalog dikelompokkan per fitur", len(catalog_body["groups"]) >= 8, len(catalog_body["groups"]))
    check("kewenangan baru ikut terdaftar", {"role.manage", "transaction.delete", "attachment.upload"} <= codes)

    roles = admin.get("/api/v1/roles")
    check("daftar role dapat dibaca", roles.status_code == 200, roles.status_code)
    role_rows = {row["code"]: row for row in roles.json()}
    check("role bawaan lengkap (>= 9)", len(role_rows) >= 9, sorted(role_rows)[:4])
    check("role bawaan ditandai sistem", role_rows.get("ADMIN_YAYASAN", {}).get("is_system") is True)
    check("role Pusat ditandai global", role_rows.get("FINANCE_PUSAT", {}).get("is_global") is True)
    check("role Purchasing tersedia", "PURCHASING" in role_rows)

    detail = admin.get(f"/api/v1/roles/{role_rows['ADMIN_YAYASAN']['id']}").json()
    check("detail role memuat daftar kewenangan", isinstance(detail.get("permissions"), list) and len(detail["permissions"]) > 10,
          len(detail.get("permissions") or []))

    # --- 2. Siapkan unit + jenis biaya
    units = admin.get("/api/v1/organization/units?pageSize=100").json()["rows"]
    unit_id = units[0]["id"]
    check("unit siap untuk transaksi", ensure_ready_unit(admin, unit_id))
    category = admin.post("/api/v1/expense-categories", json={
        "code": f"RG{SUFFIX}", "name": f"Biaya UAT Role {SUFFIX}", "expenseAccountCode": "5-2100",
    })
    check("jenis biaya uji dibuat", category.status_code == 201, category.text[:90])
    if category.status_code != 201:
        return summary()
    category_id = category.json()["id"]

    # --- 3. Buat role baru dengan kewenangan terbatas
    role_code = f"GUDANG_{SUFFIX}"
    created = admin.post("/api/v1/roles", json={
        "code": role_code, "name": f"Staf Gudang {SUFFIX}", "description": "UAT role dinamis",
        "isGlobal": False, "permissions": ["unit.view", "expense.view", "attachment.upload"],
    })
    check("role baru dibuat", created.status_code == 201, created.text[:90])
    if created.status_code != 201:
        return summary()
    role_id = created.json()["id"]
    check("role baru bukan role sistem", created.json().get("is_system") in (0, False))
    check("kewenangan role baru tersimpan", len(created.json().get("permissions") or []) == 3,
          len(created.json().get("permissions") or []))

    duplicate = admin.post("/api/v1/roles", json={"code": role_code, "name": "Duplikat"})
    check("kode role duplikat ditolak", duplicate.status_code == 409, duplicate.status_code)

    unknown = admin.post("/api/v1/roles", json={"name": f"Role Salah {SUFFIX}", "permissions": ["fitur.tidak.ada"]})
    check("kewenangan tidak dikenal ditolak", unknown.status_code == 400
          and unknown.json().get("error") == "ROLE_PERMISSION_INVALID", unknown.text[:90])

    # --- 4. Pengguna dengan role baru
    staff = httpx.Client(base_url=BASE, timeout=40)
    staff_email = f"gudang.role{SUFFIX}@sekolah.test"
    user = admin.post("/api/v1/users", json={
        "fullName": f"Staf Gudang UAT {SUFFIX}", "email": staff_email, "password": "Gudang2026!",
        "role": role_code, "unitIds": [unit_id],
    })
    check("pengguna dengan role baru dibuat", user.status_code == 201, user.text[:90])
    if user.status_code != 201:
        return summary()

    logged_staff = staff.post("/api/auth/login", json={"email": staff_email, "password": "Gudang2026!"})
    check("login pengguna role baru", logged_staff.status_code == 200, logged_staff.status_code)
    if logged_staff.status_code != 200:
        return summary()
    staff_permissions = set(logged_staff.json()["permissions"])
    check("kewenangan pengguna sesuai role", {"unit.view", "expense.view", "attachment.upload"} <= staff_permissions,
          sorted(staff_permissions))
    check("kewenangan yang tidak dicentang tidak diberikan", "expense.create" not in staff_permissions)
    check("nama role ikut di sesi", logged_staff.json()["user"].get("roleName") == f"Staf Gudang {SUFFIX}",
          logged_staff.json()["user"].get("roleName"))

    check("pengguna boleh melihat pengajuan", staff.get("/api/v1/expenses").status_code == 200)
    denied = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Ditolak {SUFFIX}", "amount": 10000,
    })
    check("pengguna tidak boleh membuat pengajuan", denied.status_code == 403, denied.status_code)
    check("menu role tidak terbuka", staff.get("/api/v1/roles").status_code == 403)

    # --- 5. Ubah kewenangan -> berlaku tanpa login ulang
    granted = admin.patch(f"/api/v1/roles/{role_id}", json={
        "permissions": ["unit.view", "expense.view", "attachment.upload", "expense.create"],
    })
    check("kewenangan role ditambah", granted.status_code == 200
          and "expense.create" in granted.json()["permissions"], granted.text[:90])

    allowed = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Pengajuan staf gudang {SUFFIX}", "amount": 25000,
    })
    check("kewenangan baru langsung berlaku", allowed.status_code == 201, allowed.text[:90])

    revoked = admin.patch(f"/api/v1/roles/{role_id}", json={"permissions": ["unit.view", "expense.view"]})
    check("kewenangan role dikurangi", revoked.status_code == 200
          and "expense.create" not in revoked.json()["permissions"])
    denied_again = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Setelah dicabut {SUFFIX}", "amount": 25000,
    })
    check("kewenangan yang dicabut langsung ditolak", denied_again.status_code == 403, denied_again.status_code)

    if allowed.status_code == 201:
        cleaned = admin.request("DELETE", f"/api/v1/expenses/{allowed.json()['id']}", json={"reason": "UAT role"})
        check("pengajuan uji dibersihkan", cleaned.status_code == 200, cleaned.status_code)

    # --- 6. Pengaman
    blocked_delete = admin.delete(f"/api/v1/roles/{role_rows['ADMIN_YAYASAN']['id']}")
    check("role bawaan tidak bisa dihapus",
          blocked_delete.status_code == 409 and blocked_delete.json().get("error") == "ROLE_SYSTEM_LOCKED",
          blocked_delete.text[:90])

    in_use = admin.delete(f"/api/v1/roles/{role_id}")
    check("role yang dipakai pengguna tidak bisa dihapus",
          in_use.status_code == 409 and in_use.json().get("error") == "ROLE_IN_USE", in_use.text[:90])

    temp = admin.post("/api/v1/roles", json={"name": f"Role Sementara {SUFFIX}", "permissions": []})
    check("role tanpa kewenangan bisa dibuat", temp.status_code == 201, temp.text[:90])
    if temp.status_code == 201:
        removed = admin.delete(f"/api/v1/roles/{temp.json()['id']}")
        check("role tak terpakai bisa dihapus", removed.status_code == 200, removed.text[:90])

    # --- 7. Role PURCHASING (dulu gagal karena CHECK constraint users.role)
    purchasing = admin.post("/api/v1/users", json={
        "fullName": f"Purchasing UAT {SUFFIX}", "email": f"purchasing.role{SUFFIX}@sekolah.test",
        "password": "Purchasing2026!", "role": "PURCHASING", "unitIds": [unit_id],
    })
    check("pengguna role PURCHASING bisa dibuat", purchasing.status_code == 201, purchasing.text[:90])

    # --- 8. Anti-lockout (dijalankan terakhir)
    admin_detail = admin.get(f"/api/v1/roles/{role_rows['ADMIN_YAYASAN']['id']}").json()
    without_manage = [code for code in admin_detail["permissions"] if code != "role.manage"]
    lockout = admin.patch(f"/api/v1/roles/{role_rows['ADMIN_YAYASAN']['id']}", json={"permissions": without_manage})
    check("pencabutan role.manage terakhir ditolak",
          lockout.status_code == 409 and lockout.json().get("error") == "ROLE_MANAGE_REQUIRED",
          lockout.text[:90])
    after = admin.get("/api/auth/me").json()
    check("kewenangan admin tetap utuh", "role.manage" in after["permissions"], len(after["permissions"]))

    return summary()


if __name__ == "__main__":
    sys.exit(main())
