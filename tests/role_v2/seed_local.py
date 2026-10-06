#!/usr/bin/env python3
"""
Seed LOKAL untuk regression Role V2 — HANYA untuk DB lokal/salinan (bukan production).
Membuat: outlet ke-2 (kode QA2) + user uji per role lewat API existing (/api/access/users).
Env wajib: ADMIN_EMAIL, ADMIN_PASSWORD (system admin), QA_PASSWORD (password user uji), ALLOW_SEED=1.
Opsional: BASE (default http://localhost:8001).
"""
import os
import sys

import httpx

if os.environ.get("ALLOW_SEED") != "1":
    sys.exit("Set ALLOW_SEED=1 (pastikan backend terhubung ke DB LOKAL, bukan production).")

BASE = os.environ.get("BASE", "http://localhost:8001")
QA_PASSWORD = os.environ["QA_PASSWORD"]
c = httpx.Client(base_url=BASE, timeout=60)
r = c.post("/api/auth/login", json={"email": os.environ["ADMIN_EMAIL"], "password": os.environ["ADMIN_PASSWORD"]})
r.raise_for_status()

ws = c.get("/api/master/workspaces").json()[0]
co = [x for x in c.get("/api/master/companies").json() if x["workspace_id"] == ws["id"]][0]
locs = c.get("/api/master/locations").json()
loc1 = [x for x in locs if x["company_id"] == co["id"]][0]
loc2 = next((x for x in locs if x["code"] == "QA2"), None)
if not loc2:
    r = c.post("/api/master/locations", json={"companyId": co["id"], "code": "QA2", "name": "QA OUTLET 2", "locationType": "OUTLET"})
    print("create location QA2:", r.status_code, r.text[:120])
    loc2 = r.json()
roles = {x["code"]: x["id"] for x in c.get("/api/access/roles").json()}

users = [
    ("qa.akadmin@akuntakita.test", "QA AK Super Admin", "AK_SUPER_ADMIN", None, None),
    ("qa.accounting@akuntakita.test", "QA Accounting Staff", "AK_ACCOUNTING_STAFF", co["id"], None),
    ("qa.reviewer@akuntakita.test", "QA Accounting Reviewer", "AK_ACCOUNTING_REVIEWER", co["id"], None),
    ("qa.finance@akuntakita.test", "QA Finance Manager", "CLIENT_FINANCE_MANAGER", co["id"], None),
    ("qa.financestaff@akuntakita.test", "QA Finance Staff", "CLIENT_FINANCE_STAFF", co["id"], None),
    ("qa.owner@akuntakita.test", "QA Owner", "CLIENT_OWNER", co["id"], None),
    ("qa.outlet@akuntakita.test", "QA Outlet MN", "CLIENT_OUTLET_USER", co["id"], loc1["id"]),
]
for email, name, role, company_id, location_id in users:
    r = c.post("/api/access/users", json={
        "fullName": name, "email": email, "temporaryPassword": QA_PASSWORD,
        "workspaceId": ws["id"], "roleId": roles[role], "companyId": company_id, "locationId": location_id,
    })
    print(f"{email:36s} {role:24s} -> {r.status_code} {'' if r.status_code < 300 else r.text[:80]}")
print("workspace", ws["id"], "company", co["id"], "loc1", loc1["id"], "loc2", loc2["id"])
