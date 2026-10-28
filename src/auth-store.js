// Read-only access to pi's credential store (~/.pi/agent/auth.json).
//
// pi's own precedence for a custom provider's key is: the auth.json credential
// ("stored credential") first, then the models.json `apiKey` field. Historically
// this extension only read the models.json field, so a user who followed pi's
// auth.json flow got unauthenticated probes (401s) from `check` and
// `list --ping` even though the runtime worked fine. Probing now falls back to
// the same credential pi would use.
//
// This module never writes auth.json: pi owns that file (file-locked, mode
// 0600, concurrent writers), and racing its lock from an extension is not a
// bet worth taking. A broken or unreadable auth.json degrades to "no
// credential": probing is best-effort, and pi itself surfaces any real problem
// at request time.
import { statSync } from "node:fs";
import { readFileIfExists } from "./json-file.js";
import { authStorePath } from "./paths.js";

let cache; // { path, mtimeMs, store }

// api_key credentials carry a usable key; oauth credentials do not (the bearer
// is minted by pi's refresh flow), and anything else is not ours to interpret.
function apiKeyFor(store, pid) {
	const entry = store?.[pid];
	if (entry?.type !== "api_key" || typeof entry.key !== "string" || !entry.key.trim()) return undefined;
	return entry.key.trim();
}

function loadStore(path) {
	let mtimeMs;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return {};
	}
	if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.store;
	const raw = readFileIfExists(path);
	let store = {};
	if (raw !== undefined) {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed;
		} catch {
			/* a torn or hand-broken file: degrade to empty, pi will report at runtime */
		}
	}
	cache = { path, mtimeMs, store };
	return store;
}

// The key pi would use for this provider: models.json first (that is also where
// this extension writes), then the auth.json credential. Mirrors the models.json
// "none" convention — a literal "none" means no key, not a key named none.
export function resolveProbeKey(provider, pid, { authStore } = {}) {
	const explicit = provider?.apiKey && provider.apiKey !== "none" ? provider.apiKey : "";
	if (explicit) return explicit;
	return apiKeyFor(authStore ?? loadStore(authStorePath()), pid) ?? "";
}

// Whether pi holds a usable api_key credential for this provider (for reports;
// never exposes the key itself).
export function authStoreKey(pid) {
	return Boolean(apiKeyFor(loadStore(authStorePath()), pid));
}
