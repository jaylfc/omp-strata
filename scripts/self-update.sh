#!/usr/bin/env bash
# Pull this repo and apply it. Runs inside imagelxc, as the omp user.
# A new commit restarts the running omp session so extensions reload.
set -euo pipefail

if [[ ! -x /opt/host-omp/omp ]]; then
  echo "self-update runs inside imagelxc, where /opt/host-omp/omp exists" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
log="${HOME}/.omp/logs/omp-strata-update.log"
mkdir -p "${HOME}/.omp/logs"
exec >>"$log" 2>&1
echo "----- $(date -u +%Y-%m-%dT%H:%M:%SZ) -----"

cd "$root"
old="$(git rev-parse HEAD)"
git pull --ff-only origin main
new="$(git rev-parse HEAD)"
echo "head ${old} -> ${new}"

if sudo -n true 2>/dev/null; then
  sudo -n chown -R jay:jay "${HOME}/.omp/agent/skills" 2>/dev/null || true
fi

bash "$root/scripts/apply.sh"

if sudo -n true 2>/dev/null; then
  sudo -n cp "$root/scripts/omp-wrapper.sh" /usr/local/bin/omp
  sudo -n chmod 755 /usr/local/bin/omp
  echo "installed /usr/local/bin/omp wrapper"
fi

if [[ "$old" != "$new" ]]; then
  echo "restarting omp so the new profile loads"
  bash "$root/scripts/restart-session.sh"
else
  echo "already current"
fi
