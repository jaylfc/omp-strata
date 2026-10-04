# omp-strata

Profile for [oh-my-pi](https://github.com/can1357/oh-my-pi) pointed at one local [Strata](https://github.com/Niko1221/Strata) server. Install the upstream `omp` binary, then apply this profile on top. The running agent keeps using that upstream binary. This repo is not a second client fork. The only upstream code change is [oh-my-pi PR 14312](https://github.com/can1357/oh-my-pi/pull/14312), and that PR is only the generic identical-failure block at ten.

Tested on omp 18.4.4 with `qwen3.8-flash-next-coder-iq1_m`, a 262144 context, and one request in flight. Upstream is ahead of that pin. See [UPSTREAM.md](UPSTREAM.md).

## Updates come from this repo

The running profile is this repository. `scripts/apply.sh` installs it into `~/.omp/profiles/omp-strata`, then merges `agent/strata.config.yml`. Inside imagelxc, a new commit that changes `agent/` or `bin/` restarts a running `omp-strata` session with `--continue`, in the directory it was running in, in a detached `screen` with the same name (reattach with `screen -r omp`). Commits that touch only docs, such as the daily `UPSTREAM.md` pin, leave the session running. It does not send `/goal resume`, so a goal session restarts paused.

`omp` stays the upstream command and keeps using `~/.omp/agent`. `omp-strata` is `omp --profile=omp-strata` with this profile. `omp-strata update` pulls this repo. `omp update` stays the upstream updater.

`startup.checkUpdate` is false on the profile, so `omp-strata` does not offer upgrades from `can1357/oh-my-pi`. The host timer `omp-strata-update.timer` runs `scripts/host-self-update.sh` hourly inside imagelxc. The omp program itself stays the tested upstream binary. [UPSTREAM.md](UPSTREAM.md) only records that upstream tag. It does not install it.

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
| `compat.qwenTemplateReasoningEffort` plus `extraBody.reasoning_effort: none` | coder thinking off | `low` still spent the 4096 output budget on empty thinking. `extraBody` is applied after the template value, so `none` wins. The model entry is `reasoning: false`. |
| Coder `input` | `[text]` | This quant does not accept images. Tool images are omitted from the coder request. |
| Coder `contextWindow` | `262144` | The server is started with `--max-context 262144`. |
| Coder `maxTokens` | `4096` | Measured generations on this model stopped on their own, largest well under 4096. Raising the cap does not speed the loop. |
| `providers.maxInFlightRequests.strata` | `1` | A second in-flight call on this server is the thing that drops the prefix. |
| `title.refreshOnReplan` | `false` | A title call is another request. Also launch with `--no-title`. |
| `provider.appendOnlyContext` | `on` | New turns append to the cached prefix instead of rewriting it. A healthy turn then reads a few dozen new tokens. |
| Compaction method | `shake`, then `handoff`, then `soft` | Shake drops recoverable tool output and makes no model call. It only commits when the remainder is under the threshold. Handoff is the model summary. Soft is the local fallback. |
| `compaction.thresholdTokens` | `65536` | On 2026-10-04 a 32000 threshold handed off four times in half an hour. Each summary took 140–225s on Strata and dropped about 10k tokens. A cached prompt read of 30k tokens took 1–3s, and a cold 25k read took about 25s. 65536 leaves about 45k tokens of room above `keepRecentTokens` and stays under the 100k–160k range where a cold prefill has taken minutes. |
| `compaction.keepRecentTokens` | `20000` | The recent tail stays verbatim. The summary replaces what is older. |
| `compaction.midTurnEnabled` | `true` | Compaction can run in the middle of a turn, so a long tool loop does not wait for the turn to end. |
| `compaction.asyncEnabled` | `true` | A speculative summary can arm before the threshold. A mid-turn handoff that is not already armed still runs inline on the coder. omp 18.4.4 builds that request on the session model's prompt cache. |
| Artifact spill | `tools.artifactSpillThreshold`, `artifactHeadBytes`, `artifactTailBytes` all `10` | These are kilobytes. Large tool output leaves the prompt. The head and tail that remain are short. |
| `defaultThinkingLevel` | `minimal` | Lowest level omp accepts. The provider `extraBody` above is what stops coder thinking on an existing session. |
| `RULES.md` | caveman lite, ponytail lite, and the vision paragraph | Re-sent every turn, so it stays short. Code, commands, paths, numbers, and error strings stay verbatim. |
| Repeated calls | extension, after 3 identical arguments | The next identical call is refused whether the earlier calls failed, succeeded, or mixed. A pure failure streak tells the model to determine why, and includes the oldest failure text. Emitting that same call again aborts the turn. A text turn does not reset the counter, and `--continue` rebuilds it from the session. The extension's own refusals do not count as runs. `wait`, `job`, `irc`, `yield`, `todo`, and `goal` may repeat. The signature ignores `i` and `__intent`. |
| Game probes | 3 per script since the last edit or write | `where.mjs`, `touchprobe.mjs`, `menutest.mjs`, and the other `cinderline/tools/*.mjs` probes share a count even when the shell pipeline changes. `describe.mjs` is refused. Screenshot questions are `read <path>?q=<question>` or one `judge()` call, both on the Mac. |
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
| Coder `compactionModel` | unset | Handoff does not use this field. Bonsai's loaded context is 41472, which cannot hold a prompt near 65536. A set value makes the soft fallback try the Mac, fail, and summarize on the coder anyway. |

`SIDE_MODEL` at the top of `agent/extensions/fail-loop-resteer.ts` is `mac/prism-ml/bonsai-27b`. Every subagent, including eval `agent()`, is pinned to that selector. Set `SIDE_MODEL` to `""` to refuse subagents instead, which is the right sample behavior when the second provider does not exist. `apply.sh` overwrites the extension, so the constant in this repo is the one that will be installed.

On the Mac mini this profile was exercised with, LM Studio serves `prism-ml/bonsai-27b` (MLX, 2-bit, vision). Two server facts decide the omp entry:

- omp sends images as WebP data URLs. LM Studio answers `400 'url' field must be a base64 encoded image` for those. Set `imageInputDecoder: stb` on the model so omp re-encodes to PNG or JPEG first. A direct HTTP call must send `data:image/png;base64,...`.
- The model thinks unless the request sets `reasoning_effort` to `none`. Thinking can spend the whole `max_tokens` budget and return empty content. Set `compat.extraBody.reasoning_effort: none`. Use `max_tokens` of at least 1500 for a direct call. A verified PNG description with that flag returned in a few seconds.

LM Studio kept this MLX model at context 41472 even when asked for 65536 or 131072. Set the model's `contextWindow` to the loaded context, not the catalog maximum. Handoff stays on the coder, so the compaction threshold is not capped by that window. Leave `compactionModel` unset.

`providers.maxInFlightRequests` for the side provider is `1` on that machine so a vision call and a subagent queue on the Mac instead of loading the 27B model twice. The coder's slot stays separate, so one Mac call can overlap one coder turn. Handoff stays on the coder.

The `mac-mini` skill tells the agent which call to use. `RULES.md` stays the short always-on reminder. `apply.sh` replaces `RULES.md` from this repo on every install.

## What this profile does not change

- The installed omp binary. PR 14312 blocks the same failing tool call at ten and tells the model to determine why. This profile blocks at three, covers successes and mixed repeats, blocks `completion()`, and pins or refuses subagents. Those extras stay here.
- Strata's listen address. It stays on `127.0.0.1:8080`.
- The coder output cap, unless a measured generation is cut off at 4096.
- The goal session. Extensions load at process start. Pickup is `/goal pause`, exit, `omp-strata --continue --auto-approve --no-title`, then `/goal resume` on the same goal.

## Install

Install upstream `omp` first. This profile was tested on 18.4.4. Then:

```bash
git clone https://github.com/jaylfc/omp-strata.git
cd omp-strata
bash scripts/install.sh
```

After that:

| Command | What it runs |
| --- | --- |
| `omp` | Upstream omp, state in `~/.omp/agent`. |
| `omp-strata` | `omp --profile=omp-strata`, state in `~/.omp/profiles/omp-strata`. |
| `omp update` | Upstream's own updater. |
| `omp-strata update` | `git pull` of this repo, then `scripts/install.sh`. |

`install.sh` links `bin/omp-strata` into `~/.local/bin`, adds the `omp-strata` shell function to `~/.bashrc`, and runs `apply.sh`. `apply.sh` installs the extension, the `mac-mini` skill, `RULES.md`, and `models.yml`, and merges `agent/strata.config.yml` with `omp --profile=omp-strata config set`. Theme keys already in the profile `config.yml` stay. `strata.config.yml` is the only list of keys; `scripts/config-pairs.py` maps it onto `omp config list --json` and needs PyYAML (`python3-yaml`).

Point Strata's OpenAI server at the machine where omp runs. This repo's `agent/models.yml` uses the imagelxc proxy, `http://127.0.0.1:18080/v1`. On imagelxc the same install restores `/usr/local/bin/omp` to the upstream binary and links `/usr/local/bin/omp-strata`. The first imagelxc install moves the old default `~/.omp/agent` into the profile, because that directory was this profile before the split.

Install RTK 0.51.0 and let it write its extension.

```bash
# https://github.com/rtk-ai/rtk/releases/tag/v0.51.0
rtk init --agent omp --global --auto-patch
```

`agent/models.yml` already names the side provider. Match its `contextWindow` to the loaded context before starting.

Start in the project directory:

```bash
omp-strata --continue --auto-approve --no-title
```

`--continue` uses the session saved for the current directory, so start it in the same directory as the original session.

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
bin/omp-strata                          `omp --profile=omp-strata`; `update` pulls this repo
scripts/install.sh                       link the command, alias it, and apply the profile
scripts/apply.sh                         install into ~/.omp/profiles/omp-strata/agent
scripts/config-pairs.py                  strata.config.yml -> `omp config set` pairs
scripts/migrate-profile.sh               imagelxc one-time move of the old default agent
scripts/self-update.sh                   pull this repo and install it
scripts/host-self-update.sh              hourly host entry, runs the update in imagelxc
scripts/restart-session.sh               relaunch omp-strata in screen after a profile change
scripts/systemd/                         user timer for the hourly pull
scripts/check-upstream.sh                compare the pin with upstream
UPSTREAM.md                              tested omp, latest release, PR 14312
```
