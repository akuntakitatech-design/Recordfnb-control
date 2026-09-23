#!/usr/bin/env python3
"""E2E API smoke test FNB Control (MariaDB) — data dummy, memanggil hampir semua route.
Pakai: python3 e2e_api.py http://localhost:8001 agustrnt@gmail.com admin123
"""
import sys, json, base64, datetime, requests

BASE, EMAIL, PASSWORD = sys.argv[1], sys.argv[2], sys.argv[3]
s = requests.Session()
fails = []
today = datetime.date.today().isoformat()
TAG = datetime.datetime.now().strftime('%H%M%S')

def call(method, path, expect=(200, 201), **kw):
    r = s.request(method, BASE + path, **kw)
    ok = r.status_code in expect
    body = r.text[:300]
    mark = 'OK ' if ok else 'ERR'
    print(f"[{mark}] {method:6s} {path:60s} {r.status_code} {'' if ok else body}")
    if not ok:
        fails.append((method, path, r.status_code, body))
    try:
        return r.json()
    except Exception:
        return None

def first(lst, **match):
    for x in lst or []:
        if all(str(x.get(k)) == str(v) for k, v in match.items()):
            return x
    return (lst or [None])[0]

# ---- auth
call('GET', '/api/health')
call('POST', '/api/auth/login', json={'email': EMAIL, 'password': PASSWORD})
me = call('GET', '/api/auth/me')
call('POST', '/api/auth/login', expect=(401,), json={'email': EMAIL, 'password': 'salah'})
call('GET', '/api/foundation/summary')

# ---- workspace / company / location
ws_list = call('GET', '/api/master/workspaces')
ws = first(ws_list, code='MN') or call('POST', '/api/master/workspaces', json={'code': 'MN', 'name': 'MEATNIGHT'})
WS = ws['id']
comps = call('GET', '/api/master/companies')
comp = first(comps, code='MN') or call('POST', '/api/master/companies', json={'workspaceId': WS, 'code': 'MN', 'name': 'PT Meatnight'})
CO = comp['id']
locs = call('GET', '/api/master/locations')
loc1 = first(locs, code='HO') or call('POST', '/api/master/locations', json={'companyId': CO, 'code': 'HO', 'name': 'Head Office', 'locationType': 'HEAD_OFFICE'})
loc2 = first(locs, code='OUT1') or call('POST', '/api/master/locations', json={'companyId': CO, 'code': 'OUT1', 'name': 'Outlet 1', 'locationType': 'OUTLET'})
LOC, LOC2 = loc1['id'], loc2['id']

# ---- units / categories / items
units = call('GET', f'/api/master/units?workspaceId={WS}')
u_kg = first(units, code='KG') or call('POST', '/api/master/units', json={'workspaceId': WS, 'code': 'KG', 'name': 'Kilogram', 'decimalPrecision': 3})
u_pcs = first(units, code='PCS') or call('POST', '/api/master/units', json={'workspaceId': WS, 'code': 'PCS', 'name': 'Pieces', 'decimalPrecision': 0})
u_g = first(units, code='G') or call('POST', '/api/master/units', json={'workspaceId': WS, 'code': 'G', 'name': 'Gram', 'decimalPrecision': 0})
cats = call('GET', f'/api/master/item-categories?workspaceId={WS}')
c_raw = first(cats, code='RAW') or call('POST', '/api/master/item-categories', json={'workspaceId': WS, 'code': 'RAW', 'name': 'Bahan Baku', 'categoryType': 'RAW_MATERIAL'})
c_fg = first(cats, code='FG') or call('POST', '/api/master/item-categories', json={'workspaceId': WS, 'code': 'FG', 'name': 'Produk Jadi', 'categoryType': 'FINISHED_GOOD'})
items = call('GET', f'/api/master/items?workspaceId={WS}')
i_daging = first(items, code='RAW-DAGING') or call('POST', '/api/master/items', json={'workspaceId': WS, 'code': 'RAW-DAGING', 'name': 'Daging Sapi', 'categoryId': c_raw['id'], 'baseUnitId': u_kg['id'], 'trackStock': True, 'canPurchase': True, 'canSell': False, 'canProduce': False, 'canUseInRecipe': True})
i_bumbu = first(items, code='RAW-BUMBU') or call('POST', '/api/client-master/items', json={'workspaceId': WS, 'code': 'RAW-BUMBU', 'name': 'Bumbu Rendang', 'categoryId': c_raw['id'], 'baseUnitId': u_kg['id'], 'trackStock': True, 'canPurchase': True, 'canUseInRecipe': True})
i_steak = first(items, code='FG-STEAK') or call('POST', '/api/master/items', json={'workspaceId': WS, 'code': 'FG-STEAK', 'name': 'Steak Rendang', 'categoryId': c_fg['id'], 'baseUnitId': u_pcs['id'], 'trackStock': True, 'canPurchase': False, 'canSell': True, 'canProduce': True, 'canUseInRecipe': False})
call('GET', f'/api/master/unit-conversions?workspaceId={WS}')
convs = call('GET', f'/api/master/unit-conversions?workspaceId={WS}')
if not first(convs, from_unit_id=u_g['id']):
    call('POST', '/api/master/unit-conversions', json={'workspaceId': WS, 'fromUnitId': u_g['id'], 'toUnitId': u_kg['id'], 'multiplier': 0.001})
    call('POST', '/api/master/unit-conversions', expect=(400, 409), json={'workspaceId': WS, 'fromUnitId': u_g['id'], 'toUnitId': u_kg['id'], 'multiplier': 0.001})  # duplikat -> harus gagal (unique generated col)

