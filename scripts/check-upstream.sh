#!/usr/bin/env bash
# Compare UPSTREAM.md with can1357/oh-my-pi. With --write, refresh the four
# metadata lines when the latest release tag or PR 14312 has moved.
# tested_omp is left as recorded.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

write=0
if [[ "${1:-}" == "--write" ]]; then
  write=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: scripts/check-upstream.sh [--write]" >&2
  exit 1
fi

ghq() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    gh "$@"
  else
    env -u GITHUB_TOKEN -u GH_TOKEN gh "$@"
  fi
}

field() {
  awk -F': ' -v k="$1" '$1 == k { print $2; exit }' UPSTREAM.md
}

tested="$(field tested_omp)"
recorded_tag="$(field upstream_latest_seen)"
recorded_state="$(field pr_14312_state)"
recorded_head="$(field pr_14312_head)"

release_json="$(ghq release view --repo can1357/oh-my-pi --json tagName)"
pr_json="$(ghq pr view 14312 --repo can1357/oh-my-pi --json state,headRefOid)"

eval "$(RELEASE_JSON="$release_json" PR_JSON="$pr_json" python3 - <<'PY'
import json, os, shlex
release = json.loads(os.environ["RELEASE_JSON"])
pr = json.loads(os.environ["PR_JSON"])
print("live_tag=" + shlex.quote(release["tagName"]))
print("live_state=" + shlex.quote(pr["state"]))
print("live_head=" + shlex.quote(pr["headRefOid"]))
PY
)"

seen_at="$(date -u +%Y-%m-%d)"

metadata_stale=no
if [[ "$recorded_tag" != "$live_tag" || "$recorded_state" != "$live_state" || "$recorded_head" != "$live_head" ]]; then
  metadata_stale=yes
fi

tested_behind=no
norm_test="${tested#v}"
norm_live="${live_tag#v}"
older="$(printf '%s\n%s\n' "$norm_test" "$norm_live" | sort -V | head -1)"
if [[ "$norm_test" != "$norm_live" && "$older" == "$norm_test" ]]; then
  tested_behind=yes
fi

status=current
if [[ "$metadata_stale" == yes && "$write" == 1 ]]; then
  LIVE_TAG="$live_tag" LIVE_STATE="$live_state" LIVE_HEAD="$live_head" SEEN_AT="$seen_at" python3 - <<'PY'
import os
from pathlib import Path
repl = {
    "upstream_latest_seen": os.environ["LIVE_TAG"],
    "upstream_latest_seen_at": os.environ["SEEN_AT"],
    "pr_14312_state": os.environ["LIVE_STATE"],
    "pr_14312_head": os.environ["LIVE_HEAD"],
}
path = Path("UPSTREAM.md")
lines = path.read_text().splitlines(keepends=True)
out = []
seen = set()
for line in lines:
    key = line.split(":", 1)[0]
    if key in repl:
        nl = "\n" if line.endswith("\n") else ""
        out.append(f"{key}: {repl[key]}{nl}")
        seen.add(key)
    else:
        out.append(line)
missing = [key for key in repl if key not in seen]
if missing:
    raise SystemExit("UPSTREAM.md is missing: " + ", ".join(missing))
path.write_text("".join(out))
PY
  status=updated
elif [[ "$metadata_stale" == yes ]]; then
  status=stale
fi

printf 'status: %s\n' "$status"
printf 'tested_omp: %s\n' "$tested"
printf 'upstream_latest: %s\n' "$live_tag"
printf 'recorded_latest: %s\n' "$recorded_tag"
printf 'tested_behind: %s\n' "$tested_behind"
printf 'pr_14312_state: %s\n' "$live_state"
printf 'pr_14312_head: %s\n' "$live_head"
printf 'recorded_pr_state: %s\n' "$recorded_state"
printf 'recorded_pr_head: %s\n' "$recorded_head"
printf 'metadata_stale: %s\n' "$metadata_stale"
