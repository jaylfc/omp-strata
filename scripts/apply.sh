#!/usr/bin/env bash
# Copy the Strata profile into ~/.omp/agent. This repo is the source of truth:
# models.yml, RULES.md, the extension, and the skill are replaced. Config keys
# are merged with `omp config set`, so a theme already in config.yml stays.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
agent="${HOME}/.omp/agent"
mkdir -p "$agent/extensions" "$agent/skills/mac-mini"

install -m 644 "$root/agent/extensions/fail-loop-resteer.ts" "$agent/extensions/fail-loop-resteer.ts"
echo "installed $agent/extensions/fail-loop-resteer.ts"

install -m 644 "$root/agent/skills/mac-mini/SKILL.md" "$agent/skills/mac-mini/SKILL.md"
echo "installed $agent/skills/mac-mini/SKILL.md"

install -m 644 "$root/agent/RULES.md" "$agent/RULES.md"
echo "installed $agent/RULES.md"

install -m 644 "$root/agent/models.yml" "$agent/models.yml"
echo "installed $agent/models.yml"

if ! command -v omp >/dev/null 2>&1; then
  echo "omp is not on PATH; merge agent/strata.config.yml after omp is installed"
  exit 1
fi

set_key() {
  omp config set "$1" "$2"
  echo "set $1"
}

set_key modelRoles '{"vision":"mac/prism-ml/bonsai-27b","judge":"mac/prism-ml/bonsai-27b","task":"mac/prism-ml/bonsai-27b","smol":"mac/prism-ml/bonsai-27b"}'
set_key compaction.methodOrder '["shake","handoff","soft"]'
set_key compaction.thresholdTokens 32000
set_key compaction.keepRecentTokens 20000
set_key compaction.midTurnEnabled true
set_key compaction.asyncEnabled true
set_key title.refreshOnReplan false
set_key provider.appendOnlyContext on
set_key tools.artifactSpillThreshold 10
set_key tools.artifactHeadBytes 10
set_key tools.artifactTailBytes 10
set_key defaultThinkingLevel low
set_key startup.checkUpdate false
set_key providers.maxInFlightRequests '{"strata":1,"mac":1}'

echo "extensions load on the next omp start"
