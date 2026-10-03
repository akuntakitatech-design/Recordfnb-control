#!/usr/bin/env python3
"""
Uji 6 flow wajib Kas & Bank (PR #6) lewat API — semua data berprefix TEST-.
Kredensial dari env (TIDAK di-hardcode): TEST_EMAIL, TEST_PASSWORD. BASE default http://localhost:8001.
Opsional: RUN_PERIOD_TEST=1 untuk flow (f) — membuat periode HARD_CLOSED 1 hari (PERIOD_DATE, default 2000-01-01).
PERHATIAN: HARD_CLOSED bersifat permanen (tidak bisa dibuka kembali) — pakai tanggal terisolasi.
Keluaran: ringkasan angka nyata per flow + exit code 1 bila ada assert gagal.
"""
import json
import os
import sys
from datetime import date

import httpx

BASE = os.environ.get("BASE", "http://localhost:8001")
CO = os.environ.get("COMPANY_ID", "a57df7de-646b-48f3-93da-2c415fe46859")
LOC = os.environ.get("LOCATION_ID", "23ab678a-990d-4243-987b-4538ad173b78")
WS = os.environ.get("WORKSPACE_ID", "fca7bf4e-21e7-43c3-b4a9-4ce6fe032231")
TODAY = os.environ.get("TX_DATE", date.today().isoformat())
TAG = os.environ.get("TEST_TAG", TODAY.replace("-", ""))
PERIOD_DATE = os.environ.get("PERIOD_DATE", "2000-01-01")
FLOWS = os.environ.get("FLOWS", "abcd")

c = httpx.Client(base_url=BASE, timeout=60)
failures: list[str] = []
report: dict = {}


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def call(method, url, **kw):
    r = c.request(method, url, **kw)
    try:
        body = r.json()
    except Exception:
        body = r.text
    return r.status_code, body


def rp(v):
    return f"Rp{float(v):,.0f}".replace(",", ".")


def accounts():
    s, b = call("GET", f"/api/cash-bank/accounts?companyId={CO}")
    assert s == 200, b
    by = {a["code"]: a for a in b["accounts"]}
    return by, b["totals"]


def overview_bucket(tx_id):
    s, b = call("GET", f"/api/accounting-control/overview?companyId={CO}")
    row = next((r for r in b["rows"] if r["id"] == tx_id), None)
    return row


def journal_of(tx_id):
    s, b = call("GET", f"/api/cash-bank/transactions/{tx_id}")
    return b.get("journal_number"), b.get("journal_status"), b


def main():
    s, b = call("POST", "/api/auth/login", json={"email": os.environ["TEST_EMAIL"], "password": os.environ["TEST_PASSWORD"]})
    check(s == 200, f"login user uji → {s}")
    by, totals = accounts()
    bca, kas = by["TEST-BCA"], by["TEST-KAS"]
    s, cats = call("GET", f"/api/master/expense-categories?companyId={CO}")
    cat = {x["code"]: x for x in cats}
    s, partners = call("GET", f"/api/master/partners?workspaceId={WS}")
    sup = next(x for x in partners if x["code"] == "TEST-SUP")
    s, items = call("GET", f"/api/master/items?workspaceId={WS}")
    item = next(x for x in items if x["code"] == "TEST-DAGING")

    # ---- Saldo awal (cash-in existing) bila BCA < 10jt
    print("\n[0] Saldo awal TEST-BCA:", rp(bca["balance"]))
    if any(f in FLOWS for f in "abcd") and float(bca["balance"]) < 10_000_000:
        s, ci = call("POST", "/api/client-transactions/cash-ins", json={
            "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"],
            "cashInType": "OTHER_RECEIPT", "referenceNumber": f"TEST-SALDO-{TAG}", "sourceName": "TEST Setoran Modal",
            "lines": [{"description": "TEST saldo awal uji Kas & Bank", "amount": 20_000_000}]})
        check(s == 201, f"cash-in saldo awal Rp20.000.000 → {s} {ci.get('transaction_number') if isinstance(ci, dict) else ci}")
        s2, v = call("POST", f"/api/client-transactions/cash-ins/{ci['id']}/verify")
        check(s2 == 200, f"verifikasi cash-in → {s2}")
        report["saldo_awal"] = ci.get("transaction_number")
    by, totals = accounts()
    print("  saldo BCA sekarang", rp(by["TEST-BCA"]["balance"]), "| KAS", rp(by["TEST-KAS"]["balance"]), "| total company", rp(totals["total"]))

    if "a" in FLOWS:
        flow_a(bca, cat)
    inv = None
    if "b" in FLOWS or "c" in FLOWS:
        inv = flow_b(bca, sup, item, skip_payment="b" not in FLOWS)
    if "c" in FLOWS:
        flow_c(bca, sup, inv)
    if "d" in FLOWS:
        flow_d(bca, kas)
    if "f" in FLOWS or os.environ.get("RUN_PERIOD_TEST") == "1":
        flow_f(bca, kas, cat)
    finish(bca)


