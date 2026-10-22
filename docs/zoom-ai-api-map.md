# Zoom.ai (Zoom AI Services) public API map: Decisions focus

Read 2026-10-20 at about 8:50 PM ET, from public pages only. Nothing here sits behind a login, and no API calls were made.
Labels: **SEEN** means stated on the linked public page. **INFER** means my inference. **unknown** means not published.

Sources:
[REF] https://developers.zoom.us/docs/api/ai-services/ (OpenAPI reference) ·
[GUIDE] https://developers.zoom.us/docs/ai-services/decisions/ ·
[FAST] https://developers.zoom.us/docs/ai-services/decisions/fast-mode/ ·
[AUTH] https://developers.zoom.us/docs/ai-services/auth/ ·
[BLOG] https://www.zoom.com/en/ai-research/introducing-zoom-decisions-apis-accurate-speech-reliable-action/ (published Oct 19, 2026) ·
[RATE] https://developers.zoom.us/docs/api/rate-limits/ ·
[TOS] https://www.zoom.com/en/trust/terms/ §10 ·
[WP] https://library.zoom.com/ai/ai-whitepaper/data-governance-and-privacy ·
[PORTAL] https://zoom.ai ·
[VA] https://developers.zoom.us/docs/ai-services/voice-agent/

## 0. What "Zoom.ai" is
- **SEEN** [PORTAL]: zoom.ai is the "AI Services Developer Portal". Its products are Scribe (STT), Text-to-Speech, Translator, Interpreter, Voice agent, Text Summarization, Speech Summarization, Enterprise Search (Onyx), Clinical Notes, plus Decisions [BLOG]. Keys come from Platform Studio (platform.zoom.us) [AUTH].
- **SEEN** [REF]: the operations are vocabularies, **decisions/decide**, scribe (batch, sync, live WS), speech-summarization (SSE), summarizer (batch, sync), translator (batch, sync) and voice-agent (live WS). **There is no chat/completions, responses, embeddings or models-list endpoint.**

## 1. Does a Zoom Decisions model exist?  **Yes, SEEN.**
- Endpoint `POST https://api.zoom.us/v2/aiservices/decisions/decide` [REF][FAST]. Launched publicly in the Oct 19, 2026 CTO post [BLOG].
- Two models: **`zoom-decisions`** (default, "optimized for latency and cost") and **`zoom-decisions-pro`** ("higher decision accuracy and more complex workloads") [REF][GUIDE].
  - Conflict, SEEN: [REF] names the default id `zoom-decisions`, while [GUIDE] and [FAST] call it `zoom-decisions-standard`. Omitting `model` selects the default in both, so the adapter omits it for the standard tier.
  - "The model identifiers represent service tiers, rather than the underlying model implementation" [GUIDE]. "The underlying model implementation may change while preserving the public API contract" [REF].
  - **INFER**: there's no version pinning, unlike `jev-1.13.0`, so thresholds can drift silently. Log `model` and `request_id` on every call.

## 2. Auth
- **SEEN** [REF]: "Authenticate with a Decisions-enabled API key in the `x-api-key` request header. A Zoom AI Services or Universal SDK entitlement is required." Granular scope `aiservices:write:decide:admin`. Not supported in the Gov cluster.
- **SEEN** [AUTH]: AI Services accept `Authorization: Bearer <API key or JWT>` or `x-api-key: <API key>`. If both are sent, x-api-key wins, and an invalid x-api-key fails even when the bearer is valid. API keys are made in Platform Studio → Credentials, with expiry (never/30/90/180 days/1 year), an IP allowlist and per-product scopes. A JWT is short-lived (90 minutes, 1 day or 1 week). [FAST]'s example uses `Authorization: Bearer $TOKEN` with a JWT.
- **INFER**: the key belongs to a Zoom Build / Platform Studio account. Use a developer account you personally control and are entitled to bill. This tool's default is `x-api-key` with `ZOOM_AI_AUTH=bearer` as an option.

## 3. Request and response shape
- **SEEN** request [REF][FAST]:
  - `input`: a string, or `[{role:"user", content:[{type:"input_text",text}|{type:"input_image",image_url:"data:…",detail?}]}]`.
  - `questions[]`: `{type:"predicate"|"choice"|"score", name, instructions, choices?|levels?}`.
  - Optional: `model`, `enable_image_input` (default false; required when images are present), `reference_id`.
  - Choices: 2 to 255 unique string or boolean `value`s with optional `description`. Levels: 2 to 10 `{label, description?}`, lowest first.
