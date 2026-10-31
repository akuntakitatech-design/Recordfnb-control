#!/usr/bin/env python3
"""
UAT ACC-01 (blueprint V1.2) — CoA, jurnal otomatis, jurnal manual, reversal,
rekonsiliasi subledger vs GL, dan tutup/buka periode.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional, 4 karakter)
Jalankan: uv run --with httpx python tests/accounting_uat.py
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
    if admin.get(f"/api/v1/organization/units/{unit_id}").json().get("operational_status") == "DRAFT":
        if admin.post(f"/api/v1/organization/units/{unit_id}/activate", json={"reason": "UAT ACC-01"}).status_code != 200:
            return False
    if admin.get(f"/api/v1/organization/units/{unit_id}/readiness").json().get("status") == "READY":
        return True

    suffix = str(int(time.time()))[-4:]
    central = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Pusat", "accountNumber": f"51{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "CENTRAL",
    })
    dedicated = admin.post("/api/v1/bank-accounts", json={
        "bankName": "Bank Khusus", "accountNumber": f"52{suffix}00",
        "accountHolder": "Yayasan Pendidikan Harapan", "accountUsage": "DEDICATED",
    })
    if central.status_code not in (201, 409) or dedicated.status_code not in (201, 409):
        return False
    accounts = admin.get("/api/v1/bank-accounts").json()
    central_id = next(a["id"] for a in accounts if a["account_number"] == f"51{suffix}00")
    dedicated_id = next(a["id"] for a in accounts if a["account_number"] == f"52{suffix}00")
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


def manual_entry(admin: httpx.Client, entry_date: str, description: str, lines: list[dict], unit_id: str | None = None):
    payload = {"entryDate": entry_date, "description": description, "lines": lines}
    if unit_id:
        payload["unitId"] = unit_id
    return admin.post("/api/v1/journal-entries", json=payload)


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=60)
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
    check("unit siap transaksi (aktif + READY)", ensure_ready_unit(admin, unit_id))

    # Jurnal & periode hanya untuk Accounting Pusat (blueprint §08)
    acct_email = f"akuntan.acc{SUFFIX}@sekolah.test"
    acct_password = "Akuntan2026!"
    acct_user = admin.post("/api/v1/users", json={
        "fullName": "Akuntan ACC UAT", "email": acct_email, "password": acct_password,
        "role": "ACCOUNTING_PUSAT",
    })
    check("user accounting pusat dibuat", acct_user.status_code == 201, acct_user.text[:80])
    if acct_user.status_code != 201:
        return summary()
    acct = httpx.Client(base_url=BASE, timeout=60)
    acct.post("/api/auth/login", json={"email": acct_email, "password": acct_password})

    # CoA awal
    chart = acct.get("/api/v1/accounts").json()
    codes = {row["code"] for row in chart}
    check("CoA awal tersedia (kas, piutang, pendapatan, beban)",
          {"1-1100", "1-1200", "2-1200", "4-1100", "5-1100", "5-2100"} <= codes, len(codes))

    # Backfill transaksi lama (idempoten)
    backfill = acct.post("/api/v1/accounting/backfill")
    body = backfill.json()
    check("backfill jurnal transaksi lama", backfill.status_code == 200, backfill.text[:120])
    check("backfill tanpa error", not body.get("errors"), (body.get("errors") or [])[:2])
    check("backfill memproses invoice & penerimaan",
          body.get("invoices", 0) > 0 and body.get("receipts", 0) > 0,
          (body.get("invoices"), body.get("receipts"), body.get("expensePayments")))

    entries_before = acct.get("/api/v1/journal-entries", params={"pageSize": 10}).json()["total"]
    replay_backfill = acct.post("/api/v1/accounting/backfill").json()
    entries_after = acct.get("/api/v1/journal-entries", params={"pageSize": 10}).json()["total"]
    check("backfill ulang tidak membuat jurnal ganda", entries_before == entries_after,
          (entries_before, entries_after))
    check("backfill ulang tetap tanpa error", not replay_backfill.get("errors"), len(replay_backfill.get("errors") or []))

    # Transaksi baru: tagihan → jurnal Dr Piutang / Cr Pendapatan
    fee = admin.post("/api/v1/fee-types", json={
        "code": f"ACC{SUFFIX}", "name": f"Biaya ACC {SUFFIX}", "revenueAccountCode": "4-1200",
    })
    check("jenis biaya dengan akun pendapatan", fee.status_code == 201, fee.text[:90])
    if fee.status_code != 201:
        return summary()

    scheme = admin.post("/api/v1/fee-schemes", json={
        "unitId": unit_id, "academicYearId": year_id, "feeTypeId": fee.json()["id"],
        "name": f"Tarif ACC {SUFFIX}", "amount": 1000000, "frequency": "MONTHLY",
        "installmentCount": 1, "effectiveStart": "2026-07-01",
    })
    check("tarif ACC dibuat", scheme.status_code == 201, scheme.status_code)

    student = admin.post("/api/v1/students", json={
        "nis": f"ACCS{SUFFIX}", "fullName": f"Siswa ACC {SUFFIX}", "gender": "L",
        "unitId": unit_id, "academicYearId": year_id, "classLabel": "TK A",
        "effectiveStart": "2026-07-01",
    })
    check("siswa ACC dibuat", student.status_code == 201, student.status_code)
    if student.status_code != 201:
        return summary()
    student_id = student.json()["id"]

    period = f"JA{SUFFIX}"
    generated = admin.post("/api/v1/billing-runs/generate", json={
        "unitId": unit_id, "academicYearId": year_id, "periodLabel": period,
        "invoiceDate": "2026-09-01", "dueDate": "2026-09-15",
    })
    check("tagihan ACC diterbitkan", generated.status_code == 201, generated.text[:100])

    invoices = admin.get("/api/v1/invoices", params={"periodLabel": period, "pageSize": 100}).json()["rows"]
    invoice = next((row for row in invoices if row["student_id"] == student_id), None)
    check("invoice ACC ditemukan", invoice is not None)
    if not invoice:
        return summary()
    invoice_total = num(invoice["total_amount"])

    entry_rows = acct.get("/api/v1/journal-entries",
                          params={"sourceType": "INVOICE", "pageSize": 100}).json()["rows"]
    invoice_entry = next((row for row in entry_rows if row["source_id"] == invoice["id"]), None)
    check("jurnal tagihan otomatis dibuat", invoice_entry is not None, len(entry_rows))
    if not invoice_entry:
        return summary()

    invoice_detail = acct.get(f"/api/v1/journal-entries/{invoice_entry['id']}").json()
    debit_lines = [line for line in invoice_detail["lines"] if num(line["debit"]) > 0]
    credit_lines = [line for line in invoice_detail["lines"] if num(line["credit"]) > 0]
    check("jurnal tagihan seimbang",
          num(invoice_detail["lines"][0]["debit"]) + sum(num(l["debit"]) for l in invoice_detail["lines"][1:])
          == sum(num(l["credit"]) for l in invoice_detail["lines"]),
          (invoice_total, len(invoice_detail["lines"])))
    check("debit tagihan ke piutang", any(l["account_code"] == "1-1200" for l in debit_lines),
          [l["account_code"] for l in debit_lines])
    check("kredit tagihan ke akun pendapatan jenis biaya",
          any(l["account_code"] == "4-1200" for l in credit_lines), [l["account_code"] for l in credit_lines])

    # Penerimaan → jurnal Dr Kas / Cr Piutang
    assignments = admin.get(f"/api/v1/organization/units/{unit_id}").json().get("assignments", [])
    receipt_account = next((a for a in assignments if a.get("allow_receipt") and a.get("status") == "ACTIVE"), None)
    check("rekening penerimaan tersedia", receipt_account is not None)
    if not receipt_account:
        return summary()

    receipt = admin.post("/api/v1/receipts", json={
        "unitId": unit_id, "bankAccountId": receipt_account["bank_account_id"],
        "receiptDate": "2026-09-10", "method": "TRANSFER", "payerName": f"Wali ACC {SUFFIX}",
        "totalAmount": invoice_total, "idempotencyKey": f"acc-receipt-{SUFFIX}",
        "allocations": [{"invoiceId": invoice["id"], "amount": invoice_total}],
    })
    check("penerimaan ACC dibuat", receipt.status_code == 201, receipt.text[:110])
    if receipt.status_code != 201:
        return summary()
    receipt_id = receipt.json()["receipt"]["id"]

    receipt_entries = acct.get("/api/v1/journal-entries",
                               params={"sourceType": "RECEIPT", "pageSize": 100}).json()["rows"]
    receipt_entry = next((row for row in receipt_entries if row["source_id"] == receipt_id), None)
    check("jurnal penerimaan otomatis dibuat", receipt_entry is not None)
    if receipt_entry:
        receipt_detail = acct.get(f"/api/v1/journal-entries/{receipt_entry['id']}").json()
        debit_codes = {l["account_code"] for l in receipt_detail["lines"] if num(l["debit"]) > 0}
        credit_codes = {l["account_code"] for l in receipt_detail["lines"] if num(l["credit"]) > 0}
        check("jurnal penerimaan: kas masuk, piutang berkurang",
              "1-1100" in debit_codes and "1-1200" in credit_codes, (debit_codes, credit_codes))

    # Neraca saldo
    trial = acct.get("/api/v1/accounting/trial-balance", params={"from": "2026-01-01", "to": "2026-12-31"}).json()
    check("neraca saldo seimbang", trial.get("balanced") is True,
          (trial.get("totalDebit"), trial.get("totalCredit")))
    check("neraca saldo memuat akun bergerak", len(trial.get("items", [])) >= 3, len(trial.get("items", [])))

    # Rekonsiliasi subledger vs GL
    recon = acct.get("/api/v1/accounting/reconciliation").json()
    check("GL piutang = subledger tagihan", abs(num(recon["receivable"]["difference"])) < 0.005,
          recon["receivable"])
    check("GL kas = mutasi bank (+ jurnal manual)",
          abs(num(recon["cash"]["unexplained"])) < 0.005, recon["cash"])
    check("GL uang muka = penerimaan belum dialokasikan",
          abs(num(recon["deposit"]["difference"])) < 0.005, recon["deposit"])
    check("rekonsiliasi keseluruhan seimbang", recon.get("balanced") is True, recon.get("balanced"))

    # Jurnal manual: tidak seimbang ditolak
    unbalanced = manual_entry(acct, "2027-03-05", "UAT jurnal tidak seimbang", [
        {"accountCode": "5-2100", "debit": 100000},
        {"accountCode": "1-1100", "credit": 90000},
    ], unit_id)
    check("jurnal tidak seimbang ditolak",
          unbalanced.status_code == 409 and unbalanced.json().get("error") == "JOURNAL_NOT_BALANCED",
          (unbalanced.status_code, unbalanced.text[:80]))

    # Akun tidak dikenal ditolak
    unknown = manual_entry(acct, "2027-03-05", "UAT akun tidak dikenal", [
        {"accountCode": "9-9999", "debit": 50000},
        {"accountCode": "1-1100", "credit": 50000},
    ], unit_id)
    check("akun tidak dikenal ditolak",
          unknown.status_code == 400 and unknown.json().get("error") == "ACCOUNT_MAPPING_MISSING",
          unknown.status_code)

    # Jurnal manual seimbang
    manual = manual_entry(acct, "2027-03-05", f"UAT jurnal manual {SUFFIX}", [
        {"accountCode": "5-2100", "debit": 75000, "description": "Beban operasional"},
        {"accountCode": "1-1100", "credit": 75000, "description": "Kas keluar"},
    ], unit_id)
    check("jurnal manual seimbang dibuat", manual.status_code == 201, manual.text[:100])
    if manual.status_code != 201:
        return summary()
    manual_id = manual.json()["id"]
    check("nomor jurnal berpola JE", str(manual.json()["entry_number"]).startswith("JE-"),
          manual.json()["entry_number"])

    # Tutup periode 2027-03 lalu tolak posting baru
    periods = acct.get("/api/v1/fiscal-periods").json()
    march = next((row for row in periods if row["name"] == "2027-03"), None)
    check("periode 2027-03 tersedia otomatis", march is not None, [row["name"] for row in periods][:4])
    if not march:
        return summary()

    closed = acct.post(f"/api/v1/fiscal-periods/{march['id']}/close")
    check("periode ditutup", closed.status_code == 200 and closed.json().get("status") == "CLOSED",
          closed.status_code)

    blocked = manual_entry(acct, "2027-03-10", "UAT posting periode tertutup", [
        {"accountCode": "5-2100", "debit": 10000},
        {"accountCode": "1-1100", "credit": 10000},
    ], unit_id)
    check("posting pada periode tertutup ditolak",
          blocked.status_code == 409 and blocked.json().get("error") == "PERIOD_CLOSED",
          (blocked.status_code, blocked.text[:70]))

    reopen = acct.post(f"/api/v1/fiscal-periods/{march['id']}/reopen", json={"reason": "UAT buka kembali periode"})
    check("periode dibuka kembali dengan alasan", reopen.status_code == 200 and reopen.json().get("status") == "OPEN",
          reopen.status_code)

    after_reopen = manual_entry(acct, "2027-03-10", "UAT posting setelah buka", [
        {"accountCode": "5-2100", "debit": 10000},
        {"accountCode": "1-1100", "credit": 10000},
    ], unit_id)
    check("posting berhasil setelah periode dibuka", after_reopen.status_code == 201, after_reopen.status_code)

    # Reversal jurnal manual
    reversed_entry = acct.post(f"/api/v1/journal-entries/{manual_id}/reverse",
                               json={"reason": "UAT pembalik jurnal manual"})
    check("jurnal manual dapat dibalik", reversed_entry.status_code == 200, reversed_entry.text[:80])
    reverse_again = acct.post(f"/api/v1/journal-entries/{manual_id}/reverse",
                              json={"reason": "UAT pembalik ulang"})
    check("pembalikan ganda ditolak",
          reverse_again.status_code == 409 and reverse_again.json().get("error") == "JOURNAL_NOT_REVERSIBLE",
          reverse_again.status_code)

    trial2 = acct.get("/api/v1/accounting/trial-balance", params={"from": "2026-01-01", "to": "2027-12-31"}).json()
    check("neraca saldo tetap seimbang setelah reversal", trial2.get("balanced") is True,
          (trial2.get("totalDebit"), trial2.get("totalCredit")))

    # Scope: bendahara tidak boleh posting jurnal
    staff_email = f"bendahara.acc{SUFFIX}@sekolah.test"
    created_user = admin.post("/api/v1/users", json={
        "fullName": "Bendahara ACC UAT", "email": staff_email, "password": "Bendahara2026!",
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("user bendahara ACC dibuat", created_user.status_code == 201, created_user.status_code)
    if created_user.status_code == 201:
        staff = httpx.Client(base_url=BASE, timeout=30)
        staff.post("/api/auth/login", json={"email": staff_email, "password": "Bendahara2026!"})
        denied = staff.post("/api/v1/journal-entries", json={
            "entryDate": "2027-04-01", "description": "UAT bendahara posting",
            "lines": [{"accountCode": "5-2100", "debit": 1000}, {"accountCode": "1-1100", "credit": 1000}],
        })
        check("bendahara tidak boleh posting jurnal",
              denied.status_code == 403 and denied.json().get("error") == "PERMISSION_DENIED", denied.status_code)
        allowed_read = staff.get("/api/v1/journal-entries", params={"pageSize": 10})
        check("bendahara boleh membaca jurnal unitnya", allowed_read.status_code == 200, allowed_read.status_code)

    # Audit
    actions = {row["action"] for row in admin.get("/api/v1/audit-logs?limit=100").json()}
    check("audit akuntansi tercatat",
          {"JOURNAL_POST", "JOURNAL_REVERSE", "PERIOD_CLOSE", "PERIOD_REOPEN"} <= actions, sorted(actions)[:8])

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