# ---- partners / cost centers
partners = call('GET', f'/api/master/partners?workspaceId={WS}')
sup = first(partners, code='SUP-01') or call('POST', '/api/client-master/partners', json={'workspaceId': WS, 'code': 'SUP-01', 'name': 'CV Sumber Daging', 'partnerType': 'SUPPLIER', 'paymentTermDays': 14, 'phone': '0812', 'email': 'sup@x.id', 'address': 'Jl. Pasar 1', 'taxNumber': ''})
call('POST', '/api/master/partners', json={'workspaceId': WS, 'code': f'CUST-{TAG}', 'name': 'Pelanggan Umum', 'partnerType': 'CUSTOMER', 'paymentTermDays': 0})
ccs = call('GET', f'/api/master/cost-centers?companyId={CO}')
cc = first(ccs, code='KITCHEN') or call('POST', '/api/master/cost-centers', json={'workspaceId': WS, 'companyId': CO, 'code': 'KITCHEN', 'name': 'Dapur'})

# ---- COA template apply (INSERT..SELECT ON CONFLICT DO NOTHING RETURNING + trigger)
tpls = call('GET', '/api/master/coa-standard/templates')
TPL = tpls[0]['id']
call('GET', f'/api/master/coa-standard/templates/{TPL}/accounts')
apply1 = call('POST', f'/api/master/coa-standard/templates/{TPL}/apply', json={'companyId': CO})
apply2 = call('POST', f'/api/master/coa-standard/templates/{TPL}/apply', json={'companyId': CO})
print('   apply1', apply1, '| apply2 (idempoten, insertedAccounts harus 0):', apply2)
if apply2 and apply2.get('insertedAccounts') != 0:
    fails.append(('LOGIC', 'apply template ke-2 insertedAccounts != 0', apply2))
mappings = call('GET', f'/api/master/coa-standard/company/{CO}/mappings')
accounts = call('GET', f'/api/master/accounts?companyId={CO}')
print(f'   accounts={len(accounts)} mappings keys={list(mappings.keys()) if isinstance(mappings, dict) else type(mappings)}')
def acc(code):
    return first(accounts, code=code)
# sales_payment_mappings hasil trigger
call('GET', f'/api/client-transactions/sales-context?companyId={CO}&locationId={LOC}')

