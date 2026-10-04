---
name: mac-mini
description: Use the Mac mini side model for vision, screenshot questions, judge(), and subagents so the Strata coder keeps its one prompt cache. Use when a task needs an image, a screenshot, classification, or side work that must not run on the coder.
---

# Mac mini side model

The coder is text-only and serves one request. A second request on that server drops the prompt cache. Vision, judge, and subagents go to the provider named `mac` in `~/.omp/profiles/omp-strata/agent/models.yml`.

## What to call

- Saved image: `read <path>?q=<question>`. This uses `modelRoles.vision`.
- Screenshot classification, yes/no, ranking: `judge()` in eval. This uses `modelRoles.judge`. Batch questions in one call.
- Side work, research, or a long look that should not sit on the coder: the `task` tool. The extension pins every subagent to `SIDE_MODEL` in `agent/extensions/fail-loop-resteer.ts`.
- Numbers from the game, one probe after an edit: `cinderline/tools/where.mjs`, `touchprobe.mjs`, or `menutest.mjs`. Do not run `describe.mjs`. It holds this turn and lets Bonsai think the budget away. Screenshot questions go through `read <path>?q=<question>` or one `judge()` call.

`completion()` stays blocked. It would call the coder.

## Direct HTTP

Read `baseUrl` from the `mac` provider. OpenAI chat completions, model id from that provider. Send `reasoning_effort: "none"` and `max_tokens` of at least 1500. Thinking left on can spend the whole budget and return empty content.

Images must be PNG data URLs: `data:image/png;base64,...`. A WebP data URL is rejected. omp itself re-encodes when the model sets `imageInputDecoder: stb`.

## Context

The side model's `contextWindow` in `models.yml` must match the context LM Studio actually loaded. Handoff stays on the coder: omp 18.4.4 builds that summary on the session model's prompt cache. Leave the coder's `compactionModel` unset while `compaction.thresholdTokens` is above this context window.
