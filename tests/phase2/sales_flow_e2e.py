#!/usr/bin/env python3
"""
Phase 2 E2E — POS -> Cash Drawer -> Rekonsiliasi -> Verifikasi -> Settlement -> Kas & Bank -> Accounting Source.
HANYA untuk DB LOKAL (fixture item/mapping disisipkan langsung via socket MariaDB lokal; ALLOW_SEED=1 wajib).
Env: QA_PASSWORD (password user qa.*). Opsional BASE, MARIADB_SOCKET.
Exit code 1 bila ada cek gagal.
"""
import base64, json, os, random, subprocess, sys
from datetime import date, timedelta
import httpx

BASE = os.environ.get("BASE", "http://localhost:8001")
PW = os.environ["QA_PASSWORD"]
SOCK = os.environ.get("MARIADB_SOCKET", "/root/mariadb-run/mysqld.sock")
CO = "a57df7de-646b-48f3-93da-2c415fe46859"; WS = "fca7bf4e-21e7-43c3-b4a9-4ce6fe032231"
MN = "23ab678a-990d-4243-987b-4538ad173b78"; QA2 = "2df1428a-c168-11f1-945f-1adb9e44ada0"
assert os.environ.get("ALLOW_SEED") == "1", "set ALLOW_SEED=1 (DB lokal saja)"
results = []

def check(scn, label, ok, detail=""):
    results.append((scn, label, bool(ok), str(detail)[:160]))
    print(f"[{'OK ' if ok else 'ERR'}] {scn:5s} {label} {str(detail)[:160]}")

def sql(q):
    out = subprocess.run(["mariadb", "-S", SOCK, "-uroot", "fnb_local", "-N", "-e", q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return [l.split("\t") for l in out.stdout.strip().splitlines() if l]

def login(email):
    c = httpx.Client(base_url=BASE, timeout=120)
    r = c.post("/api/auth/login", json={"email": email, "password": PW}); assert r.status_code == 200, (email, r.text)
    return c

def j(r):
    try: return r.json()
    except Exception: return r.text

# ------------------------------------------------------------------ fixtures (lokal)
acc_id = lambda code: sql(f"SELECT id FROM chart_of_accounts WHERE company_id='{CO}' AND code='{code}'")[0][0]
fa_id = lambda code: sql(f"SELECT id FROM financial_accounts WHERE company_id='{CO}' AND code='{code}'")[0][0]
CAT = sql(f"SELECT id FROM item_categories WHERE workspace_id='{WS}' AND name='Makanan / Food'")[0][0]
UNIT = sql(f"SELECT id FROM units WHERE workspace_id='{WS}' LIMIT 1")[0][0]
SALES_ACC = acc_id("4101-00-002")
sql(f"INSERT INTO item_category_account_mappings(company_id,category_id,sales_account_id) VALUES('{CO}','{CAT}','{SALES_ACC}') "
    f"ON DUPLICATE KEY UPDATE sales_account_id=COALESCE(sales_account_id,'{SALES_ACC}')")
sql(f"INSERT IGNORE INTO items(workspace_id,code,name,category_id,base_unit_id,track_stock,can_sell,status) VALUES('{WS}','TEST-P2-MENU','TEST Nasi Phase2','{CAT}','{UNIT}',0,1,'ACTIVE')")
KAS, BCA = fa_id("TEST-KAS"), fa_id("TEST-BCA")
CLR_QRIS, CLR_OJOL, FEE = acc_id("1103-00-099"), acc_id("1104-00-099"), acc_id("8001-00-001")
PDF = base64.b64encode(b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").decode()
JPG = base64.b64encode(bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")).decode()
WEBP = base64.b64encode(b"RIFF\x1a\x00\x00\x00WEBPVP8 \x0e\x00\x00\x00" + b"\x00" * 14).decode()
GIF = base64.b64encode(b"GIF89a\x01\x00\x01\x00\x00\x00\x00;").decode()
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/root/gh-work/uploads")
PNG = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()

acc, fin, fst, own, out = (login(e) for e in ["qa.accounting@akuntakita.test", "qa.finance@akuntakita.test", "qa.financestaff@akuntakita.test", "qa.owner@akuntakita.test", "qa.outlet@akuntakita.test"])

# ------------------------------------------------------------------ payment methods
def method(client, name, code, dest, locs, fa=None, evidence="OPTIONAL", clearing=None, fee=None):
    rows = acc.get(f"/api/sales-flow/payment-methods?companyId={CO}").json()["rows"]
    hit = next((m for m in rows if m["name"] == name), None)
    body = {"companyId": CO, "name": name, "posPaymentCode": code, "destinationBehavior": dest, "financialAccountId": fa, "evidencePolicy": evidence, "locationIds": locs}
    if clearing is not None: body.update(clearingAccountId=clearing, feeAccountId=fee)
    r = client.put(f"/api/sales-flow/payment-methods/{hit['id']}", json=body) if hit else client.post("/api/sales-flow/payment-methods", json=body)
    check("PM", f"metode {name}", r.status_code in (200, 201), r.status_code)
    return j(r).get("id")

# ------------------------------------------------------------------ akun selisih terpisah (Accounting)
CDV, STV, CBV = acc_id("6900-00-004"), acc_id("6900-00-005"), acc_id("6900-00-002")  # default migrasi 007
tpl = {r[0]: r[1] for r in sql("SELECT m.role_code,m.account_code FROM coa_template_important_accounts m JOIN coa_templates t ON t.id=m.template_id WHERE t.code='AK_FNB_STANDARD_V1' AND m.role_code IN ('CASH_DRAWER_VARIANCE','SETTLEMENT_VARIANCE')")}
check("VAR", "Template COA: default Selisih Kas 6900-00-004 & Selisih Settlement 6900-00-005", tpl == {"CASH_DRAWER_VARIANCE": "6900-00-004", "SETTLEMENT_VARIANCE": "6900-00-005"}, tpl)
r = fin.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "CASH_DRAWER_VARIANCE", "accountId": CDV})
check("VAR", "Finance tidak bisa set akun selisih", r.status_code == 403, j(r))
for role, a in (("CASH_DRAWER_VARIANCE", CDV), ("SETTLEMENT_VARIANCE", STV)):
    r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": role, "accountId": a})
    check("VAR", f"Accounting set akun {role}", r.status_code == 200, j(r))
va = {x["role_code"]: x["account_id"] for x in acc.get(f"/api/sales-flow/variance-accounts?companyId={CO}").json()}
vrows = acc.get(f"/api/sales-flow/variance-accounts?companyId={CO}").json()
check("VAR", "Master akun selisih: nama akun Selisih Kas (Cash Drawer) & Selisih Settlement", {x["role_code"]: x["account_name"] for x in vrows} == {"CASH_DRAWER_VARIANCE": "Selisih Kas (Cash Drawer)", "SETTLEMENT_VARIANCE": "Selisih Settlement"}, vrows)
check("VAR", "Selisih Kas & Selisih Settlement akun terpisah (bukan CASH_BANK_VARIANCE)", va["CASH_DRAWER_VARIANCE"] == CDV and va["SETTLEMENT_VARIANCE"] == STV and CBV not in va.values(), va)
# Mapping akun selisih dapat diubah Accounting dari master, Finance/Owner/Outlet tidak
ALT_CDV, ALT_STV = acc_id("6900-00-002"), acc_id("6900-00-003")
vmap = lambda: {x["role_code"]: x["account_id"] for x in acc.get(f"/api/sales-flow/variance-accounts?companyId={CO}").json()}
for role, alt, orig in (("CASH_DRAWER_VARIANCE", ALT_CDV, CDV), ("SETTLEMENT_VARIANCE", ALT_STV, STV)):
    r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": role, "accountId": alt})
    check("VAR", f"Accounting ubah akun {role} -> akun lain", r.status_code == 200 and vmap()[role] == alt, j(r))
    r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": role, "accountId": orig})
    check("VAR", f"Accounting kembalikan akun {role} ke default", r.status_code == 200 and vmap()[role] == orig, j(r))
    for who, c in (("Finance", fin), ("Owner", own), ("Outlet", out)):
        r = c.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": role, "accountId": alt})
        check("VAR", f"{who} ubah akun {role} -> 403", r.status_code == 403, j(r))
    r = fin.put(f"/api/master/coa-standard/company/{CO}/important/{role}", json={"accountId": alt})
    check("VAR", f"Finance ubah {role} via COA standar -> 403", r.status_code == 403, j(r))
for who, c in (("Finance", fin), ("Owner", own), ("Outlet", out)):
    r = c.get(f"/api/sales-flow/variance-accounts?companyId={CO}")
    check("VAR", f"{who} tidak membaca konfigurasi akun selisih (COA) -> 403", r.status_code == 403, r.status_code)
check("VAR", "Mapping akun selisih tidak berubah oleh percobaan non-Accounting", vmap() == {"CASH_DRAWER_VARIANCE": CDV, "SETTLEMENT_VARIANCE": STV}, vmap())
r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "SETTLEMENT_VARIANCE", "accountId": CDV})
check("VAR", "Selisih Settlement tidak boleh sama dengan Selisih Kas", r.status_code == 400 and j(r).get("error") == "VARIANCE_ACCOUNTS_MUST_DIFFER", j(r))
r = acc.put(f"/api/master/coa-standard/company/{CO}/important/CASH_DRAWER_VARIANCE", json={"accountId": STV})
check("VAR", "Jalur COA standar juga menolak akun selisih yang sama", r.status_code == 400 and j(r).get("error") == "VARIANCE_ACCOUNTS_MUST_DIFFER", j(r))
r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "CASH_DRAWER_VARIANCE", "accountId": acc_id("1103-00-099")})
check("VAR", "Akun selisih harus akun laba/rugi (aset ditolak)", r.status_code == 400 and j(r).get("error") == "VARIANCE_ACCOUNT_MUST_BE_PROFIT_LOSS", j(r))
check("VAR", "Mapping akhir tetap default terpisah", vmap() == {"CASH_DRAWER_VARIANCE": CDV, "SETTLEMENT_VARIANCE": STV}, vmap())

