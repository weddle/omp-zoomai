# omp-zoomai

An **unofficial, community** provider plugin for [OMP (oh-my-pi)](https://omp.sh) that exposes
[Zoom.ai](https://zoom.ai)'s public **Decisions** models (`zoom-decisions`, `zoom-decisions-pro`) as
**judge**-role models inside OMP.

> **Disclaimer.** This is an unofficial, community-built plugin. It is **NOT** an official Zoom or Zoom.ai
> product, and it is **not affiliated with, authorized, sponsored, or endorsed by** Zoom Video Communications,
> Inc. or Zoom.ai. "Zoom" and "Zoom.ai" are trademarks of their respective owners; they are used here only to
> describe interoperability with Zoom's public AI Services API. The software is provided **"as is", without
> warranty of any kind**; use it at your own risk. You are responsible for your own Zoom AI Services account,
> API key, usage, and costs.

## What it is

OMP has no native Zoom judgment dialect, and an extension can't add one, so this plugin registers the Zoom
Decisions models on OMP's built-in **`openai-decisions`** judgment wire and points them at a **localhost,
keyless relay** (`extension/zoom-ai/shim.ts`) that translates each request to Zoom's
`POST https://api.zoom.us/v2/aiservices/decisions/decide` and back:

- splits requests into chunks of at most 10 questions (Zoom's cap);
- omits `model` for the standard tier; sets `enable_image_input` when images are present;
- maps Zoom's `input_units` to `input_tokens`, so OMP's session cost ledger is right;
- fills the missing `confidence` on choice/score answers from the top probability;
- maps 503 `metadata.retry_after_seconds` to `Retry-After`, so OMP's backoff honors it.

The relay binds `127.0.0.1` only, holds no key (OMP passes the key per request and the relay forwards it once as
`x-api-key`) and never logs bodies or keys. No OMP fork and no global config change are needed.

Also included: `bin/judge.ts`, a small CLI that sends one typed-judgment request to Jev, OpenAI Decisions or Zoom
with one output shape, and an offline mock of all three APIs for tests.

This repo uses Zoom's **public** AI Services API and public docs only.

## Requirements
- **OMP (oh-my-pi)** — built and tested against **v18.12.1**; the contract is stable across the 18.12.x line.
  The extension uses only `pi.registerProvider` and the `openai-decisions` judgment API, see
  [`docs/omp-extension-point.md`](docs/omp-extension-point.md).
- **Bun** (tested with Bun 1.4.2). The relay, mock and CLI use `Bun.serve` / `Bun.file`, so **Node is not
  supported**. Inside OMP the extension runs in OMP's own Bun runtime; you only need `bun` on PATH for the CLI
  and the tests. No npm dependencies.
- A Zoom AI Services API key with the Decisions scope (`aiservices:write:decide:admin`), created in Platform Studio
  (https://platform.zoom.us → Credentials) on a Zoom Build account with an AI Services entitlement or credits.
  Use a developer account you control; a 90-day expiry with only the Decisions scope is a sensible setting.

## Install (one command)
From a checkout of this repo:

```bash
# into a project (creates <project>/.omp/extensions/zoom-ai; --with-config also writes .omp/config.yml if it doesn't exist)
./install.sh --project /path/to/project --with-config

# into the OMP agent dir: ${PI_CODING_AGENT_DIR:-~/.omp/agent}/extensions/zoom-ai
./install.sh --global
```

Clone and install into the current project in one line (replace the URL with wherever you cloned this repo):

```bash
git clone https://github.com/weddle/omp-zoomai.git /tmp/omp-zoomai && /tmp/omp-zoomai/install.sh --project "$PWD" --with-config
```

Options: `--link` symlinks instead of copying (follows `git pull`), `--agent-dir DIR` targets a profile's agent
dir (e.g. `~/.omp/profiles/NAME/agent`). The script only copies the three files in `extension/zoom-ai/`; it never
writes keys and never edits an existing `config.yml` (it prints the snippet for you to merge).

Manual equivalent: copy or symlink `extension/zoom-ai/` to `<project>/.omp/extensions/zoom-ai/` or
`~/.omp/agent/extensions/zoom-ai/`.

## Environment variables
The extension is **fail-closed**: it registers nothing unless both `ZOOM_AI_ENABLE=1` and the key variable are set.

| Variable | Used by | Meaning |
|---|---|---|
| `ZOOM_AI_ENABLE` | extension | Must be exactly `1` to register the provider. Explicit opt-in, so a key that happens to be in the env never causes paid calls. |
| `ZOOM_AI_API_KEY` | extension, CLI | The Zoom AI Services API key (Decisions scope). |
| `ZOOM_AI_KEY_ENV` | extension | Name of a different env var that holds the key (default `ZOOM_AI_API_KEY`). |
| `ZOOM_AI_BASE_URL` | extension | AI Services root (default `https://api.zoom.us/v2/aiservices`; tests point it at the mock). |
| `ZOOM_AI_AUTH` | extension, CLI | `x-api-key` (default, per the decide API reference) or `bearer`. |
| `ZOOM_AI_IMAGES` | extension | `1` advertises image input (off by default: Zoom's image limits are undocumented). |
| `JUDGE_LIVE_OK` | CLI | Must be `1` for the CLI to call any non-loopback endpoint; otherwise it exits 3 before touching keys or network. |
| `TYPESAFE_API_KEY` | CLI | Key for `--backend jev`. |
| `OPENAI_API_KEY` | CLI | Key for `--backend openai-decisions`. |
| `MOCK_PORT`, `MOCK_OMIT_CONFIDENCE` | mock | Port for `bun run mock`; `1` drops `confidence` like the real API does. |

Keep the key in a `0600` file and pass it only to the runs that need it, e.g.
`ZOOM_AI_ENABLE=1 ZOOM_AI_API_KEY="$(cat ~/.config/zoom-ai/decisions.key)" omp ...`. Never commit it.

## Use it as a judge, with Jev as the fallback
In the project's `.omp/config.yml` (or the agent dir's `config.yml`), see [`examples/omp-config.yml`](examples/omp-config.yml):

```yaml
modelRoles:
  judge: zoom-ai/zoom-decisions-pro   # or zoom-ai/zoom-decisions
retry:
  fallbackChains:
    judge:
      - typesafe/jev-1.13.0
```

- With `ZOOM_AI_ENABLE=1` and a key, OMP's judge role (eval `judge()` / `judge_batch()` and internal features
  such as find) uses Zoom, and falls back to Jev on errors. OMP's judge chain is native-only after the first native
  judge, so it never falls back to a prompted chat model.
- Without them, the extension registers nothing and the role falls through to Jev, so the config is safe to
  leave in place.
- To keep **Jev as the default** (recommended, below) and ask Zoom for a second opinion only on specific
  questions, leave `judge: typesafe/jev-1.13.0` and call the CLI:

```bash
JUDGE_LIVE_OK=1 ZOOM_AI_API_KEY=... bun bin/judge.ts --backend zoom-decisions-pro \
  --state '"I was charged twice this month"' \
  --questions '{"route":{"type":"choice","instructions":"Which team?","criteria":{"billing":null,"support":null}}}'
```

CLI backends: `jev | openai-decisions | zoom-decisions | zoom-decisions-pro`. Add `--dry-run` to print the exact
wire body without a request, `--base-url URL` / `--model ID` to override. Exit codes: 0 ok, 2 a question was
refused, 3 live call blocked (no `JUDGE_LIVE_OK=1`), 1 other error. The CLI refuses state that looks like a
credential.

## Calibration summary (2026-10-20)
Live run on a 52-case gold set (predicate and choice questions), both Zoom models, compared with earlier runs of
Jev and OpenAI Decisions on the same set:

| | Jev 1.13.0 | OpenAI Decisions | Zoom Decisions | Zoom Decisions Pro |
|---|---|---|---|---|
| Correct on decided cases | 49/50 (2 abstain) | 49/49 (3 abstain) | **51/52** | **52/52** |
| ECE (predicate set, 5 bins) | 0.054 | 0.014 | 0.002 | 0.001 |
| Mean / p95 latency | 0.10 / 0.17 s | 0.20 / 0.38 s | 0.27 / 0.58 s | 0.31 / 0.90 s |
| Cost per 1,000 single-question decisions | $0.022 | $0.030 | $0.012 | $0.028 |
| Max questions per request | no count cap | 200 | 10 | 10 |

- Both Zoom models had the best calibration of the four judges. Pro got every case right, including the one
  ambiguous routing case the others missed or abstained on.
- The run was 116 requests (2 models × (52 gold + 6 probes)), about **$0.0045** at list price.
- The gold set is near ceiling (differences are 0–1 cases at n=52), so treat this as "fit for use", not a ranking.

**Recommendation:** keep **Jev as the default judge**: it handles many-question fan-out cheaply, while Zoom caps at
10 questions per request and its per-question cost grows fast. Use **Zoom Decisions Pro as an independent second
opinion** on single, high-stakes questions (about OpenAI Decisions' price, separate vendor). A judge should never
be the final decider for sends, deletes, spend or pushes.

## Known caveats
- **10 questions per request.** 11 or more returns HTTP 400 (`too many questions (max 10)`). The relay and CLI
  split larger requests automatically, but each chunk is a separate billed request.
- **No `confidence` field.** Choice/score answers carry only `probabilities`; the relay synthesizes
  `confidence` = top probability (OMP's decoder requires it).
- **Answers cluster near 0 or 1.** Every predicate in the gold run came back ≤0.05 or ≥0.95, so abstain gates
  tuned for Jev (0.85/0.15) never trigger. Tune thresholds per model on a harder set before relying on abstention.
- **Default model.** A request without `model` returns `"model": "zoom-decisions"` (docs also call it
  `zoom-decisions-standard`); the relay omits `model` for the standard tier.
- **Non-linear billing.** `input_units` grows faster than linearly with questions per request (same input, N
  questions: 351 units at N=1, 896 at N=2, 3,695 at N=5, 12,240 at N=10; most reported as cached, and whether cached
  tokens are discounted is undocumented). Prefer 1–3 questions per request.
- No version pinning: the model ids are service tiers and the implementation may change. Log `model` and
  `request_id` and re-check calibration periodically.
- Context, payload and image limits are unpublished; `contextWindow: 64000` in the extension is a placeholder.

More: [`docs/zoom-ai-api-map.md`](docs/zoom-ai-api-map.md) (public API map),
[`docs/judge-comparison.md`](docs/judge-comparison.md) (Zoom vs Jev vs OpenAI),
[`docs/omp-extension-point.md`](docs/omp-extension-point.md) (why an extension plus relay).

## Layout
| Path | What |
|---|---|
| `extension/zoom-ai/index.ts` | OMP extension (fail-closed provider registration) |
| `extension/zoom-ai/shim.ts` | localhost keyless relay: `openai-decisions` → Zoom `decisions/decide` |
| `extension/zoom-ai/zoom-wire.ts` | pure translation: ≤10-question split, model id, images, usage, confidence |
| `src/judge/`, `bin/judge.ts` | backend-agnostic judge CLI and shared Decisions codec |
| `src/mock/mock-server.ts` | offline mock of the Zoom, Jev and OpenAI decision APIs (`bun run mock`) |
| `test/` | `bun test` |
| `install.sh` | install / uninstall |
| `examples/omp-config.yml` | judge role + Jev fallback |

## Tests
```bash
bun test     # offline; never calls a real API
```
Some tests also run OMP v18.12.1's own `NativeJudge` and model-config schema end to end through the relay. They
skip unless an OMP checkout is present in `vendor/` (gitignored):

```bash
git clone https://github.com/can1357/oh-my-pi vendor/oh-my-pi && git -C vendor/oh-my-pi checkout v18.12.1
(cd vendor/oh-my-pi && bun install --ignore-scripts)
npm pack @oh-my-pi/pi-natives-linux-x64@18.12.1 && tar xzf oh-my-pi-pi-natives-linux-x64-18.12.1.tgz \
  && cp package/*.node vendor/oh-my-pi/packages/natives/native/ && rm -rf package oh-my-pi-pi-natives-linux-x64-18.12.1.tgz
```

## Uninstall
```bash
./install.sh --project /path/to/project --uninstall   # or: ./install.sh --global --uninstall
```
This removes the `extensions/zoom-ai` directory or symlink. Then remove the `judge: zoom-ai/...` line (and the Jev
fallback if you don't want it) from the `config.yml` you edited, and unset `ZOOM_AI_ENABLE` / `ZOOM_AI_API_KEY`.
Revoke the key in Platform Studio if you no longer need it. Nothing else is installed.

## License
[MIT](LICENSE) © 2026 Ryan Weddle.