def flow_a(bca, cat):
    by, _ = accounts()
    print("\n[a] Pengeluaran operasional dari TEST-BCA (kategori TEST-LISTRIK Rp500.000)")
    before = float(by["TEST-BCA"]["balance"])
    s, co = call("POST", "/api/client-transactions/cash-outs", json={
        "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"], "cashOutType": "OPERATIONAL_EXPENSE",
        "referenceNumber": f"TEST-A1-{TAG}", "payeeName": "TEST PLN",
        "lines": [{"description": "TEST listrik outlet", "expenseCategoryId": cat["TEST-LISTRIK"]["id"], "amount": 500_000}]})
    check(s == 201, f"create cash-out → {s} {co.get('transaction_number') if isinstance(co, dict) else co}")
    by, _ = accounts()
    after = float(by["TEST-BCA"]["balance"])
    check(abs(before - after - 500_000) < 0.01, f"saldo BCA turun {rp(before)} → {rp(after)} (selisih {rp(before - after)})")
    s, v = call("POST", f"/api/client-transactions/cash-outs/{co['id']}/verify")
    check(s == 200, f"verifikasi → {s} {json.dumps(v)[:160]}")
    jn, js, _ = journal_of(co["id"])
    row = overview_bucket(co["id"])
    check(bool(jn), f"jurnal terbentuk: {jn} ({js})")
    check(row and row["bucket"] == "AUTO_OK", f"Accounting Control bucket = {row and row['bucket']}")
    report["a1"] = {"tx": co["transaction_number"], "saldo_before": before, "saldo_after": after, "journal": jn, "bucket": row and row["bucket"]}

    print("   + pengeluaran kategori TEST-LAIN (belum dipetakan) Rp100.000")
    s, co2 = call("POST", "/api/client-transactions/cash-outs", json={
        "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"], "cashOutType": "OPERATIONAL_EXPENSE",
        "referenceNumber": f"TEST-A2-{TAG}", "payeeName": "TEST Lain",
        "lines": [{"description": "TEST biaya lain", "expenseCategoryId": cat["TEST-LAIN"]["id"], "amount": 100_000}]})
    check(s == 201, f"create cash-out TEST-LAIN → {s} {co2.get('transaction_number') if isinstance(co2, dict) else co2}")
    s, v = call("POST", f"/api/client-transactions/cash-outs/{co2['id']}/verify")
    check(s == 200, f"verifikasi → {s}")
    row = overview_bucket(co2["id"])
    check(row and row["bucket"] == "NEEDS_REVIEW", f"bucket = {row and row['bucket']} ({row and row['issue']})")
    report["a2"] = {"tx": co2["transaction_number"], "bucket": row and row["bucket"]}



def flow_b(bca, sup, item, skip_payment=False):
    print("\n[b] Invoice pembelian kredit Rp10.000.000 → bayar Rp6.000.000")
    ref = f"TEST-INV-{TAG}"
    s, invs = call("GET", f"/api/client-transactions/purchase-invoices?companyId={CO}")
    inv = next((x for x in invs if x.get("reference_number") == ref), None)
    if inv:
        print(f"  (pakai ulang invoice {inv['transaction_number']} status {inv['workflow_status']})")
    else:
        s, inv = call("POST", "/api/client-transactions/purchase-invoices", json={
            "companyId": CO, "locationId": LOC, "partnerId": sup["id"], "transactionDate": TODAY, "referenceNumber": ref,
            "paymentType": "CREDIT", "lines": [{"itemId": item["id"], "quantity": 100, "unitPrice": 100_000}]})
        check(s == 201, f"create invoice → {s} {inv.get('transaction_number') if isinstance(inv, dict) else inv} total {inv.get('grand_total') if isinstance(inv, dict) else ''}")
    if inv["workflow_status"] == "DRAFT":
        s, v = call("POST", f"/api/transactions/{inv['id']}/verify")
        check(s == 200, f"verifikasi invoice → {s} {json.dumps(v)[:120]}")
    if skip_payment:
        return inv
    s, co3 = call("POST", "/api/client-transactions/cash-outs", json={
        "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"], "cashOutType": "DEBT_PAYMENT",
        "referenceNumber": f"TEST-B1-{TAG}", "partnerId": sup["id"], "allocations": [{"invoiceId": inv["id"], "amount": 6_000_000}]})
    check(s == 201, f"create bayar hutang 6jt → {s} {co3.get('transaction_number') if isinstance(co3, dict) else co3}")
    s, v = call("POST", f"/api/client-transactions/cash-outs/{co3['id']}/verify")
    check(s == 200, f"verifikasi pembayaran → {s}")
    s, pay = call("GET", f"/api/cash-bank/payables?companyId={CO}")
    p = next(x for x in pay if x["id"] == inv["id"])
    _, _, invd = journal_of(inv["id"])
    jn, js, _ = journal_of(co3["id"])
    check(abs(float(p["remaining"]) - 4_000_000) < 0.01, f"sisa hutang = {rp(p['remaining'])} status {p['status']}")
    check(invd["payment_status"] == "PARTIAL", f"invoice payment_status = {invd['payment_status']}")
    check(bool(jn), f"jurnal pembayaran: {jn} ({js})")
    report["b"] = {"invoice": inv["transaction_number"], "invoice_journal": invd.get("journal_number"), "payment": co3["transaction_number"], "journal": jn, "remaining": p["remaining"], "payment_status": invd["payment_status"]}
    return inv


