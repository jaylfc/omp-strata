#!/usr/bin/env bash
# SIGTERM the running omp-strata session and start it again with --continue in
# a detached screen, in the directory it was running in. omp is usually the
# screen window's own process, so the old screen exits with it and there is no
# shell left to type into. Reattach with `screen -r <name>`. Does not send
# /goal resume.
set -euo pipefail

session=()
for dir in /proc/[0-9]*; do
  cmd="$(tr '\0' ' ' <"$dir/cmdline" 2>/dev/null)" || continue
  [[ "$cmd" == *"--profile=omp-strata"* && "$cmd" != *__omp_worker* ]] || continue
  session+=("${dir#/proc/}")
done

if (( ${#session[@]} == 0 )); then
  echo "no omp-strata session"
  exit 0
fi
if (( ${#session[@]} > 1 )); then
  echo "more than one omp-strata session (${session[*]}); not restarting" >&2
  exit 1
fi

pid="${session[0]}"
cwd="$(readlink "/proc/$pid/cwd")"
parent="$(awk '{print $4}' "/proc/$pid/stat")"

# Reuse the screen name when the session runs as `screen -S <name> ...`.
name=omp
if [[ "$(cat "/proc/$parent/comm" 2>/dev/null)" =~ ^(screen|SCREEN)$ ]]; then
  mapfile -d '' args <"/proc/$parent/cmdline"
  for ((i = 1; i < ${#args[@]} - 1; i++)); do
    if [[ "${args[i]}" =~ ^-[a-zA-Z]*S$ ]]; then
      name="${args[i + 1]}"
      break
    fi
  done
fi
echo "omp ${pid} in ${cwd}, screen ${name}"

kill -TERM "$pid"
for _ in $(seq 150); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then
  echo "omp ${pid} still alive after 30s; not relaunching" >&2
  exit 1
fi
# Let the old screen exit so `screen -r <name>` is not ambiguous.
for _ in $(seq 25); do
  kill -0 "$parent" 2>/dev/null || break
  sleep 0.2
done

screen -dmS "$name" bash -lc "cd $(printf '%q' "$cwd") && exec omp-strata --continue --auto-approve --no-title"
echo "relaunched in screen ${name}"
