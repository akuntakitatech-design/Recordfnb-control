#!/usr/bin/env python3
"""
UAT RPT-01 (blueprint V1.2) — ringkasan cabang/jenjang/yayasan, posisi keuangan,
aktivitas, arus kas, drill-down, dan pembatasan scope unit.
HANYA untuk DB lokal/staging.

Env: BASE, ADMIN_EMAIL, ADMIN_PASSWORD, RUN_SUFFIX (opsional, 4 karakter)
Jalankan: uv run --with httpx python tests/report_uat.py
"""
import os
import sys
import time

import httpx

BASE = os.environ.get("BASE", "http://127.0.0.1:4100")
EMAIL = os.environ["ADMIN_EMAIL"]
PASSWORD = os.environ["ADMIN_PASSWORD"]
SUFFIX = os.environ.get("RUN_SUFFIX") or str(int(time.time()))[-4:]

FROM = "2026-01-01"
TO = "2026-12-31"

results: list[tuple[str, bool]] = []


def check(label: str, ok: bool, detail="") -> None:
    results.append((label, bool(ok)))
    print(f"[{'OK ' if ok else 'ERR'}] {label} {str(detail)[:150]}")


def num(value) -> float:
    return float(value) if value is not None else 0.0


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=120)
    r = admin.post("/api/auth/login", json={"email": EMAIL, "password": PASSWORD})
    check("login admin", r.status_code == 200, r.status_code)
    if r.status_code != 200:
        return summary()

    hierarchy = admin.get("/api/v1/organization/hierarchy").json()
    unit = next((u for u in hierarchy["units"] if u["unit_code"] == "TK-PANAM"), None)
    other_unit = next((u for u in hierarchy["units"] if u["unit_code"] != "TK-PANAM"), None)
    check("unit TK-PANAM tersedia", unit is not None)
    if not unit:
        return summary()
    unit_id = unit["id"]

    # Ringkasan
    overview = admin.get("/api/v1/reports/overview", params={"from": FROM, "to": TO})
    body = overview.json()
    check("ringkasan tersedia", overview.status_code == 200, overview.text[:90])
    totals = body.get("totals", {})
    check("ringkasan memuat KPI utama",
          {"billed", "collected", "expenses", "outstanding", "surplus", "students"} <= set(totals.keys()),
          sorted(totals.keys()))
    check("ringkasan memuat agregasi unit & jenjang",
          len(body.get("units", [])) > 0 and len(body.get("byLevel", [])) > 0,
          (len(body.get("units", [])), len(body.get("byLevel", []))))
    check("ringkasan memuat aging & status closing",
          set(body.get("aging", {}).keys()) == {"CURRENT", "D1_30", "D31_60", "D61_PLUS"}
          and len(body.get("closing", [])) > 0,
          (body.get("aging"), len(body.get("closing", []))))

    # Drill-down harus sama dengan agregat (yayasan -> transaksi)
    def drill(metric: str, **extra):
        params = {"metric": metric, "from": FROM, "to": TO, "pageSize": 100}
        params.update(extra)
        return admin.get("/api/v1/reports/drilldown", params=params).json()

    billed = drill("billed")
    collected = drill("collected")
    expense = drill("expense")
    outstanding = drill("outstanding")
    check("drill-down tagihan = total tagihan",
          abs(num(billed.get("sumAmount")) - num(totals.get("billed"))) < 0.005,
          (billed.get("sumAmount"), totals.get("billed")))
    check("drill-down penerimaan = total penerimaan",
          abs(num(collected.get("sumAmount")) - num(totals.get("collected"))) < 0.005,
          (collected.get("sumAmount"), totals.get("collected")))
    check("drill-down pengeluaran = total pengeluaran",
          abs(num(expense.get("sumAmount")) - num(totals.get("expenses"))) < 0.005,
          (expense.get("sumAmount"), totals.get("expenses")))
    check("drill-down piutang = total piutang",
          abs(num(outstanding.get("sumAmount")) - num(totals.get("outstanding"))) < 0.005,
          (outstanding.get("sumAmount"), totals.get("outstanding")))
    check("drill-down mengembalikan baris transaksi",
          len(billed.get("rows", [])) > 0
          and {"document_number", "document_date", "amount", "unit_name"} <= set(billed["rows"][0].keys()),
          billed.get("rows", [{}])[0].get("document_number"))

    # Aging harus menjumlah ke outstanding
    aging_total = sum(num(value) for value in body.get("aging", {}).values())
    check("agging menjumlah ke piutang", abs(aging_total - num(totals.get("outstanding"))) < 0.005,
          (aging_total, totals.get("outstanding")))

    # Agregasi jenjang = agregasi unit
    level_billed = sum(num(row.get("billed")) for row in body.get("byLevel", []))
    level_collected = sum(num(row.get("collected")) for row in body.get("byLevel", []))
    level_expense = sum(num(row.get("expenses")) for row in body.get("byLevel", []))
    check("agregasi jenjang = agregasi unit (tagihan)",
          abs(level_billed - num(totals.get("billed"))) < 0.005, (level_billed, totals.get("billed")))
    check("agregasi jenjang = agregasi unit (penerimaan & pengeluaran)",
          abs(level_collected - num(totals.get("collected"))) < 0.005
          and abs(level_expense - num(totals.get("expenses"))) < 0.005,
          (level_collected, level_expense))
    check("surplus = penerimaan - pengeluaran",
          abs(num(totals.get("surplus")) - (num(totals.get("collected")) - num(totals.get("expenses")))) < 0.005,
          totals.get("surplus"))

    # Posisi keuangan
    position = admin.get("/api/v1/reports/position", params={"asOf": TO}).json()
    check("posisi keuangan seimbang (aset = liabilitas + ekuitas + surplus)",
          position.get("balanced") is True and abs(num(position.get("difference"))) < 0.005,
          {k: position.get(k) for k in ("assets", "liabilities", "equity", "netIncome", "difference")})
    check("net income = pendapatan - beban",
          abs(num(position.get("netIncome"))
              - (num(position.get("revenue")) - num(position.get("expense")))) < 0.005,
          (position.get("netIncome"), position.get("revenue"), position.get("expense")))

    # Aktivitas
    activity = admin.get("/api/v1/reports/activity", params={"from": FROM, "to": TO}).json()
    check("laporan aktivitas memuat akun pendapatan & beban",
          any(row["account_type"] == "REVENUE" for row in activity.get("items", [])),
          len(activity.get("items", [])))
    check("surplus aktivitas = pendapatan - beban",
          abs(num(activity.get("surplus")) - (num(activity.get("revenue")) - num(activity.get("expense")))) < 0.005,
          (activity.get("revenue"), activity.get("expense"), activity.get("surplus")))

    # Arus kas
    cash = admin.get("/api/v1/reports/cash-flow", params={"from": FROM, "to": TO}).json()
    check("arus kas: saldo akhir = awal + perubahan",
          abs(num(cash.get("closing")) - (num(cash.get("opening")) + num(cash.get("netChange")))) < 0.005,
          (cash.get("opening"), cash.get("netChange"), cash.get("closing")))
    check("arus kas: masuk + keluar = perubahan",
          abs(num(cash.get("inflow")) + num(cash.get("outflow")) - num(cash.get("netChange"))) < 0.005,
          (cash.get("inflow"), cash.get("outflow"), cash.get("netChange")))
    check("arus kas memuat sumber transaksi", len(cash.get("movements", [])) > 0,
          [row["source_type"] for row in cash.get("movements", [])])

    # Saldo kas laporan = saldo akun kas di buku besar
    trial = admin.get("/api/v1/accounting/trial-balance", params={"from": "2000-01-01", "to": TO}).json()
    cash_account = next((row for row in trial.get("items", []) if row["code"] == "1-1100"), None)
    check("saldo kas laporan = akun kas buku besar",
          cash_account is not None and abs(num(cash_account["balance"]) - num(cash.get("closing"))) < 0.005,
          (cash_account["balance"] if cash_account else None, cash.get("closing")))

    # Validasi input
    invalid = admin.get("/api/v1/reports/drilldown", params={"metric": "unknown", "from": FROM, "to": TO})
    check("metrik drill-down tidak dikenal ditolak",
          invalid.status_code == 400 and invalid.json().get("error") == "DRILLDOWN_METRIC_INVALID",
          invalid.status_code)

    filtered = admin.get("/api/v1/reports/overview",
                         params={"from": FROM, "to": TO, "unitId": unit_id}).json()
    check("filter unit menyempitkan ringkasan",
          len(filtered.get("units", [])) == 1 and filtered["units"][0]["unit_code"] == "TK-PANAM",
          [row["unit_code"] for row in filtered.get("units", [])])
    check("filter unit: tagihan = drill-down unit",
          abs(num(filtered["totals"]["billed"])
              - num(drill("billed", unitId=unit_id).get("sumAmount"))) < 0.005,
          (filtered["totals"]["billed"], drill("billed", unitId=unit_id).get("sumAmount")))

    # Scope unit
    staff_email = f"bendahara.rpt{SUFFIX}@sekolah.test"
    created_user = admin.post("/api/v1/users", json={
        "fullName": "Bendahara Laporan UAT", "email": staff_email, "password": "Bendahara2026!",
        "role": "BENDAHARA_CABANG", "unitIds": [unit_id],
    })
    check("user bendahara laporan dibuat", created_user.status_code == 201, created_user.status_code)
    if created_user.status_code == 201:
        staff = httpx.Client(base_url=BASE, timeout=120)
        staff.post("/api/auth/login", json={"email": staff_email, "password": "Bendahara2026!"})
        scoped = staff.get("/api/v1/reports/overview", params={"from": FROM, "to": TO})
        check("ringkasan bendahara hanya unitnya", scoped.status_code == 200
              and len(scoped.json().get("units", [])) == 1
              and scoped.json()["units"][0]["unit_code"] == "TK-PANAM",
              scoped.status_code)
        scoped_rows = staff.get("/api/v1/reports/drilldown",
                                params={"metric": "collected", "from": FROM, "to": TO, "pageSize": 100}).json()
        check("drill-down bendahara hanya unitnya",
              all(row["unit_code"] == "TK-PANAM" for row in scoped_rows.get("rows", [])),
              len(scoped_rows.get("rows", [])))
        if other_unit:
            cross = staff.get("/api/v1/reports/overview",
                              params={"from": FROM, "to": TO, "unitId": other_unit["id"]})
            check("bendahara lintas unit ditolak", cross.status_code == 403,
                  (cross.status_code, cross.text[:70]))

    # Rentang default (bulan berjalan) tetap berfungsi
    default_range = admin.get("/api/v1/reports/overview").json()
    check("rentang default terisi", default_range.get("from") and default_range.get("to"),
          (default_range.get("from"), default_range.get("to")))

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