PM = {
    "CASH_MN": method(acc, "TEST Cash MN", "CASH", "CASH_DIRECT", [MN], KAS),
    "QRIS": method(acc, "TEST QRIS BCA", "QRIS", "SETTLEMENT", [MN], BCA, "REQUIRED", CLR_QRIS, FEE),
    "TRF": method(acc, "TEST Transfer BCA", "TRANSFER", "BANK_DIRECT", [MN], BCA),
    "GOFOOD": method(acc, "TEST GoFood", "GOFOOD", "SETTLEMENT", [MN], BCA, "OPTIONAL", CLR_OJOL, FEE),
    "CASH_Q2": method(acc, "TEST Cash QA2", "CASH", "CASH_DIRECT", [QA2], KAS),
    "SHOPEE": method(acc, "TEST ShopeeFood", "SHOPEEFOOD", "SETTLEMENT", [QA2], BCA, "OPTIONAL", CLR_OJOL, FEE),
    "DEBIT": method(acc, "TEST Debit BCA", "CARD", "SETTLEMENT", [QA2], BCA, "OPTIONAL", CLR_QRIS, FEE),
}
r = fin.post("/api/sales-flow/payment-methods", json={"companyId": CO, "name": "TEST X", "posPaymentCode": "GRABFOOD", "destinationBehavior": "SETTLEMENT", "locationIds": [MN], "clearingAccountId": CLR_OJOL})
check("S9", "Finance tidak bisa membuat/mengubah master metode pembayaran", r.status_code == 403 and j(r).get("error") == "PAYMENT_METHOD_ACCOUNTING_ONLY", j(r))
r = fin.put(f"/api/sales-flow/payment-methods/{PM['CASH_MN']}", json={"companyId": CO, "name": "TEST Cash MN", "posPaymentCode": "CASH", "destinationBehavior": "CASH_DIRECT", "financialAccountId": KAS, "locationIds": [MN], "evidencePolicy": "REQUIRED"})
check("S9", "Finance tidak bisa ubah requirement bukti / outlet", r.status_code == 403, j(r))
r = fin.get(f"/api/sales-flow/payment-methods?companyId={CO}")
check("S9", "Finance tidak melihat akun clearing/MDR", r.status_code == 200 and all("clearing_account_id" not in m for m in r.json()["rows"]), r.status_code)
r = acc.post("/api/sales-flow/payment-methods", json={"companyId": CO, "name": "TEST Dup QRIS", "posPaymentCode": "QRIS", "destinationBehavior": "SETTLEMENT", "locationIds": [MN]})
check("PM", "1 kode POS = 1 metode per outlet", r.status_code == 409, j(r))
# MDR/Admin Fee = akun beban sendiri (bukan akun selisih); clearing = aset
qbody = lambda clearing, fee: {"companyId": CO, "name": "TEST QRIS BCA", "posPaymentCode": "QRIS", "destinationBehavior": "SETTLEMENT", "financialAccountId": BCA, "evidencePolicy": "REQUIRED", "locationIds": [MN], "clearingAccountId": clearing, "feeAccountId": fee}
for label, fee, err in (("Selisih Kas", CDV, "FEE_ACCOUNT_CANNOT_BE_VARIANCE"), ("Selisih Settlement", STV, "FEE_ACCOUNT_CANNOT_BE_VARIANCE"), ("akun aset", CLR_QRIS, "FEE_ACCOUNT_MUST_BE_EXPENSE")):
    r = acc.put(f"/api/sales-flow/payment-methods/{PM['QRIS']}", json=qbody(CLR_QRIS, fee))
    check("MDR", f"Akun MDR = {label} ditolak", r.status_code == 400 and j(r).get("error") == err, j(r))
