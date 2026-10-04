#!/usr/bin/env bash
# Copy the Strata profile into ~/.omp/profiles/omp-strata/agent.
# Stock omp keeps ~/.omp/agent. agent/strata.config.yml is merged with
# `omp config set`, so a theme already in the profile config.yml stays.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${HOME}/.omp/profiles/omp-strata/agent"
mkdir -p "$agent/extensions" "$agent/skills/mac-mini"

install -m 644 "$root/agent/extensions/fail-loop-resteer.ts" "$agent/extensions/fail-loop-resteer.ts"
echo "installed $agent/extensions/fail-loop-resteer.ts"

install -m 644 "$root/agent/skills/mac-mini/SKILL.md" "$agent/skills/mac-mini/SKILL.md"
echo "installed $agent/skills/mac-mini/SKILL.md"

install -m 644 "$root/agent/RULES.md" "$agent/RULES.md"
echo "installed $agent/RULES.md"

install -m 644 "$root/agent/models.yml" "$agent/models.yml"
echo "installed $agent/models.yml"

# imagelxc reaches host Strata through the proxy on 18080. Other machines use 8080.
if [[ -x /opt/host-omp/omp ]]; then
  python3 - "$agent/models.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "http://127.0.0.1:8080/v1"
new = "http://127.0.0.1:18080/v1"
if old in text:
    path.write_text(text.replace(old, new, 1))
    print("strata baseUrl 18080 (imagelxc proxy)")
PY
fi

if [[ -x /opt/host-omp/omp ]]; then
  omp_bin=/opt/host-omp/omp
elif command -v omp >/dev/null 2>&1; then
  omp_bin=omp
else
  echo "omp is not on PATH; merge agent/strata.config.yml after omp is installed"
  exit 1
fi

keys="$(mktemp)"
pairs="$(mktemp)"
trap 'rm -f "$keys" "$pairs"' EXIT
"$omp_bin" --profile=omp-strata config list --json >"$keys"
python3 "$root/scripts/config-pairs.py" "$root/agent/strata.config.yml" "$keys" >"$pairs"
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  "$omp_bin" --profile=omp-strata config set "$key" "$value"
  echo "set $key"
done <"$pairs"

echo "extensions load on the next omp-strata start"
