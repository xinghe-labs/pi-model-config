// Constants shared by every module.
//
// Nothing here may describe one person's machine. Anything that could differ
// between installs belongs in user config (see ./user-config.js) or is derived
// from the endpoint itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;

// Pi's full set of thinking levels. `xhigh` and `max` are only selectable when
// thinkingLevelMap has a key for them, so the map is written explicitly.
export const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Gateways generally report no pricing. pi-ai's calculateCost reads
// model.cost.tiers and throws a TypeError when cost is missing — which fails the
// whole turn. Models that live in models.json get defaults filled in by Pi, but
// provider objects replaced at runtime by another extension do not, so every
// model this package writes carries cost explicitly.
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Supported API types. The default ordering is arbitrary; the add flow reorders
// it so the guess for the entered URL comes first.
export const API_TYPES = [
	{ value: "openai-completions", hint: "OpenAI-compatible /chat/completions (gateways, proxies, Ollama, vLLM)" },
	{ value: "openai-responses", hint: "OpenAI /responses" },
	{ value: "anthropic-messages", hint: "Anthropic /v1/messages" },
	{ value: "google-generative-ai", hint: "Google Gemini API" },
];

export const API_VALUES = API_TYPES.map((t) => t.value);

// ---- models.dev ----
// The full api.json is several MB; only `short name -> capability` is cached
// locally. A fresh cache is used as-is and refetched at most every 6 hours.
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;
export const MODELS_DEV_TIMEOUT_MS = 15000;
// After a failed fetch, retry no sooner than this. Without a negative cache an
// offline machine waits out the timeout on every add, check and startup.
export const MODELS_DEV_RETRY_MS = 15 * 60 * 1000;
// Bump when the extraction logic changes so stale caches rebuild themselves.
export const MODELS_DEV_CACHE_VERSION = 4;

// Model-name prefix -> the provider that actually makes the model. A "first
// entry wins" scan over every provider is not enough: aggregators (poe, azure,
// openrouter, ...) also list models they do not own, and because providers are
// visited in alphabetical order they can shadow the real entry.
// claude / gpt / o1-o9 are mapped explicitly for exactly that reason:
// models.dev does have first-party anthropic and openai entries.
export const UPSTREAM_BY_PREFIX = [
	[/^claude/i, "anthropic"],
	[/^gpt/i, "openai"],
	[/^chatgpt/i, "openai"],
	[/^o[1-9](?:-|$)/i, "openai"],
	[/^glm/i, "zai"],
	[/^deepseek/i, "deepseek"],
	[/^kimi/i, "moonshotai"],
	[/^gemini/i, "google"],
	[/^grok/i, "xai"],
	[/^qwen/i, "alibaba"],
	[/^mimo/i, "xiaomi"],
	[/^minimax/i, "minimax"],
];

// Some gateways reject requests that carry no User-Agent with a 403.
export const PROBE_UA = `pi-model-config/${packageVersion()}`;
export const PROBE_TIMEOUT_MS = 10000;

// The /model picker is built from an enabledModels snapshot taken when the
// session starts: model-selector.js receives that list at construction and only
// refreshes models in place. agent-session.reload() does not call
// setScopedModels, so /reload does not recompute it.
export const SCOPED_RELOAD_HINT =
	"takes effect in a new session or after restarting pi (/reload does not re-resolve the /model scoped snapshot)";

export function packageVersion() {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}
