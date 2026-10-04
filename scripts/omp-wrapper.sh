#!/bin/bash
# imagelxc entrypoint. `omp update` pulls jaylfc/omp-strata.
# Every other command is the upstream binary.
if [[ "${1:-}" == "update" ]]; then
  exec /home/jay/src/omp-strata/scripts/self-update.sh
fi
exec /opt/host-omp/omp "$@"
