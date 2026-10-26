// models.dev: fetch once, keep only what is needed, cache with two TTLs.
//
// The full api.json is several MB and mostly irrelevant, so only a
// `short name -> capabilities` map is stored. A failure is cached for a much
// shorter time than a success: offline, every add / check / startup would
// otherwise wait out a 15s timeout before falling back to heuristics.
import fs from "node:fs";
import {
	MODELS_DEV_CACHE_VERSION,
	MODELS_DEV_RETRY_MS,
	MODELS_DEV_TIMEOUT_MS,
	MODELS_DEV_TTL_MS,
	MODELS_DEV_URL,
	PROBE_UA,
	UPSTREAM_BY_PREFIX,
} from "./const.js";
import { shortModelName } from "./infer.js";
import { readFileIfExists, writeJson } from "./json-file.js";
import { agentDir, officialCachePath } from "./paths.js";

export function normalizeOfficialModel(m) {
	const efforts = [];
	for (const opt of Array.isArray(m?.reasoning_options) ? m.reasoning_options : []) {
		if (opt?.type === "effort" && Array.isArray(opt.values)) efforts.push(...opt.values);
	}
	const ctx = m?.limit?.context;
	const out = m?.limit?.output;
	const aliases = [];
	if (typeof m?.canonical_model_id === "string") {
		const canonical = shortModelName(m.canonical_model_id);
		if (canonical) aliases.push(canonical);
	}
	return {
		context: Number.isInteger(ctx) && ctx > 0 ? ctx : undefined,
		output: Number.isInteger(out) && out > 0 ? out : undefined,
		reasoning: m?.reasoning === true,
		image: Array.isArray(m?.modalities?.input) && m.modalities.input.includes("image"),
		efforts: [...new Set(efforts)],
		aliases: [...new Set(aliases)],
	};
}

// Keep short names only. An entry from the provider that actually makes the model
// goes to `primary` and overwrites anything else; every other provider can only
// fill in a name that no first-party entry claimed.
export function extractOfficial(data) {
	const primary = {};
	const secondary = {};
	for (const [pid, provider] of Object.entries(data ?? {})) {
		const models = provider?.models;
		if (!models || typeof models !== "object") continue;
		for (const [mid, m] of Object.entries(models)) {
			const key = shortModelName(mid);
			if (!key) continue;
			const expected = UPSTREAM_BY_PREFIX.find(([re]) => re.test(key))?.[1];
			const normalized = { ...normalizeOfficialModel(m), firstParty: pid === expected };
			if (pid === expected) {
				primary[key] = normalized;
			} else if (!secondary[key]) {
				secondary[key] = normalized;
			}
		}
	}
	return { ...secondary, ...primary };
}

export function readOfficialCache() {
	// A cache file that cannot be read (permissions, I/O error) is the same as no
	// cache: throwing here would reject loadOfficialData and silently kill the
	// startup audit via its background catch.
	try {
		const raw = readFileIfExists(officialCachePath());
		if (raw === undefined) return undefined;
		const parsed = JSON.parse(raw);
		if (parsed?.official && typeof parsed.fetchedAt === "number" && parsed.version === MODELS_DEV_CACHE_VERSION) {
			return parsed;
		}
	} catch {
		/* a corrupt or unreadable cache is the same as no cache */
	}
	return undefined;
}

export function writeOfficialCache(payload) {
	try {
		fs.mkdirSync(agentDir(), { recursive: true });
		writeJson(officialCachePath(), payload);
	} catch {
		/* a cache write failure must not break the caller */
	}
}

// `fetchImpl` is injectable so tests never touch the network.
export async function loadOfficialData({ fetchImpl = fetch, now = () => Date.now() } = {}) {
	const cached = readOfficialCache();
	const ttl = cached?.ok === false ? MODELS_DEV_RETRY_MS : MODELS_DEV_TTL_MS;
	if (cached && now() - cached.fetchedAt < ttl) return cached.official;
	// Shared by the fetch failure and the empty-catalog fall-through below.
	const recordFailure = () => {
		// Re-read before recording the failure: a concurrent caller may have
		// refreshed the cache while this request was in flight, and clobbering that
		// fresh success with a failure marker would downgrade it to a 15-minute
		// negative cache for no reason. A different fetchedAt proves the concurrent
		// write; the stale success we started from does not count as one.
		const latest = readOfficialCache();
		if (latest?.fetchedAt !== cached?.fetchedAt && latest?.ok && latest.official && Object.keys(latest.official).length) {
			return latest.official;
		}
		// Record the failure but keep the previous successful payload, so a transient
		// outage downgrades to stale data instead of to nothing.
		const official = latest?.official ?? cached?.official ?? {};
		writeOfficialCache({ version: MODELS_DEV_CACHE_VERSION, fetchedAt: now(), ok: false, official });
		return official;
	};
	try {
		const res = await fetchImpl(MODELS_DEV_URL, {
			headers: { "User-Agent": PROBE_UA },
			signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const official = extractOfficial(await res.json());
		// An empty catalog is a failure like any other: falling through with
		// undefined would hand callers nothing and poison the alias index.
		if (!Object.keys(official).length) throw new Error("models.dev catalog was empty");
		writeOfficialCache({ version: MODELS_DEV_CACHE_VERSION, fetchedAt: now(), ok: true, official });
		return official;
	} catch {
		/* offline, malformed, or empty: degrade to the last good data */
		return recordFailure();
	}
}
