#!/usr/bin/env python3
"""
Phase 2 Final Cleanup Verification
Verifies the cleanup changes made by main agent:
1. sales-context returns paymentSetup (not paymentMappings/expectedPaymentMappings)
2. Variance account validation enforces separation rules
3. Payment Method validation enforces account type rules
"""
import requests
import sys
import os

# DB LOKAL saja. Kredensial dari env (tidak di-hardcode): QA_PASSWORD. Opsional BASE.
BASE = os.environ.get("BASE", "http://localhost:8001")
QA_PASSWORD = os.environ["QA_PASSWORD"]

CO = "a57df7de-646b-48f3-93da-2c415fe46859"  # Company MN
MN = "23ab678a-990d-4243-987b-4538ad173b78"  # Location MN
QA2 = "2df1428a-c168-11f1-945f-1adb9e44ada0"  # Location QA2

def login(email):
    r = requests.post(f"{BASE}/api/auth/login", json={"email": email, "password": QA_PASSWORD})
    if r.status_code != 200:
        print(f"❌ Login failed for {email}: {r.status_code} {r.text}")
        sys.exit(1)
    return requests.Session(), r.cookies

def check(tag, desc, cond, detail=""):
    global passed, total
    total += 1
    if cond:
        passed += 1
        print(f"✅ [{tag}] {desc}")
    else:
        print(f"❌ [{tag}] {desc}")
        if detail:
            print(f"   Detail: {detail}")
    return cond

passed = 0
total = 0

print("\n=== Phase 2 Final Cleanup Verification ===\n")

# 1. Test sales-context API changes
print("--- 1. Sales Context API (paymentSetup instead of legacy fields) ---")
fin, cookies = login("qa.finance@akuntakita.test")
fin.cookies.update(cookies)

r = fin.get(f"{BASE}/api/client-transactions/sales-context", params={"companyId": CO, "locationId": MN})
check("CTX", "sales-context returns 200", r.status_code == 200, r.text if r.status_code != 200 else "")
if r.status_code == 200:
    data = r.json()
    check("CTX", "paymentSetup field present", "paymentSetup" in data, data.keys())
    check("CTX", "paymentMappings field ABSENT", "paymentMappings" not in data, data.keys())
    check("CTX", "expectedPaymentMappings field ABSENT", "expectedPaymentMappings" not in data, data.keys())
    if "paymentSetup" in data:
        setup = data["paymentSetup"]
        check("CTX", "paymentSetup has activeMethods", "activeMethods" in setup, setup)
        check("CTX", "paymentSetup has readyMethods", "readyMethods" in setup, setup)
        print(f"   → activeMethods: {setup.get('activeMethods')}, readyMethods: {setup.get('readyMethods')}")
    check("CTX", "paymentMethods array present", "paymentMethods" in data and isinstance(data["paymentMethods"], list), data.get("paymentMethods"))
    if "paymentMethods" in data and data["paymentMethods"]:
        pm = data["paymentMethods"][0]
        check("CTX", "paymentMethod has mapping_ready field", "mapping_ready" in pm, pm)

# 2. Test variance account validation (Accounting only)
print("\n--- 2. Variance Account Validation (separation rules) ---")
acc, cookies = login("qa.accounting@akuntakita.test")
acc.cookies.update(cookies)