# mapping kategori item -> akun (ON CONFLICT DO UPDATE EXCLUDED)
inv = acc('1301-00-001') or acc('1301-00-002') or accounts[0]
cogs = first(accounts, account_type='COGS') or accounts[0]
exp = first(accounts, account_type='EXPENSE') or accounts[0]
sales_acc = first(accounts, account_type='REVENUE') or accounts[0]
call('PUT', f'/api/master/coa-standard/company/{CO}/item-category/{c_raw["id"]}', json={'inventoryAccountId': inv['id'], 'cogsAccountId': cogs['id'], 'usageAccountId': exp['id'], 'salesAccountId': sales_acc['id'], 'stockAdjustmentAccountId': exp['id']})
call('PUT', f'/api/master/coa-standard/company/{CO}/item-category/{c_fg["id"]}', json={'inventoryAccountId': inv['id'], 'cogsAccountId': cogs['id'], 'usageAccountId': exp['id'], 'salesAccountId': sales_acc['id'], 'stockAdjustmentAccountId': exp['id']})
imp = mappings.get('important') if isinstance(mappings, dict) else None
if imp:
    r0 = imp[0]
    call('PUT', f'/api/master/coa-standard/company/{CO}/important/{r0.get("role_code")}', json={'accountId': r0.get('account_id') or accounts[0]['id']})
taxmap = mappings.get('tax') if isinstance(mappings, dict) else None
if taxmap:
    t0 = taxmap[0]
    call('PUT', f'/api/master/coa-standard/company/{CO}/tax/{t0.get("tax_role_code")}', json={'accountId': t0.get('account_id') or accounts[0]['id'], 'label': t0.get('label') or 'Pajak'})

# ---- finance master
call('GET', f'/api/master/tax-codes?workspaceId={WS}')
call('POST', '/api/master/tax-codes', json={'workspaceId': WS, 'code': f'PPN{TAG}', 'name': 'PPN 11%', 'taxType': 'VAT', 'rate': 0.11, 'effectiveFrom': today, 'defaultInclusive': False})
call('POST', '/api/master/accounts', json={'workspaceId': WS, 'companyId': CO, 'code': f'9999-{TAG}', 'name': 'Akun Uji', 'accountType': 'EXPENSE', 'normalBalance': 'DEBIT', 'allowManualPosting': True})
fas = call('GET', f'/api/master/financial-accounts?companyId={CO}')
cash_acc = acc('1101-00-001') or accounts[0]
bank_acc = acc('1102-00-001') or accounts[0]
fa_cash = first(fas, code='KAS') or call('POST', '/api/master/financial-accounts', json={'companyId': CO, 'code': 'KAS', 'name': 'Kas Kecil', 'accountKind': 'CASH', 'coaAccountId': cash_acc['id']})
fa_bank = first(fas, code='BCA') or call('POST', '/api/master/financial-accounts', json={'companyId': CO, 'code': 'BCA', 'name': 'Bank BCA', 'accountKind': 'BANK', 'coaAccountId': bank_acc['id'], 'locationId': LOC})
call('GET', f'/api/client-transactions/financial-accounts?companyId={CO}')

# ---- purchase invoice (document_sequences upsert RETURNING, jsonb metadata, lines)
pi = call('POST', '/api/client-transactions/purchase-invoices', json={
    'companyId': CO, 'locationId': LOC, 'partnerId': sup['id'], 'transactionDate': today, 'dueDate': today,
    'referenceNumber': f'INV-{TAG}', 'paymentType': 'CREDIT', 'notes': 'uji e2e',
    'lines': [
        {'itemId': i_daging['id'], 'description': 'Daging sapi', 'quantity': 10, 'unitId': u_kg['id'], 'unitPrice': 120000, 'discountType': 'PERCENT', 'discountValue': 5, 'taxIncluded': False},
        {'itemId': i_bumbu['id'], 'description': 'Bumbu', 'quantity': 2, 'unitId': u_kg['id'], 'unitPrice': 50000, 'taxIncluded': False},
    ]})