r = acc.put(f"/api/sales-flow/payment-methods/{PM['QRIS']}", json=qbody(FEE, FEE))
check("MDR", "Akun clearing harus aset (akun beban ditolak)", r.status_code == 400 and j(r).get("error") == "CLEARING_ACCOUNT_MUST_BE_ASSET", j(r))
r = acc.put("/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "SETTLEMENT_VARIANCE", "accountId": FEE})
check("MDR", "Akun selisih tidak boleh akun MDR yang dipakai metode", r.status_code == 400 and j(r).get("error") == "VARIANCE_ACCOUNT_IS_MDR_ACCOUNT", j(r))
r = fin.put(f"/api/sales-flow/payment-methods/{PM['QRIS']}", json=qbody(CLR_QRIS, FEE))
check("MDR", "Finance tidak bisa memilih/mengubah akun MDR", r.status_code == 403, j(r))
pmq = next(m for m in acc.get(f"/api/sales-flow/payment-methods?companyId={CO}").json()["rows"] if m["id"] == PM["QRIS"])
check("MDR", "Mapping QRIS tetap: clearing aset + MDR akun beban (tidak berubah oleh percobaan gagal)", pmq["clearing_account_id"] == CLR_QRIS and pmq["fee_account_id"] == FEE and pmq["mapping_ready"], (pmq["clearing_account_code"], pmq["fee_account_code"]))
codes = {c["code"]: c for c in fin.get(f"/api/sales-flow/pos-codes?companyId={CO}").json()}
check("REG", "Registry kode POS memuat ShopeeFood & Debit/EDC (Kartu)", "SHOPEEFOOD" in codes and "CARD" in codes and "DEBIT" in codes["CARD"]["aliases"] and "EDC" in codes["CARD"]["aliases"], list(codes))
check("REG", "Compliment di registry: tidak ikut rekonsiliasi", codes["COMPLIMENT"]["include_in_reconciliation"] is False)
r = fin.post("/api/sales-flow/pos-codes", json={"companyId": CO, "code": "TESTPAY", "label": "Test Pay", "methodType": "EWALLET"})
check("REG", "Finance tidak bisa menambah kode POS", r.status_code == 403, j(r))
if "TESTPAY" not in codes:
    r = acc.post("/api/sales-flow/pos-codes", json={"companyId": CO, "code": "TESTPAY", "label": "Test Pay (e-wallet)", "methodType": "EWALLET", "aliases": "TESTWALLET"})
    check("REG", "Accounting menambah kode POS baru tanpa ubah kode program", r.status_code == 201, j(r))
PM["TESTPAY"] = method(acc, "TEST Wallet QA2", "TESTPAY", "SETTLEMENT", [QA2], BCA, "OPTIONAL", CLR_QRIS, FEE)
ctx = fin.get(f"/api/client-transactions/sales-context?companyId={CO}&locationId={MN}").json()
n_mn = int(sql(f"SELECT COUNT(*) FROM payment_method_locations pml JOIN payment_methods pm ON pm.id=pml.payment_method_id AND pm.status='ACTIVE' WHERE pml.location_id='{MN}'")[0][0])
check("PMS", "Status setup pembayaran Penjualan memakai Payment Method Phase 2 (aktif & siap per outlet)", ctx.get("paymentSetup") == {"activeMethods": n_mn, "readyMethods": n_mn} and n_mn >= 4, ctx.get("paymentSetup"))
ctx2 = fin.get(f"/api/client-transactions/sales-context?companyId={CO}&locationId={QA2}").json()
check("PMS", "Status setup outlet 2 berbeda (konfigurasi outlet sendiri)", ctx2.get("paymentSetup", {}).get("activeMethods") == len([m for m in ctx2.get("paymentMethods", [])]) and {m["name"] for m in ctx2["paymentMethods"]} >= {"TEST ShopeeFood", "TEST Debit BCA"}, ctx2.get("paymentSetup"))

# ------------------------------------------------------------------ POS import (multi tanggal -> dipecah per tanggal)
used = {r[0] for r in sql(f"SELECT DISTINCT business_date FROM sales_reconciliations WHERE location_id IN ('{MN}','{QA2}') UNION SELECT DISTINCT business_date FROM cash_drawers WHERE location_id IN ('{MN}','{QA2}')")}
while True:  # 7 hari berturut-turut yang belum dipakai run sebelumnya
    start = date(2025, 1, 1) + timedelta(days=random.randint(0, 330))
    if not any((start + timedelta(days=i)).isoformat() in used for i in range(7)): break
D = [(start + timedelta(days=i)).isoformat() for i in range(7)]
TAG = f"P2{random.randint(10000, 99999)}"
def row(d, inv, **pay):
    total = sum(pay.values())
    base = {"saleDate": d, "invoiceNumber": f"{TAG}-{inv}", "itemCode": "TEST-P2-MENU", "itemName": "TEST Nasi Phase2", "quantity": 1, "unitPrice": total, "discountAmount": 0, "lineTotal": total}
    return {**base, **{k: v for k, v in pay.items()}}
mn_rows = [row(D[0], "A1", cash=50000), row(D[0], "A2", qris=30000), row(D[0], "A3", transfer=20000), row(D[0], "A4", compliment=10000),
           row(D[1], "B1", cash=100000), row(D[2], "C1", qris=100000), row(D[3], "D1", qris=200000), row(D[4], "E1", gofood=150000),
           row(D[5], "F1", gofood=50000), row(D[6], "G1", grabfood=25000)]
r = out.post("/api/client-transactions/sales-batches", json={"companyId": CO, "locationId": MN, "sourceType": "CSV", "sourceName": "outlet.csv", "rows": mn_rows})
check("A", "Outlet tidak boleh upload POS", r.status_code == 403, j(r))
r = fin.post("/api/client-transactions/sales-batches", json={"companyId": CO, "locationId": MN, "sourceType": "CSV", "sourceName": "p2.csv", "rows": mn_rows})
check("A", "Finance import POS multi tanggal -> 1 batch per tanggal", r.status_code == 201 and len(j(r).get("batches", [])) == 7, j(r))
batches = j(r).get("batches", [])
r = fin.post("/api/client-transactions/sales-batches", json={"companyId": CO, "locationId": MN, "sourceType": "CSV", "sourceName": "dup.csv", "rows": mn_rows[:2]})
check("S11", "Duplicate POS import ditolak", r.status_code == 409 and j(r).get("error") == "DUPLICATE_POS_IMPORT", j(r))
r = fin.post(f"/api/client-transactions/sales-batches/{batches[0]['id']}/verify", json={})
check("S12", "Verifikasi batch langsung diblok (wajib rekonsiliasi)", r.status_code == 409 and j(r).get("error") == "SALES_VERIFY_VIA_RECONCILIATION", j(r))
q2_rows = [row(D[0], "Q1", cash=25000), row(D[0], "Q2", shopeefood=40000), row(D[0], "Q3", card=60000),
           {**row(D[0], "Q4", cash=0), "unitPrice": 15000, "lineTotal": 15000, "payments": {"TESTPAY": 15000}}]
r = fin.post("/api/client-transactions/sales-batches", json={"companyId": CO, "locationId": QA2, "sourceType": "CSV", "sourceName": "qa2.csv", "rows": q2_rows})
check("S7", "Import POS outlet 2 (ShopeeFood + Kartu)", r.status_code == 201, j(r))

def detail(c, loc, d):
    return c.get(f"/api/sales-flow/reconciliations/detail?companyId={CO}&locationId={loc}&date={d}")
def line_of(det, pm): return next((l for l in det["lines"] if l["payment_method_id"] == pm), {})
def drawer(c, loc, d, lines, shift=""):
    return c.post("/api/sales-flow/cash-drawers", json={"companyId": CO, "locationId": loc, "businessDate": d, "shiftLabel": shift, "lines": [{"paymentMethodId": k, "actualAmount": v} for k, v in lines.items()]})
def evidence(c, line_id): return c.post("/api/sales-flow/evidence", json={"entityType": "CASH_DRAWER_LINE", "entityId": line_id, "fileName": "bukti.png", "mimeType": "image/png", "dataBase64": PNG})
def verify(c, loc, d): return c.post("/api/sales-flow/reconciliations/verify", json={"companyId": CO, "locationId": loc, "date": d})
def ledger(): return {r["transaction_id"]: r for r in acc.get(f"/api/cash-bank/ledger?companyId={CO}").json()["rows"]}

# ------------------------------------------------------------------ S8 outlet isolation + context
r = out.get(f"/api/sales-flow/cash-drawers/context?companyId={CO}&locationId={MN}")
check("S8", "Outlet: metode pembayaran outlet sendiri otomatis", r.status_code == 200 and {m["name"] for m in r.json()["methods"]} >= {"TEST Cash MN", "TEST QRIS BCA"}, [m["name"] for m in j(r).get("methods", [])])
check("S8", "Outlet A & B punya metode berbeda", "TEST ShopeeFood" not in {m["name"] for m in r.json()["methods"]})
r = out.get(f"/api/sales-flow/cash-drawers/context?companyId={CO}&locationId={QA2}")
check("S8", "Outlet akses outlet lain (context) ditolak", r.status_code == 403, j(r))
r = drawer(out, QA2, D[0], {PM["CASH_Q2"]: 1})
check("S8", "Outlet tulis Cash Drawer outlet lain ditolak", r.status_code == 403, j(r))
r = out.get(f"/api/sales-flow/reconciliations?companyId={CO}")
check("S8", "Outlet tidak bisa membuka rekonsiliasi Finance", r.status_code == 403, j(r))
r = fin.post("/api/sales-flow/cash-drawers", json={"companyId": CO, "locationId": MN, "businessDate": D[0], "lines": []})
check("B", "Finance hanya review Cash Drawer (tidak input)", r.status_code == 403, j(r))

# ------------------------------------------------------------------ S1 cash cocok + QRIS cocok + multi metode (D0)
det = detail(fin, MN, D[0]).json()
check("S1", "Sebelum Cash Drawer: Menunggu Cash Drawer", det["status"] == "MENUNGGU_CASH_DRAWER", det["status"])
r = drawer(out, MN, D[0], {PM["CASH_MN"]: 30000, PM["QRIS"]: 30000}, "PAGI")
r2 = drawer(out, MN, D[0], {PM["CASH_MN"]: 20000, PM["TRF"]: 20000}, "MALAM")
check("S1", "Outlet isi Cash Drawer 2 shift", r.status_code == 201 and r2.status_code == 201, (j(r), j(r2)))
det = detail(fin, MN, D[0]).json()
check("S1", "Shift dijumlah: Cash POS 50rb vs aktual 50rb", float(line_of(det, PM["CASH_MN"]).get("difference", 1)) == 0 and float(line_of(det, PM["CASH_MN"])["actual_amount"]) == 50000)
check("S1", "Compliment dikeluarkan dari rekonsiliasi", float(det["totals"]["compliment"]) == 10000 and all(l["pos_payment_code"] != "COMPLIMENT" for l in det["lines"]))
check("S1", "Bukti QRIS wajib belum ada -> blokir", line_of(det, PM["QRIS"]).get("evidence_missing") and not det["can_verify"], det["blockers"][:2])
r = verify(fin, MN, D[0]); check("S1", "Verifikasi ditolak saat bukti wajib kurang", r.status_code == 409, j(r))
qris_line = next(l for l in drawer(out, MN, D[0], {PM["CASH_MN"]: 30000, PM["QRIS"]: 30000}, "PAGI").json()["lines"] if l["payment_method_id"] == PM["QRIS"])
r = evidence(out, qris_line["id"]); check("S1", "Upload bukti foto per metode (QRIS)", r.status_code == 201, j(r))
r = out.post("/api/sales-flow/evidence", json={"entityType": "CASH_DRAWER_LINE", "entityId": qris_line["id"], "fileName": "x.pdf", "mimeType": "application/pdf", "dataBase64": PNG})
check("S1", "Bukti Cash Drawer hanya JPG/PNG/WEBP", r.status_code == 400, j(r))

# ------------------------------------------------------------------ EV: validasi bukti pembayaran (server-side)
def up(c, line_id, name, mime, data): return c.post("/api/sales-flow/evidence", json={"entityType": "CASH_DRAWER_LINE", "entityId": line_id, "fileName": name, "mimeType": mime, "dataBase64": data})
cash_line = next(l for l in drawer(out, MN, D[0], {PM["CASH_MN"]: 30000, PM["QRIS"]: 30000}, "PAGI").json()["lines"] if l["payment_method_id"] == PM["CASH_MN"])
det = detail(fin, MN, D[0]).json()
check("EV", "Konfigurasi per metode: QRIS REQUIRED, Transfer OPTIONAL", line_of(det, PM["QRIS"])["evidence_policy"] == "REQUIRED" and line_of(det, PM["TRF"])["evidence_policy"] == "OPTIONAL")
check("EV", "Metode OPTIONAL tanpa bukti tidak memblokir", not line_of(det, PM["TRF"])["evidence_missing"] and not line_of(det, PM["CASH_MN"])["evidence_missing"])
r = up(out, qris_line["id"], "bukti.jpg", "image/jpeg", JPG); check("EV", "File valid JPG diterima", r.status_code == 201 and j(r).get("mime_type") == "image/jpeg", j(r))
r = up(out, qris_line["id"], "bukti.jpeg", "image/jpeg", JPG); check("EV", "File valid JPEG diterima", r.status_code == 201, j(r))
r = up(out, qris_line["id"], "bukti.webp", "image/webp", WEBP); check("EV", "File valid WEBP diterima", r.status_code == 201 and j(r).get("mime_type") == "image/webp", j(r))
big_ok = base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"\x00" * (7 * 1024 * 1024 - 8)).decode()
r = up(out, cash_line["id"], "besar.png", "image/png", big_ok); check("EV", "File tepat 7 MB diterima", r.status_code == 201, (r.status_code, j(r)))
big_bad = base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"\x00" * (7 * 1024 * 1024 - 7)).decode()
r = up(out, cash_line["id"], "besar.png", "image/png", big_bad); check("EV", "File > 7 MB (7MB+1 byte) ditolak server", r.status_code in (400, 413) and j(r).get("error") == "EVIDENCE_MAX_7MB", (r.status_code, j(r)))
huge = base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"\x00" * (9 * 1024 * 1024)).decode()
r = up(out, cash_line["id"], "besar.png", "image/png", huge); check("EV", "File 9 MB ditolak server (bukan crash)", r.status_code in (400, 413) and j(r).get("error") == "EVIDENCE_MAX_7MB", (r.status_code, j(r)))
r = up(out, cash_line["id"], "anim.gif", "image/gif", GIF); check("EV", "GIF ditolak", r.status_code == 400 and j(r).get("error") == "EVIDENCE_IMAGE_ONLY", j(r))
r = up(out, cash_line["id"], "palsu.png", "image/png", GIF); check("EV", "GIF disamarkan MIME image/png ditolak (cek isi file)", r.status_code == 400, j(r))
r = up(out, cash_line["id"], "skrip.jpg", "image/jpeg", base64.b64encode(b"<script>alert(1)</script>").decode()); check("EV", "Teks/skrip berekstensi .jpg ditolak", r.status_code == 400, j(r))
r = up(out, cash_line["id"], "foto.jpg", "image/jpeg", PNG); check("EV", "Isi PNG dideklarasikan JPEG ditolak (MIME mismatch)", r.status_code == 400 and j(r).get("error") == "EVIDENCE_TYPE_MISMATCH", j(r))
r = up(out, cash_line["id"], "foto.exe", "image/png", PNG); check("EV", "Ekstensi tidak sesuai isi ditolak", r.status_code == 400 and j(r).get("error") == "EVIDENCE_TYPE_MISMATCH", j(r))
r = up(out, cash_line["id"], "dok.pdf", "application/pdf", PDF); check("EV", "PDF ditolak untuk bukti Cash Drawer (foto saja)", r.status_code == 400, j(r))
r = up(out, cash_line["id"], "", "image/png", ""); check("EV", "File kosong ditolak", r.status_code == 400, j(r))
r = up(fin, cash_line["id"], "bukti.png", "image/png", PNG); check("EV", "Finance tidak bisa upload bukti Cash Drawer", r.status_code == 403, j(r))
r = up(own, cash_line["id"], "bukti.png", "image/png", PNG); check("EV", "Owner tidak bisa upload bukti", r.status_code == 403, j(r))
att = sql(f"SELECT id,storage_path,mime_type,file_size FROM attachments WHERE entity_type='CASH_DRAWER_LINE' AND entity_id='{qris_line['id']}' ORDER BY uploaded_at")
drawer_id = sql(f"SELECT cash_drawer_id FROM cash_drawer_lines WHERE id='{qris_line['id']}'")[0][0]
exp = f"{WS}/{CO}/{MN}/cash-drawer/{D[0]}/pagi/{drawer_id}/qris/{qris_line['id']}/"
check("EV", "Path bukti: workspace/company/outlet/cash-drawer/tanggal/shift/drawer/metode/baris", all(a[1].startswith(exp) for a in att[-3:]), att[-1][1] if att else None)
check("EV", "File tersimpan di storage lokal", os.path.isfile(os.path.join(UPLOAD_DIR, att[-1][1])), UPLOAD_DIR)
r = out.get(f"/api/sales-flow/evidence/{att[-1][0]}"); check("EV", "Outlet membuka bukti outlet sendiri", r.status_code == 200 and r.headers.get("content-type", "").startswith("image/webp"), r.status_code)
r = fin.get(f"/api/sales-flow/evidence/{att[-1][0]}"); check("EV", "Finance dapat melihat bukti (review)", r.status_code == 200, r.status_code)
aud = [x["action"] for x in acc.get(f"/api/sales-flow/cash-drawers/{drawer_id}/history").json()]
check("EV", "Penggantian bukti masuk audit trail (ADD + REPLACE_EVIDENCE)", "ADD_EVIDENCE" in aud and "REPLACE_EVIDENCE" in aud, aud[:6])
det = detail(fin, MN, D[0]).json()
check("S1", "Status Cocok / siap verifikasi", det["status"] == "COCOK" and det["can_verify"], (det["status"], det["blockers"][:2]))
r = verify(own, MN, D[0]); check("S13", "Owner tidak bisa verifikasi", r.status_code == 403, j(r))
r = verify(fst, MN, D[0]); check("S1", "Finance Staff Verifikasi Penjualan", r.status_code == 200, j(r))
det = detail(fin, MN, D[0]).json()
check("S1", "Status Menunggu Settlement (QRIS)", det["status"] == "MENUNGGU_SETTLEMENT", det["status"])
check("S1", "Setelah verified: total penjualan POS & daftar invoice tetap tampil (dari SALES_INVOICE)", float(det["totals"]["pos_sales"]) == 110000 and len(det["invoices"]) == 4, (det["totals"]["pos_sales"], len(det["invoices"])))
lg = ledger()
cash_mv = [x for x in lg.values() if x["transaction_type"] == "SALES_VERIFICATION" and x["transaction_number"] == det["header"]["reconciliation_number"]]
check("S1", "Kas & Bank otomatis: Cash 50rb ke Kas + Transfer 20rb ke Bank (tanpa input ulang)",
      sorted((x["financial_account_id"], float(x["amount_in"])) for x in cash_mv) == sorted([(KAS, 50000.0), (BCA, 20000.0)]), [(x["kind"], x["amount_in"]) for x in cash_mv])
