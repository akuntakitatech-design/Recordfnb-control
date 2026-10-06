#!/usr/bin/env python3
"""
Regression Role V2 (Phase 1 — Foundation & Role) lewat API.
Menguji permission matrix per role + transaksi existing tetap jalan. JALANKAN HANYA DI DB LOKAL/SALINAN
(membuat transaksi uji berprefix RV2-).

Env wajib : QA_PASSWORD (password user qa.*@akuntakita.test dari seed_local.py), SYSADMIN_EMAIL, SYSADMIN_PASSWORD
Opsional  : BASE (default http://localhost:8001)
Prasyarat : seed_local.py + backend/tests/e2e_api.py sudah dijalankan (master item/unit/supplier/kas tersedia).
Keluaran  : tabel hasil per role + exit 1 bila ada yang gagal.
"""
import os
import sys
from datetime import date

import httpx

BASE = os.environ.get("BASE", "http://localhost:8001")
PW = os.environ["QA_PASSWORD"]
TODAY = date.today().isoformat()
TAG = "RV2-" + date.today().strftime("%m%d") + os.environ.get("TEST_TAG", "")
results: list[tuple[str, str, bool, str]] = []


def login(email: str, password: str) -> httpx.Client:
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    results.append(("login", f"{email} login", r.status_code == 200, str(r.status_code)))
    return c


def check(role: str, label: str, c: httpx.Client, method: str, path: str, expect: set[int], **kw):
    r = c.request(method, path, **kw)
    ok = r.status_code in expect
    detail = f"{r.status_code}" + ("" if ok else f" body={r.text[:160]}")
    results.append((role, label, ok, detail))
    try:
        return r.json()
    except Exception:
        return None


def assert_true(role: str, label: str, cond: bool, detail: str = ""):
    results.append((role, label, bool(cond), detail))


def by_code(rows, code):
    return next((x for x in rows or [] if x.get("code") == code), None)


# ---------------------------------------------------------------- setup (Accounting super admin)
ak = login("qa.akadmin@akuntakita.test", PW)
WS = ak.get("/api/master/workspaces").json()[0]["id"]
CO = next(x for x in ak.get("/api/master/companies").json() if x["workspace_id"] == WS)["id"]
locs = ak.get("/api/master/locations").json()
LOC = next(x for x in locs if x["code"] == "MN")["id"]
LOC2 = next(x for x in locs if x["code"] == "QA2")["id"]
units = ak.get(f"/api/master/units?workspaceId={WS}").json()
kg = by_code(units, "KG") or by_code(units, "TEST-KG") or ak.post("/api/master/units", json={"workspaceId": WS, "code": "KG", "name": "Kilogram", "decimalPrecision": 3}).json()
KG = kg["id"]
cats = ak.get(f"/api/master/item-categories?workspaceId={WS}").json()
RAW_CAT = (by_code(cats, "TEST-RAW") or by_code(cats, "BAHAN_BAKU") or cats[0])["id"]
STJ_CAT = (by_code(cats, "SETENGAH_JADI") or by_code(cats, "TEST-RAW") or cats[0])["id"]
items = ak.get(f"/api/master/items?workspaceId={WS}").json()


def ensure_item(code, name, cat, **flags):
    found = by_code(items, code)
    if found:
        return found["id"]
    body = {"workspaceId": WS, "code": code, "name": name, "categoryId": cat, "baseUnitId": KG, "trackStock": True,
            "canPurchase": True, "canSell": False, "canProduce": False, "canUseInRecipe": True}
    body.update(flags)
    r = ak.post("/api/master/items", json=body)
    r.raise_for_status()
    return r.json()["id"]