PI = pi['id'] if pi and 'id' in pi else None
pi_list = call('GET', f'/api/client-transactions/purchase-invoices?companyId={CO}')
print(f'   purchase invoices: {len(pi_list)}')
if PI:
    call('GET', f'/api/client-transactions/{PI}/attachments')
    att = call('POST', f'/api/client-transactions/{PI}/attachments', json={'fileName': 'nota.pdf', 'mimeType': 'application/pdf', 'dataBase64': base64.b64encode(f'nota uji {TAG}'.encode()).decode()})
    atts = call('GET', f'/api/client-transactions/{PI}/attachments')
    if atts:
        r = s.get(BASE + f'/api/client-transactions/{PI}/attachments/{atts[0]["id"]}/file')
        print(f'   download attachment -> {r.status_code} {len(r.content)} bytes, content-type={r.headers.get("content-type")}')
        if r.status_code != 200 or f'nota uji' not in r.text:
            fails.append(('GET', 'attachment file', r.status_code, r.text[:200]))
        # upload ke-2 lalu hapus -> objek di storage ikut terhapus, list berkurang 1
        att2 = call('POST', f'/api/client-transactions/{PI}/attachments', json={'fileName': 'foto.png', 'mimeType': 'image/png', 'dataBase64': base64.b64encode(b'\x89PNG dummy').decode()})
        if att2 and 'id' in att2:
            call('DELETE', f'/api/client-transactions/{PI}/attachments/{att2["id"]}', expect=(204,))
            call('GET', f'/api/client-transactions/{PI}/attachments/{att2["id"]}/file', expect=(404,))
            after = call('GET', f'/api/client-transactions/{PI}/attachments')
            print(f'   attachments setelah hapus: {len(after)} (harus {len(atts)})')
            if len(after) != len(atts):
                fails.append(('DELETE', 'attachment', 0, 'jumlah attachment tidak sesuai'))
        call('POST', f'/api/client-transactions/{PI}/attachments', expect=(400,), json={'fileName': 'x.exe', 'mimeType': 'application/x-msdownload', 'dataBase64': 'AAAA'})
    call('POST', f'/api/transactions/{PI}/verify')  # journal engine + inventory movement

call('GET', f'/api/transactions/recent?companyId={CO}')
journals = call('GET', f'/api/journals/recent?companyId={CO}')
if journals:
    J = journals[0]['id']
    call('GET', f'/api/journals/{J}')
    call('POST', f'/api/journals/{J}/ready', expect=(200, 201, 400))
    call('POST', f'/api/journals/{J}/post', expect=(200, 201, 400))

# ---- cash out (operational + debt payment with allocations) & accounting direction
co1 = call('POST', '/api/client-transactions/cash-outs', json={
    'companyId': CO, 'locationId': LOC, 'financialAccountId': fa_cash['id'], 'transactionDate': today,
    'cashOutType': 'OPERATIONAL_EXPENSE', 'payeeName': 'Toko Gas', 'referenceNumber': f'CO-{TAG}', 'notes': 'gas',
    'lines': [{'description': 'Isi gas', 'amount': 150000, 'costCenterId': cc['id']}, {'description': 'Parkir', 'amount': 5000}]})
if co1 and 'id' in co1:
    call('POST', f'/api/client-transactions/cash-outs/{co1["id"]}/verify')
call('GET', f'/api/client-transactions/open-payables?companyId={CO}&supplierId={sup["id"]}')
if PI:
    co2 = call('POST', '/api/client-transactions/cash-outs', json={
        'companyId': CO, 'locationId': LOC, 'financialAccountId': fa_bank['id'], 'transactionDate': today,
        'cashOutType': 'DEBT_PAYMENT', 'partnerId': sup['id'], 'referenceNumber': f'PAY-{TAG}',
        'lines': [{'description': 'Bayar sebagian', 'amount': 100000}],
        'allocations': [{'invoiceId': PI, 'amount': 100000}]})
    if co2 and 'id' in co2:
        call('POST', f'/api/client-transactions/cash-outs/{co2["id"]}/verify')
call('GET', f'/api/client-transactions/cash-outs?companyId={CO}')
pending = call('GET', f'/api/accounting-cash-outs/pending?companyId={CO}')
if pending:
    p0 = pending[0]
    print(f'   pending cash-out lines type={type(p0.get("lines")).__name__}')
    if not isinstance(p0.get('lines'), list):
        fails.append(('LOGIC', 'json_agg lines bukan list', p0.get('lines')))
    else:
        call('POST', f'/api/accounting-cash-outs/{p0["id"]}/direct', json={'assignments': [{'lineId': l['id'], 'accountId': exp['id']} for l in p0['lines']]})

# ---- cash in
ci = call('POST', '/api/client-transactions/cash-ins', json={
    'companyId': CO, 'locationId': LOC, 'financialAccountId': fa_cash['id'], 'transactionDate': today,
    'cashInType': 'OTHER_RECEIPT', 'sourceName': 'Sewa lahan', 'referenceNumber': f'CI-{TAG}',
    'lines': [{'description': 'Sewa', 'amount': 250000}]})