check("S1", "QRIS tidak langsung masuk Bank", not any("QRIS" in x["kind"] for x in cash_mv))

# ------------------------------------------------------------------ S12 setelah verified
r = drawer(out, MN, D[0], {PM["CASH_MN"]: 1}, "PAGI"); check("S12", "Edit Cash Drawer setelah verified ditolak", r.status_code == 409, j(r))
r = verify(fin, MN, D[0]); check("S12", "Verifikasi ulang ditolak", r.status_code == 409, j(r))
r = fin.post("/api/sales-flow/reconciliations/reopen", json={"companyId": CO, "locationId": MN, "date": D[0], "reason": "coba reopen finance"})
check("S12", "Finance tidak bisa reopen (Accounting Control saja)", r.status_code == 403 and j(r).get("error") == "REOPEN_ACCOUNTING_ONLY", j(r))
r = fin.post("/api/client-transactions/sales-batches", json={"companyId": CO, "locationId": MN, "sourceType": "CSV", "rows": [row(D[0], "LATE", cash=1000)]})
check("S12", "Import POS baru ke tanggal terverifikasi ditolak", r.status_code == 409 and j(r).get("error") == "SALES_DATE_ALREADY_VERIFIED", j(r))

# ------------------------------------------------------------------ S2 cash selisih (D1)
drawer(out, MN, D[1], {PM["CASH_MN"]: 98000})
det = detail(fin, MN, D[1]).json()
check("S2", "Cash POS 100rb vs aktual 98rb = selisih -20rb? (-2rb)", det["status"] == "ADA_SELISIH" and float(line_of(det, PM["CASH_MN"])["difference"]) == -2000, det["status"])
r = verify(fin, MN, D[1]); check("S2", "Selisih tidak bisa dilewati tanpa penyelesaian", r.status_code == 409, j(r))
r = fin.post("/api/sales-flow/reconciliations/resolve", json={"companyId": CO, "locationId": MN, "date": D[1], "paymentMethodId": PM["CASH_MN"], "reasonCode": "UANG_KURANG", "notes": "kembalian salah"})
check("S2", "Penyelesaian selisih (alasan bisnis)", r.status_code == 201, j(r))
ra = fin.post("/api/sales-flow/evidence", json={"entityType": "SALES_RECON_RESOLUTION", "entityId": j(r).get("id"), "fileName": "nota.pdf", "mimeType": "application/pdf", "dataBase64": PDF})
check("S2", "Lampiran penyelesaian selisih", ra.status_code == 201, j(ra))
det = detail(fin, MN, D[1]).json()
check("S2", "Status Selisih Diselesaikan & siap verifikasi", det["status"] == "SELISIH_DISELESAIKAN" and det["can_verify"], det["status"])
r = verify(fin, MN, D[1]); check("S2", "Verifikasi dengan selisih terselesaikan", r.status_code == 200 and j(r).get("differenceTransactionId"), j(r))
diff_tx = j(r).get("differenceTransactionId")
det = detail(fin, MN, D[1]).json()
check("S2", "Jejak selisih awal tetap tersimpan", len(det["resolutions"]) >= 1 and float(det["resolutions"][0]["difference"]) == -2000)
mv = [x for x in ledger().values() if x["transaction_number"] == det["header"]["reconciliation_number"]]
check("S2", "Kas bertambah sesuai aktual 98rb", len(mv) == 1 and float(mv[0]["amount_in"]) == 98000, [x["amount_in"] for x in mv])

