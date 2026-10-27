import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MODELS_DEV_CACHE_VERSION, MODELS_DEV_RETRY_MS, MODELS_DEV_TTL_MS } from "../src/const.js";
import { extractOfficial, loadOfficialData, normalizeOfficialModel, readOfficialCache } from "../src/official.js";

// Every test gets its own agent directory so the cache is never shared.
function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-official-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

const cacheFile = (dir) => path.join(dir, "model-config-modelsdev-cache.json");

function writeCache(dir, payload) {
	fs.writeFileSync(cacheFile(dir), JSON.stringify(payload));
}

const apiJson = {
	anthropic: {
		models: {
			"claude-opus-4-6": {
				limit: { context: 1000000, output: 32000 },
				reasoning: true,
				modalities: { input: ["text", "image"] },
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
				cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
			},
		},
	},
	// An aggregator that also lists anthropic's model. Alphabetically first, so a
	// naive "first one wins" scan would take its (wrong) numbers.
	azure: {
		models: {
			"claude-opus-4-6": { limit: { context: 200000, output: 8192 }, reasoning: false, modalities: { input: ["text"] } },
			"azure-only-model": { limit: { context: 64000, output: 4096 } },
		},
	},
	zai: { models: { "glm-5.3": { limit: { context: 200000, output: 131072 }, reasoning: true } } },
};

test("normalizeOfficialModel keeps only what is used", () => {
	const got = normalizeOfficialModel({
		limit: { context: 1000000, output: 32000 },
		reasoning: true,
		modalities: { input: ["text", "image"] },
		reasoning_options: [{ type: "effort", values: ["low", "high", "high"] }],
		canonical_model_id: "deepseek/deepseek-v4.1-flash-1017",
		cost: { input: 2.5, output: 10, cache_read: 0.25 },
	});
	assert.deepEqual(got, {
		context: 1000000,
		output: 32000,
		reasoning: true,
		image: true,
		efforts: ["low", "high"],
		aliases: ["deepseek-v4.1-flash-1017"],
		cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 },
	});
});

test("normalizeOfficialModel rejects nonsense limits", () => {
	const got = normalizeOfficialModel({ limit: { context: -1, output: 0 } });
	assert.equal(got.context, undefined);
	assert.equal(got.output, undefined);
	assert.equal(got.reasoning, false);
	assert.equal(got.image, false);
	assert.deepEqual(got.efforts, []);
	assert.deepEqual(got.aliases, []);
	assert.equal(got.cost, undefined, "no price data means no cost key at all");
});

test("extractOfficial lets the real provider win over an aggregator", () => {
	const got = extractOfficial(apiJson);
	// anthropic's 1M context, not azure's 200k.
	assert.equal(got["claude-opus-4-6"].context, 1000000);
	assert.equal(got["claude-opus-4-6"].reasoning, true);
	assert.equal(got["claude-opus-4-6"].firstParty, true);
	// A model only an aggregator lists is still available.
	assert.equal(got["azure-only-model"].context, 64000);
	assert.equal(got["azure-only-model"].firstParty, false);
});

test("extractOfficial maps glm to zai", () => {
	assert.equal(extractOfficial(apiJson)["glm-5.3"].context, 200000);
});

test("extractOfficial handles prefixes and missing models", () => {
	const got = extractOfficial({
		moonshotai: { models: { "moonshotai/kimi-k3": { limit: { context: 256000 } } } },
		empty: {},
		broken: { models: null },
	});
	assert.equal(got["kimi-k3"].context, 256000);
	assert.deepEqual(extractOfficial(undefined), {});
	assert.deepEqual(extractOfficial({}), {});
});

test("loadOfficialData fetches once and then serves the cache", async (t) => {
	const dir = withAgentDir(t);
	let calls = 0;
	const fetchImpl = async () => {
		calls += 1;
		return { ok: true, json: async () => apiJson };
	};
	const first = await loadOfficialData({ fetchImpl });
	assert.equal(calls, 1);
	assert.equal(first["claude-opus-4-6"].context, 1000000);
	assert.equal(readOfficialCache().ok, true);

	const second = await loadOfficialData({ fetchImpl });
	assert.equal(calls, 1, "a fresh cache must not refetch");
	assert.deepEqual(second, first);
	void dir;
});

test("a failed fetch is cached briefly and keeps the last good data", async (t) => {
	const dir = withAgentDir(t);
	writeCache(dir, {
		version: MODELS_DEV_CACHE_VERSION,
		// Just past the success TTL, so a refetch is attempted.
		fetchedAt: Date.now() - MODELS_DEV_TTL_MS - 1000,
		ok: true,
		official: { "glm-5.3": { context: 200000 } },
	});

	const broken = [
		async () => {
			throw new Error("offline");
		},
		async () => ({ ok: false, status: 503, json: async () => ({}) }),
		async () => ({ ok: true, json: async () => ({}) }),
	];
	for (const fetchImpl of broken) {
		const got = await loadOfficialData({ fetchImpl });
		// The previous payload survives a failure.
		assert.equal(got["glm-5.3"].context, 200000);
		const cache = readOfficialCache();
		assert.equal(cache.ok, false);
		assert.equal(cache.official["glm-5.3"].context, 200000);
	}
});

test("a negative cache entry suppresses refetches for the retry window", async (t) => {
	const dir = withAgentDir(t);
	writeCache(dir, { version: MODELS_DEV_CACHE_VERSION, fetchedAt: Date.now(), ok: false, official: {} });
	let calls = 0;
	const got = await loadOfficialData({
		fetchImpl: async () => {
			calls += 1;
			return { ok: true, json: async () => apiJson };
		},
	});
	assert.equal(calls, 0, "within the retry window nothing must be fetched");
	assert.deepEqual(got, {});
});

test("a negative cache entry is retried after the retry window", async (t) => {
	const dir = withAgentDir(t);
	writeCache(dir, {
		version: MODELS_DEV_CACHE_VERSION,
		fetchedAt: Date.now() - MODELS_DEV_RETRY_MS - 1000,
		ok: false,
		official: {},
	});
	let calls = 0;
	const got = await loadOfficialData({
		fetchImpl: async () => {
			calls += 1;
			return { ok: true, json: async () => apiJson };
		},
	});
	assert.equal(calls, 1);
	assert.equal(got["glm-5.3"].context, 200000);
});

test("a cache from an older extraction version is ignored", async (t) => {
	const dir = withAgentDir(t);
	writeCache(dir, { version: MODELS_DEV_CACHE_VERSION - 1, fetchedAt: Date.now(), ok: true, official: { x: {} } });
	assert.equal(readOfficialCache(), undefined);
	let calls = 0;
	await loadOfficialData({
		fetchImpl: async () => {
			calls += 1;
			return { ok: true, json: async () => apiJson };
		},
	});
	assert.equal(calls, 1, "a version mismatch must refetch");
});

test("a corrupt cache file is treated as no cache", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(cacheFile(dir), "{not json");
	assert.equal(readOfficialCache(), undefined);
	const got = await loadOfficialData({ fetchImpl: async () => ({ ok: true, json: async () => apiJson }) });
	assert.equal(got["glm-5.3"].context, 200000);
});
