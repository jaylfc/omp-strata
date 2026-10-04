#!/usr/bin/env bash
# Copy the Strata profile into ~/.omp/agent. Existing models.yml and RULES.md
# are left in place. Config keys are merged with `omp config set`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${HOME}/.omp/agent"
mkdir -p "$agent/extensions"

install -m 644 "$root/agent/extensions/fail-loop-resteer.ts" "$agent/extensions/fail-loop-resteer.ts"
echo "installed $agent/extensions/fail-loop-resteer.ts"

mkdir -p "$agent/skills/mac-mini"
install -m 644 "$root/agent/skills/mac-mini/SKILL.md" "$agent/skills/mac-mini/SKILL.md"
echo "installed $agent/skills/mac-mini/SKILL.md"

if [[ -f "$agent/RULES.md" ]]; then
  if cmp -s "$root/agent/RULES.md" "$agent/RULES.md"; then
    echo "RULES.md already matches"
  else
    echo "left existing $agent/RULES.md in place"
  fi
else
  install -m 644 "$root/agent/RULES.md" "$agent/RULES.md"
  echo "installed $agent/RULES.md"
fi

if [[ -f "$agent/models.yml" ]]; then
  echo "left existing $agent/models.yml in place"
  echo "strata baseUrl in this repo is http://127.0.0.1:8080/v1"
  echo "an incus proxy in front of host port 8080 uses http://127.0.0.1:18080/v1"
else
  install -m 644 "$root/agent/models.yml" "$agent/models.yml"
  echo "installed $agent/models.yml"
fi

if ! command -v omp >/dev/null 2>&1; then
  echo "omp is not on PATH; merge agent/strata.config.yml after omp is installed"
  exit 1
fi

set_key() {
  omp config set "$1" "$2"
  echo "set $1"
}

set_key compaction.methodOrder '["shake","handoff","soft"]'
set_key compaction.thresholdTokens 48000
set_key compaction.keepRecentTokens 20000
set_key compaction.midTurnEnabled true
set_key title.refreshOnReplan false
set_key provider.appendOnlyContext on
set_key tools.artifactSpillThreshold 10
set_key tools.artifactHeadBytes 10
set_key tools.artifactTailBytes 10
set_key defaultThinkingLevel low
set_key providers.maxInFlightRequests '{"strata":1}'

echo "extensions load on the next omp start"