# ------------------------------------------------------------------ settlement helpers
def outstanding(pm):
    return [x for x in fin.get(f"/api/sales-flow/settlements/outstanding?companyId={CO}&paymentMethodId={pm}").json()]
def settle(c, lines, net, fee, accept=False, ref="REF"):
    return c.post("/api/sales-flow/settlements", json={"companyId": CO, "financialAccountId": BCA, "settlementDate": D[6], "reference": f"{TAG}-{ref}", "netAmount": net, "feeAmount": fee, "acceptDifference": accept, "allocations": lines})
def line_for(pm, d): return next((x for x in outstanding(pm) if x["business_date"][:10] == d), None)

# S3 QRIS settlement penuh (D0 30rb)
l = line_for(PM["QRIS"], D[0])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 30000}], 30000, 0, ref="S3")
check("S3", "QRIS settlement penuh", r.status_code == 201, j(r))
s3 = j(r).get("id")
check("S3", "Status Settled", detail(fin, MN, D[0]).json()["status"] == "SETTLED")
mv = ledger().get(s3)
check("S3", "Kas & Bank: settlement masuk Bank (source QRIS_SETTLEMENT)", mv and float(mv["amount_in"]) == 30000 and mv["counterparty"] == "QRIS_SETTLEMENT", mv and (mv["amount_in"], mv["counterparty"]))
r = fin.post("/api/sales-flow/evidence", json={"entityType": "SALES_SETTLEMENT", "entityId": s3, "fileName": "mutasi.pdf", "mimeType": "application/pdf", "dataBase64": PDF})
check("S3", "Bukti settlement", r.status_code == 201, j(r))

