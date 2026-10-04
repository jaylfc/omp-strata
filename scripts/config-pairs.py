#!/usr/bin/env python3
"""Print `key\\0value\\0` pairs from agent/strata.config.yml for `omp config set`.

argv[1] is the yml, argv[2] is `omp config list --json`. A map such as
modelRoles is emitted whole when omp has no dotted setting below it.
"""
import json
import sys

try:
    import yaml
except ImportError:
    sys.exit("apply.sh needs PyYAML (python3-yaml) to read strata.config.yml")

config = yaml.safe_load(open(sys.argv[1]))
known = set(json.load(open(sys.argv[2])))
out = sys.stdout.buffer


def walk(node, path):
    if path in known:
        value = node if isinstance(node, str) else json.dumps(node)
        out.write(path.encode() + b"\0" + value.encode() + b"\0")
    elif isinstance(node, dict):
        for key, child in node.items():
            walk(child, f"{path}.{key}" if path else key)
    else:
        sys.exit(f"strata.config.yml: omp has no setting {path}")


walk(config, "")