if ci and 'id' in ci:
    call('POST', f'/api/client-transactions/cash-ins/{ci["id"]}/verify')
call('GET', f'/api/client-transactions/cash-ins?companyId={CO}')
pending_in = call('GET', f'/api/accounting-cash-ins/pending?companyId={CO}')
if pending_in:
    p0 = pending_in[0]
    call('POST', f'/api/accounting-cash-ins/{p0["id"]}/direct', json={'assignments': [{'lineId': l['id'], 'accountId': sales_acc['id']} for l in p0['lines']]})

# ---- item usage
call('GET', f'/api/client-transactions/item-usage-balances?companyId={CO}&locationId={LOC}')
iu = call('POST', '/api/client-transactions/item-usages', json={'companyId': CO, 'locationId': LOC, 'transactionDate': today, 'notes': 'pakai', 'lines': [{'itemId': i_bumbu['id'], 'quantity': 0.5, 'unitId': u_kg['id'], 'description': 'pakai bumbu', 'costCenterId': cc['id']}]})
if iu and 'id' in iu:
    call('GET', f'/api/client-transactions/item-usages/{iu["id"]}/preview')
    call('POST', f'/api/client-transactions/item-usages/{iu["id"]}/verify', json={'allowBelowZero': True})
call('GET', f'/api/client-transactions/item-usages?companyId={CO}')

# ---- stock transfer
call('GET', f'/api/client-transactions/stock-transfer-items?companyId={CO}&fromLocationId={LOC}&toLocationId={LOC2}')
st = call('POST', '/api/client-transactions/stock-transfers', json={'companyId': CO, 'fromLocationId': LOC, 'toLocationId': LOC2, 'transactionDate': today, 'lines': [{'itemId': i_daging['id'], 'quantity': 2, 'unitId': u_kg['id'], 'description': 'kirim ke outlet'}]})
if st and 'id' in st:
    call('GET', f'/api/client-transactions/stock-transfers/{st["id"]}/preview')
    call('POST', f'/api/client-transactions/stock-transfers/{st["id"]}/verify', json={'allowBelowZero': True})
call('GET', f'/api/client-transactions/stock-transfers?companyId={CO}')

# ---- stock opname (metadata jsonb + FILTER rewrite)
call('GET', f'/api/client-transactions/stock-opname-items?companyId={CO}&locationId={LOC}')
so = call('POST', '/api/client-transactions/stock-opnames', json={'companyId': CO, 'locationId': LOC, 'transactionDate': today, 'notes': 'opname', 'lines': [{'itemId': i_daging['id'], 'physicalQuantity': 7.5, 'unitId': u_kg['id'], 'description': 'fisik'}]})
if so and 'id' in so:
    call('GET', f'/api/client-transactions/stock-opnames/{so["id"]}/preview')
    call('POST', f'/api/client-transactions/stock-opnames/{so["id"]}/verify')
sol = call('GET', f'/api/client-transactions/stock-opnames?companyId={CO}')
print('   opname list sample:', json.dumps(sol[0], default=str)[:250] if sol else sol)

# ---- BOM & production
call('GET', f'/api/client-transactions/bom-context?companyId={CO}')
boms = call('GET', f'/api/client-transactions/boms?companyId={CO}')
bom = first(boms, output_item_id=i_steak['id']) or call('POST', '/api/client-transactions/boms', json={'companyId': CO, 'bomType': 'PRODUCTION', 'outputItemId': i_steak['id'], 'outputQuantity': 10, 'outputUnitId': u_pcs['id'], 'notes': 'resep', 'lines': [{'componentItemId': i_daging['id'], 'quantity': 2, 'unitId': u_kg['id'], 'wastePercent': 5}, {'componentItemId': i_bumbu['id'], 'quantity': 0.2, 'unitId': u_kg['id']}]})
if bom and 'id' in bom:
    # upsert BOM lagi (ON CONFLICT DO UPDATE EXCLUDED)
    call('POST', '/api/client-transactions/boms', json={'companyId': CO, 'bomType': 'PRODUCTION', 'outputItemId': i_steak['id'], 'outputQuantity': 10, 'outputUnitId': u_pcs['id'], 'notes': 'resep v2', 'lines': [{'componentItemId': i_daging['id'], 'quantity': 2, 'unitId': u_kg['id'], 'wastePercent': 5}]})
    pr = call('POST', '/api/client-transactions/productions', json={'companyId': CO, 'locationId': LOC, 'bomId': bom['id'], 'transactionDate': today, 'batchCount': 1, 'actualOutput': 10, 'notes': 'produksi'})
    if pr and 'id' in pr:
        call('GET', f'/api/client-transactions/productions/{pr["id"]}/preview')
        call('POST', f'/api/client-transactions/productions/{pr["id"]}/verify', json={'allowBelowZero': True})