def flow_c(bca, sup, inv):
    # ---- (c) bayar 4jt → PAID, bayar lagi ditolak
    print("\n[c] Bayar Rp4.000.000 → PAID, lalu coba bayar lagi")
    s, co4 = call("POST", "/api/client-transactions/cash-outs", json={
        "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"], "cashOutType": "DEBT_PAYMENT",
        "referenceNumber": f"TEST-C1-{TAG}", "partnerId": sup["id"], "allocations": [{"invoiceId": inv["id"], "amount": 4_000_000}]})
    check(s == 201, f"create bayar 4jt → {s} {co4.get('transaction_number') if isinstance(co4, dict) else co4}")
    s, v = call("POST", f"/api/client-transactions/cash-outs/{co4['id']}/verify")
    check(s == 200, f"verifikasi → {s}")
    _, _, invd = journal_of(inv["id"])
    jn, js, _ = journal_of(co4["id"])
    check(invd["payment_status"] == "PAID", f"invoice payment_status = {invd['payment_status']}")
    s, again = call("POST", "/api/client-transactions/cash-outs", json={
        "companyId": CO, "locationId": LOC, "transactionDate": TODAY, "financialAccountId": bca["id"], "cashOutType": "DEBT_PAYMENT",
        "referenceNumber": f"TEST-C2-{TAG}", "partnerId": sup["id"], "allocations": [{"invoiceId": inv["id"], "amount": 1_000}]})
    check(s >= 400, f"bayar lagi ditolak → {s} {again}")
    s, openp = call("GET", f"/api/client-transactions/open-payables?companyId={CO}&supplierId={sup['id']}")
    check(all(x["id"] != inv["id"] for x in openp), "invoice tidak lagi muncul di open-payables")
    report["c"] = {"payment": co4["transaction_number"], "journal": jn, "payment_status": invd["payment_status"], "retry": again}


def flow_d(bca, kas):
    # ---- (d) transfer BCA → KAS 2jt
    print("\n[d] Transfer TEST-BCA → TEST-KAS Rp2.000.000")
    by, totals = accounts()
    tb, kb, bb = float(totals["total"]), float(by["TEST-KAS"]["balance"]), float(by["TEST-BCA"]["balance"])
    s, tf = call("POST", "/api/cash-bank/transfers", json={"companyId": CO, "transactionDate": TODAY, "fromAccountId": bca["id"], "toAccountId": kas["id"],
                                                          "amount": 2_000_000, "referenceNumber": f"TEST-D1-{TAG}", "notes": "TEST pindah uang", "locationId": LOC})
    check(s == 201, f"create transfer → {s} {tf.get('transaction_number') if isinstance(tf, dict) else tf}")
    s, v = call("POST", f"/api/cash-bank/transfers/{tf['id']}/verify")
    check(s == 200, f"verifikasi transfer → {s}")
    by, totals = accounts()
    ta, ka, ba = float(totals["total"]), float(by["TEST-KAS"]["balance"]), float(by["TEST-BCA"]["balance"])
    jn, js, _ = journal_of(tf["id"])
    check(abs(tb - ta) < 0.01, f"total kas & bank tetap {rp(tb)} → {rp(ta)}")
    check(abs(bb - ba - 2_000_000) < 0.01 and abs(ka - kb - 2_000_000) < 0.01, f"BCA {rp(bb)}→{rp(ba)}, KAS {rp(kb)}→{rp(ka)}")
    check(tf["transaction_number"].startswith("TF-"), f"satu referensi {tf['transaction_number']}")
    s, led = call("GET", f"/api/cash-bank/ledger?companyId={CO}")
    legs = [r for r in led["rows"] if r["transaction_id"] == tf["id"]]
    check(len(legs) == 2 and {r["kind"] for r in legs} == {"Transfer Keluar", "Transfer Masuk"}, f"ledger: {len(legs)} baris dengan no {set(r['transaction_number'] for r in legs)}")
    check(bool(jn) and jn.startswith("AJ-TF-"), f"jurnal {jn} ({js})")
    report["d"] = {"transfer": tf["transaction_number"], "journal": jn, "total_before": tb, "total_after": ta}



