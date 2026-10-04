#!/usr/bin/env bash
# Install the omp-strata command next to an existing upstream omp.
# Stock `omp` keeps ~/.omp/agent. This profile uses ~/.omp/profiles/omp-strata.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/scripts/migrate-profile.sh"
bash "$root/scripts/apply.sh"

mkdir -p "${HOME}/.local/bin"
ln -sfn "$root/bin/omp-strata" "${HOME}/.local/bin/omp-strata"
echo "linked ${HOME}/.local/bin/omp-strata"

bashrc="${HOME}/.bashrc"
touch "$bashrc"
python3 - "$bashrc" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
begin = "# >>> omp profile alias: omp-strata >>>"
end = "# <<< omp profile alias: omp-strata <<<"
block = """# >>> omp profile alias: omp-strata >>>
omp-strata() {
  if [[ "${1:-}" == "update" ]]; then
    local bin
    bin="$(type -P omp-strata || true)"
    if [[ -n "$bin" ]]; then
      command "$bin" update
      return
    fi
    echo "omp-strata update needs the omp-strata command on PATH" >&2
    return 1
  fi
  command omp --profile=omp-strata "$@"
}
# <<< omp profile alias: omp-strata <<<
"""
text = path.read_text() if path.exists() else ""
if begin in text and end in text:
    pre, rest = text.split(begin, 1)
    _, post = rest.split(end, 1)
    text = pre.rstrip() + "\n\n" + block + post.lstrip("\n")
else:
    if text and not text.endswith("\n"):
        text += "\n"
    text += "\n" + block + "\n"
path.write_text(text)
print(f"alias omp-strata in {path}")
PY

# webcheck: one-command real-browser page check for the coder (tools/webcheck).
if command -v npm >/dev/null 2>&1; then
  if (cd "$root/tools/webcheck" && timeout 600 npm install --silent --no-audit --no-fund >/dev/null); then
    chmod +x "$root/tools/webcheck/webcheck.mjs"
    ln -sfn "$root/tools/webcheck/webcheck.mjs" "${HOME}/.local/bin/webcheck"
    echo "linked ${HOME}/.local/bin/webcheck"
  else
    echo "webcheck was not installed: npm install failed in tools/webcheck"
  fi
else
  echo "webcheck needs Node.js and npm; install them, then rerun scripts/install.sh"
fi

if [[ -x /opt/host-omp/omp ]] && sudo -n true 2>/dev/null; then
  sudo -n ln -sfn "$root/bin/omp-strata" /usr/local/bin/omp-strata
  echo "linked /usr/local/bin/omp-strata"
  if [[ -e "$root/tools/webcheck/node_modules" ]]; then
    sudo -n ln -sfn "$root/tools/webcheck/webcheck.mjs" /usr/local/bin/webcheck
    echo "linked /usr/local/bin/webcheck"
  fi
  if [[ -f /usr/local/bin/omp ]] && grep -q 'self-update.sh' /usr/local/bin/omp; then
    sudo -n ln -sfn /opt/host-omp/omp /usr/local/bin/omp
    echo "restored /usr/local/bin/omp -> /opt/host-omp/omp"
  fi
fi

strata_dir="${STRATA_DIR:-$HOME/Strata}"
settings="${XDG_CONFIG_HOME:-$HOME/.config}/omp-strata/settings.env"
if [[ -f "$settings" ]] && grep -qx "STRATA_VISION=off" "$settings"; then
  echo "Strata vision is off ($settings); images go to the model set there"
elif [[ -f "$strata_dir/setup.py" ]]; then
  if ! bash "$root/scripts/enable-strata-vision.sh"; then
    echo "Strata vision was not enabled. The omp profile is installed. Rerun scripts/enable-strata-vision.sh"
  fi
else
  echo "No Strata checkout at $strata_dir. After the coder is installed, run scripts/enable-strata-vision.sh"
fi
