# omp-strata

Profile for [oh-my-pi](https://github.com/can1357/oh-my-pi) pointed at one local [Strata](https://github.com/Niko1221/Strata) server. Install the upstream `omp` binary, then apply this profile on top. The running agent keeps using that upstream binary. This repo is the guide for that one-machine setup, not a second client fork. The only upstream code change is [oh-my-pi PR 14312](https://github.com/can1357/oh-my-pi/pull/14312), and that PR is only the generic identical-failure block at ten.

The focus is a single card on one machine. Our setup also includes a Mac mini M4 with 24 GB, and we are experimenting with offloading judge calls, subagent chat, and subagent image reviews to it. Coding, handoff, smol, and the main session's screenshot questions stay on the Strata card. An install with no second machine does that work on the card.

Tested on omp 18.4.4 with `qwen3.8-flash-next-coder-iq1_m`, a 262144 context, and one request in flight. Upstream is ahead of that pin. See [UPSTREAM.md](UPSTREAM.md).

## Updates come from this repo

The running profile is this repository. `scripts/apply.sh` installs it into `~/.omp/profiles/omp-strata`, then merges `agent/strata.config.yml`. Extensions load at process start. When a new commit changes `agent/` or `bin/`, `self-update.sh` runs `~/.config/omp-strata/restart-hook` if that file is executable, so a long-running session can restart itself with `--continue`; without a hook it logs that a restart is needed. Commits that touch only docs, such as the daily `UPSTREAM.md` pin, do not run the hook.

`omp` stays the upstream command and keeps using `~/.omp/agent`. `omp-strata` is `omp --profile=omp-strata` with this profile. `omp-strata update` pulls this repo. `omp update` stays the upstream updater.

`startup.checkUpdate` is false on the profile, so `omp-strata` does not offer upgrades from `can1357/oh-my-pi`. The host timer `omp-strata-update.timer` runs `scripts/host-self-update.sh` hourly inside imagelxc. The omp program itself stays the tested upstream binary. [UPSTREAM.md](UPSTREAM.md) only records that upstream tag. It does not install it.

RTK's generated `extensions/rtk.ts` is not in this repo. `rtk init` writes it, and a later RTK release replaces it.

## Why these changes exist

Strata here serves one request at a time and keeps one prompt-cache prefix. The log line is `prompt N tokens = R reused + M read in M ms`. A different request in the middle (a subagent on the same server, a title, a judge call, a compaction handoff) makes the next coder turn cold. Decode is about 17–25 tokens/s. A cold prefill of 100k–160k tokens has taken minutes. Repeated identical tool calls cost the same.

The coder stays the main model. Coding, the main session's screenshots, handoff, and smol all run on it, which is the path for a single card. Judge, subagent chat, and a subagent's image review are the Mac mini experiment below: they try that machine when it is configured, and they continue on the coder when it does not answer.

## Every setting

| Piece | Value | Why |
| --- | --- | --- |
| Provider id | `strata` | omp 18.2.7 and newer reserves the provider id `local` for tiny on-device models. |
| `baseUrl` | `http://127.0.0.1:8080/v1` | Strata's own port. Inside imagelxc, `apply.sh` rewrites the installed copy to `http://127.0.0.1:18080/v1`, the proxy onto host `127.0.0.1:8080`. Strata itself still listens on the host port only. |
| `api` / `auth` | `openai-completions`, `auth: none` | Matches the local server. `auth: none` still counts as a configured credential, so omp will actually call it. |
| `compat.qwenTemplateReasoningEffort` plus `extraBody.reasoning_effort: low` and `reasoning_budget_tokens: 1536` | short, capped coder thinking | With thinking off, the coder reacted only to its latest observation and ran loops such as a three-step edit cycle 39 times (experiment 001). Uncapped `low` thinking used to spend the whole 4096 output budget, so Strata's hard budget closes the thinking at 1536 tokens (about 75–100 s at 19 tok/s) and the answer gets the rest of `maxTokens`. `extraBody` is applied after the template, so it wins on an existing session. |
| Coder `input` | `[text, image]` | The coder pack keeps vision. `imageInputDecoder: stb` makes omp send PNG or JPEG. `scripts/enable-strata-vision.sh` turns the encoder on and reserves 700 MiB, which is what fits the encoder beside the expert cache on a 12 GB card. A vision call uses the coder's only slot. `scripts/strata-vision.sh off` makes it `[text]` and sends images to another model (see Vision on or off). |
| Coder `contextWindow` | `262144` | The server is started with `--max-context 262144`. |
| Coder `maxTokens` | `6144` | Up to 1536 thinking tokens plus room for a file-sized answer. Measured answers without thinking stayed well under 4096. |
| `providers.maxInFlightRequests.strata` | `1` | A second in-flight call on this server is the thing that drops the prefix. |
| `title.refreshOnReplan` | `false` | A title call is another request. Also launch with `--no-title`. |
| `provider.appendOnlyContext` | `on` | New turns append to the cached prefix instead of rewriting it. A healthy turn then reads a few dozen new tokens. |
| Compaction method | `shake`, then `handoff`, then `soft` | Shake drops recoverable tool output and makes no model call. It only commits when the remainder is under the threshold. Handoff is the model summary. Soft is the local fallback. |
| `compaction.thresholdTokens` | `65536` | On 2026-10-04 a 32000 threshold handed off four times in half an hour. Each summary took 140–225s on Strata and dropped about 10k tokens. A cached prompt read of 30k tokens took 1–3s, and a cold 25k read took about 25s. 65536 leaves about 45k tokens of room above `keepRecentTokens` and stays under the 100k–160k range where a cold prefill has taken minutes. |
| `compaction.keepRecentTokens` | `20000` | The recent tail stays verbatim. The summary replaces what is older. |
| `compaction.midTurnEnabled` | `true` | Compaction can run in the middle of a turn, so a long tool loop does not wait for the turn to end. |
| `compaction.asyncEnabled` | `true` | A speculative summary can arm before the threshold. A mid-turn handoff that is not already armed still runs inline on the coder. omp 18.4.4 builds that request on the session model's prompt cache. |
| Artifact spill | `tools.artifactSpillThreshold`, `artifactHeadBytes`, `artifactTailBytes` all `10` | These are kilobytes. Large tool output leaves the prompt. The head and tail that remain are short. |
| `defaultThinkingLevel` | `low` | Matches the provider's `reasoning_effort: low`; the budget above is the hard limit. |
| `RULES.md` | caveman lite, ponytail lite, git, webcheck, and completion() | Re-sent every turn, so it stays short. Code, commands, paths, numbers, and error strings stay verbatim. |
| Repeated calls | extension, after 3 identical arguments | The next identical call is refused whether the earlier calls failed, succeeded, or mixed. A pure failure streak tells the model to determine why, and includes the oldest failure text. Emitting that same call again steers the session (`pi.sendUserMessage`, `deliverAs: "steer"`): the first steer asks for the cause and a different approach, the second tells the model to drop the step and move to the next item of the goal. Later repeats keep getting the second steer. The guard never aborts, because in omp an abort pauses the goal and stops the autonomous run. `read`, `grep`, `glob`, `find`, and `ls` may repeat up to 6 times in a row while they succeed, since after compaction or output trimming the model needs the same file again (without a cap one session read the same six lines 164 times); repeated failures of those tools are still refused. A cycle of 2–4 calls repeated three times in a row (A, B, A, B, A, B or A, B, C three times) is refused on its next step, with the cycle listed. A second check watches file state: omp stamps each edit result with the file's hash, and when edits bring a file back to the same earlier version twice, the next edit to that file is refused until the model commits or makes 15 other calls. In experiment 001 a three-step cycle (add a hint line, delete the duplicate, restore it) ran 39 edits; the file hash went #9EDB, #0A73, #4FD0 and back each time. Replayed through the guard, it stops at edit 8 with results visible and at edit 10 when shake had hidden them. A text turn does not reset the counter, and `--continue` rebuilds it from the session. The extension's own refusals do not count as runs. `wait`, `job`, `irc`, `yield`, `todo`, and `goal` may repeat. The signature ignores `i` and `__intent`. |
| Game probes | 3 per script since the last edit or write | `where.mjs`, `touchprobe.mjs`, `menutest.mjs`, and the other `cinderline/tools/*.mjs` probes share a count even when the shell pipeline changes. `describe.mjs` is refused. A screenshot question in the main session is `read <path>?q=<question>` on the coder. In a subagent, that read stays on the subagent's model. `judge()` tries the Mac, then the coder. |
| `completion()` | refused | That eval helper calls the coder and replaces the prefix. |
| Browser eval pre-flight | refused before running | `browser.open("url")` with a string, and `tab.run(() => …)` that touches `document`, `window`, or `fetch` (it runs in Bun, not the page). The refusal shows the accepted form and points at `webcheck`. In a replay of 327 real eval cells from 2026-10-04 these two rules matched 50 of the 133 failures and none of the successes. |
| `webcheck` | `tools/webcheck`, linked into `~/.local/bin` | One bash command loads a page in headless Chromium with a device (`--device iphone14promax`, `--landscape`, `--standalone` for an installed PWA), runs `--wait`, `--tap X,Y`, `--click`, `--key`, `--eval`, and `--shot` in order, and prints JSON: status, console errors, page errors, eval values, and the element under each tap. A small model gets a real browser without writing async code. Needs Node.js and a Chromium binary (`WEBCHECK_CHROME` overrides the path). |
| `judge()` | allowed | It uses `modelRoles.judge`. With no judge role configured, the call errors; the 3-repeat block then stops a retry loop. |
| Subagents | pinned or refused | See the side-model section. |
| RTK 0.51.0 | installed by `rtk init`, not vendored | Strips shell noise from context. omp needs `rtk` on `PATH` (0.23.0 or newer). |
| Prompt cache | left on | `--prompt-cache 0`, `--adapt-swaps 0`, and `--pcie-frac 0` disable it. This profile does not do that. |

Personal theme, symbol preset, and setup version are not part of the profile. `apply.sh` merges keys and leaves those alone.

## Vision on the coder

`modelRoles.vision` is `strata/qwen3.8-flash-next-coder-iq1_m`. `read <path>?q=<question>` uses that role. The coder pack is the GSQ-RCO Coder quant, which keeps the vision pathway. Strata reads pictures with a separate `strata-vision` process and the coder repo's `mmproj-Qwen3.8-Flash-Next-BF16.gguf` (about 0.9 GB). That is not a switch to the full unpruned model.

`scripts/enable-strata-vision.sh` downloads that projector, compiles `strata-vision` when the local engine was built without it, and writes two things into `strata-coder-iq1_m.json`: a `vision` section (`gpu: true`, `max_tokens: 1024`) and `--vision --vram-reserve-mib 700` on the engine. The encoder starts before the engine and holds about 1.2 GB. The 700 MiB reserve is what Strata leaves so a 12 GB card still fits the expert cache. Text decode is a few percent slower. A running server does not pick this up until it is restarted (`--restart` does that when the server is idle).

A vision call is a request on the only coder slot, so the following turn misses the prompt prefix. Handoff stays on the coder. Leave `compactionModel` unset.

That path is the main session. omp 18.4.4 answers `read <path>?q=<question>` with `modelRoles.vision` through a direct call. A busy Strata provider waits in `providers.maxInFlightRequests`. A subagent's copy of the extension rewrites that read so the image comes back to the subagent's own model. While the subagent is on the Mac, the review runs there and the coder keeps its slot. After a failed Mac request has continued the subagent on the coder, the same read returns the image on the coder. A one-machine install still answers the main session's screenshot questions on the card.

`install.sh` runs the vision script when `STRATA_DIR` or `~/Strata` contains a Strata checkout. The omp profile still installs if that checkout is absent.

### Vision on or off

Vision on the coder is the default, because a one-machine install has no other model to read pictures. With a second model that accepts images, you can turn the coder's encoder off. The 12 GB card then gives the encoder's VRAM (about 1.2 GB with the 700 MiB reserve) to the expert cache, and screenshots stop taking the coder's only slot.

```bash
# Images on the coder (default)
bash scripts/strata-vision.sh on --restart
# Images on another model from models.yml; the coder is text-only
bash scripts/strata-vision.sh off --model mac/google/gemma-4-12b-qat --restart
```

The choice is saved in `~/.config/omp-strata/settings.env` (`STRATA_VISION`, `VISION_MODEL`), so `apply.sh`, `install.sh`, and updates keep it. With `off`, `apply.sh` sets the coder's `input` to `[text]` and `modelRoles.vision` to `VISION_MODEL`. omp then describes tool screenshots with that model, and `read <path>?q=` goes there. The Strata half edits `strata-coder-iq1_m.json` (it keeps the previous file as `.json.vision-on`), and `--restart` restarts the running server through `scripts/restart-strata.sh`. When Strata and omp run on different machines, run the script on each with `--server-only` or `--profile-only`.

`SIDE_FALLBACK=off` in the same file stops judge and subagent calls from continuing on the coder when the side model fails. Each such fallback is a cold read of an 8–12K-token subagent prompt on the coder, and it evicts the main session's cached prompt, so the next main turn re-reads 55–61K tokens (about a minute on a 3060). With the coder's vision off, a fallback review also cannot see the screenshot. Leave it on for a one-machine install.

`COMPACTION_MODEL=<provider/model>` in the same file moves compaction to that model: `apply.sh` sets the coder entry's `compactionModel` and puts `soft` first. Measured on 2026-10-04 with Gemma 4 12B on a base M4 as that model, a mid-turn `soft` compaction of a 74K-token session blocked the coder for 14 minutes (a cold read of about 54K tokens on the Mac plus a 14K-character summary at about 14 tok/s). The coder's own `handoff` took about 6 minutes on the same session size. In omp 18.4.4 a mid-turn compaction does not run in the background, so leave this unset unless the side model reads and writes faster than the coder. If you do set it, the model's loaded context must hold the span older than `keepRecentTokens` (about 45K at a 65536 threshold) plus its summary.

## The Mac mini experiment

Our development setup includes a Mac mini M4 with 24 GB alongside the 12 GB Strata card. Offloading judge calls, subagent chat, and subagent image reviews to that Mac is an experiment. The repo's focus stays the single card. Coding, the main session's screenshots, handoff, and smol run on `strata/qwen3.8-flash-next-coder-iq1_m`, and an install with only that server still codes, reads screenshots, and compacts. Handoff stays on the coder. Leave `compactionModel` unset.

`modelRoles.smol` is the coder. omp uses that role to compress a skill description into one routing hint of at most 12 words and 160 characters, and small background calls use it when no separate tiny model is set. The call does not walk `retry.fallbackChains` and stops after 30s. On 2026-10-04 a 108-token mac-mini prompt took 1.6–2.2s warm on the coder and 3.6–3.7s on the Mac. Both answers were 14 or 15 words, so omp kept the plain preview. The role stays on the coder, which is the machine a single-card install has. After the skill text changed, one cold coder call (108 prompt tokens, 19 generated, about 3.7s) returned `Use Mac mini for judge() and subagents; main-session screenshots use read ?q=`. That line is 12 words and 77 characters, so omp cached it. The same description does not call the coder again. A compression still uses the coder's only slot. Titles stay off (`--no-title`, and `title.refreshOnReplan: false`).

`agent/models.yml` has the side provider for that experiment. On our tailnet it is LM Studio on the Mac mini, `http://100.123.160.60:1234/v1`, model `google/gemma-4-12b-qat`. A single-card install can leave the provider unused. Judge and subagent calls continue on the coder when the Mac does not answer.

| Role | Where it runs |
| --- | --- |
| `modelRoles.vision` | The Strata coder, for the main session. A subagent's `read <path>?q=<question>` stays on the subagent's model. |
| `modelRoles.judge` | The Mac first, then the coder. `judge()` and `judgeBatch()`. |
| `modelRoles.task` | The Mac first, then the coder. The bundled task agent (`@task`). |
| `modelRoles.smol` | The Strata coder. Skill compression and other small calls. |
| Coder `compactionModel` | unset. Handoff uses the session model. |

`SIDE_MODEL` in `agent/extensions/fail-loop-resteer.ts` is `mac/google/gemma-4-12b-qat`. Every subagent, including eval `agent()`, is pinned to the Mac. Set it to `""` to refuse subagents when that provider is gone. `apply.sh` overwrites the extension, so the constant in this repo is the one that will be installed.

`retry.fallbackChains` lists the coder under that Mac model and under `judge` and `task`. Smol is already the coder, so it has no chain. The Mac is still the first try for judge and subagents. When the request fails, omp continues it on the coder. That uses the coder's only slot, so the next coder turn reads the prompt cold. `retry.fallbackRevertPolicy` stays `cooldown-expiry`, so a later call tries the Mac again after the suppression window.

On 2026-10-04 the side model changed from `prism-ml/bonsai-27b` (MLX, 2-bit, dense 27B) to `google/gemma-4-12b-qat` (Gemma 4 12B, Q4_0 GGUF, vision, loaded at 32768 context with 2 parallel slots; compaction stays on the coder, so the Mac keeps memory free for on-demand image generation). On a base M4, the dense 27B read a 6.5K-token prompt at about 31 tok/s and decoded at about 2 tok/s while other requests were queued, so each screenshot review took many minutes. LM Studio's just-in-time model loading is off, so a request can never load the model again with default settings. Gemma 4 26B-A4B (a mixture-of-experts model with about 4B active parameters) is the next candidate to measure.

Two LM Studio facts decide that entry (first measured with Bonsai, and they hold for any model served there):

- omp sends images as WebP data URLs. LM Studio answers `400 'url' field must be a base64 encoded image` for those. The Mac model sets `imageInputDecoder: stb`, and so does the coder. A direct HTTP call must send `data:image/png;base64,...`.
- The model thinks unless the request sets `reasoning_effort` to `none`. Thinking can spend the whole `max_tokens` budget and return empty content. Set `compat.extraBody.reasoning_effort: none`.

`providers.maxInFlightRequests` for the Mac is `1`, so a judge call and a subagent queue there instead of loading the 27B model twice. The coder's slot stays separate, so one Mac call can overlap one coder turn. A main-session vision call is a coder turn. A subagent image review runs on the subagent's model, so it overlaps the coder while the Mac is answering.

The `mac-mini` skill tells the agent which call goes where. `RULES.md` stays the short always-on reminder. `apply.sh` replaces `RULES.md` from this repo on every install.

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

`install.sh` links `bin/omp-strata` into `~/.local/bin`, adds the `omp-strata` shell function to `~/.bashrc`, runs `apply.sh`, and enables Strata vision when a checkout is at `STRATA_DIR` or `~/Strata`. `apply.sh` installs the extension, the `mac-mini` skill, `RULES.md`, and `models.yml`, and merges `agent/strata.config.yml` with `omp --profile=omp-strata config set`. Theme keys already in the profile `config.yml` stay. `strata.config.yml` is the only list of keys; `scripts/config-pairs.py` maps it onto `omp config list --json` and needs PyYAML (`python3-yaml`).

`agent/models.yml` points Strata at `http://127.0.0.1:8080/v1`. On imagelxc, where `/opt/host-omp/omp` exists, `apply.sh` rewrites the installed copy to `http://127.0.0.1:18080/v1`. The same install restores `/usr/local/bin/omp` to the upstream binary and links `/usr/local/bin/omp-strata`. The first imagelxc install moves the old default `~/.omp/agent` into the profile, because that directory was this profile before the split.

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
agent/extensions/fail-loop-resteer.ts    loop re-steer, completion block, eval pre-flight, subagent pin, image review
tools/webcheck/                          one-command browser check that prints JSON
bin/omp-strata                          `omp --profile=omp-strata`; `update` pulls this repo
scripts/install.sh                       link the command, alias it, apply the profile, enable Strata vision
scripts/apply.sh                         install into ~/.omp/profiles/omp-strata/agent
scripts/enable-strata-vision.sh          mmproj, strata-vision, 700 MiB reserve on a coder config
scripts/strata-vision.sh                 vision on the coder, or off with images on another model
scripts/restart-strata.sh                restart the running Strata server with the same command
scripts/config-pairs.py                  strata.config.yml -> `omp config set` pairs
scripts/migrate-profile.sh               imagelxc one-time move of the old default agent
scripts/self-update.sh                   pull this repo and install it
scripts/host-self-update.sh              hourly host entry, runs the update in imagelxc
scripts/systemd/                         user timer for the hourly pull
scripts/check-upstream.sh                compare the pin with upstream
UPSTREAM.md                              tested omp, latest release, PR 14312
```
