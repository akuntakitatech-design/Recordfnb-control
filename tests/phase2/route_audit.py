#!/usr/bin/env python3
"""
Phase 2 — audit route /api/sales-flow/* : auth, company scope, role permission (DB LOKAL).
Env: QA_PASSWORD, SYSADMIN_EMAIL, SYSADMIN_PASSWORD. Opsional BASE.
Tidak menulis data bisnis (semua panggilan tulis diharapkan ditolak sebelum menyentuh DB, kecuali tidak ada).
"""
import os, sys
import httpx

BASE = os.environ.get("BASE", "http://localhost:8001")
PW = os.environ["QA_PASSWORD"]
CO = "a57df7de-646b-48f3-93da-2c415fe46859"; MN = "23ab678a-990d-4243-987b-4538ad173b78"
FAKE = "00000000-0000-0000-0000-000000000000"
D = "2025-12-31"
results = []

def login(email, pw=PW):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/auth/login", json={"email": email, "password": pw}); assert r.status_code == 200, (email, r.text)
    return c

anon = httpx.Client(base_url=BASE, timeout=60)
U = {
    "ACCOUNTING": login("qa.accounting@akuntakita.test"), "FINANCE": login("qa.finance@akuntakita.test"),
    "FINANCE_STAFF": login("qa.financestaff@akuntakita.test"), "OWNER": login("qa.owner@akuntakita.test"),
    "OUTLET": login("qa.outlet@akuntakita.test"), "SYSADMIN": login(os.environ["SYSADMIN_EMAIL"], os.environ["SYSADMIN_PASSWORD"]),
}

# (method, path, body, {role: allowed_statuses}) — status "OK" = bukan 401/403 (lolos guard; boleh 400/404/409 karena data uji kosong)
OK = "OK"
F = {"ACCOUNTING": OK, "FINANCE": OK, "FINANCE_STAFF": OK, "OWNER": OK, "OUTLET": 403, "SYSADMIN": 403}          # baca Finance
FW = {"ACCOUNTING": OK, "FINANCE": OK, "FINANCE_STAFF": OK, "OWNER": 403, "OUTLET": 403, "SYSADMIN": 403}        # tulis Finance
A = {"ACCOUNTING": OK, "FINANCE": 403, "FINANCE_STAFF": 403, "OWNER": 403, "OUTLET": 403, "SYSADMIN": 403}       # Accounting saja
CDR = {"ACCOUNTING": OK, "FINANCE": OK, "FINANCE_STAFF": OK, "OWNER": OK, "OUTLET": OK, "SYSADMIN": 403}          # baca Cash Drawer
CDW = {"ACCOUNTING": OK, "FINANCE": 403, "FINANCE_STAFF": 403, "OWNER": 403, "OUTLET": OK, "SYSADMIN": 403}     # tulis Cash Drawer
ROUTES = [
    ("GET", f"/api/sales-flow/payment-methods?companyId={CO}", None, F),
    ("POST", "/api/sales-flow/payment-methods", {"companyId": CO}, A),
    ("PUT", f"/api/sales-flow/payment-methods/{FAKE}", {"companyId": CO}, A),
    ("GET", f"/api/sales-flow/pos-codes?companyId={CO}", None, F),
    ("POST", "/api/sales-flow/pos-codes", {"companyId": CO}, A),
    ("GET", f"/api/sales-flow/variance-accounts?companyId={CO}", None, {**A, "OWNER": 403}),
    ("PUT", "/api/sales-flow/variance-accounts", {"companyId": CO}, A),
    ("GET", f"/api/sales-flow/cash-drawers/context?companyId={CO}&locationId={MN}", None, CDR),
    ("GET", f"/api/sales-flow/cash-drawers?companyId={CO}&locationId={MN}", None, CDR),
    ("GET", f"/api/sales-flow/cash-drawers/{FAKE}/history", None, {**CDR, "SYSADMIN": 403}),
    ("POST", "/api/sales-flow/cash-drawers", {"companyId": CO, "locationId": MN, "businessDate": "bad"}, CDW),
    ("POST", "/api/sales-flow/evidence", {"entityType": "CASH_DRAWER_LINE", "entityId": FAKE}, {**CDW, "FINANCE": 404, "FINANCE_STAFF": 404, "OWNER": 403, "SYSADMIN": 403}),
    ("GET", f"/api/sales-flow/evidence/{FAKE}", None, {**CDR, "SYSADMIN": 403}),
    ("GET", f"/api/sales-flow/reconciliations?companyId={CO}", None, F),
    ("GET", f"/api/sales-flow/reconciliations/detail?companyId={CO}&locationId={MN}&date={D}", None, F),
    ("GET", f"/api/sales-flow/reconciliations/history?companyId={CO}&locationId={MN}&date={D}", None, F),
    ("POST", "/api/sales-flow/reconciliations/resolve", {"companyId": CO, "locationId": MN, "date": D, "reasonCode": "XX"}, FW),
    ("POST", "/api/sales-flow/reconciliations/verify", {"companyId": CO, "locationId": MN, "date": D}, FW),
    ("POST", "/api/sales-flow/reconciliations/reopen", {"companyId": CO, "locationId": MN, "date": D, "reason": "audit route"}, A),
    ("GET", f"/api/sales-flow/settlements/outstanding?companyId={CO}", None, F),
    ("GET", f"/api/sales-flow/settlements?companyId={CO}", None, F),
    ("POST", "/api/sales-flow/settlements", {"companyId": CO, "settlementDate": "bad"}, FW),
    ("POST", f"/api/sales-flow/settlements/{FAKE}/cancel", {"companyId": CO, "reason": "audit route"}, A),
]

def ok_status(expected, status):
    if expected == OK: return status not in (401, 403)
    return status == expected

for m, p, body, exp in ROUTES:
    r = anon.request(m, p, json=body) if body is not None else anon.request(m, p)
    results.append(("ANON", m, p, r.status_code == 401, r.status_code))
    for role, c in U.items():
        r = c.request(m, p, json=body) if body is not None else c.request(m, p)
        results.append((role, m, p, ok_status(exp[role], r.status_code), f"{r.status_code} (exp {exp[role]})"))

# Company scope: tanpa companyId / company asing -> ditolak walau Accounting
for m, p, body in [("GET", "/api/sales-flow/payment-methods", None), ("GET", "/api/sales-flow/pos-codes", None),
                   ("GET", f"/api/sales-flow/reconciliations?companyId={FAKE}", None), ("GET", f"/api/sales-flow/settlements?companyId={FAKE}", None),
                   ("GET", f"/api/sales-flow/cash-drawers?companyId={FAKE}&locationId={MN}", None),
                   ("POST", "/api/sales-flow/settlements", {"companyId": FAKE, "settlementDate": D}),
                   ("POST", "/api/sales-flow/reconciliations/reopen", {"companyId": FAKE, "locationId": MN, "date": D, "reason": "audit route"})]:
    r = U["ACCOUNTING"].request(m, p, json=body) if body is not None else U["ACCOUNTING"].request(m, p)
    results.append(("SCOPE", m, p, r.status_code in (400, 403), r.status_code))

# Catatan: penolakan 403 POS_IMPORT_FINANCE_ONLY untuk Outlet diuji di sales_flow_e2e.py
fails = [x for x in results if not x[3]]
for x in results: print(f"[{'OK ' if x[3] else 'ERR'}] {x[0]:13s} {x[1]:4s} {x[2][:80]:80s} {x[4]}")
print(f"\nTOTAL {len(results) - len(fails)}/{len(results)} lulus, gagal: {len(fails)}")
sys.exit(1 if fails else 0)
