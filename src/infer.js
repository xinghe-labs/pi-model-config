// Guesses that need no network: API type from the URL, capability flags from the
// model name, provider id from the host, and the display mask for a key.
import { API_VALUES, DEFAULT_CONTEXT_WINDOW, PI_LEVELS } from "./const.js";

// An Anthropic host or a /messages path beats a Google host, which beats
// /responses, which falls back to plain OpenAI-compatible. Only a default: the
// add flow shows this choice first and the user can override it.
export function inferApi(baseUrl) {
	let host = "";
	let pathname = "";
	try {
		const u = new URL(baseUrl);
		host = u.hostname.toLowerCase();
		pathname = u.pathname.toLowerCase();
	} catch {
		return "openai-completions";
	}
	let guess = "openai-completions";
	if (host.includes("anthropic") || /\/messages\/?$/.test(pathname)) guess = "anthropic-messages";
	else if (/(^|\.)googleapis\.com$/.test(host) || host.includes("generativelanguage")) guess = "google-generative-ai";
	else if (/\/responses\/?$/.test(pathname)) guess = "openai-responses";
	return API_VALUES.includes(guess) ? guess : "openai-completions";
}

// A size marker in the name ("128k", "1m", "32b"-style numbers excluded by the
// unit) wins; otherwise only famous families get a starting value. Everything
// else falls back to the default, and the add flow prints what was inferred.
export function inferContextWindow(id) {
	const m = /(?:^|[^0-9a-z])(\d{1,4})\s*([km])(?![0-9a-z])/i.exec(id);
	if (m) {
		const n = Number(m[1]) * (m[2].toLowerCase() === "m" ? 1000000 : 1000);
		if (n >= 1000 && n <= 10000000) return n;
	}
	if (/^claude/i.test(id)) return 200000;
	if (/^gemini/i.test(id)) return 1000000;
	if (/^o[134](-|$)/i.test(id)) return 200000;
	return DEFAULT_CONTEXT_WINDOW;
}

export const REASONING_HINTS = /(?:^|[^a-z])(?:o[134](?:-|$)|r1(?:-|$)|reasoner|reasoning|thinking|qwq|qvq)/i;
export const VISION_HINTS = /(?:^|[^a-z])vl(?:[^a-z]|$)|vision|llava|pixtral|internvl|gpt-4o|gpt-4\.1|claude-[34]|gemini/i;

// Build pi's thinkingLevelMap from the effort values an endpoint reports.
// Levels must be written as an explicit null to close off pi's defaults —
// omitting a key leaves it enabled — and xhigh/max only exist when keyed.
// Values outside PI_LEVELS (models.dev also reports "none", "default", ...) are
// dropped rather than written, since pi would not understand them.
export function thinkingMapFromEfforts(efforts) {
	if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
	const usable = efforts.filter((e) => typeof e === "string" && PI_LEVELS.includes(e));
	const map = {};
	for (const level of PI_LEVELS) map[level] = usable.includes(level) ? level : null;
	return map;
}

export function suggestProviderId(baseUrl) {
	try {
		const host = new URL(baseUrl).hostname;
		return host.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "custom";
	} catch {
		return "custom";
	}
}

// Never render a whole key, and never render most of one either: first 6 + last 4
// of a 13-character key is 11 of its 13 characters. Anything short enough for a
// partial mask to be revealing is reported by length alone.
const MASK_MIN_LENGTH = 24;

export function maskKey(key) {
	if (!key) return "(not set)";
	if (key === "none") return "none (no key)";
	if (key.length < MASK_MIN_LENGTH) return `(set, ${key.length} chars)`;
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// The short name used to match a model id against models.dev: gateways prefix ids
// with "global:", "vendor/", or both.
export function shortModelName(id) {
	return String(id).split(/[/:]/).pop().toLowerCase();
}

// Gateways spell the same model many ways: `deepseek-4.1-flash`,
// `deepseek-v4.1-flash`, `deepseek-v4p1-flash`. Normalize those cosmetic
// differences so a models.dev entry can still be found by name.
export function modelAliasKey(id) {
	let name = shortModelName(id);
	// Region-separated entries are exact matches when the gateway uses the same
	// suffix; for fuzzy matching drop it so the base model can still match.
	name = name.replace(/@[a-z0-9-]+$/i, "");
	// A gateway may expose the same model with a background/foreground suffix.
	name = name.replace(/(?:[-_.]|^)background$/i, "");
	// `4p1` is a common spelling of `4.1`.
	name = name.replace(/(\d)p(\d)/g, "$1.$2");
	// `v4.1` and `4.1` are the same version marker.
	name = name.replace(/(^|[^a-z0-9])v(?=\d)/g, "$1");
	return name.replace(/[^a-z0-9]+/g, "");
}

// Snapshot suffixes (`-1017`, `-260828`) should not stop an undated gateway id
// from matching the corresponding models.dev entry.
export function modelAliasKeys(id) {
	const name = shortModelName(id);
	const keys = new Set([modelAliasKey(name)]);
	const undated = name.replace(/[-_.](?:\d{4}|\d{6}|\d{8})$/i, "");
	if (undated !== name) keys.add(modelAliasKey(undated));
	return [...keys].filter(Boolean);
}