# Get current variance accounts
r = acc.get(f"{BASE}/api/sales-flow/variance-accounts", params={"companyId": CO})
check("VAR", "GET variance-accounts returns 200 for Accounting", r.status_code == 200, r.text if r.status_code != 200 else "")
if r.status_code == 200:
    variance = r.json()
    cdv = next((v for v in variance if v["role_code"] == "CASH_DRAWER_VARIANCE"), None)
    stv = next((v for v in variance if v["role_code"] == "SETTLEMENT_VARIANCE"), None)
    check("VAR", "CASH_DRAWER_VARIANCE present", cdv is not None, variance)
    check("VAR", "SETTLEMENT_VARIANCE present", stv is not None, variance)
    if cdv and stv:
        check("VAR", "Variance accounts are different", cdv["account_id"] != stv["account_id"], f"CDV={cdv['account_id']}, STV={stv['account_id']}")
        print(f"   → Cash Drawer: {cdv['account_code']} {cdv['account_name']}")
        print(f"   → Settlement: {stv['account_code']} {stv['account_name']}")
        
        # Try to set SETTLEMENT_VARIANCE to same account as CASH_DRAWER_VARIANCE (should fail)
        r = acc.put(f"{BASE}/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "SETTLEMENT_VARIANCE", "accountId": cdv["account_id"]})
        check("VAR", "Setting same account for both variance roles rejected (400)", r.status_code == 400, r.text)
        if r.status_code == 400:
            check("VAR", "Error is VARIANCE_ACCOUNTS_MUST_DIFFER", r.json().get("error") == "VARIANCE_ACCOUNTS_MUST_DIFFER", r.json())

# Finance should NOT be able to set variance accounts
r = fin.put(f"{BASE}/api/sales-flow/variance-accounts", json={"companyId": CO, "roleCode": "CASH_DRAWER_VARIANCE", "accountId": "any-id"})
check("VAR", "Finance PUT variance-accounts returns 403", r.status_code == 403, r.text if r.status_code != 403 else "")

# 3. Test Payment Method validation (fee account, clearing account)
print("\n--- 3. Payment Method Validation (account type rules) ---")

# Get payment methods to find one with fee account
r = acc.get(f"{BASE}/api/sales-flow/payment-methods", params={"companyId": CO})
check("PM", "GET payment-methods returns 200 for Accounting", r.status_code == 200, r.text if r.status_code != 200 else "")
if r.status_code == 200:
    methods = r.json()["rows"]
    settlement_method = next((m for m in methods if m["destination_behavior"] == "SETTLEMENT" and m["fee_account_id"]), None)
    if settlement_method:
        print(f"   → Found settlement method: {settlement_method['name']}")
        print(f"   → Fee account: {settlement_method.get('fee_account_code')} {settlement_method.get('fee_account_name')}")
        print(f"   → Clearing account: {settlement_method.get('clearing_account_code')} {settlement_method.get('clearing_account_name')}")
        
        # Try to set variance account as fee account (should fail)
        if cdv:
            # Get valid POS codes first
            r_codes = acc.get(f"{BASE}/api/sales-flow/pos-codes", params={"companyId": CO})
            if r_codes.status_code == 200:
                codes = r_codes.json()
                valid_code = next((c["code"] for c in codes if c["code"] not in ["CASH", "QRIS", "TRANSFER", "GOFOOD"]), "CARD")
                test_data = {
                    "companyId": CO,
                    "name": "TEST Validation",
                    "posPaymentCode": valid_code,
                    "destinationBehavior": "SETTLEMENT",
                    "locationIds": [QA2],  # Use QA2 to avoid clash with existing methods
                    "feeAccountId": cdv["account_id"],  # Try to use variance account as fee account
                    "clearingAccountId": settlement_method["clearing_account_id"],
                    "evidencePolicy": "OPTIONAL",
                    "status": "INACTIVE"
                }
                r = acc.post(f"{BASE}/api/sales-flow/payment-methods", json=test_data)
                check("PM", "Using variance account as fee account rejected (400)", r.status_code == 400, r.text)
                if r.status_code == 400:
                    check("PM", "Error is FEE_ACCOUNT_CANNOT_BE_VARIANCE", r.json().get("error") == "FEE_ACCOUNT_CANNOT_BE_VARIANCE", r.json())

# Finance should see payment methods but without account details
r = fin.get(f"{BASE}/api/sales-flow/payment-methods", params={"companyId": CO})
check("PM", "Finance GET payment-methods returns 200", r.status_code == 200, r.text if r.status_code != 200 else "")
if r.status_code == 200:
    fin_methods = r.json()["rows"]
    if fin_methods:
        fm = fin_methods[0]
        check("PM", "Finance view has NO clearing_account_id", "clearing_account_id" not in fm, fm.keys())
        check("PM", "Finance view has NO fee_account_id", "fee_account_id" not in fm, fm.keys())
        check("PM", "Finance view has mapping_ready flag", "mapping_ready" in fm, fm.keys())

# Finance should NOT be able to create/update payment methods
r = fin.post(f"{BASE}/api/sales-flow/payment-methods", json={"companyId": CO, "name": "TEST", "posPaymentCode": "TEST", "destinationBehavior": "CASH_DIRECT", "locationIds": [MN]})
check("PM", "Finance POST payment-methods returns 403", r.status_code == 403, r.text if r.status_code != 403 else "")
if r.status_code == 403:
    check("PM", "Error is PAYMENT_METHOD_ACCOUNTING_ONLY", r.json().get("error") == "PAYMENT_METHOD_ACCOUNTING_ONLY", r.json())

print(f"\n=== Summary: {passed}/{total} checks passed ===\n")
sys.exit(0 if passed == total else 1)
