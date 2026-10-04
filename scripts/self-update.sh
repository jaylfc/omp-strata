#!/usr/bin/env bash
# Pull this repo and apply the omp-strata profile.
# Inside imagelxc, a new commit that changes agent/ or bin/ restarts a running
# omp-strata session. Doc-only commits, such as the daily UPSTREAM.md pin, do
# not. It does not send /goal resume.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/scripts/migrate-profile.sh"
mkdir -p "${HOME}/.omp/profiles/omp-strata/logs"
log="${HOME}/.omp/profiles/omp-strata/logs/omp-strata-update.log"
if [[ -t 1 ]]; then
  exec > >(tee -a "$log") 2>&1
else
  exec >>"$log" 2>&1
fi
echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) -----"

cd "$root"
old="$(git rev-parse HEAD)"
git pull --ff-only origin main
new="$(git rev-parse HEAD)"
echo "head ${old} -> ${new}"

if sudo -n true 2>/dev/null; then
  sudo -n chown -R "$(id -un):$(id -gn)" "${HOME}/.omp/profiles/omp-strata/agent/skills" 2>/dev/null || true
fi

bash "$root/scripts/install.sh"

if [[ "$old" == "$new" ]]; then
  echo "already current"
elif [[ -z "$(git diff --name-only "$old" "$new" -- agent bin)" ]]; then
  echo "updated ${old} -> ${new}; no profile files changed, session left running"
elif [[ -x /opt/host-omp/omp ]]; then
  echo "restarting omp-strata so the new profile loads"
  bash "$root/scripts/restart-session.sh"
else
  echo "updated ${old} -> ${new}"
fi
