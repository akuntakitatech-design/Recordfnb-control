#!/usr/bin/env python3
"""
UAT T24 — Pengajuan pembelian (rincian barang + ongkos kirim) dan MCM (pengajuan pembayaran).

Alur yang diuji:
  purchasing/bendahara mengajukan (rincian barang) -> approval pengajuan ->
  Finance membuat MCM (DP) -> Ketua Yayasan menyetujui -> posting -> kas keluar ->
  MCM pelunasan -> pengajuan PAID.

HANYA untuk DB lokal/staging.
Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional, 4 karakter)
Jalankan: uv run --with httpx python tests/payment_request_uat.py
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


def summary() -> int:
    failed = [label for label, ok in results if not ok]
    print(f"\nRINGKASAN: {len(results) - len(failed)}/{len(results)} lulus")
    if failed:
        print("Gagal:", "; ".join(failed[:8]))
    return 0 if not failed else 1


def ensure_ready_unit(admin: httpx.Client, unit_id: str) -> bool:
    """Aktifkan unit bila masih Draft dan lengkapi rekening + mapping agar READY."""
    if admin.get(f"/api/v1/organization/units/{unit_id}").json().get("operational_status") == "DRAFT":
        if admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT T24"}).status_code != 200:
            return False
    if admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY":
        return True

    suffix = str(int(time.time()))[-4:]
    central = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Mandiri", "accountNumber": f"61{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    dedicated = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"62{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    })
    if central.status_code not in (201, 409) or dedicated.status_code not in (201, 409):
        return False
    accounts = admin.get("/api/v1/bank-accounts").json()
    central_id = next(a["id"] for a in accounts if a["account_number"] == f"61{suffix}00")
    dedicated_id = next(a["id"] for a in accounts if a["account_number"] == f"62{suffix}00")
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
    check("unit siap pengeluaran (aktif + READY)", ensure_ready_unit(admin, unit_id))

    balances = admin.get("/api/v1/cash-bank/balances").json()
    payable = [row for row in balances if unit_id in (row.get("disbursement_unit_ids") or [])]
    check("rekening berizin bayar tersedia", len(payable) >= 1, len(payable))
    if not payable:
        return summary()
    bank_account_id = payable[0]["id"]

    category = admin.post("/api/v1/expense-categories", json={
        "code": f"PR{SUFFIX}", "name": f"Pembelian UAT {SUFFIX}", "expenseAccountCode": "5-2100",
    })
    check("jenis biaya pembelian dibuat", category.status_code == 201, category.text[:90])
    if category.status_code != 201:
        return summary()
    category_id = category.json()["id"]

    # --- Pengguna: pengaju (bendahara), penyetuju pengajuan (kepala), finance MCM, ketua yayasan
    staff = httpx.Client(base_url=BASE, timeout=30)
    staff_email = f"bendahara.pr{SUFFIX}@sekolah.test"
    created = admin.post("/api/v1/users", json={
        "fullName": "Bendahara Pembelian UAT", "email": staff_email, "password": "Bendahara2026!",
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("user pengaju dibuat", created.status_code == 201, created.status_code)
    if created.status_code != 201:
        return summary()
    staff.post("/api/auth/login", json={"email": staff_email, "password": "Bendahara2026!"})

    chief = httpx.Client(base_url=BASE, timeout=30)
    chief_email = f"kepala.pr{SUFFIX}@sekolah.test"
    created = admin.post("/api/v1/users", json={
        "fullName": "Kepala Cabang UAT", "email": chief_email, "password": "KepalaSekolah2026!",
        "role": "KEPALA_CABANG", "unitIds": [unit_id],
    })
    check("user penyetuju pengajuan dibuat", created.status_code == 201, created.status_code)
    if created.status_code != 201:
        return summary()
    chief.post("/api/auth/login", json={"email": chief_email, "password": "KepalaSekolah2026!"})

    finance = httpx.Client(base_url=BASE, timeout=30)
    finance_email = f"finance.pr{SUFFIX}@sekolah.test"
    created = admin.post("/api/v1/users", json={
        "fullName": "Finance Pusat UAT", "email": finance_email, "password": "Finance2026!",
        "role": "FINANCE_PUSAT", "unitIds": [unit_id],
    })
    check("user finance MCM dibuat", created.status_code == 201, created.status_code)
    if created.status_code != 201:
        return summary()
    finance.post("/api/auth/login", json={"email": finance_email, "password": "Finance2026!"})

    ketua = httpx.Client(base_url=BASE, timeout=30)
    ketua_email = f"ketua.pr{SUFFIX}@sekolah.test"
    created = admin.post("/api/v1/users", json={
        "fullName": "Ketua Yayasan UAT", "email": ketua_email, "password": "KetuaYayasan2026!",
        "role": "PIMPINAN",
    })
    check("user ketua yayasan dibuat", created.status_code == 201, created.status_code)
    if created.status_code != 201:
        return summary()
    ketua.post("/api/auth/login", json={"email": ketua_email, "password": "KetuaYayasan2026!"})

    # --- 1. Pengajuan pembelian dengan rincian barang + ongkos kirim
    created = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Pembelian ATK {SUFFIX}", "payeeName": "Toko ATK UAT",
        "shippingCost": 25000,
        "lines": [
            {"itemName": "Kertas A4 80gsm", "qty": 10, "uom": "rim", "unitPrice": 55000},
            {"itemName": "Tinta printer", "qty": 2, "uom": "botol", "unitPrice": 120000},
        ],
    })
    check("pengajuan dengan rincian dibuat", created.status_code == 201, created.text[:120])
    if created.status_code != 201:
        return summary()
    request = created.json()
    request_id = request["id"]
    check("total = rincian + ongkir", num(request["amount"]) == 10 * 55000 + 2 * 120000 + 25000, request["amount"])
    check("ongkos kirim tersimpan", num(request.get("shipping_cost")) == 25000, request.get("shipping_cost"))
    check("rincian barang tersimpan (2 baris)", len(request.get("lines") or []) == 2, len(request.get("lines") or []))
    check("subtotal baris pertama", num((request.get("lines") or [{}])[0].get("amount")) == 550000)

    lines_invalid = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Qty salah {SUFFIX}", "lines": [{"itemName": "Barang", "qty": 0, "unitPrice": 1000}],
    })
    check("qty rincian 0 ditolak",
          lines_invalid.status_code == 400 and lines_invalid.json().get("error") == "EXPENSE_LINE_QTY_INVALID",
          (lines_invalid.status_code, lines_invalid.text[:70]))

    # --- 2. Submit + approval pengajuan
    check("pengajuan diajukan", staff.post(f"/api/v1/expenses/{request_id}/submit").status_code == 200)
    check("approval pengajuan", chief.post(f"/api/v1/expenses/{request_id}/approve").status_code == 200)

    # --- 3. MCM belum boleh dibuat untuk pengajuan yang belum disetujui
    draft_request = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Belum disetujui {SUFFIX}", "amount": 100000,
    }).json()
    blocked = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": draft_request["id"], "bankAccountId": bank_account_id,
        "requestDate": "2026-08-02", "amount": 50000,
    })
    check("MCM untuk pengajuan belum disetujui ditolak",
          blocked.status_code == 409 and blocked.json().get("error") == "EXPENSE_NOT_APPROVED",
          (blocked.status_code, blocked.text[:70]))

    # --- 4. MCM DP 40%
    dp_amount = round(num(request["amount"]) * 0.4)
    mcm = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": request_id, "bankAccountId": bank_account_id,
        "requestDate": "2026-08-02", "method": "TRANSFER", "amount": dp_amount,
        "notes": f"DP pembelian {SUFFIX}",
    })
    check("MCM DP dibuat", mcm.status_code == 201, mcm.text[:120])
    if mcm.status_code != 201:
        return summary()
    mcm_row = mcm.json()
    mcm_id = mcm_row["id"]
    check("nomor MCM berpola", str(mcm_row["request_number"]).startswith("MCM-"), mcm_row["request_number"])
    check("MCM berstatus DRAFT", mcm_row["status"] == "DRAFT", mcm_row["status"])

    over = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": request_id, "bankAccountId": bank_account_id,
        "requestDate": "2026-08-02", "amount": num(request["amount"]) + 100000,
    })
    check("MCM melebihi sisa pengajuan ditolak",
          over.status_code == 409 and over.json().get("error") == "PAYMENT_EXCEEDS_REMAINING",
          (over.status_code, over.text[:70]))

    check("MCM diajukan", finance.post(f"/api/v1/payment-requests/{mcm_id}/submit").status_code == 200)

    self_approve = finance.post(f"/api/v1/payment-requests/{mcm_id}/approve")
    check("finance tidak boleh menyetujui MCM sendiri",
          self_approve.status_code == 403, (self_approve.status_code, self_approve.text[:70]))

    approved = ketua.post(f"/api/v1/payment-requests/{mcm_id}/approve")
    check("ketua yayasan menyetujui MCM", approved.status_code == 200 and approved.json().get("status") == "APPROVED",
          approved.text[:100])

    # --- 5. Posting MCM -> kas keluar + jurnal
    posting = finance.post(f"/api/v1/payment-requests/{mcm_id}/post")
    check("posting MCM berhasil", posting.status_code == 200, posting.text[:120])
    if posting.status_code != 200:
        return summary()
    check("MCM berstatus POSTED", posting.json().get("paymentRequest", {}).get("status") == "POSTED",
          posting.json().get("paymentRequest", {}).get("status"))
    check("nomor pembayaran terbentuk", str(posting.json().get("paymentNumber") or "").startswith("PAY-"),
          posting.json().get("paymentNumber"))

    detail = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("DP tercatat pada pengajuan", num(detail["paid_amount"]) == dp_amount, detail["paid_amount"])
    check("pengajuan belum lunas tetap APPROVED", detail["status"] == "APPROVED", detail["status"])
    check("MCM tampil di detail pengajuan", len(detail.get("paymentRequests") or []) == 1,
          len(detail.get("paymentRequests") or []))

    mutations = admin.get(f"/api/v1/cash-bank/mutations?from=2026-08-02&to=2026-08-02&unitId={unit_id}").json()
    rows = mutations.get("rows", []) if isinstance(mutations, dict) else mutations
    check("mutasi kas keluar terbentuk",
          any(m.get("direction") == "OUT" and m.get("source_type") == "EXPENSE" for m in rows),
          [(m.get("direction"), m.get("source_type")) for m in rows[:3]])

    # --- 6. Pelunasan lewat MCM kedua
    remaining = num(request["amount"]) - dp_amount
    mcm2 = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": request_id, "bankAccountId": bank_account_id,
        "requestDate": "2026-08-03", "amount": remaining, "notes": f"Pelunasan {SUFFIX}",
    })
    check("MCM pelunasan dibuat", mcm2.status_code == 201, mcm2.text[:100])
    if mcm2.status_code != 201:
        return summary()
    mcm2_id = mcm2.json()["id"]
    finance.post(f"/api/v1/payment-requests/{mcm2_id}/submit")
    ketua.post(f"/api/v1/payment-requests/{mcm2_id}/approve")
    posted2 = finance.post(f"/api/v1/payment-requests/{mcm2_id}/post")
    check("posting pelunasan berhasil", posted2.status_code == 200, posted2.text[:100])

    detail = admin.get(f"/api/v1/expenses/{request_id}").json()
    check("pengajuan menjadi PAID setelah pelunasan", detail["status"] == "PAID", detail["status"])
    check("sisa pengajuan 0", num(detail["remaining"]) == 0, detail["remaining"])

    # --- 7. Penolakan MCM oleh ketua
    mcm3 = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": draft_request["id"], "bankAccountId": bank_account_id,
        "requestDate": "2026-08-04", "amount": 50000,
    })
    # pengajuan belum disetujui, jadi pakai pengajuan lain: buat + setujui dulu
    second = staff.post("/api/v1/expenses", json={
        "unitId": unit_id, "expenseCategoryId": category_id, "requestDate": "2026-08-01",
        "description": f"Pengajuan kedua {SUFFIX}", "amount": 300000,
    }).json()
    staff.post(f"/api/v1/expenses/{second['id']}/submit")
    chief.post(f"/api/v1/expenses/{second['id']}/approve")
    mcm3 = finance.post("/api/v1/payment-requests", json={
        "expenseRequestId": second["id"], "bankAccountId": bank_account_id,
        "requestDate": "2026-08-04", "amount": 150000,
    })
    check("MCM kedua dibuat", mcm3.status_code == 201, mcm3.text[:100])
    mcm3_id = mcm3.json()["id"]
    finance.post(f"/api/v1/payment-requests/{mcm3_id}/submit")
    rejected = ketua.post(f"/api/v1/payment-requests/{mcm3_id}/reject", json={"reason": "Dokumen belum lengkap"})
    check("MCM ditolak ketua", rejected.status_code == 200 and rejected.json().get("status") == "REJECTED",
          rejected.text[:100])
    check("MCM ditolak bisa diajukan ulang",
          finance.post(f"/api/v1/payment-requests/{mcm3_id}/submit").status_code == 200)

    # --- 8. Audit jejak MCM
    logs = admin.get("/api/v1/audit-logs?entityType=PAYMENT_REQUEST").json()
    rows = logs.get("rows", []) if isinstance(logs, dict) else logs
    actions = {row.get("action") for row in rows}
    check("audit MCM tercatat",
          {"PAYMENT_REQUEST_CREATE", "PAYMENT_REQUEST_APPROVE", "PAYMENT_REQUEST_POST"} <= actions,
          sorted(actions)[:6])

    return summary()


if __name__ == "__main__":
    sys.exit(main())
