# Upstream pin

tested_omp: 18.4.4
upstream_latest_seen: v18.6.0
upstream_latest_seen_at: 2026-10-04
pr_14312_state: OPEN
pr_14312_head: cbef7c5a5258062eb88d7704613aefdd808c2892

The profile was run on upstream omp 18.4.4. The daily check records the newest can1357/oh-my-pi release tag and the head of PR 14312. It may rewrite the four `upstream_latest_seen`, `upstream_latest_seen_at`, `pr_14312_state`, and `pr_14312_head` lines. `tested_omp` changes when that version has actually been run with this profile.

v18.6.0 (2026-10-03) parses DeepSeek DSML tool calls from local servers, including llama.cpp and other OpenAI-compatible hosts. The Strata model in use here is Qwen3.8-Flash-Next. The installed binary stays on 18.4.4 until that newer build is tried on purpose.

PR 14312 is the upstream failure block: https://github.com/can1357/oh-my-pi/pull/14312. The extension in this repo blocks the next identical call after 3 uses, including successes and mixed results, refuses `completion()` on the coder, and pins subagents to the side model. Those stay while the running binary is 18.4.4. After a release contains the failure block, the fail half of the extension can come out. The success block, the completion block, and the subagent pin stay until upstream has them.