DAGING = (by_code(items, "TEST-DAGING") or {}).get("id") or ensure_item("RV2-DAGING", "RV2 Daging", RAW_CAT)
BUMBU = ensure_item("RV2-BUMBU", "RV2 Bumbu", RAW_CAT)
STJ = ensure_item("RV2-STJ", "RV2 Saus STJ", STJ_CAT, canPurchase=False, canProduce=True)
fas = ak.get(f"/api/client-transactions/financial-accounts?companyId={CO}").json()
KAS = next(x for x in fas if x.get("account_kind") == "CASH")["id"]
partners = ak.get(f"/api/master/partners?workspaceId={WS}").json()
SUP = (by_code(partners, "TEST-SUP") or by_code(partners, "SUP-01") or ak.post("/api/client-master/partners", json={
    "workspaceId": WS, "code": "RV2-SUP", "name": "RV2 Supplier", "partnerType": "SUPPLIER", "paymentTermDays": 14}).json())["id"]


def purchase_body(loc):
    return {"companyId": CO, "locationId": loc, "partnerId": SUP, "transactionDate": TODAY, "dueDate": TODAY,
            "referenceNumber": f"{TAG}-{os.urandom(3).hex()}", "paymentType": "CREDIT",
            "lines": [{"itemId": DAGING, "description": "Daging", "quantity": 5, "unitId": KG, "unitPrice": 100000, "taxIncluded": False}]}


def cash_out_body(loc):
    return {"companyId": CO, "locationId": loc, "financialAccountId": KAS, "transactionDate": TODAY, "cashOutType": "OPERATIONAL_EXPENSE",
            "payeeName": "Toko", "referenceNumber": f"{TAG}-CO", "lines": [{"description": "Gas", "amount": 1000}]}


def opname_body(loc):
    return {"companyId": CO, "locationId": loc, "transactionDate": TODAY, "notes": TAG,
            "lines": [{"itemId": DAGING, "physicalQuantity": 1, "unitId": KG, "description": "fisik"}]}


def usage_body(loc):
    return {"companyId": CO, "locationId": loc, "transactionDate": TODAY, "notes": TAG,
            "lines": [{"itemId": BUMBU, "quantity": 0.1, "unitId": KG, "description": "pakai"}]}


def bom_body(notes):
    return {"companyId": CO, "bomType": "PRODUCTION", "outputItemId": STJ, "outputQuantity": 5, "outputUnitId": KG, "notes": notes,
            "lines": [{"componentItemId": DAGING, "quantity": 2, "unitId": KG, "wastePercent": 5}, {"componentItemId": BUMBU, "quantity": 0.5, "unitId": KG}]}


ACC_ENDPOINTS = [
    ("GET", f"/api/journals/recent?companyId={CO}"),
    ("GET", f"/api/accounting-control/overview?companyId={CO}"),
    ("GET", f"/api/accounting-periods?companyId={CO}"),
    ("GET", "/api/master/coa-standard/templates"),
    ("GET", f"/api/master/coa-standard/company/{CO}/mappings"),
    ("GET", f"/api/master/accounts?companyId={CO}"),
    ("GET", f"/api/transactions/recent?companyId={CO}"),
    ("GET", f"/api/accounting-cash-outs/pending?companyId={CO}"),
    ("GET", f"/api/accounting-cash-ins/pending?companyId={CO}"),
]
ACC_WRITES = [
    ("POST", "/api/accounting-periods", {"companyId": CO, "month": "2001-01"}),
    ("POST", "/api/transactions/drafts", {"companyId": CO}),
    ("POST", "/api/master/accounts", {"workspaceId": WS, "companyId": CO, "code": "X-1", "name": "x", "accountType": "EXPENSE", "normalBalance": "DEBIT"}),
]

# ---------------------------------------------------------------- ACCOUNTING (staff, scope company)
acc = login("qa.accounting@akuntakita.test", PW)
R = "ACCOUNTING"
for m, p in ACC_ENDPOINTS:
    check(R, f"Accounting API {p.split('?')[0]}", acc, m, p, {200})
for m, p in [("GET", f"/api/cash-bank/accounts?companyId={CO}"), ("GET", f"/api/cash-bank/payables?companyId={CO}"),
             ("GET", f"/api/client-transactions/purchase-invoices?companyId={CO}"), ("GET", f"/api/client-transactions/sales-batches?companyId={CO}"),
             ("GET", f"/api/client-transactions/inventory-control?companyId={CO}&locationId={LOC2}")]:
    check(R, f"Finance menu API {p.split('?')[0]}", acc, m, p, {200})