call('GET', f'/api/client-transactions/productions?companyId={CO}')
call('GET', f'/api/client-transactions/inventory-control?companyId={CO}&locationId={LOC}')
call('GET', f'/api/client-transactions/stock-card?companyId={CO}&locationId={LOC}&itemId={i_daging["id"]}&from={today}&to={today}')

# ---- sales import profile & batch (JSON_TABLE, jsonb settings, generated unique alias)
profs = call('GET', f'/api/client-transactions/sales-import-profiles?companyId={CO}')
prof = first(profs, name='Quinos Uji') or call('POST', '/api/client-transactions/sales-import-profiles', json={'companyId': CO, 'name': 'Quinos Uji', 'provider': 'QUINOS', 'fileMode': 'CSV', 'headerRow': 1, 'delimiter': ',', 'dateFormat': 'DD/MM/YYYY', 'numberFormat': 'ID', 'headerSignature': ['Tanggal', 'Item', 'Qty'], 'columnMapping': {'saleDate': 'Tanggal', 'itemName': 'Item', 'quantity': 'Qty'}, 'settings': {'skipEmpty': True}})
if prof and 'id' in prof:
    PF = prof['id']
    call('GET', f'/api/client-transactions/sales-import-profiles/{PF}')
    call('PUT', f'/api/client-transactions/sales-import-profiles/{PF}', json={'name': 'Quinos Uji', 'provider': 'QUINOS', 'status': 'ACTIVE', 'fileMode': 'CSV', 'headerRow': 1, 'delimiter': ',', 'dateFormat': 'DD/MM/YYYY', 'numberFormat': 'ID', 'headerSignature': ['Tanggal', 'Item', 'Qty'], 'columnMapping': {'saleDate': 'Tanggal'}, 'settings': {'skipEmpty': False}})
    call('GET', f'/api/client-transactions/sales-import-profile-items?companyId={CO}')
    al = call('POST', f'/api/client-transactions/sales-import-profiles/{PF}/item-aliases', json={'externalCode': 'STK01', 'externalName': 'Steak Rendang POS', 'itemId': i_steak['id']})
    call('POST', f'/api/client-transactions/sales-import-profiles/{PF}/item-aliases', json={'externalCode': ' stk01 ', 'externalName': 'Steak Rendang POS 2', 'itemId': i_steak['id']})  # upsert by UPPER(TRIM(code))
    pa = call('POST', f'/api/client-transactions/sales-import-profiles/{PF}/payment-aliases', json={'externalValue': 'Gopay', 'paymentCode': 'GOFOOD'})
    call('POST', f'/api/client-transactions/sales-import-profiles/{PF}/payment-aliases', json={'externalValue': 'Gopay', 'paymentCode': 'QRIS'})  # DO UPDATE EXCLUDED
    call('POST', '/api/client-transactions/sales-import-profiles/detect', json={'companyId': CO, 'headers': ['Tanggal', 'Item', 'Qty']})
    detail = call('GET', f'/api/client-transactions/sales-import-profiles/{PF}')
    if detail and isinstance(detail, dict):
        print('   profile settings type:', type(detail.get('profile', detail).get('settings')).__name__)
        for a in (detail.get('itemAliases') or detail.get('item_aliases') or []):
            call('DELETE', f'/api/client-transactions/sales-import-profiles/{PF}/item-aliases/{a["id"]}')
            break
