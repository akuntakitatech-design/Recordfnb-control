#!/usr/bin/env python3
"""
UAT BILL-01 (blueprint V1.2) — siswa, tarif, tagihan, piutang.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional)
Jalankan: uv run --with httpx python tests/billing_uat.py
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


def ensure_ready_unit(admin: httpx.Client, unit_id: str) -> bool:
    """Aktifkan unit bila masih Draft dan lengkapi rekening + mapping agar READY."""
    detail = admin.get(f"/api/v1/organization/units/{unit_id}").json()
    if detail.get("operational_status") == "DRAFT":
        r = admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT BILL-01"})
        if r.status_code != 200:
            return False

    readiness = admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json()
    if readiness.get("status") == "READY":
        return True

    suffix = str(int(time.time()))[-4:]
    central = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Pusat", "accountNumber": f"31{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    dedicated = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"32{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    })
    if central.status_code not in (201, 409) or dedicated.status_code not in (201, 409):
        return False
    accounts = admin.get("/api/v1/bank-accounts").json()
    central_id = next(a["id"] for a in accounts if a["account_number"] == f"31{suffix}00")
    dedicated_id = next(a["id"] for a in accounts if a["account_number"] == f"32{suffix}00")
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
    admin = httpx.Client(base_url=BASE, timeout=30)
    r = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", r.status_code == 200, r.status_code)
    if r.status_code != 200:
        return summary()

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    unit = next((u for u in hierarchy["units"] if u["unit_code"] == "TK-PANAM"), None)
    check("unit TK-PANAM tersedia", unit is not None)
    if not unit:
        return summary()
    unit_id = unit["id"]
    year_id = hierarchy["academicYears"][0]["id"]

    check("unit siap billing (aktif + READY)", ensure_ready_unit(admin, unit_id))

    # Tarif
    fee = admin.post("/api/v1/fee-types", json={"code": f"SPP{SUFFIX}", "name": f"SPP UAT {SUFFIX}"})
    check("jenis biaya dibuat", fee.status_code == 201, fee.text[:90])
    if fee.status_code != 201:
        return summary()
    fee_type_id = fee.json()["id"]

    scheme = admin.post("/api/v1/fee-schemes", json={
        "unitId": unit_id, "academicYearId": year_id, "feeTypeId": fee_type_id,
        "name": f"SPP Bulanan {SUFFIX}", "amount": 500000, "frequency": "MONTHLY",
        "installmentCount": 1, "effectiveStart": "2026-07-01",
    })
    check("tarif dibuat", scheme.status_code == 201, scheme.text[:90])

    # Siswa
    student = admin.post("/api/v1/students", json={
        "nis": f"UAT{SUFFIX}", "fullName": f"Siswa UAT {SUFFIX}", "gender": "L",
        "unitId": unit_id, "academicYearId": year_id, "classLabel": "TK A",
        "effectiveStart": "2026-07-01", "guardianName": "Wali UAT",
    })
    check("siswa + penempatan dibuat", student.status_code == 201, student.text[:90])
    if student.status_code != 201:
        return summary()
    student_id = student.json()["id"]

    period = f"P{SUFFIX}"
    payload = {
        "unitId": unit_id, "academicYearId": year_id, "periodLabel": period,
        "invoiceDate": "2026-07-01", "dueDate": "2026-07-15",
    }

    preview = admin.post("/api/v1/billing-runs/preview", json=payload)
    body = preview.json()
    check("pratinjau tagihan", preview.status_code == 200 and body.get("studentCount", 0) >= 1, body.get("studentCount"))
    expected_total = sum(s.get("amount", 0) for s in body.get("schemes", []))
    check("nominal per siswa = jumlah tarif aktif",
          expected_total > 0 and body.get("totalPerStudent") == expected_total,
          (body.get("totalPerStudent"), expected_total))
    check("tarif yang baru dibuat masuk perhitungan",
          any(s.get("feeTypeId") == fee_type_id for s in body.get("schemes", [])), len(body.get("schemes", [])))

    # Unit belum siap
    not_ready = next((u for u in hierarchy["units"] if u["finance_status"] != "READY" and u["id"] != unit_id), None)
    if not_ready:
        blocked = admin.post("/api/v1/billing-runs/preview", json={**payload, "unitId": not_ready["id"], "periodLabel": f"X{SUFFIX}"})
        check("unit belum READY ditolak", blocked.status_code == 400 and blocked.json().get("error") == "UNIT_NOT_READY_FOR_BILLING", blocked.status_code)

    generated = admin.post("/api/v1/billing-runs/generate", json=payload)
    check("generate tagihan", generated.status_code == 201, generated.text[:100])
    duplicate = admin.post("/api/v1/billing-runs/generate", json=payload)
    check("generate ganda ditolak", duplicate.status_code == 409 and duplicate.json().get("error") == "BILLING_RUN_DUPLICATE", duplicate.status_code)

    invoices = admin.get("/api/v1/invoices", params={"periodLabel": period}).json()
    invoice = next((row for row in invoices["rows"] if row["student_id"] == student_id), None)
    check("invoice terbentuk", invoice is not None, invoices.get("total"))
    if not invoice:
        return summary()

    detail = admin.get(f"/api/v1/invoices/{invoice['id']}").json()
    line_total = sum(float(line["amount"]) for line in detail.get("lines", []))
    check("rincian invoice & angsuran",
          len(detail.get("lines", [])) == len(body.get("schemes", []))
          and line_total == float(detail["total_amount"])
          and len(detail.get("installments", [])) == body.get("installmentCount"),
          (len(detail.get("lines", [])), len(detail.get("installments", [])), line_total))

    receivables = admin.get("/api/v1/receivables").json()
    outstanding = next((row for row in receivables["items"] if row["id"] == invoice["id"]), None)
    check("piutang tercatat", outstanding is not None and float(outstanding["outstanding"]) == float(expected_total),
          outstanding["outstanding"] if outstanding else None)

    voided = admin.post(f"/api/v1/invoices/{invoice['id']}/void", json={"reason": "UAT void tagihan"})
    check("void invoice", voided.status_code == 200, voided.text[:80])
    receivables_after = admin.get("/api/v1/receivables").json()
    check("invoice void keluar dari piutang", all(row["id"] != invoice["id"] for row in receivables_after["items"]))
    void_again = admin.post(f"/api/v1/invoices/{invoice['id']}/void", json={"reason": "UAT void ulang"})
    check("void ulang ditolak", void_again.status_code == 409 and void_again.json().get("error") == "INVOICE_ALREADY_VOID", void_again.status_code)

    # Periode kedua + piutang aktif
    second = admin.post("/api/v1/billing-runs/generate", json={**payload, "periodLabel": f"Q{SUFFIX}"})
    check("generate periode kedua", second.status_code == 201, second.status_code)
    receivables2 = admin.get("/api/v1/receivables").json()
    check("piutang periode kedua muncul", any(row["student_id"] == student_id for row in receivables2["items"]), receivables2["totalOutstanding"])
    check("aging tersedia", set(receivables2["aging"].keys()) == {"CURRENT", "D1_30", "D31_60", "D61_PLUS"})

    # Scope unit: bendahara TK-PANAM tidak boleh generate di unit lain
    if not_ready:
        email = f"bendahara.bill{SUFFIX}@sekolah.test"
        created = admin.post("/api/v1/users", json={
            "fullName": "Bendahara Billing UAT", "email": email, "password": "Bendahara2026!",
            "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
        })
        check("user bendahara billing dibuat", created.status_code == 201, created.status_code)
        staff = httpx.Client(base_url=BASE, timeout=30)
        staff.post("/api/auth/login", json={"email": email, "password": "Bendahara2026!"})
        denied = staff.post("/api/v1/billing-runs/preview", json={
            **payload, "unitId": not_ready["id"], "periodLabel": f"Z{SUFFIX}",
        })
        check("bendahara lintas unit ditolak", denied.status_code == 403, denied.status_code)
        allowed = staff.post("/api/v1/billing-runs/preview", json={**payload, "periodLabel": f"R{SUFFIX}"})
        check("bendahara unit sendiri diizinkan", allowed.status_code == 200, allowed.status_code)

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