acc_locs = {x["code"] for x in acc.get("/api/master/locations").json()}
assert_true(R, "lihat seluruh outlet company (MN + QA2)", {"MN", "QA2"} <= acc_locs, str(sorted(acc_locs)))
b1 = check(R, "BOM create", acc, "POST", "/api/client-transactions/boms", {201}, json=bom_body(f"{TAG} v1")) or {}
b2 = check(R, "BOM edit (versi baru)", acc, "POST", "/api/client-transactions/boms", {201}, json=bom_body(f"{TAG} v2")) or {}
assert_true(R, "BOM versioning naik", b2.get("version", 0) == b1.get("version", -1) + 1, f"v{b1.get('version')} -> v{b2.get('version')}")
BOM_ID = b2.get("id")
pi_acc = check(R, "Accounting jalankan fungsi Finance: invoice pembelian", acc, "POST", "/api/client-transactions/purchase-invoices", {201}, json=purchase_body(LOC2)) or {}

# ---------------------------------------------------------------- FINANCE (manager & staff)
for email, R in [("qa.finance@akuntakita.test", "FINANCE"), ("qa.financestaff@akuntakita.test", "FINANCE_STAFF")]:
    fin = login(email, PW)
    for m, p in ACC_ENDPOINTS:
        check(R, f"Accounting API ditolak {p.split('?')[0]}", fin, m, p, {403})
    for m, p, body in ACC_WRITES:
        check(R, f"Accounting write ditolak {p}", fin, m, p, {403}, json=body)
    check(R, "BOM bisa dilihat", fin, "GET", f"/api/client-transactions/boms?companyId={CO}", {200})
    check(R, "BOM create ditolak", fin, "POST", "/api/client-transactions/boms", {403}, json=bom_body("finance"))
    check(R, "BOM edit ditolak", fin, "POST", "/api/client-transactions/boms", {403}, json=bom_body("finance edit"))
    if BOM_ID:
        check(R, "BOM deactivate ditolak", fin, "DELETE", f"/api/client-transactions/boms/{BOM_ID}", {403})
    pi = check(R, "Purchase Invoice create", fin, "POST", "/api/client-transactions/purchase-invoices", {201}, json=purchase_body(LOC)) or {}
    if pi.get("id"):
        check(R, "Purchase Invoice Finance Verified", fin, "POST", f"/api/transactions/{pi['id']}/verify", {200})
    co = check(R, "Kas & Bank: pengeluaran (cash-out)", fin, "POST", "/api/client-transactions/cash-outs", {201}, json=cash_out_body(LOC)) or {}
    if co.get("id"):
        check(R, "Kas & Bank: verifikasi cash-out", fin, "POST", f"/api/client-transactions/cash-outs/{co['id']}/verify", {200})
    check(R, "Kas & Bank: saldo", fin, "GET", f"/api/cash-bank/accounts?companyId={CO}", {200})
    check(R, "Hutang Supplier: daftar", fin, "GET", f"/api/cash-bank/payables?companyId={CO}", {200})
    check(R, "Inventory: pemakaian", fin, "POST", "/api/client-transactions/item-usages", {201}, json=usage_body(LOC))
    check(R, "Inventory: transfer MN->QA2", fin, "POST", "/api/client-transactions/stock-transfers", {201}, json={
        "companyId": CO, "fromLocationId": LOC, "toLocationId": LOC2, "transactionDate": TODAY, "lines": [{"itemId": DAGING, "quantity": 0.1, "unitId": KG, "description": TAG}]})
    check(R, "Inventory: stock opname", fin, "POST", "/api/client-transactions/stock-opnames", {201}, json=opname_body(LOC))
    check(R, "Inventory: kartu/kontrol stok", fin, "GET", f"/api/client-transactions/inventory-control?companyId={CO}&locationId={LOC}", {200})
    if BOM_ID:
        check(R, "Produksi dengan BOM aktif", fin, "POST", "/api/client-transactions/productions", {201}, json={
            "companyId": CO, "locationId": LOC, "bomId": BOM_ID, "transactionDate": TODAY, "batchCount": 1, "actualOutput": 5, "notes": TAG})
    check(R, "Master operasional: tambah item", fin, "POST", "/api/client-master/items", {201}, json={
        "workspaceId": WS, "code": f"{TAG}-{R[:3]}-{os.urandom(2).hex()}", "name": "Item Finance", "categoryId": RAW_CAT, "baseUnitId": KG, "trackStock": True})

