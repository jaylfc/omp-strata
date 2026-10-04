#!/usr/bin/env bash
# One-time move of the imagelxc default agent into the omp-strata profile.
# That default directory was this profile before `omp` and `omp-strata` were split.
# Other machines keep ~/.omp/agent for stock omp; apply.sh fills the profile itself.
set -euo pipefail

if [[ ! -x /opt/host-omp/omp ]]; then
  exit 0
fi

profile="${HOME}/.omp/profiles/omp-strata"
mkdir -p "${HOME}/.omp/profiles"

if [[ -d "${HOME}/.omp/agent" && ! -e "${profile}/agent" ]]; then
  mv "${HOME}/.omp/agent" "${profile}/agent"
  echo "moved ~/.omp/agent -> ~/.omp/profiles/omp-strata/agent"
fi

if [[ -d "${HOME}/.omp/logs" && ! -e "${profile}/logs" ]]; then
  mv "${HOME}/.omp/logs" "${profile}/logs"
  echo "moved ~/.omp/logs -> ~/.omp/profiles/omp-strata/logs"
fi
