#!/usr/bin/env bash
# Pause or resume an omp-strata goal without aborting the step that is running.
#
#   scripts/omp-pause.sh pause [--timeout SECONDS]   (default 900)
#   scripts/omp-pause.sh resume
#   scripts/omp-pause.sh status
#
# pause:
#   1. Creates ~/.config/omp-strata/pause-requested. The operator-pause extension
#      then refuses the next tool call and asks the model for a short status.
#   2. Types `/goal pause` into the omp screen session.
#   3. Waits until omp is idle and paused, then removes the file.
#   It never presses Esc. If omp is still busy at the timeout, the file is removed
#   and the script exits 1 so the caller can decide what to do.
# resume: removes the file if present, then types `/goal resume`.
#
# Set OMP_STRATA_CONTAINER (default: imagelxc; "none" runs on this machine) and
# OMP_STRATA_SCREEN (default: omp) for other setups.
set -euo pipefail

cmd="${1:-status}"; shift || true
timeout=900
if [[ "${1:-}" == "--timeout" ]]; then timeout="${2:?--timeout needs seconds}"; fi
if ! [[ "$timeout" =~ ^[1-9][0-9]*$ ]]; then echo "--timeout must be a positive whole number of seconds" >&2; exit 2; fi
container="${OMP_STRATA_CONTAINER:-imagelxc}"
screen_name="${OMP_STRATA_SCREEN:-omp}"
uid="${OMP_STRATA_UID:-1000}"
if [[ "$container" != none ]]; then
  # The omp user's home inside the container, so the pause file lands where the extension looks.
  home="$(sudo -n incus exec "$container" -- getent passwd "$uid" | cut -d: -f6)"
  [[ -n "$home" ]] || { echo "no user $uid in container $container" >&2; exit 2; }
fi

run() {  # run a bash snippet as the omp user, in the container or here
  if [[ "$container" == none ]]; then
    bash -c "$1"
  else
    sudo -n incus exec "$container" --user "$uid" --group "$uid" --env HOME="$home" -- bash -c "$1"
  fi
}

flag='${XDG_CONFIG_HOME:-$HOME/.config}/omp-strata/pause-requested'

type_line() {  # paste one line into the screen session and press Enter twice
  local text="$1" name
  name="/tmp/omp-strata-cmd-$$-$RANDOM.txt"
  run "printf '%s' '$text' > $name && screen -S $screen_name -X readbuf $name && screen -S $screen_name -X paste . && rm -f $name"
  run "screen -S $screen_name -X stuff \$'\\r'"
  sleep 2
  run "screen -S $screen_name -X stuff \$'\\r'"
}

state() {  # prints "idle" or "busy", and "paused" or "goal" or "none"
  run "f=\$(mktemp); screen -S $screen_name -X hardcopy \$f; s=\$(grep -E '> \\[' \$f | tail -1); rm -f \$f
       case \"\$s\" in *'pi >'*) a=idle ;; *) a=busy ;; esac
       case \"\$s\" in *'|| Goal'*) b=paused ;; *Goal*) b=goal ;; *) b=none ;; esac
       echo \"\$a \$b\""
}

case "$cmd" in
  pause)
    # Never leave the pause file behind: an interrupted script would otherwise keep refusing every tool call.
    trap 'run "rm -f $flag" || true; exit 130' INT TERM
    run "mkdir -p \"\$(dirname $flag)\" && touch $flag"
    type_line "/goal pause"
    end=$((SECONDS + timeout))
    while (( SECONDS < end )); do
      read -r activity goal < <(state)
      if [[ "$activity" == idle && "$goal" != goal ]]; then
        run "rm -f $flag"
        echo "paused cleanly ($activity, $goal) after $((SECONDS)) s"
        exit 0
      fi
      sleep 5
    done
    run "rm -f $flag"
    echo "omp still busy after ${timeout}s; pause file removed, nothing aborted" >&2
    exit 1
    ;;
  resume)
    run "rm -f $flag"
    type_line "/goal resume"
    sleep 5
    state
    ;;
  status)
    state
    run "test -f $flag && echo 'pause requested' || true"
    ;;
  *)
    echo "usage: $0 pause [--timeout SECONDS] | resume | status" >&2
    exit 2
    ;;
esac