def flow_f(bca, kas, cat):
    if True:
        print(f"\n[f] Periode HARD_CLOSED {PERIOD_DATE}")
        s, periods = call("GET", f"/api/accounting-periods?companyId={CO}")
        per = next((x for x in periods if x["period_start"] == PERIOD_DATE and x["period_end"] == PERIOD_DATE), None)
        draft_id = None
        if not per:
            s, per = call("POST", "/api/accounting-periods", json={"companyId": CO, "periodStart": PERIOD_DATE, "periodEnd": PERIOD_DATE})
            check(s == 201, f"buat periode → {s}")
        if per["status"] != "HARD_CLOSED":
            s, d = call("POST", "/api/cash-bank/transfers", json={"companyId": CO, "transactionDate": PERIOD_DATE, "fromAccountId": bca["id"], "toAccountId": kas["id"],
                                                                 "amount": 1, "referenceNumber": "TEST-F-DRAFT", "notes": "TEST draft untuk uji periode HARD_CLOSED", "locationId": LOC})
            check(s == 201, f"draft transfer Rp1 di periode OPEN → {s} {d.get('transaction_number') if isinstance(d, dict) else d}")
            draft_id = d["id"]
            s, x = call("PATCH", f"/api/accounting-periods/{per['id']}/status", json={"status": "HARD_CLOSED"})
            check(s == 200, f"ubah status → HARD_CLOSED {s}")
        else:
            s, led = call("GET", f"/api/cash-bank/ledger?companyId={CO}&to={PERIOD_DATE}")
            draft_id = next(r["transaction_id"] for r in led["rows"] if r["reference_number"] == "TEST-F-DRAFT")
        s, x = call("POST", "/api/client-transactions/cash-outs", json={
            "companyId": CO, "locationId": LOC, "transactionDate": PERIOD_DATE, "financialAccountId": bca["id"], "cashOutType": "OPERATIONAL_EXPENSE",
            "referenceNumber": "TEST-F1", "lines": [{"description": "TEST", "expenseCategoryId": cat["TEST-LISTRIK"]["id"], "amount": 1}]})
        check(s == 409 and x.get("error") == "ACCOUNTING_PERIOD_HARD_CLOSED", f"create cash-out di HARD_CLOSED → {s} {x}")
        s, x = call("POST", "/api/cash-bank/transfers", json={"companyId": CO, "transactionDate": PERIOD_DATE, "fromAccountId": bca["id"], "toAccountId": kas["id"], "amount": 1})
        check(s == 409, f"create transfer di HARD_CLOSED → {s} {x}")
        s, x = call("POST", f"/api/cash-bank/transfers/{draft_id}/verify")
        check(s == 409, f"verify draft di HARD_CLOSED → {s} {x}")
        s, x = call("POST", f"/api/cash-bank/transactions/{draft_id}/cancel", json={"reason": "TEST"})
        check(s == 409, f"cancel draft di HARD_CLOSED → {s} {x}")
        s, x = call("PATCH", f"/api/accounting-periods/{per['id']}/status", json={"status": "OPEN"})
        check(s == 409, f"buka kembali periode HARD_CLOSED → {s} {x}")
        report["f"] = {"period": PERIOD_DATE, "draft_id": draft_id}



def finish(bca):
    s = c.get(f"/api/cash-bank/export/ledger?companyId={CO}&accountId={bca['id']}").status_code
    check(s == 200, f"export ledger xlsx → {s}")
    s = c.get(f"/api/cash-bank/export/payables?companyId={CO}").status_code
    check(s == 200, f"export payables xlsx → {s}")

    print("\nREPORT", json.dumps(report, default=str))
    print(f"\nGAGAL: {len(failures)}")
    for f in failures:
        print("  -", f)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