# S4 QRIS + MDR (D2 100rb -> bank 99.300 + MDR 700)
for d in (D[2], D[3]):
    dr = drawer(out, MN, d, {PM["QRIS"]: 100000 if d == D[2] else 200000}).json()
    evidence(out, dr["lines"][0]["id"])
    check("S4", f"Verifikasi QRIS {d}", verify(fin, MN, d).status_code == 200)
l = line_for(PM["QRIS"], D[2])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 100000}], 99300, 700, ref="S4")
check("S4", "QRIS settlement dengan MDR (net 99.300 + MDR 700)", r.status_code == 201 and j(r)["accountingStatus"] == "ACCOUNTING_REVIEW", j(r))
s4 = j(r).get("id")

# S5 partial (D3 200rb): 120rb lalu 80rb
l = line_for(PM["QRIS"], D[3])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 120000}], 119160, 840, ref="S5a")
check("S5", "QRIS partial settlement 120rb", r.status_code == 201, j(r))
l = line_for(PM["QRIS"], D[3])
check("S5", "Sisa outstanding 80rb (PARTIAL)", l and l["settlement_status"] == "PARTIAL" and float(l["remaining"]) == 80000, l and (l["settlement_status"], l["remaining"]))
r = settle(fin, [{"lineId": l["id"], "grossAmount": 90000}], 89000, 1000, ref="S5x")
check("S5", "Settlement melebihi outstanding ditolak", r.status_code == 400, j(r))
r = settle(fin, [{"lineId": l["id"], "grossAmount": 80000}], 79440, 560, ref="S5b")
check("S5", "Pelunasan sisa 80rb -> Settled", r.status_code == 201 and line_for(PM["QRIS"], D[3]) is None, j(r))

# S6 OJOL (D4 GoFood 150rb, komisi 30rb) + selisih settlement (D5 50rb)
for d, amt in ((D[4], 150000), (D[5], 50000)):
    drawer(out, MN, d, {PM["GOFOOD"]: amt}); check("S6", f"Verifikasi GoFood {d}", verify(fin, MN, d).status_code == 200)
l = line_for(PM["GOFOOD"], D[4])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 150000}], 120000, 30000, ref="S6")
check("S6", "OJOL settlement (source OJOL_SETTLEMENT)", r.status_code == 201 and ledger()[j(r)["id"]]["counterparty"] == "OJOL_SETTLEMENT", j(r))
l = line_for(PM["GOFOOD"], D[5])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 50000}], 40000, 9000, ref="S6d")
check("S6", "Selisih settlement wajib konfirmasi", r.status_code == 409, j(r))
r = settle(fin, [{"lineId": l["id"], "grossAmount": 50000}], 40000, 9000, accept=True, ref="S6d")
check("S6", "Selisih settlement dicatat (1rb)", r.status_code == 201 and float(j(r)["difference"]) == 1000, j(r))
s6d = j(r).get("id")