sb = call('POST', '/api/client-transactions/sales-batches', json={'companyId': CO, 'locationId': LOC, 'sourceType': 'PASTE', 'sourceName': 'uji', 'rows': [
    {'saleDate': today, 'invoiceNumber': f'S-{TAG}-1', 'cashier': 'Ani', 'saleType': 'DINE_IN', 'itemCode': 'FG-STEAK', 'itemName': 'Steak Rendang', 'itemId': i_steak['id'], 'quantity': 2, 'unitPrice': 75000, 'discountAmount': 0, 'lineTotal': 150000, 'cash': 150000, 'qris': 0, 'transfer': 0, 'compliment': 0, 'gofood': 0, 'grabfood': 0},
    {'saleDate': today, 'invoiceNumber': f'S-{TAG}-2', 'cashier': 'Ani', 'saleType': 'TAKE_AWAY', 'itemCode': 'FG-STEAK', 'itemName': 'Steak Rendang', 'itemId': i_steak['id'], 'quantity': 1, 'unitPrice': 75000, 'discountAmount': 5000, 'lineTotal': 70000, 'cash': 0, 'qris': 70000, 'transfer': 0, 'compliment': 0, 'gofood': 0, 'grabfood': 0},
]})
if sb and 'id' in sb:
    pv = call('GET', f'/api/client-transactions/sales-batches/{sb["id"]}/preview')
    call('POST', f'/api/client-transactions/sales-batches/{sb["id"]}/verify', json={'allowBelowZero': True})
call('GET', f'/api/client-transactions/sales-batches?companyId={CO}&page=1&pageSize=20')

# ---- access control
roles = call('GET', '/api/access/roles')
users = call('GET', '/api/access/users')
r_staff = first(roles, code='CLIENT_FINANCE_STAFF')
new_email = f'staff{TAG}@meatnight.test'
nu = call('POST', '/api/access/users', json={'email': new_email, 'fullName': 'Staff Uji', 'temporaryPassword': 'Rahasia123!', 'workspaceId': WS, 'roleId': r_staff['id'], 'companyId': CO, 'locationId': LOC})
if nu and 'id' in nu:
    UID = nu['id']
    call('PATCH', f'/api/access/users/{UID}', json={'fullName': 'Staff Uji Edit', 'status': 'ACTIVE'})
    m = call('POST', f'/api/access/users/{UID}/memberships', json={'workspaceId': WS, 'roleId': r_staff['id'], 'companyId': CO, 'locationId': None, 'status': 'ACTIVE'})
    call('POST', f'/api/access/users/{UID}/memberships', expect=(400, 409), json={'workspaceId': WS, 'roleId': r_staff['id'], 'companyId': CO, 'locationId': None, 'status': 'ACTIVE'})  # duplikat scope -> unique generated
    if m and 'id' in m:
        call('PATCH', f'/api/access/memberships/{m["id"]}', json={'status': 'INACTIVE'})
    call('POST', f'/api/access/users/{UID}/reset-password', json={'newPassword': 'BaruRahasia123!'})
    # login sebagai staff dan cek scope
    s2 = requests.Session()
    r = s2.post(BASE + '/api/auth/login', json={'email': new_email, 'password': 'BaruRahasia123!'})
    print(f'   login staff -> {r.status_code}')
    if r.status_code != 200: fails.append(('POST', 'login staff', r.status_code, r.text[:200]))
    else:
        r = s2.get(BASE + '/api/auth/me'); print('   staff memberships:', len(r.json().get('memberships', [])))
        r = s2.get(BASE + '/api/foundation/summary'); print('   staff summary:', r.json())
        r = s2.post(BASE + '/api/master/workspaces', json={'code': 'X', 'name': 'X'}); print(f'   staff create workspace -> {r.status_code} (harus 403)')
        if r.status_code != 403: fails.append(('LOGIC', 'staff bisa buat workspace', r.status_code, ''))

call('POST', '/api/auth/change-password', expect=(400,), json={'currentPassword': 'salah', 'newPassword': 'Rahasia12345'})
call('GET', '/api/foundation/summary')
call('POST', '/api/auth/logout')
call('GET', '/api/auth/me', expect=(401,))

print('\n==== RINGKASAN ====')
print('gagal:', len(fails))
for f in fails:
    print('  ', f)
sys.exit(1 if fails else 0)
