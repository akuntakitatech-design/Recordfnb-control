#!/usr/bin/env python3
"""
UAT FC-01 (blueprint V1.2) — penerimaan siswa, alokasi ke tagihan, mutasi kas & bank.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional)
Jalankan: uv run --with httpx python tests/receipt_uat.py
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


def num(value) -> float:
    return float(value) if value is not None else 0.0


def ensure_ready_unit(admin: httpx.Client, unit_id: str) -> bool:
    """Aktifkan unit bila masih Draft dan lengkapi rekening + mapping agar READY."""
    detail = admin.get(f"/api/v1/organization/units/{unit_id}").json()
    if detail.get("operational_status") == "DRAFT":
        if admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT FC-01"}).status_code != 200:
            return False

    if admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY":
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


def generate_invoice(admin: httpx.Client, unit_id: str, year_id: str, period: str, student_id: str, invoice_date: str = "2026-07-01"):
    payload = {
        "unitId": unit_id, "academicYearId": year_id, "periodLabel": period,
        "invoiceDate": invoice_date, "dueDate": "2026-07-15",
    }
    created = admin.post("/api/v1/billing-runs/generate", json=payload)
    if created.status_code not in (201, 409):
        return None, created.text[:120]
    rows = admin.get("/api/v1/invoices", params={"periodLabel": period, "pageSize": 100}).json().get("rows", [])
    return next((row for row in rows if row["student_id"] == student_id), None), created.status_code


def invoice_of(admin: httpx.Client, invoice_id: str) -> dict:
    return admin.get(f"/api/v1/invoices/{invoice_id}").json()


def mutations_of(admin: httpx.Client, bank_account_id: str) -> list[dict]:
    body = admin.get("/api/v1/cash-bank/mutations", params={"bankAccountId": bank_account_id, "pageSize": 100}).json()
    return body.get("rows", [])


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=30)
    r = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", r.status_code == 200, r.status_code)
    if r.status_code != 200:
        return summary()

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    unit = next((u for u in hierarchy["units"] if u["unit_code"] == "TK-PANAM"), None)
    other_unit = next((u for u in hierarchy["units"] if u["unit_code"] != "TK-PANAM"), None)
    check("unit TK-PANAM tersedia", unit is not None)
    if not unit:
        return summary()
    unit_id = unit["id"]
    year_id = hierarchy["academicYears"][0]["id"]

    check("unit siap penerimaan (aktif + READY)", ensure_ready_unit(admin, unit_id))

    # Rekening penerimaan unit
    assignments = admin.get(f"/api/v1/organization/units/{unit_id}").json().get("assignments", [])
    receipt_accounts = [a for a in assignments if a.get("allow_receipt") and a.get("status") == "ACTIVE"]
    check("rekening penerimaan unit tersedia", len(receipt_accounts) >= 1, len(receipt_accounts))
    if not receipt_accounts:
        return summary()
    bank_account_id = receipt_accounts[0]["bank_account_id"]
    if receipt_accounts[0].get("allow_receipt") in (1, True):
        pass
    check("rekening punya izin terima", bool(receipt_accounts[0]["allow_receipt"]), receipt_accounts[0].get("usage_type"))

    # Prasyarat: tarif + siswa
    fee = admin.post("/api/v1/fee-types", json={"code": f"SPP{SUFFIX}", "name": f"SPP UAT {SUFFIX}"})
    check("jenis biaya dibuat", fee.status_code == 201, fee.text[:90])
    if fee.status_code != 201:
        return summary()

    scheme = admin.post("/api/v1/fee-schemes", json={
        "unitId": unit_id, "academicYearId": year_id, "feeTypeId": fee.json()["id"],
        "name": f"SPP Bulanan {SUFFIX}", "amount": 500000, "frequency": "MONTHLY",
        "installmentCount": 1, "effectiveStart": "2026-07-01",
    })
    check("tarif dibuat", scheme.status_code == 201, scheme.text[:90])

    student = admin.post("/api/v1/students", json={
        "nis": f"UATR{SUFFIX}", "fullName": f"Siswa Terima {SUFFIX}", "gender": "P",
        "unitId": unit_id, "academicYearId": year_id, "classLabel": "TK B",
        "effectiveStart": "2026-07-01", "guardianName": "Wali Terima",
    })
    check("siswa dibuat", student.status_code == 201, student.text[:90])
    if student.status_code != 201:
        return summary()
    student_id = student.json()["id"]

    invoice_a, state_a = generate_invoice(admin, unit_id, year_id, f"RA{SUFFIX}", student_id)
    invoice_b, _ = generate_invoice(admin, unit_id, year_id, f"RB{SUFFIX}", student_id)
    invoice_c, _ = generate_invoice(admin, unit_id, year_id, f"RC{SUFFIX}", student_id)
    check("tiga tagihan terbentuk", all([invoice_a, invoice_b, invoice_c]), state_a)
    if not all([invoice_a, invoice_b, invoice_c]):
        return summary()

    total = int(num(invoice_a["total_amount"]))
    partial = total // 2
    check("nominal tagihan = total tarif unit", total > 0 and int(num(invoice_c["total_amount"])) == total, total)

    today = "2026-07-05"
    base_receipt = {
        "unitId": unit_id, "bankAccountId": bank_account_id, "receiptDate": today,
        "method": "TRANSFER", "payerName": "Wali Terima",
    }

    # 1) Pelunasan penuh
    pay_a = admin.post("/api/v1/receipts", json={
        **base_receipt, "totalAmount": total, "idempotencyKey": f"rcpt-a-{SUFFIX}",
        "referenceNumber": f"TRX-A-{SUFFIX}",
        "allocations": [{"invoiceId": invoice_a["id"], "amount": total}],
    })
    check("penerimaan penuh dibuat", pay_a.status_code == 201, pay_a.text[:120])
    if pay_a.status_code != 201:
        return summary()
    receipt_a = pay_a.json()["receipt"]
    check("nomor penerimaan berpola RCP", str(receipt_a["receipt_number"]).startswith("RCP-"), receipt_a["receipt_number"])
    check("alokasi penuh tercatat", num(receipt_a["allocated_amount"]) == total and num(receipt_a["unallocated_amount"]) == 0,
          (receipt_a["allocated_amount"], receipt_a["unallocated_amount"]))

    after_a = invoice_of(admin, invoice_a["id"])
    check("tagihan A lunas", after_a["status"] == "PAID" and num(after_a["paid_amount"]) == total,
          (after_a["status"], after_a["paid_amount"]))
    check("angsuran A lunas", all(i["status"] == "PAID" for i in after_a["installments"]), after_a["installments"])

    receivables = admin.get("/api/v1/receivables", params={"pageSize": 100}).json()
    row_a = next((row for row in receivables["items"] if row["id"] == invoice_a["id"]), None)
    check("tagihan A keluar dari piutang", row_a is None)

    # 2) Satu penerimaan untuk dua tagihan (satu penuh, satu sebagian)
    pay_bc = admin.post("/api/v1/receipts", json={
        **base_receipt, "totalAmount": total + partial, "idempotencyKey": f"rcpt-bc-{SUFFIX}",
        "allocations": [
            {"invoiceId": invoice_b["id"], "amount": total},
            {"invoiceId": invoice_c["id"], "amount": partial},
        ],
    })
    check("penerimaan dua tagihan dibuat", pay_bc.status_code == 201, pay_bc.text[:120])
    if pay_bc.status_code != 201:
        return summary()
    receipt_bc = pay_bc.json()["receipt"]
    check("dua alokasi tersimpan", len(receipt_bc.get("allocations", [])) == 2, len(receipt_bc.get("allocations", [])))
    after_b = invoice_of(admin, invoice_b["id"])
    after_c = invoice_of(admin, invoice_c["id"])
    check("tagihan B lunas", after_b["status"] == "PAID", (after_b["status"], after_b["paid_amount"]))
    check("tagihan C sebagian", after_c["status"] == "PARTIAL" and num(after_c["paid_amount"]) == partial,
          (after_c["status"], after_c["paid_amount"]))

    # 3) Alokasi melebihi sisa tagihan
    outstanding_c = total - partial
    over_outstanding = admin.post("/api/v1/receipts", json={
        **base_receipt, "totalAmount": outstanding_c + 1,
        "allocations": [{"invoiceId": invoice_c["id"], "amount": outstanding_c + 1}],
    })
    check("alokasi melebihi sisa tagihan ditolak",
          over_outstanding.status_code == 409 and over_outstanding.json().get("error") == "ALLOCATION_EXCEEDS_OUTSTANDING",
          (over_outstanding.status_code, over_outstanding.text[:80]))

    # 4) Alokasi melebihi nilai penerimaan
    over_receipt = admin.post("/api/v1/receipts", json={
        **base_receipt, "totalAmount": 100000,
        "allocations": [{"invoiceId": invoice_c["id"], "amount": 200000}],
    })
    check("alokasi melebihi nilai penerimaan ditolak",
          over_receipt.status_code == 400 and over_receipt.json().get("error") == "ALLOCATION_EXCEEDS_RECEIPT",
          (over_receipt.status_code, over_receipt.text[:80]))

    # 5) Idempotensi
    replay = admin.post("/api/v1/receipts", json={
        **base_receipt, "totalAmount": total + partial, "idempotencyKey": f"rcpt-bc-{SUFFIX}",
        "allocations": [
            {"invoiceId": invoice_b["id"], "amount": total},
            {"invoiceId": invoice_c["id"], "amount": partial},
        ],
    })
    body = replay.json()
    check("idempotency key mengembalikan penerimaan sama",
          replay.status_code == 200 and body.get("idempotent") is True and body["receipt"]["id"] == receipt_bc["id"],
          (replay.status_code, body.get("idempotent")))
    still_b = invoice_of(admin, invoice_b["id"])
    still_c = invoice_of(admin, invoice_c["id"])
    check("tidak ada pembayaran ganda", num(still_b["paid_amount"]) == total and num(still_c["paid_amount"]) == partial,
          (still_b["paid_amount"], still_c["paid_amount"]))

    # 6) Pembatalan penerimaan
    void = admin.post(f"/api/v1/receipts/{receipt_a['id']}/void", json={"reason": "UAT batal terima"})
    check("penerimaan dibatalkan", void.status_code == 200, void.text[:90])
    after_void = invoice_of(admin, invoice_a["id"])
    check("tagihan A kembali belum dibayar",
          after_void["status"] == "ISSUED" and num(after_void["paid_amount"]) == 0,
          (after_void["status"], after_void["paid_amount"]))
    check("angsuran A kembali belum dibayar", all(i["status"] == "UNPAID" for i in after_void["installments"]))
    void_again = admin.post(f"/api/v1/receipts/{receipt_a['id']}/void", json={"reason": "UAT batal ulang"})
    check("pembatalan ganda ditolak",
          void_again.status_code == 409 and void_again.json().get("error") == "RECEIPT_ALREADY_VOID", void_again.status_code)

    # 7) Mutasi kas & bank dari penerimaan
    mutations = mutations_of(admin, bank_account_id)
    in_a = [m for m in mutations if m.get("source_id") == receipt_a["id"] and m["direction"] == "IN"]
    out_a = [m for m in mutations if m.get("source_id") == receipt_a["id"] and m["direction"] == "OUT"]
    check("mutasi masuk penerimaan tercatat",
          len(in_a) == 1 and num(in_a[0]["amount"]) == total, len(in_a))
    check("mutasi keluar pembatalan tercatat",
          len(out_a) == 1 and num(out_a[0]["amount"]) == total, len(out_a))

    balances = admin.get("/api/v1/cash-bank/balances").json()
    balance_row = next((row for row in balances if row["id"] == bank_account_id), None)
    check("saldo rekening tersedia", balance_row is not None)
    if balance_row:
        expected_in = sum(num(m["amount"]) for m in mutations if m["direction"] == "IN")
        expected_out = sum(num(m["amount"]) for m in mutations if m["direction"] == "OUT")
        check("saldo = total masuk - total keluar",
              num(balance_row["balance"]) == expected_in - expected_out,
              (balance_row["balance"], expected_in - expected_out))
        ledger = admin.get("/api/v1/cash-bank/mutations", params={"bankAccountId": bank_account_id, "pageSize": 100}).json()
        check("total mutasi konsisten dengan saldo",
              num(ledger["totals"]["in"]) - num(ledger["totals"]["out"]) == num(balance_row["balance"]),
              (ledger["totals"], balance_row["balance"]))

    # 8) Rekening aktif tapi belum dipetakan ke unit
    stray_number = f"39{SUFFIX}00"
    stray = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Tanpa Mapping", "accountNumber": stray_number,
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    stray_id = None
    if stray.status_code == 201:
        stray_id = stray.json()["id"]
    else:
        accounts = admin.get("/api/v1/bank-accounts").json()
        stray_id = next((a["id"] for a in accounts if a["account_number"] == stray_number), None)
    if stray_id:
        admin.post(f"/api/v1/bank-accounts/{stray_id}/verify")
        rejected = admin.post("/api/v1/receipts", json={
            **base_receipt, "bankAccountId": stray_id, "totalAmount": 100000,
            "allocations": [{"invoiceId": invoice_c["id"], "amount": 100000}],
        })
        check("rekening tanpa pemetaan unit ditolak",
              rejected.status_code == 400 and rejected.json().get("error") == "BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT",
              (rejected.status_code, rejected.text[:80]))

    # 9) Scope unit: bendahara unit lain tidak boleh menerima
    scope_email = f"bendahara.rcpt{SUFFIX}@sekolah.test"
    created_user = admin.post("/api/v1/users", json={
        "fullName": "Bendahara Penerimaan UAT", "email": scope_email, "password": "Bendahara2026!",
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("user bendahara penerimaan dibuat", created_user.status_code == 201, created_user.status_code)
    if created_user.status_code == 201 and other_unit:
        staff = httpx.Client(base_url=BASE, timeout=30)
        staff.post("/api/auth/login", json={"email": scope_email, "password": "Bendahara2026!"})
        cross = staff.post("/api/v1/receipts", json={
            **base_receipt, "unitId": other_unit["id"], "totalAmount": 100000,
            "allocations": [{"invoiceId": invoice_c["id"], "amount": 100000}],
        })
        check("bendahara lintas unit ditolak", cross.status_code == 403, (cross.status_code, cross.text[:70]))
        own_list = staff.get("/api/v1/receipts", params={"pageSize": 100}).json().get("rows", [])
        check("daftar penerimaan hanya unit sendiri",
              all(row["unit_code"] == "TK-PANAM" for row in own_list), len(own_list))
        cross_view = staff.get(f"/api/v1/receipts/{receipt_bc['id']}")
        check("bendahara bisa lihat penerimaan unit sendiri", cross_view.status_code == 200, cross_view.status_code)

        unit_account_ids = {a["bank_account_id"] for a in assignments}
        staff_balances = staff.get("/api/v1/cash-bank/balances").json()
        check("saldo bendahara hanya rekening unitnya",
              len(staff_balances) > 0 and {row["id"] for row in staff_balances} <= unit_account_ids,
              len(staff_balances))
        check("admin melihat rekening lebih banyak dari bendahara",
              len(balances) > len(staff_balances), (len(balances), len(staff_balances)))

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
