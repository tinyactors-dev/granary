#!/usr/bin/env bash
# Svelte components aren't parsed by ast-grep; check their import lines as text (ADR 0080).
# Granary .svelte files may import only $lib/ops/contract from the ops module.
set -euo pipefail
cd "$(dirname "$0")/.."
hits=$(rg -n --glob 'src/**/*.svelte' --glob '!src/lib/ops/**' \
  -e "from ['\"](\\\$lib/ops|[./]+/ops)/" -e "import\\(['\"](\\\$lib/ops|[./]+/ops)/" src \
  | rg -v "/ops/contract['\"]" || true)
if [[ -n "$hits" ]]; then
  echo "error[svelte-imports-ops-contract-only]: .svelte files may import only \$lib/ops/contract (ADR 0080)"
  echo "$hits"
  exit 1
fi
echo "svelte boundaries ok"