- **SEEN** question count: [REF] says "**One to ten** independent typed questions". [FAST] says "one or more". The adapter enforces 10 and splits larger requests.
- **SEEN** `name`: required and unique in [REF], optional in [FAST]. The adapter always sends it.
- **SEEN** response [REF][FAST]:
  - `answers[]` come back in request order:
    - predicate: `{type, name, probability}`. There's no separate boolean ("The API does not return a separate true-or-false answer").
    - choice: `{choice, probabilities:[{value,probability}], confidence}`.
    - score: `{score (probability-weighted index), probabilities:[{value:index,label,probability}], confidence}`.
    - A question can come back as `{type:"refusal", name}` while the others are still answered.
  - Also returned: `model`, `request_id`, and `usage:{input_units, output_units (= number of questions), unit_type:"tokens", details?{cached_input_tokens}}`.
- **SEEN** conflict: `confidence` appears in [FAST]'s choice and score examples but not in [REF]'s schema. The adapter fills it from the top probability if it's missing and reports that.
- **SEEN** [GUIDE]: "Questions in one request are independent". Dependent questions need separate requests. "Invalid model output is not returned as a valid decision result" [REF].
- **SEEN** [BLOG]: "Decisions APIs share an OpenAI-compatible request and response format." **INFER**: compatible at the body level. The path, auth, usage field names and question cap differ (see `omp-extension-point.md`).

## 4. Streaming, tool calls, modes
- **SEEN** [GUIDE]: "synchronous Fast mode only. It does not provide Batch jobs, streaming, or WebSocket execution… it does not execute tools." [FAST]: "Files, audio, tool calls, function-call results, and message roles other than `user` are not supported."

## 5. Model list and context limits
- **SEEN**: there's no models endpoint for Decisions. The ids are hard-coded (§1).
- **unknown**: context window, per-question token limit, payload size, and image count, size or MIME limits. [FAST] only says requests "exceeding the service's input, payload, question, choice, level, or image limits are rejected", without numbers. The placeholder `contextWindow: 64000` in the extension is **INFER**.
- **SEEN** [GUIDE]: "Image-specific safety guardrails are not available." The extension keeps images off unless `ZOOM_AI_IMAGES=1`.

## 6. Rate limits
- **SEEN** [REF]: rate-limit label `LIGHT`, plus "Account-level rate limits and workload quotas apply". 429 comes with `Retry-After` "when applicable". 503 carries `metadata.retry_after_seconds` [FAST].
- **SEEN** [RATE]: LIGHT is 4/s and 6,000/day on Free, 30/s on Pro, 80/s on Business+. "The Zoom Build account uses the Pro rate limit."
- **unknown**: Decisions-specific "workload quotas" and concurrency caps.

## 7. Latency
- **SEEN** [BLOG]: "117 ms median latency" in the vendor's own Oct 15 test, as published in the blog post. Competitors were measured through OpenRouter, so the network paths differ.
- **INFER**: unverified from our network. For reference, measured here: Jev 0.10 s mean, OpenAI Decisions 0.20 s mean.

## 8. Accuracy claims (vendor, unverified)
- **SEEN** [BLOG], vendor-published results:
  - Five text benchmarks (including JevBench, RAGTruth, JudgeBench, ContractNLI): Pro averaged 83.9%, standard 81.3%. Both beat Jev, OpenAI Decisions and Microsoft-Decision-1.
  - Four image benchmarks: Pro 86.0%, Jev 86.3%, OpenAI 80.2%.
- **INFER**: these are vendor benchmarks. See the README's calibration summary for an independent 52-case check.

## 9. Data handling
- **SEEN** [TOS §10.2]: "Zoom does not use any of your audio, video, chat, screen sharing, attachments or other communications-like Customer Content … to train Zoom or third-party artificial intelligence models." Customer Content includes resulting "outputs".
- **SEEN** [WP] (AI whitepaper): retention follows the "associated Zoom service". Third-party model providers in Zoom's federated approach are under zero-data-retention terms, with trust-and-safety exceptions.
- **SEEN** [PORTAL]: AES-256 at rest, TLS 1.2/1.3 in transit, SOC 2 Type II, HIPAA with a BAA, and an on-prem option.
- **unknown**:
  - a Decisions/AI-Services-specific retention period for request inputs (no DPA or retention page found for AI Services);
  - whether text Decisions inputs count as "communications-like" content under the no-training clause (**INFER**: likely covered as Customer Content, but the clause lists media types explicitly);
  - whether a ZDR option exists for AI Services;
  - which models are behind the tiers.
- **INFER**, suggested policy: treat it like OpenAI Decisions. Don't send secrets or private personal data in `input` (the CLI has a secret tripwire). Keep work and personal data on their own keys.

## 10. The other AI Services in omp terms
| Service | omp fit |
|---|---|
| Voice Agent (WS, OpenAI Realtime vocabulary, function tools, `output_modalities` text or audio) [REF][VA] | Not a chat provider. The default model conflicts: [REF] says `gpt-5.6-luna`, [VA] says built-in `gemma-4`. Out of scope. |
| Summarizer / Speech Summarization / Translator / Scribe | Task APIs, not models. They could be omp tools later (out of scope). |
