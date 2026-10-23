# pi-model-config

**A URL and a key. The model's numbers are derived, not typed.**

A Pi extension for adding a third-party, self-hosted or proxied model endpoint to
`models.json` — and for keeping that entry in step with the endpoint afterwards:
re-add what appeared, drop what disappeared, repair what drifted, all against the
endpoint and [models.dev](https://models.dev).

```bash
pi install npm:pi-model-config
```

Start a new session afterwards (or `/reload`): a package installed mid-session is
not loaded until Pi re-reads its package list.

```text
/model-setup                          menu
/model-setup add                      add or replace a provider (five questions)
/model-setup add <url> <key>          add from a URL and key, no questions
/model-setup sync                     add new / remove gone / repair drifting models
/model-setup check                    reconcile model parameters (never changes the list)
/model-setup list                     show configured providers
/model-setup remove                   delete a provider
/model-setup models <pid>              remove models you do not want
```

`/model-config` is still registered as an alias.

The one-liner form is the point of the two newest commands: point it at a gateway
and it fills in `contextWindow`, `maxTokens`, reasoning, image input, thinking
levels and `cost` from the endpoint's own metadata, so nothing has to be typed.

```bash
# what would be added, and with which numbers — writes nothing
/model-setup add https://gw.example.com/v1 sk-... 

# actually add three models from that endpoint
/model-setup add https://gw.example.com/v1 sk-... --only gpt-4o,deepseek-v4-pro

# the endpoint changed: add what is new, drop what it stopped serving
/model-setup sync --all
```

`add` and `sync` print a plan and **write nothing** until `--all` or `--only` is
given. There is no mode where a typo silently rewrites the file: `--onlyy` is an
error, not a no-op. `--dry-run` forces the preview even when a writer flag is
present, and `--key` / `$PI_MODEL_CONFIG_API_KEY` avoid putting the key in shell
history.

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
| --- | --- |
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

## `/model-setup sync`

Makes the `models` list match what the endpoint serves right now:

- **adds** models the endpoint lists and the configuration does not have,
- **removes** models the endpoint no longer lists (with a confirmation when
  there is a UI, and always after a backup),
- **repairs** parameters that drifted, using the same rules as `check`,
- **fills** a provider that has no model list at all (`"models": []`, or no key),
  which is what a hand-written `{ baseUrl, api, apiKey }` looks like,
- leaves everything else — including fields it does not understand — alone.

An endpoint that lists the same id twice yields one entry, not two.

Two rules make it safe to run against a flaky gateway:

1. **Removal requires a successful probe.** If the endpoint cannot be read, the
   provider is skipped entirely — no removal, and no repair from guesses either.
   A gateway that is down for a minute can never empty a configuration.
2. **Runtime providers are skipped.** Their model list is produced by another
   extension at refresh time; `models.json` holds a static fallback that is
   *supposed* to differ from live data.

`--no-prune` keeps models the endpoint stopped listing but still adds and
repairs. `--only <ids>` limits which *new* models are added; it never limits
removals, so a partial sync cannot leave a stale list behind.

## `/model-setup models`

Hand-manages one provider's model list: pick models to remove, confirm, done.
Deleted models are recorded in `hiddenModels` (in `model-config.json`), so
`sync` will not re-add them on the next run — removing a model is a decision,
not something an audit undoes.

```bash
# interactive: pick a provider, then pick models until done
/model-setup models

# scripted: remove exactly these, no dialogs
/model-setup models my-gateway --only old-model,another-model
```

To restore a hidden model, delete its id from `hiddenModels` in
`model-config.json` and run `sync --all`.

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

`check`, `list`, `sync` and the `<url> <key>` form of `add` work in RPC, JSON and
print modes; their report goes to stdout when there is no UI.

What differs is consent. `sync` and `add` take it from a flag (`--all` /
`--only`), so an automated run gets the plan and applies exactly what was asked,
and `sync` only adds a delete confirmation when a UI is present. `check` has no
such flag — it applies repairs by asking — so without a UI it reports and writes
nothing, pointing at `sync --all` for the applying. `remove`, the menu, and `add`
without arguments need dialogs and refuse politely instead of failing halfway.

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
  Only the 5 newest timestamped backups are kept; if the backup itself fails, a
  warning is shown and the write proceeds anyway.
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
| --- | --- |
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