# ---------------------------------------------------------------- OWNER (read-only)
own = login("qa.owner@akuntakita.test", PW)
R = "OWNER"
me = own.get("/api/auth/me").json()
assert_true(R, "role CLIENT_OWNER", any(m["role_code"] == "CLIENT_OWNER" for m in me["memberships"]))
for m, p in ACC_ENDPOINTS[:3]:
    check(R, f"Accounting API ditolak {p.split('?')[0]}", own, m, p, {403})
check(R, "read-only: lihat saldo kas", own, "GET", f"/api/cash-bank/accounts?companyId={CO}", {200})
for label, p, body in [
    ("create purchase invoice", "/api/client-transactions/purchase-invoices", purchase_body(LOC)),
    ("create cash-out", "/api/client-transactions/cash-outs", cash_out_body(LOC)),
    ("create stock opname", "/api/client-transactions/stock-opnames", opname_body(LOC)),
    ("create item usage", "/api/client-transactions/item-usages", usage_body(LOC)),
    ("create pindah uang", "/api/cash-bank/transfers", {"companyId": CO}),
    ("create BOM", "/api/client-transactions/boms", bom_body("owner")),
    ("tambah item master", "/api/client-master/items", {"workspaceId": WS}),
]:
    check(R, f"{label} ditolak", own, "POST", p, {403}, json=body)
if pi_acc.get("id"):
    check(R, "verify transaksi ditolak", own, "POST", f"/api/transactions/{pi_acc['id']}/verify", {403})
    check(R, "upload lampiran ditolak", own, "POST", f"/api/client-transactions/{pi_acc['id']}/attachments", {403}, json={"fileName": "a.pdf", "mimeType": "application/pdf", "dataBase64": "eA=="})
if BOM_ID:
    check(R, "deactivate BOM ditolak", own, "DELETE", f"/api/client-transactions/boms/{BOM_ID}", {403})

# ---------------------------------------------------------------- OUTLET (assignment: MN)
out = login("qa.outlet@akuntakita.test", PW)
R = "OUTLET"
out_locs = {x["code"] for x in out.get("/api/master/locations").json()}
assert_true(R, "hanya melihat outlet assignment (MN)", out_locs == {"MN"}, str(sorted(out_locs)))
check(R, "konteks penjualan outlet sendiri", out, "GET", f"/api/client-transactions/sales-context?companyId={CO}&locationId={LOC}", {200})
check(R, "konteks penjualan outlet lain ditolak", out, "GET", f"/api/client-transactions/sales-context?companyId={CO}&locationId={LOC2}", {403})
so = check(R, "stock opname outlet sendiri", out, "POST", "/api/client-transactions/stock-opnames", {201}, json=opname_body(LOC)) or {}
check(R, "stock opname outlet lain ditolak", out, "POST", "/api/client-transactions/stock-opnames", {403}, json=opname_body(LOC2))
check(R, "pemakaian outlet sendiri", out, "POST", "/api/client-transactions/item-usages", {201}, json=usage_body(LOC))
check(R, "pemakaian outlet lain ditolak", out, "POST", "/api/client-transactions/item-usages", {403}, json=usage_body(LOC2))
check(R, "saldo stok outlet lain ditolak", out, "GET", f"/api/client-transactions/item-usage-balances?companyId={CO}&locationId={LOC2}", {403})
rows = out.get(f"/api/client-transactions/stock-opnames?companyId={CO}").json()
assert_true(R, "daftar opname hanya outlet sendiri", all(r.get("location_id") == LOC for r in rows), f"{len(rows)} baris")
if so.get("id"):
    check(R, "verifikasi Finance oleh outlet ditolak", out, "POST", f"/api/client-transactions/stock-opnames/{so['id']}/verify", {403})
