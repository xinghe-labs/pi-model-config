# pi-model-config

[![npm version](https://img.shields.io/npm/v/pi-model-config?color=cb3837&label=npm)](https://www.npmjs.com/package/pi-model-config)
[![npm downloads](https://img.shields.io/npm/dm/pi-model-config?color=cb3837)](https://www.npmjs.com/package/pi-model-config)
[![license](https://img.shields.io/github/license/xinghe-labs/pi-model-config?color=blue)](./LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/xinghe-labs/pi-model-config?include_prereleases=false&color=blue)](https://github.com/xinghe-labs/pi-model-config/releases)
[![node](https://img.shields.io/node/v/pi-model-config?color=339933)](package.json)

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
/model-config                          menu
/model-config add                      add or replace a provider (five questions)
/model-config add <url> <key>          add from a URL and key, no questions
/model-config edit                     change one provider's URL / key / api / id
/model-config sync                     add new / remove gone / repair drifting models
/model-config check [--fix]            reconcile model parameters (--fix applies repairs without asking)
/model-config list [--ping]            show configured providers (--ping adds live endpoint status)
/model-config default [pid/model]      show or set the default provider, model and thinking level
/model-config remove                   delete a provider
/model-config models <pid>              remove models you do not want
```

`/model-config` is the only command name (the old `/model-setup` spelling was removed in 0.4.0).

## What it looks like

```text
$ /model-config add https://my-gateway.example.com/v1 sk-... --all

已配置 my-gateway-example-com：3 个模型，api=openai-completions，key=sk-…sed
- deepseek-v4.1-flash  ctx=1048576 (models.dev)  max=393216 (models.dev)  reasoning (models.dev) [low/high/max]  +image (models.dev)
- glm-5.3-flash        ctx=131072 (endpoint)     max=8192   (endpoint)     reasoning (endpoint)     [low/medium/high/xhigh/max]
- whisper-1            ctx=128000 (guess)        max=16384  (guess)
参数推断来源：端点元数据 > models.dev > 模型名。随时可以手动编辑 models.json，或用 /model-config check 重新对账。原文件已备份。
```

Every field in that output names where it came from (`endpoint` / `models.dev` /
`guess`), and check and sync plans read the same way. Nothing is written until
you add `--all` / `--only` or answer the interactive prompt, and every write is
backed up first.

The one-liner form is the point of the two newest commands: point it at a gateway
and it fills in `contextWindow`, `maxTokens`, reasoning, image input and thinking
levels from the endpoint's own metadata, so nothing has to be typed. Cost is not
inferred. Every model's cost falls back to the vendor's list price from
models.dev when it has one (a gateway's actual rates differ — this is a floor
for accounting, not a billing claim); hand-edited prices are never overwritten.
See "models.dev gotchas" below.

```bash
# what would be added, and with which numbers — writes nothing
/model-config add https://gw.example.com/v1 sk-... 

# actually add three models from that endpoint
/model-config add https://gw.example.com/v1 sk-... --only gpt-4o,deepseek-v4-pro

# the endpoint changed: add what is new, drop what it stopped serving
/model-config sync --all
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

Nothing validates any of it. `/model-config add` asks for the URL, the API type,
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

## `/model-config edit`

Change one provider's connection fields without touching anything else. Where
`add` is a whole-table replace (re-probes, rewrites the model list), `edit`
updates only the fields you name and keeps the model list as-is.

```bash
# interactive: pick a provider, then answer per field (Enter keeps a field)
/model-config edit

# scripted: inspect the plan first, add --all when it looks right
/model-config edit gw --url https://new-gw.example.com/v1 --key sk-new
/model-config edit gw --url https://new-gw.example.com/v1 --all

# rename (handles the old id's enabledModels entries)
/model-config edit gw --id new-name --all
```

Rules:

- **A changed baseUrl or api probes the new endpoint first**: a failed probe
  writes nothing, so a mistyped URL cannot turn a working configuration into a
  broken one;
- **A key-only edit does not probe** (the endpoint validates the key the next
  time sync or check runs);
- The scripted form refuses a non-loopback `http://` endpoint (same gate as
  `add`);
- baseUrl / apiKey changes need no restart: another extension (sub-models and
  the like) re-reads models.json on every refresh.

## `/model-config sync`

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

## `/model-config models`

Hand-manages one provider's model list: pick models to remove, confirm, done.
Deleted models are recorded in `hiddenModels` (in `model-config.json`), so
`sync` will not re-add them on the next run — removing a model is a decision,
not something an audit undoes.

```bash
# interactive: pick a provider, then pick models until done
/model-config models

# scripted: remove exactly these, no dialogs
/model-config models my-gateway --only old-model,another-model
```

To restore a hidden model, run `sync --only <id>` (which also removes it from
the ignore list), or delete its id from `hiddenModels` in `model-config.json`
and run `sync --all`. The menu path of `sync` also asks before restoring hidden
models the endpoint still serves.

## `/model-config check`

Reconciles the static `models` lists in `models.json` against the endpoint and
models.dev and offers to write the corrections back.

- A model the endpoint no longer lists is **reported, never deleted** — removing
  configuration is not an audit decision.
- A repair only touches fields with a trusted source, so a hand-written `name`, a
  custom `compat` key or a field this package knows nothing about survives.
- `--fix` is consent in writing: every deviation found is repaired without a
  per-provider dialog (for scripts and `pi -p`).
- The audit is idempotent: a second run reports nothing.
- A file that cannot be parsed aborts before anything is written.

The same audit runs silently once per process at session start. It stays quiet
when it finds nothing and does not run again on `/reload`. A deviation it is not
allowed to fix (a vanished model, say) is reported once per session — that is a
deliberate refusal to delete on your behalf, not a nagging bug.

It is **best-effort and non-blocking**: startup is never delayed waiting on a
network probe, and a session that ends immediately (`pi -p "..."`, for instance)
can exit before the audit finishes. An interrupted audit leaves nothing
half-written — every write is atomic and all-or-nothing — it just does nothing
until the next session. `/model-config check` is the deterministic path.

## `/model-config list --ping` and `default`

Plain `list` reads files only and never touches the network. `--ping` sends one
probe per endpoint and annotates each with reachability and latency — answering
"is hub up again?" without the much heavier `check`:

```bash
/model-config list --ping
# - me
#     https://…  |  api=openai-completions  |  key=sk-8a8…117e  |  5 models
#     ✓ reachable (214ms, HTTP 200)
```

`default` turns hand-editing three settings.json fields into one command:

```bash
/model-config default                       # show current defaults
/model-config default me/glm-5.3 high --all # scripted set (model + thinking level)
```

Rules: the scripted form only prints a plan without `--all`; the chosen model is
validated against `enabledModels` and models.json, so picking something pi
cannot resolve is refused instead of written into settings; the write is backed
up first and takes effect in a new session.

## Non-interactive use

`check`, `list`, `sync` and the `<url> <key>` form of `add` work in RPC, JSON and
print modes; their report goes to stdout when there is no UI.

What differs is consent. `sync` and `add` take it from a flag (`--all` /
`--only`), so an automated run gets the plan and applies exactly what was asked,
and `sync` only adds a delete confirmation when a UI is present. For `check` the
flag is `--fix`: without it and without a UI it reports and writes nothing,
pointing at `sync --all` or `check --fix` for the applying. `remove`, the menu,
and `add` without arguments need dialogs and refuse politely instead of failing
halfway.

One extra gate: scripted `add` refuses a non-loopback `http://` endpoint outright
(the API key would travel in the clear, and there is no dialog to ask with). Use
https, run the interactive `add` to confirm, or pass `--all` explicitly to accept
the risk.

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

- `models.json` — backed up as `models.json.bak-<millisecond timestamp>` first,
  then written atomically (temp file + rename), so an interrupted write cannot
  truncate it and a rewrite cannot widen a restrictive mode such as 0600.
  Timestamped backups are kept for all three files this package writes
  (models.json / settings.json / model-config.json), 5 newest each; if a backup
  itself fails, a warning is shown and the write proceeds anyway. Every write
  rewrites the whole file, so hand-written `//` comments are not preserved.
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

Probing also understands pi's credential store: when a provider has no
`apiKey` in `models.json`, `check`, `list --ping` and `edit` fall back to the
`api_key` credential pi keeps in `~/.pi/agent/auth.json` (the same
"stored credential" the runtime prefers). OAuth credentials are ignored —
their bearers are minted by pi's refresh flow. This extension reads
`auth.json` but never writes it; the file is file-locked and owned by pi.

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
| `~/.pi/agent/model-config.json` | Optional: `runtimeProviders`, `hiddenModels`. |
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
- Cost: filled from models.dev's vendor list price when the model has one, so
  cost accounting is a floor rather than all zeros. A gateway's real rates
differ from list prices, and a hand-edited `cost` is never overwritten — write
  your gateway's actual rates into models.json and the audit will keep them.
- Deleted or vanished models are never removed automatically.

## Acknowledgments

Built for, and first shared with, the [LINUX DO](https://linux.do) community.

## License

MIT
