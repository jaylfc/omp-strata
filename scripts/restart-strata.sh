#!/usr/bin/env bash
# Restart the Strata server that runs with the given config, with the same
# command line, working directory, and log. Used after the config changes.
#   restart-strata.sh /path/to/strata-coder-iq1_m.json
set -euo pipefail

cfg="${1:?usage: restart-strata.sh <strata config json>}"
mapfile -t pids < <(ps -eo pid,cmd | awk -v cfg="$cfg" 'index($0, "serve/server.py") && index($0, cfg) && $1 ~ /^[0-9]+$/ {print $1}')
live=()
for pid in "${pids[@]}"; do
  [[ -r "/proc/$pid/cmdline" ]] || continue
  cmd_text="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  [[ "$cmd_text" == *"serve/server.py"* && "$cmd_text" == *"$cfg"* ]] || continue
  live+=("$pid")
done
pids=("${live[@]}")
if [[ "${#pids[@]}" -eq 0 ]]; then
  echo "no Strata server is using $cfg"
  exit 0
fi
if [[ "${#pids[@]}" -gt 1 ]]; then
  echo "more than one Strata server matches $cfg (${pids[*]}); not restarting" >&2
  exit 1
fi
pid="${pids[0]}"
log="$(readlink "/proc/$pid/fd/1" 2>/dev/null || true)"
if [[ -z "$log" || "$log" == /dev/* ]]; then
  log="/tmp/strata-coder.log"
fi
mapfile -d '' cmd < "/proc/$pid/cmdline"
if [[ -z "${cmd[-1]:-}" ]]; then
  unset 'cmd[-1]'
fi
srv_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || echo /)"
echo "stopping pid $pid; cwd $srv_cwd; log $log"
kill -TERM "$pid" 2>/dev/null || echo "pid $pid had already exited"
for _ in $(seq 150); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then
  echo "pid $pid still alive after 30s; not starting another server" >&2
  exit 1
fi
(
  cd "$srv_cwd"
  nohup "${cmd[@]}" >>"$log" 2>&1 &
  echo "restarted pid $! (cwd $srv_cwd, log $log)"
)
