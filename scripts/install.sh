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

if [[ -x /opt/host-omp/omp ]] && sudo -n true 2>/dev/null; then
  sudo -n ln -sfn "$root/bin/omp-strata" /usr/local/bin/omp-strata
  echo "linked /usr/local/bin/omp-strata"
  if [[ -f /usr/local/bin/omp ]] && grep -q 'self-update.sh' /usr/local/bin/omp; then
    sudo -n ln -sfn /opt/host-omp/omp /usr/local/bin/omp
    echo "restored /usr/local/bin/omp -> /opt/host-omp/omp"
  fi
fi
