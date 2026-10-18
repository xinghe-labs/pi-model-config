# pi-model-config

**Five answers and a working endpoint. The model's numbers are derived, not typed.**

A Pi extension for adding a third-party, self-hosted or proxied model endpoint to
`models.json` — and for re-auditing those numbers later against the endpoint and
[models.dev](https://models.dev).

```bash
pi install npm:pi-model-config
```

Start a new session afterwards (or `/reload`): a package installed mid-session is
not loaded until Pi re-reads its package list.

```text
/model-setup            menu
/model-setup add        add or replace a provider
/model-setup check      reconcile models.json against the endpoint and models.dev
/model-setup list       show configured providers
/model-setup remove     delete a provider
```

`/model-config` is still registered as an alias.

## The problem

Pointing Pi at an OpenAI-compatible gateway means writing this by hand:

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gw.example.com/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "claude-opus-4-6",
          "contextWindow": 1000000,
          "maxTokens": 32000,
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "supportsReasoningEffort": true },
          "thinkingLevelMap": { "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": null }
        }
      ]
    }
  }
}
```

Every one of those fields fails *silently* when it is wrong:

- **`contextWindow` too large** — Pi compacts too late and the request overflows.
- **`contextWindow` too small** — Pi compacts early, throwing away context you paid for.
- **`cost` missing** — pi-ai's `calculateCost` reads `model.cost.tiers` and throws a
  `TypeError`, which fails the whole turn with no useful message.
- **`supportsReasoningEffort` missing** — for an `openai-completions` endpoint Pi
  guesses this from the URL, cannot guess it for a gateway, and then silently never
  sends `reasoning_effort`. Reasoning models run without reasoning.
- **`thinkingLevelMap` missing or wrong** — levels the endpoint rejects stay in the
  picker; levels it supports never appear.

Nothing validates any of it. `/model-setup add` asks for the URL, the API type,
the key, the models and a provider id, and derives the rest.

## Where the numbers come from

Three sources, in this order, per field:

| Source | How |
|---|---|
| **Endpoint metadata** | `GET {baseUrl}/models`, read for `context_length`, `max_completion_tokens`, `supported_parameters`, `architecture.input_modalities`, `inputTokenLimit`, `supportedGenerationMethods`, `reasoning_options`, `reasoning_supported_efforts`, … |
| **models.dev** | `https://models.dev/api.json`, reduced to a short-name → capabilities map and cached locally |
| **Model name** | A `128k` / `1m` marker in the id, plus a handful of family defaults |

The add flow prints which source produced each field, so the inference is
reviewable instead of magic.

**A guess never overwrites an existing value.** Only endpoint metadata and
models.dev may replace a value already in `models.json`; a name-based guess may
only fill a field that is absent. When the endpoint is down and models.dev has
never heard of the model, a hand-tuned entry is left alone.

### models.dev details worth knowing

- Aggregators (poe, azure, openrouter, …) list models they do not own, and they are
  visited in alphabetical order — so "first provider that has this model wins"
  yields the aggregator's numbers. First-party providers are matched by model-name
  prefix (`claude*` → anthropic, `gpt*`/`o*` → openai, `glm*` → zai, …) and win
  over every aggregator.
- A successful fetch is cached for 6 hours; a **failed** fetch is cached for 15
  minutes. Without that negative cache, an offline machine waits out a 15-second
  timeout on every add, check and startup. A failure keeps the last successful
  payload, so losing the network downgrades to stale data rather than to nothing.
- The cache lives at `~/.pi/agent/model-config-modelsdev-cache.json`.

## `/model-setup check`

Reconciles the static `models` lists in `models.json` against the endpoint and
models.dev and offers to write the corrections back.

- A model the endpoint no longer lists is **reported, never deleted** — removing
  configuration is not an audit decision.
- A repair only touches fields with a trusted source, so a hand-written `name`, a
  custom `compat` key or a field this package knows nothing about survives.
