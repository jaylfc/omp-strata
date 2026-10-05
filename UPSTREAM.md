# Upstream pin

tested_omp: 18.4.4
upstream_latest_seen: v18.6.1
upstream_latest_seen_at: 2026-10-04

The profile was run on upstream omp 18.4.4. The daily check records the newest can1357/oh-my-pi release tag. It may rewrite the two `upstream_latest_seen` and `upstream_latest_seen_at` lines. `tested_omp` changes when that version has actually been run with this profile.

v18.6.0 (2026-10-03) parses DeepSeek DSML tool calls from local servers, including llama.cpp and other OpenAI-compatible hosts. The Strata model in use here is Qwen3.8-Flash-Next. The installed binary stays on 18.4.4 until that newer build is tried on purpose.

omp runs unmodified. Loop handling lives only in this profile's extension: it blocks the next identical call after 3 uses, including successes and mixed results, refuses `completion()` on the coder, and pins subagents to the side model. An earlier upstream PR for a generic failure block (can1357/oh-my-pi#14312) was withdrawn on 2026-10-05; its review findings were applied to the extension instead.
