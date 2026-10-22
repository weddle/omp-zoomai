# omp's extension point for Zoom (verified against source)

omp = oh-my-pi, `github.com/can1357/oh-my-pi`. Built and tested against omp `v18.12.1` (tag commit `291e0558`, 2026-10-18). The optional end-to-end test runs omp's own `NativeJudge` from a checkout in `vendor/oh-my-pi` (gitignored; see the README).

## Answer
**Use a project-local omp extension, not a fork.** The extension calls `pi.registerProvider("zoom-ai", …)` and declares models on the built-in judgment API **`openai-decisions`**. The `judge` model role then selects them. A small loopback shim inside the extension fills the gaps between OpenAI's and Zoom's dialects.

You can't just point omp at Zoom, and you can't add a new judgment dialect from an extension:

| Fact | Where |
|---|---|
| Native judgment dialects are a closed `const` map: `typesafe`, `openrouter-decisions`, `workers-ai-systemone`, `openai-decisions` | `packages/ai/src/judgment/native.ts:49` `JUDGMENT_WIRES`; `isJudgmentApi()` at `:60` |
| The judge role only treats a model as a native judge if `isJudgmentApi(model.api)` | `packages/coding-agent/src/judgment/index.ts:221` `kindOf()`; `#createJudge()` at `:445` calls `createNativeJudge()` (`native.ts:489`) |
| An extension's custom `api` string can only register a chat `streamSimple` transport (`registerCustomApi`), never a judgment wire | `packages/coding-agent/src/config/model-registry.ts:3476` `registerProvider()`; `docs/extensions.md` "Command-backed providers" |
| `openai-decisions` posts to `${baseUrl}/decisions` with `Authorization: Bearer <key>` | `packages/ai/src/judgment/openai-decisions.ts:106` `target`; `native.ts:445-449` `#attempt` |
| Its decoder reads `usage.input_tokens` and requires a numeric `confidence` on choice/score answers | `openai-decisions.ts:147`, `:87`, `:93` |
| `openai-decisions` serves kind `judge` | `packages/catalog/src/types.ts:70` `RUNNER_API_KINDS` |
| Extensions may register models on runner/judgment APIs | `packages/coding-agent/src/extensibility/extensions/types.ts:1947` `ProviderConfig`, `:1994` `ProviderModelConfig`; `docs/extensions.md` "Provider registration" |
| Question caps (`judgment-questions-max`) come from compiled catalog KDL rules, not user config | `packages/catalog/src/compat/axes.ts:527` (`set: "catalog"`); `compat/rules/providers/judgment-questions.kdl` |
| Project-local extension root `<cwd>/.omp/extensions`, project config `<cwd>/.omp/config.yml` | `docs/extension-loading.md` "Auto-discovered native extension modules"; `docs/config-usage.md` |
| Inside omp, judgments are reached through the eval prelude `judge()` / `judge_batch()` and internal features (find, ttsr) via the `judge` role | `packages/coding-agent/src/eval/judgment-bridge.ts`, `judgment-batch-bridge.ts` |
| Native-only tail policy: after the first native judge in the chain, only natives are tried, so prompted chat never stands in for calibrated probabilities | `judgment/index.ts:246` `textJudgeRoleChain()` |

So pointing `openai-decisions` straight at `https://api.zoom.us/v2/aiservices` would:
- post to `…/decisions` instead of `…/decisions/decide` (404, which `test/omp-native-judge.test.ts` shows);
- send more than 10 questions;
- record 0 tokens, because Zoom reports `input_units`, so the session cost ledger would be wrong;
- fail on any choice or score answer that comes back without `confidence`;
- never set `enable_image_input`.

## How it plugs in
```
omp judge role ──> zoom-ai/zoom-decisions (api: openai-decisions, baseUrl http://127.0.0.1:<ephemeral>/v1)
   NativeJudge (omp's own code) ──POST /v1/decisions, Bearer <key resolved from ZOOM_AI_API_KEY>──>
   loopback shim (in the extension process, holds no secret)
     • splits into ≤10 questions per request   • omits `model` for the standard tier
     • enable_image_input when images are present • x-api-key (default) or Bearer upstream
     • input_units → input_tokens               • fills missing confidence (max prob) and reports it
     • 503 metadata.retry_after_seconds → Retry-After, so omp's backoff honors it
   ──POST https://api.zoom.us/v2/aiservices/decisions/decide──> Zoom
```
The shim binds 127.0.0.1 only and is `unref`'d. It never logs request bodies or keys.

## Alternatives considered
| Option | Verdict |
|---|---|
| A. Extension plus shim (built here) | **The delivered approach.** No fork, project-local, uses omp's own retry, auth rotation, cache and ledger. |
| B. `models.yml` pointing `openai-decisions` at Zoom | Doesn't work (the route, cap, usage and confidence gaps above). It would also need a global `models.yml` change. |
| C. ~~Upstream PR adding a `zoom-decisions` JudgmentWire (~150 lines plus a KDL cap of 10)~~ | Not pursued; kept only as a design note. The extension plus shim is the delivered path. |
| D. Extension `registerTool("zoom_judge")` | Bypasses the judge role chain, cache and ledger. Rejected. |
| E. Fork omp | Unnecessary. |

## Chat or "provider" models
Zoom AI Services publishes **no chat/completions LLM endpoint** (see `zoom-ai-api-map.md`). The only text LLM is inside the Voice Agent realtime WebSocket. A `streamSimple` provider could in principle wrap it, but it's a voice product, the docs conflict on its model, and text-only use is undocumented, so it's out of scope. **The only Zoom models that fit omp are the two Decisions judge models.**