- The audit is idempotent: a second run reports nothing.
- A file that cannot be parsed aborts before anything is written.

The same audit runs silently once per process at session start. It stays quiet
when it finds nothing, does not run again on `/reload`, and never re-reports a
deviation it is not allowed to fix.

It is **best-effort and non-blocking**: startup is never delayed waiting on a
network probe, and a session that ends immediately (`pi -p "..."`, for instance)
can exit before the audit finishes. An interrupted audit leaves nothing
half-written — every write is atomic and all-or-nothing — it just does nothing
until the next session. `/model-setup check` is the deterministic path.

## Non-interactive use

`check` and `list` are read-only and work in RPC, JSON and print modes; their
report goes to stdout when there is no UI. `add` and `remove` need dialogs and
refuse politely instead of failing halfway.

## Providers managed by another extension

An extension can replace a provider's `models` array at runtime, leaving
`models.json` as little more than a static fallback plus the credential. Writing
model parameters there does nothing, and "repairing" them fights the other
extension. Such ids are therefore reported but never rewritten, and the add flow
warns before you choose one.

Declare them once:

```json
// ~/.pi/agent/model-config.json
{ "runtimeProviders": ["my-provider"] }
```

or `PI_MODEL_CONFIG_RUNTIME_PROVIDERS="a,b"`. Ids match case-insensitively. A
corrupt `model-config.json` degrades to "no options" and says so — it can never
disable the command.

## What it writes

- `models.json` — backed up as `models.json.bak-<timestamp>` first, then written
  atomically (temp file + rename), so an interrupted write cannot truncate it.
- `settings.json` — only `enabledModels`, and only when it is non-empty: adding a
  provider appends `<id>/*` automatically; removing one asks first.

### The `/model` snapshot

The `/model` picker is built from an `enabledModels` snapshot taken when the
session starts, and `agent-session.reload()` does not recompute it. So a provider
added or removed now appears or disappears only in a **new session or after
restarting pi** — `/reload` is not enough. Every message says exactly that.

## API keys

Keys are read from a dialog and written to `models.json`, which pi keeps in
plaintext. They are never printed back: a key short enough for a partial mask to
be revealing is shown by length only. `add` refuses to proceed without an explicit
confirmation when the base URL is `http://` and not loopback, because the key
would travel in the clear.

## Google Gemini

The Gemini REST API authenticates with `?key=`, not a bearer token, so the probe
uses the query parameter, appends `/v1beta` when the base URL has no version
segment, reads `name`/`inputTokenLimit`/`outputTokenLimit`, and filters the list
by `supportedGenerationMethods` to drop embeddings.

## Configuration reference

| File | Purpose |
|---|---|
| `~/.pi/agent/models.json` | Read and written. JSONC: comments and trailing commas allowed. |
| `~/.pi/agent/settings.json` | `enabledModels` only. Strict JSON, like Pi's own settings manager. |
| `~/.pi/agent/model-config.json` | Optional: `runtimeProviders`. |
| `~/.pi/agent/model-config-modelsdev-cache.json` | models.dev cache. Deleting it is safe. |

Set `PI_CODING_AGENT_DIR` to point all of the above elsewhere.

## Development

```bash
npm test        # node --test, no network, no dependencies
npm run lint    # syntax-check every source file
```

Tests build their own `PI_CODING_AGENT_DIR` under a temp directory and inject a
fake `fetch`, so nothing touches the network or your real `models.json`.

## Limits, stated plainly

- Capabilities are only as good as the sources. A gateway that reports nothing and
  a model models.dev has never seen get name-based defaults, which are marked
  `guessed` in the report. Check them, then edit `models.json` by hand.
- `models.json` is the only format written. Providers Pi ships are not modified.
- No cost data is inferred: every model is written with zero cost. Use a spend
  guard if you need budgeting.
- Deleted or vanished models are never removed automatically.

## License

MIT
