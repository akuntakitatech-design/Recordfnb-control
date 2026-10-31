#!/usr/bin/env python3
"""
UAT FC-01 (blueprint V1.2) — pengeluaran: pengajuan, maker-checker, pembayaran, mutasi kas keluar.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional, 4 karakter)
Jalankan: uv run --with httpx python tests/expense_uat.py
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


def num(value) -> float:
    return float(value) if value is not None else 0.0


def ensure_ready_unit(admin: httpx.Client, unit_id: str) -> bool:
    """Aktifkan unit bila masih Draft dan lengkapi rekening + mapping agar READY."""
    if admin.get(f"/api/v1/organization/units/{unit_id}").json().get("operational_status") == "DRAFT":
        if admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT FC-01 expense"}).status_code != 200:
            return False
    if admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY":
        return True

    suffix = str(int(time.time()))[-4:]
    central = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Pusat", "accountNumber": f"41{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    dedicated = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"42{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    })
    if central.status_code not in (201, 409) or dedicated.status_code not in (201, 409):
        return False
    accounts = admin.get("/api/v1/bank-accounts").json()
    central_id = next(a["id"] for a in accounts if a["account_number"] == f"41{suffix}00")
    dedicated_id = next(a["id"] for a in accounts if a["account_number"] == f"42{suffix}00")
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


def create_request(client: httpx.Client, unit_id: str, category_id: str, amount: int, description: str, **extra):
    payload = {
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": description, "amount": amount, "payeeName": "Penerima UAT",
    }
    payload.update(extra)
    return client.post("/api/v1/expenses", json=payload)


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=30)
    r = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", r.status_code == 200, r.status_code)
    if r.status_code != 200:
        return summary()

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    unit = next((u for u in hierarchy["units"] if u["unit_code"] == "TK-PANAM"), None)
    other_unit = next((u for u in hierarchy["units"] if u["unit_code"] != "TK-PANAM"), None)
    draft_unit = next((u for u in hierarchy["units"] if u["operational_status"] == "DRAFT"), None)
    check("unit TK-PANAM tersedia", unit is not None)
    if not unit:
        return summary()
    unit_id = unit["id"]

    check("unit siap pengeluaran (aktif + READY)", ensure_ready_unit(admin, unit_id))

    # Rekening berizin bayar untuk unit
    balances = admin.get("/api/v1/cash-bank/balances").json()
    payable = [row for row in balances if unit_id in (row.get("disbursement_unit_ids") or [])]
    check("rekening berizin bayar tersedia", len(payable) >= 1, len(payable))
    if not payable:
        return summary()
    bank_account_id = payable[0]["id"]

    # Master jenis biaya
    category = admin.post("/api/v1/expense-categories", json={
        "code": f"OPX{SUFFIX}", "name": f"Operasional UAT {SUFFIX}", "expenseAccountCode": "5-2100",
    })
    check("jenis biaya dibuat", category.status_code == 201, category.text[:90])
    if category.status_code != 201:
        return summary()
    category_id = category.json()["id"]

    invalid_account = admin.post("/api/v1/expense-categories", json={
        "code": f"BAD{SUFFIX}", "name": f"Akun Salah {SUFFIX}", "expenseAccountCode": "9-9999",
    })
    check("akun beban di luar CoA ditolak",
          invalid_account.status_code == 400
          and invalid_account.json().get("error") == "EXPENSE_ACCOUNT_MAPPING_MISSING",
          (invalid_account.status_code, invalid_account.text[:70]))

    incomplete_category = admin.post("/api/v1/expense-categories", json={
        "code": f"NAC{SUFFIX}", "name": f"Tanpa Akun {SUFFIX}",
    })
    check("jenis biaya tanpa akun beban dibuat", incomplete_category.status_code == 201, incomplete_category.status_code)

    duplicate_category = admin.post("/api/v1/expense-categories", json={
        "code": f"OPX{SUFFIX}", "name": "Duplikat",
    })
    check("kode jenis biaya duplikat ditolak",
          duplicate_category.status_code == 409 and duplicate_category.json().get("error") == "EXPENSE_CATEGORY_DUPLICATE",
          duplicate_category.status_code)

    # Vendor
    vendor = admin.post("/api/v1/vendors", json={
        "code": f"VND{SUFFIX}", "name": f"Toko Alat Tulis {SUFFIX}", "phone": "0812000000",
    })
    check("vendor dibuat", vendor.status_code == 201, vendor.text[:90])

    # Pengaju = bendahara unit
    staff_email = f"bendahara.exp{SUFFIX}@sekolah.test"
    staff_password = "Bendahara2026!"
    created_user = admin.post("/api/v1/users", json={
        "fullName": "Bendahara Pengeluaran UAT", "email": staff_email, "password": staff_password,
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("user bendahara pengeluaran dibuat", created_user.status_code == 201, created_user.status_code)
    if created_user.status_code != 201:
        return summary()
    staff = httpx.Client(base_url=BASE, timeout=30)
    staff.post("/api/auth/login", json={"email": staff_email, "password": staff_password})

    # Penyetuju terpisah (kepala cabang) untuk menguji maker-checker
    chief_email = f"kepala.exp{SUFFIX}@sekolah.test"
    chief_password = "KepalaSekolah2026!"
    chief_user = admin.post("/api/v1/users", json={
        "fullName": "Kepala Cabang UAT", "email": chief_email, "password": chief_password,
        "role": "KEPALA_CABANG", "unitIds": [unit_id],
    })
    check("user kepala cabang dibuat", chief_user.status_code == 201, chief_user.status_code)
    chief = httpx.Client(base_url=BASE, timeout=30)
    chief.post("/api/auth/login", json={"email": chief_email, "password": chief_password})

    # ACC-01: jenis biaya wajib punya akun beban
    no_account = create_request(staff, unit_id, incomplete_category.json()["id"], 100000, "Biaya tanpa mapping akun")
    check("jenis biaya tanpa akun beban ditolak",
          no_account.status_code == 400 and no_account.json().get("error") == "EXPENSE_ACCOUNT_MAPPING_MISSING",
          (no_account.status_code, no_account.text[:80]))

    # Validasi nominal
    invalid_amount = create_request(staff, unit_id, category_id, 0, "Nominal nol")
    check("nominal nol ditolak",
          invalid_amount.status_code == 400 and invalid_amount.json().get("error") == "EXPENSE_AMOUNT_INVALID",
          invalid_amount.status_code)

    # Pengajuan oleh bendahara
    request = create_request(staff, unit_id, category_id, 500000, f"Honor guru bantu {SUFFIX}")
    check("pengajuan dibuat sebagai draft", request.status_code == 201 and request.json().get("status") == "DRAFT",
          request.text[:100])
    if request.status_code != 201:
        return summary()
    request_id = request.json()["id"]
    request_number = request.json()["request_number"]
    check("nomor pengajuan berpola EXP", str(request_number).startswith("EXP-"), request_number)

    submitted = staff.post(f"/api/v1/expenses/{request_id}/submit")
    check("pengajuan diajukan", submitted.status_code == 200 and submitted.json().get("status") == "SUBMITTED",
          submitted.status_code)

    # Bendahara tidak punya izin menyetujui
    denied = staff.post(f"/api/v1/expenses/{request_id}/approve")
    check("bendahara tidak boleh menyetujui",
          denied.status_code == 403 and denied.json().get("error") == "PERMISSION_DENIED", denied.status_code)

    # Maker-checker: pembuat tidak boleh menyetujui miliknya sendiri
    own = create_request(admin, unit_id, category_id, 150000, f"Pengajuan admin {SUFFIX}", submit=True)
    check("pengajuan admin langsung diajukan",
          own.status_code == 201 and own.json().get("status") == "SUBMITTED", own.status_code)
    own_id = own.json()["id"] if own.status_code == 201 else None
    if own_id:
        self_approve = admin.post(f"/api/v1/expenses/{own_id}/approve")
        check("pengaju tidak boleh menyetujui sendiri",
              self_approve.status_code == 403 and self_approve.json().get("error") == "EXPENSE_SELF_APPROVAL_FORBIDDEN",
              (self_approve.status_code, self_approve.text[:70]))

    approved = admin.post(f"/api/v1/expenses/{request_id}/approve")
    check("pengajuan disetujui atasan", approved.status_code == 200 and approved.json().get("status") == "APPROVED",
          approved.status_code)

    # BANK-05: rekening aktif tapi tidak dipetakan ke unit
    stray_number = f"49{SUFFIX}00"
    stray = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Tanpa Izin Bayar", "accountNumber": stray_number,
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    if stray.status_code == 201:
        stray_id = stray.json()["id"]
    else:
        stray_id = next((a["id"] for a in admin.get("/api/v1/bank-accounts").json()
                         if a["account_number"] == stray_number), None)
    if stray_id:
        admin.post(f"/api/v1/bank-accounts/{stray_id}/verify")
        rejected_account = staff.post(f"/api/v1/expenses/{request_id}/payments", json={
            "bankAccountId": stray_id, "paymentDate": "2026-08-05", "amount": 100000,
        })
        check("rekening tanpa izin bayar ditolak",
              rejected_account.status_code == 400
              and rejected_account.json().get("error") == "BANK_ACCOUNT_NOT_ASSIGNED_TO_UNIT",
              (rejected_account.status_code, rejected_account.text[:80]))

    # Pembayaran sebagian
    partial = staff.post(f"/api/v1/expenses/{request_id}/payments", json={
        "bankAccountId": bank_account_id, "paymentDate": "2026-08-05", "method": "TRANSFER",
        "amount": 200000, "referenceNumber": f"TRF-A-{SUFFIX}",
        "idempotencyKey": f"exp-pay-a-{SUFFIX}",
    })
    check("pembayaran sebagian dibuat", partial.status_code == 201, partial.text[:110])
    if partial.status_code != 201:
        return summary()
    partial_payment = partial.json()["payment"]
    check("nomor pembayaran berpola PAY", str(partial_payment["payment_number"]).startswith("PAY-"),
          partial_payment["payment_number"])

    after_partial = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("status tetap APPROVED setelah bayar sebagian", after_partial["status"] == "APPROVED",
          (after_partial["status"], after_partial["paid_amount"]))
    check("sisa pengajuan berkurang", num(after_partial["remaining"]) == 300000, after_partial["remaining"])

    # Melebihi sisa
    over = staff.post(f"/api/v1/expenses/{request_id}/payments", json={
        "bankAccountId": bank_account_id, "paymentDate": "2026-08-05", "amount": 400000,
    })
    check("pembayaran melebihi sisa ditolak",
          over.status_code == 409 and over.json().get("error") == "PAYMENT_EXCEEDS_REMAINING", over.status_code)

    # T20: permintaan identik hanya satu posting
    replay = staff.post(f"/api/v1/expenses/{request_id}/payments", json={
        "bankAccountId": bank_account_id, "paymentDate": "2026-08-05", "method": "TRANSFER",
        "amount": 200000, "referenceNumber": f"TRF-A-{SUFFIX}",
        "idempotencyKey": f"exp-pay-a-{SUFFIX}",
    })
    body = replay.json()
    check("idempotency key mengembalikan pembayaran sama",
          replay.status_code == 200 and body.get("idempotent") is True
          and body["payment"]["id"] == partial_payment["id"],
          (replay.status_code, body.get("idempotent")))
    still_partial = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("tidak ada pembayaran ganda", num(still_partial["paid_amount"]) == 200000, still_partial["paid_amount"])

    # Pelunasan
    final = staff.post(f"/api/v1/expenses/{request_id}/payments", json={
        "bankAccountId": bank_account_id, "paymentDate": "2026-08-10", "amount": 300000,
        "idempotencyKey": f"exp-pay-b-{SUFFIX}",
    })
    check("pelunasan dibuat", final.status_code == 201, final.status_code)
    paid = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("pengajuan lunas", paid["status"] == "PAID" and num(paid["remaining"]) == 0,
          (paid["status"], paid["remaining"]))

    # Mutasi kas keluar
    mutations = admin.get("/api/v1/cash-bank/mutations",
                          params={"bankAccountId": bank_account_id, "pageSize": 100}).json()["rows"]
    out_rows = [m for m in mutations if m.get("source_id") == partial_payment["id"]]
    check("mutasi keluar pengeluaran tercatat",
          len(out_rows) == 1 and out_rows[0]["direction"] == "OUT" and num(out_rows[0]["amount"]) == 200000,
          [(m["direction"], m["amount"]) for m in out_rows])

    balance_row = next(row for row in admin.get("/api/v1/cash-bank/balances").json() if row["id"] == bank_account_id)
    ledger = admin.get("/api/v1/cash-bank/mutations",
                       params={"bankAccountId": bank_account_id, "pageSize": 100}).json()
    check("saldo rekening konsisten dengan mutasi",
          num(ledger["totals"]["in"]) - num(ledger["totals"]["out"]) == num(balance_row["balance"]),
          (ledger["totals"], balance_row["balance"]))

    # Void pembayaran
    void = admin.post(f"/api/v1/expense-payments/{partial_payment['id']}/void",
                      json={"reason": "UAT batal bayar"})
    check("pembayaran dibatalkan", void.status_code == 200, void.text[:80])
    after_void = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("status kembali APPROVED setelah void",
          after_void["status"] == "APPROVED" and num(after_void["paid_amount"]) == 300000,
          (after_void["status"], after_void["paid_amount"]))
    check("sisa muncul kembali", num(after_void["remaining"]) == 200000, after_void["remaining"])

    mutations2 = admin.get("/api/v1/cash-bank/mutations",
                           params={"bankAccountId": bank_account_id, "pageSize": 100}).json()["rows"]
    reversal = [m for m in mutations2 if m.get("source_id") == partial_payment["id"] and m["direction"] == "IN"]
    check("mutasi masuk pembatalan tercatat", len(reversal) == 1 and num(reversal[0]["amount"]) == 200000,
          len(reversal))

    void_again = admin.post(f"/api/v1/expense-payments/{partial_payment['id']}/void",
                            json={"reason": "UAT batal ulang"})
    check("pembatalan ganda ditolak",
          void_again.status_code == 409
          and void_again.json().get("error") == "EXPENSE_PAYMENT_ALREADY_VOID", void_again.status_code)

    # Pengajuan sudah dibayar tidak bisa dibatalkan
    cancel_paid = admin.post(f"/api/v1/expenses/{request_id}/cancel", json={"reason": "UAT batal pengajuan"})
    check("pengajuan yang sudah dibayar tidak bisa dibatalkan",
          cancel_paid.status_code == 409 and cancel_paid.json().get("error") == "EXPENSE_HAS_PAYMENT",
          cancel_paid.status_code)

    # Penolakan + ajukan ulang (ditolak oleh kepala, bukan oleh pengaju)
    rejected = chief.post(f"/api/v1/expenses/{own_id}/reject", json={"reason": "UAT tolak pengajuan"})
    check("pengajuan ditolak", rejected.status_code == 200 and rejected.json().get("status") == "REJECTED",
          rejected.status_code)
    resubmitted = admin.post(f"/api/v1/expenses/{own_id}/submit")
    check("pengajuan ditolak bisa diajukan ulang",
          resubmitted.status_code == 200 and resubmitted.json().get("status") == "SUBMITTED", resubmitted.status_code)
    cancelled = admin.post(f"/api/v1/expenses/{own_id}/cancel", json={"reason": "UAT batal pengajuan"})
    check("pengajuan tanpa pembayaran bisa dibatalkan",
          cancelled.status_code == 200 and cancelled.json().get("status") == "CANCELLED", cancelled.status_code)

    # T14 — pengeluaran cabang dibayar dari rekening pusat
    central_payable = [
        row for row in balances
        if row["account_usage"] == "CENTRAL" and unit_id in (row.get("disbursement_unit_ids") or [])
    ]
    check("T14 rekening pusat berizin bayar tersedia", len(central_payable) >= 1, len(central_payable))
    if central_payable:
        branch_request = create_request(staff, unit_id, category_id, 75000, f"Beban cabang dibayar pusat {SUFFIX}")
        branch_id = branch_request.json().get("id") if branch_request.status_code == 201 else None
        check("T14 pengajuan unit cabang dibuat", branch_id is not None, branch_request.status_code)
        if branch_id:
            staff.post(f"/api/v1/expenses/{branch_id}/submit")
            approved_branch = chief.post(f"/api/v1/expenses/{branch_id}/approve")
            check("T14 pengajuan cabang disetujui", approved_branch.status_code == 200, approved_branch.status_code)
            central_payment = staff.post(f"/api/v1/expenses/{branch_id}/payments", json={
                "bankAccountId": central_payable[0]["id"], "paymentDate": "2026-08-12",
                "amount": 75000, "idempotencyKey": f"exp-central-{SUFFIX}",
            })
            check("T14 beban cabang dibayar dari rekening pusat", central_payment.status_code == 201,
                  central_payment.text[:110])
            if central_payment.status_code == 201:
                central_body = central_payment.json()["payment"]
                check("T14 rekening pembayaran bertipe CENTRAL", central_body["account_usage"] == "CENTRAL",
                      central_body["account_usage"])
                check("T14 unit beban tetap unit cabang", central_body["unit_code"] == "TK-PANAM",
                      central_body["unit_code"])
                central_mutations = admin.get(
                    "/api/v1/cash-bank/mutations",
                    params={"bankAccountId": central_payable[0]["id"], "pageSize": 100},
                ).json()["rows"]
                check("T14 mutasi keluar tercatat di rekening pusat",
                      any(m.get("source_id") == central_body["id"] and m["direction"] == "OUT"
                          for m in central_mutations), len(central_mutations))

    # Unit belum aktif / belum READY
    if draft_unit:
        blocked = create_request(admin, draft_unit["id"], category_id, 100000, "Pengajuan unit draft")
        check("unit belum aktif ditolak", blocked.status_code == 400, (blocked.status_code, blocked.text[:70]))

    # Scope unit
    if other_unit:
        cross = create_request(staff, other_unit["id"], category_id, 100000, "Pengajuan lintas unit")
        check("bendahara lintas unit ditolak", cross.status_code == 403, (cross.status_code, cross.text[:70]))
        cross_view = staff.get(f"/api/v1/expenses/{request_id}")
        check("bendahara bisa melihat pengajuan unitnya", cross_view.status_code == 200, cross_view.status_code)

    # Audit
    actions = {row["action"] for row in admin.get("/api/v1/audit-logs?limit=100").json()}
    check("audit pengeluaran tercatat",
          {"EXPENSE_REQUEST_APPROVE", "EXPENSE_PAYMENT_CREATE", "EXPENSE_PAYMENT_VOID"} <= actions,
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
