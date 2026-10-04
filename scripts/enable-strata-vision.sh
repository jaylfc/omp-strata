#!/usr/bin/env bash
# Turn images on for a local Strata Coder server.
# A 12 GB GPU keeps the coder's expert cache if the encoder is loaded first
# and the engine reserves 700 MiB. Text is a few percent slower.
# A running server keeps the old process until you pass --restart.
set -euo pipefail

restart=0
if [[ "${1:-}" == "--restart" ]]; then
  restart=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: enable-strata-vision.sh [--restart]" >&2
  exit 2
fi

strata="${STRATA_DIR:-$HOME/Strata}"
if [[ ! -f "$strata/setup.py" ]]; then
  echo "enable-strata-vision: no Strata checkout at $strata (set STRATA_DIR)" >&2
  exit 1
fi

cfg="$strata/strata-coder-iq1_m.json"
if [[ ! -f "$cfg" ]]; then
  echo "enable-strata-vision: $cfg is missing. Install the coder pack first (family coder, IQ1_M)." >&2
  exit 1
fi

# Same pin as Strata setup.py HF_REVISIONS for the coder repo (2026-09-29).
mmproj_url="https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF/resolve/5348543e0147355ac9cbcb031184a3546350988e/mmproj-Qwen3.8-Flash-Next-BF16.gguf"
mmproj_name="mmproj-Qwen3.8-Flash-Next-BF16.gguf"

data_dir="$(python3 - "$strata" <<'PY'
import json, os, sys
from pathlib import Path
strata = Path(sys.argv[1])
xdg = os.environ.get("XDG_CONFIG_HOME")
settings = Path(xdg) / "strata" / "settings.json" if xdg else Path.home() / ".config" / "strata" / "settings.json"
if settings.is_file():
    raw = json.loads(settings.read_text())
    if raw.get("data_dir"):
        print(raw["data_dir"])
        raise SystemExit
sibling = strata.parent / "Strata-data"
print(sibling if sibling.is_dir() else strata.parent / "Strata-data")
PY
)"
mkdir -p "$data_dir/models"
mmproj="$data_dir/models/$mmproj_name"
if [[ ! -s "$mmproj" ]]; then
  echo "downloading $mmproj_name"
  curl -L --fail --retry 3 -o "$mmproj.part" "$mmproj_url"
  mv "$mmproj.part" "$mmproj"
fi
echo "vision encoder weights: $mmproj"

vision_bin="$strata/engine/strata-vision"
if [[ ! -x "$vision_bin" ]]; then
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "enable-strata-vision: nvidia-smi is missing, so the GPU encoder cannot be built" >&2
    exit 1
  fi
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d ' ')"
  arch="${cap//./}"
  echo "compiling strata-vision for sm_${arch} (once, often 10-20 minutes)"
  (
    cd "$strata"
    .venv/bin/python -c '
import setup, sys
arch = int(sys.argv[1])
setup.build_engine({"arch": arch, "archs": [arch]}, "gpu", True, setup.get_llama_cpp())
' "$arch"
  )
fi
if [[ ! -x "$vision_bin" ]]; then
  echo "enable-strata-vision: $vision_bin was not produced" >&2
  exit 1
fi
echo "vision encoder: $vision_bin"

python3 - "$cfg" "$vision_bin" "$mmproj" <<'PY'
import json, sys
from pathlib import Path
cfg_path, vision_bin, mmproj = sys.argv[1:]
cfg = json.loads(Path(cfg_path).read_text())
args = cfg.get("args")
if not isinstance(args, list):
    raise SystemExit(f"{cfg_path} has no args list")
native = None
if "--native" in args:
    native = args[args.index("--native") + 1]
if not native:
    raise SystemExit(f"{cfg_path} has no --native model shard")
if "--vision" not in args:
    args += ["--vision"]
if "--vram-reserve-mib" not in args:
    args += ["--vram-reserve-mib", "700"]
else:
    i = args.index("--vram-reserve-mib") + 1
    if i < len(args) and args[i].isdigit() and int(args[i]) < 700:
        args[i] = "700"
cfg["vision"] = {
    "exe": vision_bin,
    "mmproj": mmproj,
    "model": native,
    "gpu": True,
    "max_tokens": 1024,
}
tmp = Path(cfg_path + ".tmp")
tmp.write_text(json.dumps(cfg, indent=1) + "\n")
tmp.replace(cfg_path)
print(f"images on in {cfg_path} (700 MiB reserved)")
PY

if [[ "$restart" -eq 0 ]]; then
  echo "A server that is already running still has images off. Rerun with --restart after it is idle."
  exit 0
fi

bash "$(dirname "$0")/restart-strata.sh" "$cfg"
