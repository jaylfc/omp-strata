---
name: mac-mini
description: Use the Mac mini for judge() and subagents. A subagent image review stays on the subagent model. Main-session screenshots use read ?q= on the Strata coder.
---

# Mac mini side model

The coder serves one request and reads images through Strata. A second request on that server drops the prompt cache. Judge and subagents go to the provider named `mac` in `~/.omp/profiles/omp-strata/agent/models.yml`.

## What to call

- Saved image in the main session: `read <path>?q=<question>`. This uses `modelRoles.vision` on the Strata coder. It takes the coder's only slot, so the next coder turn reads the prompt cold.
- Saved image in a subagent: the same `read <path>?q=<question>`. The extension returns the image on this subagent's model. That is the Mac while it answers. After the Mac call has continued on the coder, the image returns there.
- Screenshot classification, yes/no, ranking: `judge()` in eval. This tries `modelRoles.judge` on the Mac. Batch questions in one call. If the Mac does not answer, omp continues that call on the coder.
- Side work, research, or a long look that should not sit on the coder: the `task` tool. The extension pins every subagent to `SIDE_MODEL` in `agent/extensions/fail-loop-resteer.ts`. A failed Mac request continues on the coder.
- Numbers from the game, one probe after an edit: `cinderline/tools/where.mjs`, `touchprobe.mjs`, or `menutest.mjs`. Do not run `describe.mjs`. It holds this turn and lets Bonsai think the budget away.

`completion()` stays blocked. It would call the coder.

## Direct HTTP

Read `baseUrl` from the `mac` provider. OpenAI chat completions, model id from that provider. Send `reasoning_effort: "none"` and `max_tokens` of at least 1500. Thinking left on can spend the whole budget and return empty content.

Images must be PNG data URLs: `data:image/png;base64,...`. A WebP data URL is rejected. omp itself re-encodes when the model sets `imageInputDecoder: stb`.

## Context

The side model's `contextWindow` in `models.yml` must match the context LM Studio actually loaded. Handoff stays on the coder: omp 18.4.4 builds that summary on the session model's prompt cache. Leave the coder's `compactionModel` unset while `compaction.thresholdTokens` is above this context window.