for m, p in ACC_ENDPOINTS:
    check(R, f"Accounting API ditolak {p.split('?')[0]}", out, m, p, {403})
for label, m, p, body in [
    ("Kas & Bank ditolak", "GET", f"/api/cash-bank/accounts?companyId={CO}", None),
    ("Hutang Supplier ditolak", "GET", f"/api/cash-bank/payables?companyId={CO}", None),
    ("Pembelian (list) ditolak", "GET", f"/api/client-transactions/purchase-invoices?companyId={CO}", None),
    ("Pembelian (create) ditolak", "POST", "/api/client-transactions/purchase-invoices", purchase_body(LOC)),
    ("Kas keluar ditolak", "POST", "/api/client-transactions/cash-outs", cash_out_body(LOC)),
    ("Produksi ditolak", "POST", "/api/client-transactions/productions", {"companyId": CO, "locationId": LOC, "bomId": BOM_ID, "transactionDate": TODAY, "batchCount": 1, "actualOutput": 1}),
    ("BOM edit ditolak", "POST", "/api/client-transactions/boms", bom_body("outlet")),
    ("transaksi generik perusahaan ditolak", "POST", "/api/transactions/drafts", {"companyId": CO}),
    ("kontrol stok perusahaan ditolak", "GET", f"/api/client-transactions/inventory-control?companyId={CO}&locationId={LOC}", None),
]:
    check(R, label, out, m, p, {403}, json=body) if body is not None else check(R, label, out, m, p, {403})
if pi_acc.get("id"):
    check(R, "lampiran transaksi Finance tidak terlihat", out, "GET", f"/api/client-transactions/{pi_acc['id']}/attachments", {403, 404})

# ---------------------------------------------------------------- SYSTEM ADMIN (tanpa membership bisnis)
sysc = login(os.environ["SYSADMIN_EMAIL"], os.environ["SYSADMIN_PASSWORD"])
R = "SYSTEM_ADMIN"
me = sysc.get("/api/auth/me").json()
check(R, "User & Akses", sysc, "GET", "/api/access/users", {200})
check(R, "Organisasi: company", sysc, "GET", "/api/master/companies", {200})
if not me["memberships"]:
    check(R, "tanpa membership: Accounting API ditolak", sysc, "GET", f"/api/journals/recent?companyId={CO}", {403})
    check(R, "tanpa membership: Kas & Bank ditolak", sysc, "GET", f"/api/cash-bank/accounts?companyId={CO}", {403})
else:
    assert_true(R, "punya membership bisnis (dilewati cek tanpa-membership)", True, ",".join(m["role_code"] for m in me["memberships"]))

# ---- deactivate BOM paling akhir (Accounting)
if BOM_ID:
    check("ACCOUNTING", "BOM deactivate", acc, "DELETE", f"/api/client-transactions/boms/{BOM_ID}", {200})
    boms = acc.get(f"/api/client-transactions/boms?companyId={CO}").json()
    assert_true("ACCOUNTING", "BOM status INACTIVE", next((b["status"] for b in boms if b["id"] == BOM_ID), "") == "INACTIVE")

# ---------------------------------------------------------------- report
width = max(len(l) for _, l, _, _ in results)
by_role: dict[str, list[bool]] = {}
for role, label, ok, detail in results:
    by_role.setdefault(role, []).append(ok)
    print(f"[{'OK ' if ok else 'ERR'}] {role:14s} {label:{width}s} {detail}")
print("\nRingkasan per role:")
for role, oks in by_role.items():
    print(f"  {role:14s} {sum(oks)}/{len(oks)} lulus")
failed = [r for r in results if not r[2]]
print(f"\nTOTAL {len(results) - len(failed)}/{len(results)} lulus, gagal: {len(failed)}")
sys.exit(1 if failed else 0)
