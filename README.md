# omp-strata

Profile for [oh-my-pi](https://github.com/can1357/oh-my-pi) pointed at one local [Strata](https://github.com/Niko1221/Strata) server. Install the upstream `omp` binary, then apply this profile on top. The running agent keeps using that upstream binary. This repo is not a second client fork. The only upstream code change is [oh-my-pi PR 14312](https://github.com/can1357/oh-my-pi/pull/14312), and that PR is only the generic identical-failure block at ten.

Tested on omp 18.4.4 with `qwen3.8-flash-next-coder-iq1_m`, a 262144 context, and one request in flight. Upstream is ahead of that pin. See [UPSTREAM.md](UPSTREAM.md).

## Updates come from this repo

The running profile is this repository. imagelxc pulls `https://github.com/jaylfc/omp-strata.git` and `scripts/apply.sh` replaces `models.yml`, `RULES.md`, the extension, and the mac-mini skill, then merges `agent/strata.config.yml`. A new commit restarts the session omp with `--continue`. It does not send `/goal resume`.

`startup.checkUpdate` is false, so the omp binary does not offer upgrades from `can1357/oh-my-pi`. In imagelxc, `omp update` is the wrapper in `scripts/omp-wrapper.sh` and runs `scripts/self-update.sh`. The host timer `omp-strata-update.timer` runs `scripts/host-self-update.sh` hourly. The omp program itself stays the tested upstream binary. [UPSTREAM.md](UPSTREAM.md) only records that upstream tag. It does not install it.

RTK's generated `extensions/rtk.ts` is not in this repo. `rtk init` writes it, and a later RTK release replaces it.

## Why these changes exist

Strata here serves one request at a time and keeps one prompt-cache prefix. The log line is `prompt N tokens = R reused + M read in M ms`. A different request in the middle (a subagent on the same server, a title, a judge call, a compaction handoff) makes the next coder turn cold. Decode is about 17–25 tokens/s. A cold prefill of 100k–160k tokens has taken minutes. Repeated identical tool calls cost the same.

The coder stays the main model. Anything that is not the goal turn goes to a second provider when one is configured, so the coder's prefix stays put.

## Every setting

| Piece | Value | Why |
| --- | --- | --- |
| Provider id | `strata` | omp 18.2.7 and newer reserves the provider id `local` for tiny on-device models. |
| `baseUrl` | `http://127.0.0.1:18080/v1` | Inside imagelxc the Incus proxy listens on 18080 and connects to host Strata on `127.0.0.1:8080`. Strata itself still listens on the host port only. |
| `api` / `auth` | `openai-completions`, `auth: none` | Matches the local server. `auth: none` still counts as a configured credential, so omp will actually call it. |
| `compat.qwenTemplateReasoningEffort` | `true` | Sends `reasoning_effort` for this Qwen server. Paired with `defaultThinkingLevel: low`. |
| Coder `input` | `[text]` | This quant does not accept images. Tool images are omitted from the coder request. |
| Coder `contextWindow` | `262144` | The server is started with `--max-context 262144`. |
| Coder `maxTokens` | `4096` | Measured generations on this model stopped on their own, largest well under 4096. Raising the cap does not speed the loop. |
| `providers.maxInFlightRequests.strata` | `1` | A second in-flight call on this server is the thing that drops the prefix. |
| `title.refreshOnReplan` | `false` | A title call is another request. Also launch with `--no-title`. |
| `provider.appendOnlyContext` | `on` | New turns append to the cached prefix instead of rewriting it. A healthy turn then reads a few dozen new tokens. |
| Compaction method | `shake`, then `handoff`, then `soft` | Shake drops recoverable tool output and makes no model call. It only commits when the remainder is under the threshold. Handoff is the model summary. Soft is the local fallback. |
| `compaction.thresholdTokens` | `32000` | Compact before the prompt is large enough for a multi-minute cold prefill. 32000 also fits a handoff inside Bonsai's loaded 41472 context. |
| `compaction.keepRecentTokens` | `20000` | The recent tail stays verbatim. The summary replaces what is older. |
| `compaction.midTurnEnabled` | `true` | Compaction can run in the middle of a turn, so a long tool loop does not wait for the turn to end. |
| `compaction.asyncEnabled` | `true` | Summarize in the background. The summary overlaps the coder turn because it uses the Mac provider. `maxInFlightRequests` is 1 for both `strata` and `mac`. |
| Artifact spill | `tools.artifactSpillThreshold`, `artifactHeadBytes`, `artifactTailBytes` all `10` | These are kilobytes. Large tool output leaves the prompt. The head and tail that remain are short. |
| `defaultThinkingLevel` | `low` | Less thinking text on every coder turn. |
| `RULES.md` | caveman lite, ponytail lite, and the vision paragraph | Re-sent every turn, so it stays short. Code, commands, paths, numbers, and error strings stay verbatim. |
| Repeated calls | extension, after 3 identical arguments | The next identical call is refused whether the earlier calls failed, succeeded, or mixed. A pure failure streak tells the model to determine why, and includes the oldest failure text. A text turn does not reset the counter. `wait`, `job`, `irc`, `yield`, `todo`, and `goal` may repeat. The signature ignores `i` and `__intent`. |
| `completion()` | refused | That eval helper calls the coder and replaces the prefix. |
| `judge()` | allowed | It uses `modelRoles.judge`. With no judge role configured, the call errors; the 3-repeat block then stops a retry loop. |
| Subagents | pinned or refused | See the side-model section. |
| RTK 0.51.0 | installed by `rtk init`, not vendored | Strips shell noise from context. omp needs `rtk` on `PATH` (0.23.0 or newer). |
| Prompt cache | left on | `--prompt-cache 0`, `--adapt-swaps 0`, and `--pcie-frac 0` disable it. This profile does not do that. |

Personal theme, symbol preset, and setup version are not part of the profile. `apply.sh` merges keys and leaves those alone.

## Side model

`agent/models.yml` includes the side provider. Its base URL is the Mac mini LM Studio on the tailnet, `http://100.123.160.60:1234/v1`, model `prism-ml/bonsai-27b`. Point these roles at `mac/prism-ml/bonsai-27b`:

| Role | What it takes off the coder |
| --- | --- |
| `modelRoles.vision` | `read <path>?q=<question>`, and text descriptions of images attached to a non-vision model. `images.describeForTextModels` already defaults on. |
| `modelRoles.judge` | `judge()` and `judgeBatch()`. |
| `modelRoles.task` | The bundled task agent (`@task`). |
| `modelRoles.smol` | Skill compression and other small calls that would otherwise look for a tiny model and then fall back toward the coder. |
| Coder `compactionModel` | The handoff summary. |

`SIDE_MODEL` at the top of `agent/extensions/fail-loop-resteer.ts` is `mac/prism-ml/bonsai-27b`. Every subagent, including eval `agent()`, is pinned to that selector. Set `SIDE_MODEL` to `""` to refuse subagents instead, which is the right sample behavior when the second provider does not exist. `apply.sh` overwrites the extension, so the constant in this repo is the one that will be installed.

On the Mac mini this profile was exercised with, LM Studio serves `prism-ml/bonsai-27b` (MLX, 2-bit, vision). Two server facts decide the omp entry:

- omp sends images as WebP data URLs. LM Studio answers `400 'url' field must be a base64 encoded image` for those. Set `imageInputDecoder: stb` on the model so omp re-encodes to PNG or JPEG first. A direct HTTP call must send `data:image/png;base64,...`.
- The model thinks unless the request sets `reasoning_effort` to `none`. Thinking can spend the whole `max_tokens` budget and return empty content. Set `compat.extraBody.reasoning_effort: none`. Use `max_tokens` of at least 1500 for a direct call. A verified PNG description with that flag returned in a few seconds.

LM Studio kept this MLX model at context 41472 even when asked for 65536 or 131072. Set the model's `contextWindow` to the loaded context, not the catalog maximum. A handoff prompt has to fit in that window minus `maxTokens`. With `maxTokens: 4096`, the live threshold is 32000 so the summary still fits. Leave `compactionModel` unset when the side model cannot hold a prompt near the threshold; omp would otherwise try it, fail, and fall back to the coder.

`providers.maxInFlightRequests` for the side provider is `1` on that machine so a vision call, a subagent, and a handoff queue on the Mac instead of loading the 27B model twice. The coder's slot stays separate, so one Mac call can overlap one coder turn.

The `mac-mini` skill tells the agent which call to use. `RULES.md` stays the short always-on reminder. A machine-specific `RULES.md` can name the model; `apply.sh` will not overwrite an existing rules file.

## What this profile does not change

- The installed omp binary. PR 14312 blocks the same failing tool call at ten and tells the model to determine why. This profile blocks at three, covers successes and mixed repeats, blocks `completion()`, and pins or refuses subagents. Those extras stay here.
- Strata's listen address. It stays on `127.0.0.1:8080`.
- The coder output cap, unless a measured generation is cut off at 4096.
- The goal session. Extensions load at process start. Pickup is `/goal pause`, exit, `omp --continue --auto-approve --no-title`, then `/goal resume` on the same goal.

## Install

1. Install upstream omp. This profile was tested on 18.4.4.
2. Point Strata's OpenAI server at the machine where omp runs. This repo's `agent/models.yml` uses the imagelxc proxy, `http://127.0.0.1:18080/v1`.
3. Apply the profile:

```bash
git clone https://github.com/jaylfc/omp-strata.git
cd omp-strata
bash scripts/apply.sh
```

`apply.sh` installs the extension, the `mac-mini` skill, `RULES.md`, and `models.yml` from this repo, and merges the keys in `agent/strata.config.yml` with `omp config set`. Theme keys already in `config.yml` stay. A later `git pull` of this repo is what updates a running install.

4. Install RTK 0.51.0 and let it write its extension.

```bash
# https://github.com/rtk-ai/rtk/releases/tag/v0.51.0
rtk init --agent omp --global --auto-patch
```

5. Add the side provider and the four role keys when that model is up. Match `contextWindow` to the loaded context.
6. Start omp again.

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
agent/skills/mac-mini/SKILL.md           when to use the side model
agent/extensions/fail-loop-resteer.ts    loop re-steer, completion block, subagent pin
scripts/apply.sh                         install into ~/.omp/agent
scripts/self-update.sh                   pull this repo inside imagelxc and apply it
scripts/host-self-update.sh              hourly host entry, runs the apply in imagelxc
scripts/omp-wrapper.sh                   `omp update` pulls this repo
scripts/restart-session.sh               relaunch the session omp after a new commit
scripts/systemd/                         user timer for the hourly pull
scripts/check-upstream.sh                compare the pin with upstream
UPSTREAM.md                              tested omp, latest release, PR 14312
```
