#!/usr/bin/env bash
# Setup master data TEST- (additive) di company MEATNIGHT untuk uji Kas & Bank.
# Aman dijalankan ulang: setiap POST akan 409 DUPLICATE bila sudah ada, lalu ID diambil dari GET.
set -u
BASE=${BASE:-http://localhost:8001}
CJ=/tmp/kb_cj
WS=fca7bf4e-21e7-43c3-b4a9-4ce6fe032231
CO=a57df7de-646b-48f3-93da-2c415fe46859
LOC=23ab678a-990d-4243-987b-4538ad173b78

j() { curl -s -b $CJ -c $CJ -H 'Content-Type: application/json' "$@"; }

# Kredensial user uji dibaca dari env (TIDAK di-hardcode): TEST_EMAIL, TEST_PASSWORD
: "${TEST_EMAIL:?TEST_EMAIL wajib diisi}"; : "${TEST_PASSWORD:?TEST_PASSWORD wajib diisi}"
j -X POST $BASE/api/auth/login -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" >/dev/null

# 1) COA dari template standar (idempoten: INSERT ... hanya yang belum ada)
TPL=$(j "$BASE/api/master/coa-standard/templates" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
j -X POST "$BASE/api/master/coa-standard/templates/$TPL/apply" -d "{\"companyId\":\"$CO\"}" | head -c 200; echo
ACC=$(j "$BASE/api/master/accounts?companyId=$CO")
coa() { echo "$ACC" | python3 -c "import sys,json;a=[x for x in json.load(sys.stdin) if x['code']=='$1'];print(a[0]['id'] if a else '')"; }
COA_BANK=$(coa 1102-00-001); COA_KAS=$(coa 1101-00-002)
echo "COA bank=$COA_BANK kas=$COA_KAS"

# 2) Rekening kas/bank
j -X POST $BASE/api/master/financial-accounts -d "{\"companyId\":\"$CO\",\"code\":\"TEST-BCA\",\"name\":\"TEST Bank BCA\",\"accountKind\":\"BANK\",\"coaAccountId\":\"$COA_BANK\"}" | head -c 200; echo
j -X POST $BASE/api/master/financial-accounts -d "{\"companyId\":\"$CO\",\"code\":\"TEST-KAS\",\"name\":\"TEST Kas Operasional\",\"accountKind\":\"CASH\",\"coaAccountId\":\"$COA_KAS\"}" | head -c 200; echo

# 3) Supplier
j -X POST $BASE/api/client-master/partners -d "{\"workspaceId\":\"$WS\",\"code\":\"TEST-SUP\",\"name\":\"TEST Supplier Daging\",\"partnerType\":\"SUPPLIER\",\"paymentTermDays\":14}" | head -c 200; echo

# 4) Unit, kategori item, item (untuk invoice pembelian)
j -X POST $BASE/api/master/units -d "{\"workspaceId\":\"$WS\",\"code\":\"TEST-KG\",\"name\":\"TEST Kilogram\",\"decimalPrecision\":2}" | head -c 200; echo
j -X POST $BASE/api/master/item-categories -d "{\"workspaceId\":\"$WS\",\"code\":\"TEST-RAW\",\"name\":\"TEST Bahan Baku\",\"categoryType\":\"RAW_MATERIAL\"}" | head -c 200; echo
UNIT=$(j "$BASE/api/master/units?workspaceId=$WS" | python3 -c 'import sys,json;print([x for x in json.load(sys.stdin) if x["code"]=="TEST-KG"][0]["id"])')
CAT=$(j "$BASE/api/master/item-categories?workspaceId=$WS" | python3 -c 'import sys,json;print([x for x in json.load(sys.stdin) if x["code"]=="TEST-RAW"][0]["id"])')
j -X POST $BASE/api/master/items -d "{\"workspaceId\":\"$WS\",\"code\":\"TEST-DAGING\",\"name\":\"TEST Daging Sapi\",\"categoryId\":\"$CAT\",\"baseUnitId\":\"$UNIT\"}" | head -c 200; echo

# 5) Kategori pengeluaran (1 ter-mapping ke COA, 1 belum -> PERLU REVIEW)
EXP_COA=$(coa 6200-00-004)  # Beban Listrik
j -X POST $BASE/api/master/expense-categories -d "{\"companyId\":\"$CO\",\"code\":\"TEST-LISTRIK\",\"name\":\"TEST Listrik & Air\",\"accountId\":\"$EXP_COA\"}" | head -c 200; echo
j -X POST $BASE/api/master/expense-categories -d "{\"companyId\":\"$CO\",\"code\":\"TEST-LAIN\",\"name\":\"TEST Lain-lain (belum dipetakan)\"}" | head -c 200; echo

echo "== financial accounts =="; j "$BASE/api/cash-bank/accounts?companyId=$CO"; echo
echo "== expense categories =="; j "$BASE/api/master/expense-categories?companyId=$CO" | head -c 600; echo
