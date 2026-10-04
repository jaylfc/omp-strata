# omp-strata

Profile for [oh-my-pi](https://github.com/can1357/oh-my-pi) pointed at one local [Strata](https://github.com/Niko1221/Strata) server. Install the upstream `omp` binary, then apply this profile on top. The running agent keeps using that upstream binary.

Tested on omp 18.4.4 with `qwen3.8-flash-next-coder-iq1_m`, a 262144 context, and one request in flight. Upstream is ahead of that pin. See [UPSTREAM.md](UPSTREAM.md).

## What this tunes

Strata here serves one request at a time and keeps one prompt-cache prefix. A second call (a subagent, a title, a compaction handoff that lands in the middle of other work) makes the next turn cold. Decode is slow, so repeated identical tool calls and large tool transcripts cost minutes.

| Piece | Setting | Why |
| --- | --- | --- |
| One request | `providers.maxInFlightRequests.strata: 1` | Matches the server. |
| No subagent | `task` is blocked by the extension | A subagent replaces the prompt the goal is in the middle of. |
| No title call | `title.refreshOnReplan: false`, launch with `--no-title` | Title generation is another request on the only server. |
| Early compaction | shake, then handoff, then soft, at 48000 tokens, mid-turn on | Shake drops recoverable tool output with no model call. The handoff runs before the prompt is huge. |
| Growing prefix | `provider.appendOnlyContext: on` | Keeps the cached prefix stable. |
| Short transcripts | artifact spill, head, and tail at 10 KB | Large tool output leaves the prompt. |
| Short thinking | `defaultThinkingLevel: low` and `compat.qwenTemplateReasoningEffort: true` | Asks the server for low reasoning effort. |
| Output cap | `maxTokens: 4096` | Enough for the turns measured on this model. |
| Terse replies | `RULES.md` | Short always-on rules. Code, commands, paths, numbers, and error strings stay verbatim. |
| Repeated calls | extension, after 10 identical failures or 10 identical successes | The goal stays active. The next identical call is refused and the model is told to continue that goal with a different action. |
| Shell noise | [RTK](https://github.com/rtk-ai/rtk) 0.51.0 | `rtk init` installs its own extension. This repo does not vendor that generated file. |

`wait`, `job`, `irc`, `yield`, `todo`, and `goal` may repeat. The provider name stays `strata`.

The failure block is also proposed upstream in [oh-my-pi PR 14312](https://github.com/can1357/oh-my-pi/pull/14312). The success block and the `task` block live in this profile.

## Install

1. Install upstream omp. This profile was tested on 18.4.4.
2. Point Strata's OpenAI server at the machine where omp runs. The sample `agent/models.yml` uses `http://127.0.0.1:8080/v1`. A container that reaches a host server through a forwarded port uses that forwarded port instead (18080 in one imagelxc setup).
3. Apply the profile:

```bash
git clone https://github.com/jaylfc/omp-strata.git
cd omp-strata
bash scripts/apply.sh
```

`apply.sh` installs the extension, copies `RULES.md` and `models.yml` when those files are absent, and merges the keys in `agent/strata.config.yml` with `omp config set`. An existing `models.yml` or `RULES.md` is left alone.

4. Install RTK 0.51.0 and let it write its extension. omp needs `rtk` on `PATH` (0.23.0 or newer).

```bash
# https://github.com/rtk-ai/rtk/releases/tag/v0.51.0
rtk init --agent omp --global --auto-patch
```

5. Start omp again. Extensions load at process start. For a goal already in progress: `/goal pause`, restart, then `/goal resume` on the same session.

```bash
omp --continue --auto-approve --no-title
```

## Daily upstream check

`.github/workflows/upstream-pin.yml` runs every day at 08:17 UTC, and on demand. It compares [UPSTREAM.md](UPSTREAM.md) with the newest can1357/oh-my-pi release and with PR 14312. When the release tag or the PR head has moved, it commits those four lines. It leaves `tested_omp` as recorded, and it does not replace an installed omp binary.

```bash
bash scripts/check-upstream.sh
bash scripts/check-upstream.sh --write
```

## Layout

```
agent/models.yml                         strata provider
agent/strata.config.yml                  keys to merge
agent/RULES.md                           always-on rules
agent/extensions/fail-loop-resteer.ts    loop re-steer and task block
scripts/apply.sh                         install into ~/.omp/agent
scripts/check-upstream.sh                compare the pin with upstream
UPSTREAM.md                              tested omp, latest release, PR 14312
```
