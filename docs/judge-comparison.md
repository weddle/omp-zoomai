# Judge backends: Zoom Decisions vs TypeSafe Jev vs OpenAI Decisions

Sources:
- Zoom: `zoom-ai-api-map.md` (public docs, SEEN/INFER labels there).
- Jev and OpenAI: vendor docs ([S] sourced) and a 52-case gold-set comparison ([M] measured, 2026-10-18).

Zoom was measured on the same 52-case gold set on 2026-10-20 (see the README's calibration summary). Rows without [M] are vendor-stated.

| | **Zoom Decisions / Pro** | **TypeSafe Jev** | **OpenAI Decisions** |
|---|---|---|---|
| Endpoint | `POST api.zoom.us/v2/aiservices/decisions/decide` | `POST api.typesafe.ai/v1/systemone` | `POST api.openai.com/v1/decisions` |
| Model ids / pinning | `zoom-decisions` (also called `-standard`) and `zoom-decisions-pro`. Tier ids, implementation may change (no pin) | `jev-1.13.0` pinned (plus latest/preview aliases) | `gpt-6-luna`, single unversioned id, public beta |
| Question types | predicate, choice (2–255), score (2–10 levels) | noul, choice (≤255), score (≤10), box (experimental) | predicate, choice (2–255), score |
| Probabilities | predicate P(true). Full distribution for choice and score, plus prob-weighted score | Same, calibrated, smoother | Same; sharper/extreme (70% hard 0/1 on tagging [M]) |
| Confidence | choice and score, 0–1 (in guide examples, **absent from the API-ref schema**) | choice and score, "concentration" | choice and score |
| Abstain / refusal | per-question `refusal` answer, others still answered; no built-in abstain (thresholds are yours) | none built in (code gates) | per-question `refusal` |
| Questions per request | **1–10** (API ref) | no count cap; 64k tokens/request, 32k/question | 1–200 |
| Fan-out cost per extra question | ≈1,321 units, super-linear (351 at N=1 → 12,240 at N=10) [M 2026-10-20] | ≈24 tokens [M] | ≈158 tokens [M] |
| Context limit | **unknown** | 64k (262k experimental) | ~1.05M |
| Images | yes, opt-in `enable_image_input`; limits undocumented; "no image-specific safety guardrails" | yes (experimental "danger zone") | yes, ≤128 |
| Price (input; output free) | **$0.042 / $0.10 per MTok** | $0.042 per MTok | $0.10 per MTok |
| Latency | vendor: 117 ms median (vendor's own test); measured 0.27 s / 0.31 s mean (std / pro) [M] | 0.10 s mean, 0.17 s p95 [M] | 0.20 s mean, 0.38 s p95 [M] |
| Rate limit | LIGHT: Build/Pro 30 req/s per account, plus unpublished workload quotas | per-org, console only | 30k RPM (observed) [M] |
| Calibration on our 52-case gold set | std 51/52, ECE 0.002; pro 52/52, ECE 0.001 [M] | 49/50 decided, ECE 0.054 [M] | 49/49 decided, ECE 0.014 [M] |
| Vendor accuracy claim | text 81.3% (std) / 83.9% (pro); image 86.0% (pro) — vendor-published | — | — |
| Training on inputs | ToS: no training on "communications-like" Customer Content (text-Decisions scope INFER) | not trained on customer data | not trained |
| Retention | AI-Services-specific period **unknown**; "per associated service"; third-party LLMs ZDR | unstated; ZDR enterprise only | 30-day abuse logs; ZDR eligible; US/EU residency |
| Compliance | SOC 2 Type II; HIPAA with BAA; on-prem option (portal) | — | HIPAA eligible |
| omp support today | **none native**; this repo's extension plus shim | native `typesafe` wire | native `openai-decisions` wire |
| Account / boundary | Zoom Build / Platform Studio API key with the Decisions scope | own vendor key | OpenAI key |

## How it plugs in: recommendation = **both, sharing one codec**
1. **In omp: the `judge` role (primary).** omp already has a pluggable judge: the `judge` model role, a fallback chain, a native-only tail, an answer cache, the session cost ledger, and eval `judge()` / `judge_batch()`. Zoom joins it as `zoom-ai/zoom-decisions` and `zoom-ai/zoom-decisions-pro` through the project-local extension in `extension/zoom-ai/`. Writing a separate omp "judge tool" would duplicate all that and skip the ledger, so I didn't. Backend switching is config only:
   ```yaml
   # <project>/.omp/config.yml
   modelRoles:
     judge: zoom-ai/zoom-decisions          # or typesafe/jev-1.13.0, openai/gpt-6-luna-decisions
   retry:
     fallbackChains:
       judge: [typesafe/jev-1.13.0]          # native → native only; never falls back to chat
   ```
2. **Outside omp: `bin/judge.ts`, a small CLI (secondary).** It takes the same System One questions and returns one output shape for `jev | openai-decisions | zoom-decisions | zoom-decisions-pro`. It has `--dry-run`, the loopback-only default, `JUDGE_LIVE_OK=1` for live calls, and a secret tripwire. This covers scripts and evals and pipelines that don't run omp. It uses the same Decisions codec as omp's wire, so the questions match across paths (`test/judge-cli.test.ts` checks the shapes are the same).

Suggested policy:
- Thresholds are per model. Don't reuse Jev's 0.85/0.15 on Zoom: its probabilities are near-binary, so those gates never abstain.
- Zoom has no version pin, so log `model` and `request_id`, and re-run the gold set monthly.
- A judge is never the final decider for sends, deletes, spend or pushes.
- **Where Zoom earns a slot (after the 2026-10-20 calibration):**
  - Pro as an independent second opinion at OpenAI's price, on a separate vendor.
  - Standard as a Jev-priced alternative for ≤10-question requests.
  - Its 10-question cap makes it a poor fit for wide fan-out (many-question tagging), where Jev stays the default.