# ------------------------------------------------------------------ S7 outlet 2 (metode berbeda) — drawer oleh Accounting
det2 = detail(fin, QA2, D[0]).json()
check("REG", "Kode POS baru (registry) terbaca di rekonsiliasi: POS 15rb", float(line_of(det2, PM["TESTPAY"]).get("pos_amount", 0)) == 15000, line_of(det2, PM["TESTPAY"]))
r = drawer(acc, QA2, D[0], {PM["CASH_Q2"]: 25000, PM["SHOPEE"]: 40000, PM["DEBIT"]: 60000, PM["TESTPAY"]: 15000})
check("S7", "Accounting dapat mengisi Cash Drawer (full business access)", r.status_code == 201, j(r))
q2_line = next(l for l in j(r)["lines"] if l["payment_method_id"] == PM["CASH_Q2"])
r = acc.post("/api/sales-flow/evidence", json={"entityType": "CASH_DRAWER_LINE", "entityId": q2_line["id"], "fileName": "q2.png", "mimeType": "image/png", "dataBase64": PNG})
check("EV", "Accounting upload bukti outlet 2", r.status_code == 201, j(r))
q2_att = j(r).get("id")
r = out.post("/api/sales-flow/evidence", json={"entityType": "CASH_DRAWER_LINE", "entityId": q2_line["id"], "fileName": "x.png", "mimeType": "image/png", "dataBase64": PNG})
check("EV", "Outlet upload bukti ke outlet lain ditolak", r.status_code == 403, j(r))
r = out.get(f"/api/sales-flow/evidence/{q2_att}"); check("EV", "Outlet membuka bukti outlet lain ditolak", r.status_code == 403, r.status_code)
r = out.get(f"/api/sales-flow/cash-drawers?companyId={CO}&locationId={QA2}"); check("S8", "Outlet lihat daftar Cash Drawer outlet lain ditolak", r.status_code == 403, j(r))
check("S7", "Verifikasi outlet 2", verify(fin, QA2, D[0]).status_code == 200)
o = fin.get(f"/api/sales-flow/settlements/outstanding?companyId={CO}&locationId={QA2}").json()
check("S7", "Outstanding ShopeeFood + Debit BCA outlet 2 terpisah", {x["method_name"] for x in o} >= {"TEST ShopeeFood", "TEST Debit BCA"} and all(x["location_id"] == QA2 for x in o), [x["method_name"] for x in o])
o = [x for x in o if x["business_date"][:10] == D[0]]
mix = [next(x for x in o if x["payment_method_id"] == PM["SHOPEE"]), next(x for x in o if x["payment_method_id"] == PM["DEBIT"])]
r = settle(fin, [{"lineId": x["id"], "grossAmount": float(x["remaining"])} for x in mix], 1, 0)
check("S7", "Settlement campur metode ditolak", r.status_code == 400 and j(r).get("error") == "SETTLEMENT_SINGLE_METHOD_REQUIRED", j(r))

# ------------------------------------------------------------------ S12b reopen terkontrol (Accounting) + batal settlement
recon_no_1 = detail(fin, MN, D[0]).json()["header"]["reconciliation_number"]
r = acc.post("/api/sales-flow/reconciliations/reopen", json={"companyId": CO, "locationId": MN, "date": D[0], "reason": "koreksi nominal cash"})
check("S12", "Reopen diblokir bila settlement sudah diproses", r.status_code == 409 and j(r).get("error") == "REOPEN_BLOCKED_ACTIVE_SETTLEMENT", j(r))
r = fin.post(f"/api/sales-flow/settlements/{s3}/cancel", json={"companyId": CO, "reason": "salah tanggal settlement"})
check("S12", "Finance tidak bisa batal settlement", r.status_code == 403, j(r))
r = acc.post(f"/api/sales-flow/settlements/{s3}/cancel", json={"companyId": CO, "reason": ""})
check("S12", "Batal settlement wajib alasan", r.status_code == 400, j(r))
r = acc.post(f"/api/sales-flow/settlements/{s3}/cancel", json={"companyId": CO, "reason": "salah tanggal settlement"})
check("S12", "Accounting batal settlement terkontrol", r.status_code == 200, j(r))
check("S12", "Settlement batal hilang dari Kas & Bank, outstanding QRIS pulih", s3 not in ledger() and line_for(PM["QRIS"], D[0]) is not None)
check("S12", "Histori settlement tetap (status CANCELLED)", any(x["id"] == s3 and x["workflow_status"] == "CANCELLED" for x in fin.get(f"/api/sales-flow/settlements?companyId={CO}").json()))
r = acc.post("/api/sales-flow/reconciliations/reopen", json={"companyId": CO, "locationId": MN, "date": D[0], "reason": ""})
check("S12", "Reopen wajib alasan", r.status_code == 400, j(r))
r = acc.post("/api/sales-flow/reconciliations/reopen", json={"companyId": CO, "locationId": MN, "date": D[0], "reason": "koreksi nominal cash"})
check("S12", "Accounting reopen verifikasi", r.status_code == 200 and j(r).get("status") == "REOPENED", j(r))
det = detail(fin, MN, D[0]).json()
check("S12", "Setelah reopen: belum verified, wajib verifikasi ulang", det["header"]["status"] == "REOPENED" and det["status"] in ("COCOK", "SELISIH_DISELESAIKAN"), (det["header"]["status"], det["status"]))
check("S12", "Kas & Bank verifikasi lama dikeluarkan (tidak dihapus)", not [x for x in ledger().values() if x["transaction_number"] == recon_no_1])
voided = sql(f"SELECT COUNT(*) FROM transaction_headers WHERE transaction_type='SALES_INVOICE' AND workflow_status='VOID' AND reference_number LIKE '{TAG}-A%'")[0][0]
check("S12", "SALES_INVOICE lama di-VOID (histori tetap)", int(voided) == 4, voided)
r = drawer(out, MN, D[0], {PM["CASH_MN"]: 30000, PM["QRIS"]: 30000}, "PAGI"); check("S12", "Outlet dapat koreksi Cash Drawer setelah reopen", r.status_code == 200, j(r))
r = verify(fin, MN, D[0]); check("S12", "Finance verifikasi ulang", r.status_code == 200 and j(r).get("reconciliationNumber", "").endswith("-R2"), j(r))
mv = [x for x in ledger().values() if x["transaction_type"] == "SALES_VERIFICATION" and x["transaction_number"].startswith(recon_no_1)]
check("S12", "Kas & Bank terbentuk ulang sekali (Cash 50rb + Transfer 20rb)", sorted(float(x["amount_in"]) for x in mv) == [20000.0, 50000.0], [(x["transaction_number"], x["amount_in"]) for x in mv])
hist = [x["action"] for x in acc.get(f"/api/sales-flow/reconciliations/history?companyId={CO}&locationId={MN}&date={D[0]}").json()]
check("S12", "Audit trail: verifikasi, reopen, verifikasi ulang", hist.count("FINANCE_VERIFY_SALES") == 2 and "REOPEN_SALES_VERIFICATION" in hist, hist)
l = line_for(PM["QRIS"], D[0])
r = settle(fin, [{"lineId": l["id"], "grossAmount": 30000}], 30000, 0, ref="S3R")
check("S3", "QRIS settlement ulang setelah koreksi", r.status_code == 201, j(r))

