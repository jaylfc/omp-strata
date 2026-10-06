#!/usr/bin/env bash
# Host side of the hourly update. The apply step runs inside imagelxc so it
# cannot write the host's ~/.omp.
set -euo pipefail

sudo -n incus exec imagelxc --user 1000 --group 1000 --env HOME=/home/jay --cwd /home/jay -- bash -lc '
set -euo pipefail
if [[ ! -d "$HOME/src/omp-strata/.git" ]]; then
  mkdir -p "$HOME/src"
  git clone https://github.com/jaylfc/omp-strata-12gb.git "$HOME/src/omp-strata"
fi
exec "$HOME/src/omp-strata/scripts/self-update.sh"
'
