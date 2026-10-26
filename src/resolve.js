// Merging three sources into one model definition, and diffing that definition
// against what is already in models.json.
//
// Precedence: endpoint metadata > models.dev > name heuristic. Each field also
// records which source produced it, because the audit may only overwrite a value
// with a trusted one — a pure guess must never silently downgrade a hand-tuned
// entry (typical case: the endpoint is down and models.dev has never heard of
// the model).
import { DEFAULT_MAX_TOKENS, PI_LEVELS, ZERO_COST } from "./const.js";
import {
	REASONING_HINTS,
	VISION_HINTS,
	inferContextWindow,
	modelAliasKeys,
	shortModelName,
	thinkingMapFromEfforts,
} from "./infer.js";

const ENDPOINT = "endpoint";
const OFFICIAL = "models.dev";
const GUESS = "guess";

// Build a fuzzy alias index once per official-data object. models.dev spells
// versions differently from many gateways (`v4.1` vs `4.1`, `v4p1`), and
// canonical ids can provide authoritative aliases when the model key is legacy.
const officialAliasIndexes = new WeakMap();

function aliasIndex(official) {
	let index = officialAliasIndexes.get(official);
	if (index) return index;
	index = new Map();
	for (const [name, meta] of Object.entries(official ?? {})) {
		const names = [name, ...(Array.isArray(meta?.aliases) ? meta.aliases : [])];
		for (const alias of names) {
			for (const key of modelAliasKeys(alias)) {
				const candidates = index.get(key) ?? [];
				if (!candidates.includes(meta)) candidates.push(meta);
				index.set(key, candidates);
			}
		}
	}
	officialAliasIndexes.set(official, index);
	return index;
}

function pickAliasCandidate(id, candidates) {
	if (!candidates?.length) return undefined;
	const wanted = shortModelName(id);
	return [...candidates].sort((a, b) => {
		// A first-party entry beats an aggregator even if both claim the same id.
		if (Boolean(a.firstParty) !== Boolean(b.firstParty)) return a.firstParty ? -1 : 1;
		const aliasesA = Array.isArray(a.aliases) ? a.aliases : [];
		const aliasesB = Array.isArray(b.aliases) ? b.aliases : [];
		const exactA = aliasesA.includes(wanted) ? 0 : 1;
		const exactB = aliasesB.includes(wanted) ? 0 : 1;
		return exactA - exactB;
	})[0];
}

export function lookupOfficialModel(id, official) {
	const exact = official?.[shortModelName(id)];
	// A first-party exact match is the strongest evidence and needs no alias pass.
	if (exact?.firstParty) return exact;
	let aliasMatch;
	for (const key of modelAliasKeys(id)) {
		aliasMatch = pickAliasCandidate(id, aliasIndex(official).get(key));
		if (aliasMatch) break;
	}
	// An aggregator can happen to use the exact gateway spelling while carrying
	// wrong limits; a first-party canonical alias is more trustworthy.
	if (aliasMatch?.firstParty) return aliasMatch;
	return exact ?? aliasMatch;
}

export const SOURCE_LABEL = {
	[ENDPOINT]: "endpoint",
	[OFFICIAL]: "models.dev",
	[GUESS]: "guessed",
};

const fieldSource = (hasEndpoint, hasOfficial) => (hasEndpoint ? ENDPOINT : hasOfficial ? OFFICIAL : GUESS);

export function resolveModelMeta(id, api, endpointMeta, official) {
	const off = lookupOfficialModel(id, official);
	const contextWindow = endpointMeta?.contextWindow ?? off?.context ?? inferContextWindow(id);
	const vision = endpointMeta?.vision ?? off?.image ?? VISION_HINTS.test(id);
	const reasoning = endpointMeta?.reasoning ?? off?.reasoning ?? REASONING_HINTS.test(id);
	const maxTokens = endpointMeta?.maxTokens ?? off?.output ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const efforts = endpointMeta?.efforts ?? off?.efforts;

	const def = {
		id,
		name: id,
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens,
		cost: { ...ZERO_COST },
	};
	if (reasoning) {
		// For openai-completions, pi auto-detects supportsReasoningEffort from the
		// URL and cannot detect a custom gateway, so without this flag it never
		// sends reasoning_effort at all.
		if (api === undefined || api === "openai-completions") def.compat = { supportsReasoningEffort: true };
		const map = thinkingMapFromEfforts(efforts);
		// The map is written even when every value is null: pi only offers the
		// xhigh/max thinking levels when a thinkingLevelMap key exists, and an
		// explicit null on a level means "the endpoint rejected this level" —
		// which is information, not absence of the feature.
		if (map) def.thinkingLevelMap = map;
	}

	return {
		def,
		sources: {
			contextWindow: fieldSource(endpointMeta?.contextWindow !== undefined, off?.context !== undefined),
			maxTokens: fieldSource(endpointMeta?.maxTokens !== undefined, off?.output !== undefined),
			reasoning: fieldSource(endpointMeta?.reasoning !== undefined, off?.reasoning !== undefined),
			vision: fieldSource(endpointMeta?.vision !== undefined, off?.image !== undefined),
			efforts: fieldSource(
				Array.isArray(endpointMeta?.efforts) && endpointMeta.efforts.length > 0,
				Array.isArray(off?.efforts) && off.efforts.length > 0,
			),
		},
	};
}