# ------------------------------------------------------------------ POS code belum dikonfigurasi (D6 GrabFood)
drawer(out, MN, D[6], {PM["CASH_MN"]: 0})
det = detail(fin, MN, D[6]).json()
check("C", "Kode POS tanpa metode outlet memblokir verifikasi", not det["can_verify"] and any(not l["configured"] for l in det["lines"]), det["blockers"][:2])

# ------------------------------------------------------------------ S9/S10 role & Accounting Source
r = fin.get(f"/api/accounting-control/overview?companyId={CO}"); check("S9", "Finance ke Accounting endpoint ditolak", r.status_code == 403, j(r))
ov = acc.get(f"/api/accounting-control/overview?companyId={CO}").json()["rows"]
by = {x["id"]: x for x in ov}
inv = [x for x in ov if x["transaction_type"] == "SALES_INVOICE" and x.get("source_module") == "SALES_VERIFICATION" and TAG in (x.get("reference_number") or "")]
check("S10", "Accounting Source: SALES_INVOICE dari verifikasi (AUTO_OK)", inv and all(x["bucket"] == "AUTO_OK" for x in inv), [(x["reference_number"], x["bucket"], x["issue"]) for x in inv][:3])
check("S10", "Accounting Source: payment method & outlet & mapping result", inv and inv[0].get("payment_method") and inv[0].get("location_name") and inv[0].get("mapping_result"), inv and (inv[0].get("payment_method"), inv[0].get("location_name")))
check("S10", "Accounting Source: selisih penjualan AUTO_OK", by.get(diff_tx, {}).get("bucket") == "AUTO_OK", by.get(diff_tx, {}).get("issue"))
check("S10", "Accounting Source: settlement MDR AUTO_OK (jurnal seimbang)", by.get(s4, {}).get("bucket") == "AUTO_OK" and by[s4]["source_module"] == "QRIS_SETTLEMENT", by.get(s4, {}).get("issue"))
r = acc.get(f"/api/sales-flow/reconciliations/detail?companyId={CO}&locationId={MN}&date={D[0]}")
check("S10", "Accounting membuka rekonsiliasi/transaksi Finance", r.status_code == 200 and r.json()["status"] == "SETTLED")
r = own.get(f"/api/sales-flow/reconciliations?companyId={CO}"); check("S13", "Owner read-only rekonsiliasi", r.status_code == 200)
h = acc.get(f"/api/sales-flow/cash-drawers?companyId={CO}&locationId={MN}&from={D[0]}&to={D[0]}").json()
hist = acc.get(f"/api/sales-flow/cash-drawers/{h[0]['id']}/history").json()
check("AUD", "Audit trail Cash Drawer (nominal & bukti)", any(x["action"] in ("CREATE_CASH_DRAWER", "UPDATE_CASH_DRAWER") for x in hist) and all(x["status"] == "LOCKED" for x in h), [x["action"] for x in hist])
inv_sql = sql(f"SELECT COUNT(*) FROM transaction_headers WHERE transaction_type='SALES_INVOICE' AND reference_number LIKE '{TAG}-%'")[0][0]
inv_sql = sql(f"SELECT COUNT(*) FROM transaction_headers WHERE transaction_type='SALES_INVOICE' AND workflow_status<>'VOID' AND reference_number LIKE '{TAG}-%'")[0][0]
check("DUP", "Tidak ada penjualan ganda aktif (1 invoice POS = 1 SALES_INVOICE)", int(inv_sql) == 4 + 1 + 1 + 1 + 1 + 1 + 4, inv_sql)  # MN D0..D5 (D6 belum verified) + QA2 (4)
acct = lambda txid: {r[0] for r in sql(f"SELECT jl.account_id FROM journal_lines jl JOIN journal_headers jh ON jh.id=jl.journal_id WHERE jh.source_transaction_id='{txid}' AND jh.status<>'VOID'")}
check("VAR", "Selisih kas memakai akun Selisih Kas (bukan CASH_BANK_VARIANCE)", CDV in acct(diff_tx) and CBV not in acct(diff_tx))
check("VAR", "Selisih settlement memakai akun Selisih Settlement; MDR di akun biaya", STV in acct(s6d) and FEE in acct(s6d) and CBV not in acct(s6d))
bal = sql(f"SELECT COUNT(*) FROM journal_headers jh WHERE jh.journal_type IN ('AUTO_SALES_SETTLEMENT','AUTO_SALES_DIFFERENCE') AND jh.engine_version LIKE 'phase2-%' AND (SELECT ROUND(SUM(debit)-SUM(credit),2) FROM journal_lines WHERE journal_id=jh.id)<>0")[0][0]
check("JRN", "Semua jurnal settlement/selisih seimbang", int(bal) == 0, bal)
jl = lambda txid: [(r[0], float(r[1]), float(r[2])) for r in sql(f"SELECT jl.account_id,jl.debit,jl.credit FROM journal_lines jl JOIN journal_headers jh ON jh.id=jl.journal_id WHERE jh.source_transaction_id='{txid}' AND jh.status<>'VOID' ORDER BY jl.line_no")]
BCA_COA = sql(f"SELECT coa_account_id FROM financial_accounts WHERE id='{BCA}'")[0][0]
s4j = jl(s4)
check("MDR", "S4 jurnal: Bank D 99.300, Beban MDR D 700, Clearing QRIS K 100.000", sorted(s4j) == sorted([(BCA_COA, 99300.0, 0.0), (FEE, 700.0, 0.0), (CLR_QRIS, 0.0, 100000.0)]), s4j)
check("MDR", "S4 MDR bukan selisih: tidak ada baris Selisih Kas/Settlement", not ({CDV, STV, CBV} & {a for a, _, _ in s4j}), s4j)
s6j = jl(s6d)
check("VAR", "S6 jurnal: Bank D 40rb, MDR D 9rb, Selisih Settlement D 1rb, Clearing K 50rb", sorted(s6j) == sorted([(BCA_COA, 40000.0, 0.0), (FEE, 9000.0, 0.0), (STV, 1000.0, 0.0), (CLR_OJOL, 0.0, 50000.0)]), s6j)
check("VAR", "S6 tidak memakai akun Selisih Kas", CDV not in {a for a, _, _ in s6j})
dj = jl(diff_tx)
check("VAR", "Selisih Cash Drawer -> akun Selisih Kas saja (bukan Settlement/MDR)", CDV in {a for a, _, _ in dj} and not ({STV, FEE, CBV} & {a for a, _, _ in dj}), dj)

# ------------------------------------------------------------------ report
fails = [r for r in results if not r[2]]
print(f"\nTOTAL {len(results) - len(fails)}/{len(results)} lulus, gagal: {len(fails)}")
for f in fails: print("  GAGAL:", f)
sys.exit(1 if fails else 0)
