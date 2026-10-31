#!/usr/bin/env bash
#
# Verifikasi menyeluruh sebelum PR / deploy.
#
#   bash scripts/verify.sh              # typecheck + build (tanpa DB)
#   ADMIN_EMAIL=... ADMIN_PASSWORD=... bash scripts/verify.sh
#                                      # + seluruh suite UAT ke backend yang berjalan
#
# Variabel opsional:
#   BASE           default http://127.0.0.1:4100
#   RUN_SUFFIX     default: 4 digit terakhir epoch
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${BASE:-http://127.0.0.1:4100}"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "Backend typecheck"
(cd "$ROOT/backend" && ./node_modules/.bin/tsc --noEmit)

step "Frontend typecheck"
(cd "$ROOT/frontend" && ./node_modules/.bin/tsc --noEmit)

step "Frontend production build"
(cd "$ROOT/frontend" && CI=true ./node_modules/.bin/vite build)

if [[ -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
  printf '\nUAT dilewati: set ADMIN_EMAIL dan ADMIN_PASSWORD untuk menjalankan suite.\n'
  printf 'Pastikan backend aktif di %s (curl -s %s/api/health).\n' "$BASE" "$BASE"
  exit 0
fi

if ! command -v uv >/dev/null 2>&1; then
  printf '\nuv tidak ditemukan; UAT dilewati.\n'
  exit 0
fi

step "Backend health"
curl -fsS "$BASE/api/health" >/dev/null || { printf 'Backend tidak merespons di %s\n' "$BASE"; exit 1; }

failed=()
index=0
for suite in foundation billing receipt expense accounting report; do
  step "UAT ${suite}"
  # Suffix berbeda per suite agar kode master tidak bertabrakan (4 digit, dipakai nomor rekening).
  if [[ -n "${RUN_SUFFIX:-}" ]]; then
    suffix="$RUN_SUFFIX"
  else
    suffix="$(printf '%04d' $(( ($(date +%s) + index * 7) % 10000 )))"
  fi
  if ! BASE="$BASE" RUN_SUFFIX="$suffix" \
       uv run --with httpx python "$ROOT/tests/${suite}_uat.py"; then
    failed+=("$suite")
  fi
  index=$((index + 1))
done

printf '\n'
if (( ${#failed[@]} > 0 )); then
  printf '\033[31mGAGAL:\033[0m %s\n' "${failed[*]}"
  exit 1
fi
printf '\033[32mSemua verifikasi lulus.\033[0m\n'