// A guessed value may only fill a field that is missing; it may never replace one
// that is present, whatever its origin.
export function trusted(source, oldValue) {
	return source !== GUESS || oldValue === undefined;
}

export function sameThinkingMap(a, b) {
	if (!a || !b) return a === b;
	return PI_LEVELS.every((l) => (a[l] ?? null) === (b[l] ?? null));
}

// Human-readable deviations; an empty array means "consistent".
export function diffModel(existing, resolved) {
	const { def, sources } = resolved;
	const diffs = [];
	if (trusted(sources.contextWindow, existing.contextWindow) && existing.contextWindow !== def.contextWindow)
		diffs.push(`ctx ${existing.contextWindow ?? "?"} -> ${def.contextWindow} (${SOURCE_LABEL[sources.contextWindow]})`);
	if (trusted(sources.maxTokens, existing.maxTokens) && existing.maxTokens !== def.maxTokens)
		diffs.push(`max ${existing.maxTokens ?? "?"} -> ${def.maxTokens} (${SOURCE_LABEL[sources.maxTokens]})`);
	const oldReasoning = existing.reasoning === true;
	if (trusted(sources.reasoning, existing.reasoning) && oldReasoning !== def.reasoning)
		diffs.push(`reasoning ${oldReasoning} -> ${def.reasoning} (${SOURCE_LABEL[sources.reasoning]})`);
	const oldVision = Array.isArray(existing.input) && existing.input.includes("image");
	const newVision = Array.isArray(def.input) && def.input.includes("image");
	if (trusted(sources.vision, existing.input) && oldVision !== newVision)
		diffs.push(`image input ${oldVision ? "on" : "off"} -> ${newVision ? "on" : "off"} (${SOURCE_LABEL[sources.vision]})`);
	if (def.reasoning) {
		if (def.compat?.supportsReasoningEffort === true && existing.compat?.supportsReasoningEffort !== true) {
			diffs.push("+reasoning_effort support");
		}
		if (def.thinkingLevelMap && !sameThinkingMap(existing.thinkingLevelMap, def.thinkingLevelMap)) {
			const levels = Object.values(def.thinkingLevelMap).filter(Boolean);
			diffs.push(`thinking levels -> ${levels.length ? levels.join("/") : "default"} (${SOURCE_LABEL[sources.efforts]})`);
		}
	}
	return diffs;
}

// Build the repaired definition. Only fields with a trusted source (or fields
// that were missing) are replaced, so a hand-edited name or an extra compat flag
// survives the audit.
export function repairedDef(existing, resolved) {
	const next = { ...existing };
	if (!next.cost || typeof next.cost !== "object") next.cost = { ...ZERO_COST };
	if (next.name === undefined) next.name = next.id;
	const { def, sources } = resolved;
	if (trusted(sources.contextWindow, existing.contextWindow)) next.contextWindow = def.contextWindow;
	if (trusted(sources.maxTokens, existing.maxTokens)) next.maxTokens = def.maxTokens;
	if (trusted(sources.reasoning, existing.reasoning)) {
		next.reasoning = def.reasoning;
		if (trusted(sources.vision, existing.input)) next.input = def.input;
	} else if (trusted(sources.vision, existing.input)) {
		next.input = def.input;
	}
	if (next.reasoning === true) {
		if (def.compat) next.compat = { ...(next.compat ?? {}), ...def.compat };
		if (def.thinkingLevelMap) next.thinkingLevelMap = def.thinkingLevelMap;
	} else {
		delete next.thinkingLevelMap;
		if (next.compat && "supportsReasoningEffort" in next.compat) {
			const rest = { ...next.compat };
			delete rest.supportsReasoningEffort;
			if (Object.keys(rest).length) next.compat = rest;
			else delete next.compat;
		}
	}
	return next;
}
