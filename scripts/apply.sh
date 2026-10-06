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

install -m 644 "$root/agent/extensions/read-before-edit.ts" "$agent/extensions/read-before-edit.ts"
echo "installed $agent/extensions/read-before-edit.ts"

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

# Local choices from scripts/strata-vision.sh. Updates keep them.
STRATA_VISION=on
VISION_MODEL=""
SIDE_FALLBACK=on
COMPACTION_MODEL=""
SMOL_MODEL=""
settings="${XDG_CONFIG_HOME:-$HOME/.config}/omp-strata/settings.env"
if [[ -f "$settings" ]]; then
  # shellcheck disable=SC1090
  source "$settings"
fi
config_yml="$root/agent/strata.config.yml"
overrides=()
if [[ "$STRATA_VISION" == off ]]; then
  if [[ -z "$VISION_MODEL" ]]; then
    echo "STRATA_VISION=off needs VISION_MODEL in $settings; run scripts/strata-vision.sh off --model PROVIDER/MODEL" >&2
    exit 1
  fi
  # The coder is text-only, so omp describes images with modelRoles.vision.
  python3 - "$agent/models.yml" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
old = "        input: [text, image]\n        imageInputDecoder: stb\n        contextWindow: 262144"
if old not in text:
    raise SystemExit(f"{path}: coder input line not found; update apply.sh")
path.write_text(text.replace(old, "        input: [text]\n        imageInputDecoder: stb\n        contextWindow: 262144", 1))
print("coder input [text] (STRATA_VISION=off)")
PY
  overrides+=("vision=$VISION_MODEL")
fi
# SIDE_FALLBACK=off: a failed side-model call errors instead of continuing on
# the coder. Each fallback is a cold read on the coder and evicts its prompt cache.
[[ "$SIDE_FALLBACK" == off ]] && overrides+=("nofallback")
# SMOL_MODEL: omp's small background calls (skill routing hints and similar,
# ~400 prompt tokens) go to modelRoles.smol. On the coder each one evicts the
# coder's conversation; with --kv-persist that is a 1-2 GB save and a restore.
[[ -n "$SMOL_MODEL" ]] && overrides+=("smol=$SMOL_MODEL")
# COMPACTION_MODEL: omp 18.4.4 runs handoff on the session model and blocks the
# coder for minutes. soft uses compactionModel and can run in the background,
# so soft goes first and the summary is written by that model.
if [[ -n "$COMPACTION_MODEL" ]]; then
  python3 - "$agent/models.yml" "$COMPACTION_MODEL" <<'PY'
import pathlib, sys
path, model = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text()
import json, re
m = re.search(r"        contextWindow: 262144\n        maxTokens: \d+\n", text)
if not m:
    raise SystemExit(f"{path}: coder entry not found; update apply.sh")
path.write_text(text[:m.end()] + f"        compactionModel: {json.dumps(model)}\n" + text[m.end():])
print(f"coder compactionModel {model}")
PY
  overrides+=("softfirst")
fi
if (( ${#overrides[@]} )); then
  config_yml="$(mktemp --suffix=.yml)"
  trap 'rm -f "$config_yml"' EXIT
  python3 - "$root/agent/strata.config.yml" "$config_yml" "${overrides[@]}" <<'PY'
import sys, yaml
src, dst, *overrides = sys.argv[1:]
cfg = yaml.safe_load(open(src))
for item in overrides:
    if item.startswith("vision="):
        cfg.setdefault("modelRoles", {})["vision"] = item.split("=", 1)[1]
        print(f"modelRoles.vision {item.split('=', 1)[1]} (STRATA_VISION=off)")
    elif item.startswith("smol="):
        cfg.setdefault("modelRoles", {})["smol"] = item.split("=", 1)[1]
        print(f"modelRoles.smol {item.split('=', 1)[1]} (SMOL_MODEL set)")
    elif item == "softfirst":
        cfg.setdefault("compaction", {})["methodOrder"] = ["soft", "shake", "handoff"]
        print("compaction.methodOrder soft, shake, handoff (COMPACTION_MODEL set)")
    elif item == "nofallback":
        cfg.setdefault("retry", {})["fallbackChains"] = {}
        cfg["retry"]["modelFallback"] = False
        print("retry.modelFallback false, fallbackChains cleared (SIDE_FALLBACK=off)")
yaml.safe_dump(cfg, open(dst, "w"), sort_keys=False)
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
python3 "$root/scripts/config-pairs.py" "$config_yml" "$keys" >"$pairs"
while IFS= read -r -d '' key && IFS= read -r -d '' value; do
  "$omp_bin" --profile=omp-strata config set "$key" "$value"
  echo "set $key"
done <"$pairs"

echo "extensions load on the next omp-strata start"
