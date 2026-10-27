import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_COST } from "../src/const.js";
import { diffModel, lookupOfficialModel, repairedDef, resolveModelMeta, sameThinkingMap, trusted } from "../src/resolve.js";

const official = {
	"claude-opus-4-6": {
		context: 1000000,
		output: 32000,
		reasoning: true,
		image: true,
		efforts: ["low", "medium", "high"],
	},
};

test("endpoint metadata outranks models.dev", () => {
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x", contextWindow: 500000 }, official);
	assert.equal(r.def.contextWindow, 500000);
	assert.equal(r.sources.contextWindow, "endpoint");
	// Fields the endpoint did not report still come from models.dev.
	assert.equal(r.def.maxTokens, 32000);
	assert.equal(r.sources.maxTokens, "models.dev");
});

test("models.dev outranks the name heuristic", () => {
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	// The heuristic would say 200000 for a claude name.
	assert.equal(r.def.contextWindow, 1000000);
	assert.equal(r.sources.contextWindow, "models.dev");
});

test("lookupOfficialModel matches gateway spelling variants", () => {
	const data = {
		"deepseek-v4.1-flash": {
			context: 1000000,
			output: 384000,
			reasoning: true,
			image: true,
			efforts: ["low", "high", "max"],
		},
	};
	for (const id of ["deepseek-4.1-flash", "deepseek-v4p1-flash", "deepseek-v4-1-flash", "deepseek-4.1-flash-background"]) {
		assert.equal(lookupOfficialModel(id, data)?.context, 1000000, id);
	}
});

test("lookupOfficialModel uses canonical aliases and prefers first-party metadata", () => {
	const data = {
		"deepseek-v4.1-flash": { context: 1000000, output: 131072, reasoning: true, image: true },
		"deepseek-flash": {
			context: 1048576,
			output: 393216,
			reasoning: true,
			image: true,
			firstParty: true,
			aliases: ["deepseek-v4.1-flash-1017"],
		},
	};
	assert.equal(lookupOfficialModel("deepseek-4.1-flash", data)?.context, 1048576);
	// Even an exact aggregator spelling loses to the first-party canonical alias.
	assert.equal(lookupOfficialModel("deepseek-v4.1-flash", data)?.output, 393216);
});

test("resolveModelMeta fills context and thinking levels from a fuzzy models.dev match", () => {
	const r = resolveModelMeta(
		"deepseek-4.1-flash",
		"openai-completions",
		{ id: "deepseek-4.1-flash" },
		{
			"deepseek-v4.1-flash": {
				context: 1000000,
				output: 384000,
				reasoning: true,
				image: true,
				efforts: ["low", "high", "max"],
			},
		},
	);
	assert.equal(r.def.contextWindow, 1000000);
	assert.equal(r.def.maxTokens, 384000);
	assert.equal(r.def.reasoning, true);
	assert.deepEqual(r.def.input, ["text", "image"]);
	assert.equal(r.def.thinkingLevelMap.high, "high");
});

test("the name heuristic is the last resort and is labelled as such", () => {
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, {});
	assert.equal(r.def.contextWindow, 200000);
	assert.equal(r.sources.contextWindow, "guess");
	assert.equal(r.sources.reasoning, "guess");
});

test("a model with no sources at all gets a coherent default", () => {
	const r = resolveModelMeta("mystery-model", "openai-completions", { id: "mystery-model" }, {});
	assert.equal(r.def.contextWindow, 128000);
	// maxTokens may never exceed the context window.
	assert.ok(r.def.maxTokens <= r.def.contextWindow);
	assert.deepEqual(r.def.cost, ZERO_COST);
	assert.deepEqual(r.def.input, ["text"]);
});

test("every definition carries cost", () => {
	// pi-ai reads model.cost.tiers and throws when cost is missing, which fails the
	// whole turn, so no definition may omit it.
	for (const id of ["gpt-5", "claude-opus-4-6", "glm-5.3", "x"]) {
		assert.deepEqual(resolveModelMeta(id, "openai-completions", { id }, {}).def.cost, ZERO_COST);
	}
});

test("resolveModelMeta falls back to the models.dev list price", () => {
	const official = {
		"claude-opus-4-6": {
			context: 1000000,
			output: 32000,
			reasoning: true,
			image: false,
			efforts: [],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		},
	};
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	assert.deepEqual(r.def.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
	assert.equal(r.sources.cost, "cost-official");
});

test("repairedDef fills zero cost from the list price but never touches a hand-edited one", () => {
	const official = {
		"claude-opus-4-6": {
			context: 1000000,
			output: 32000,
			reasoning: false,
			image: false,
			efforts: [],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		},
	};
	const resolved = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);

	// Zero cost + list price available: filled.
	const filled = repairedDef(
		{ id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 32000, reasoning: false, input: ["text"], cost: { ...ZERO_COST } },
		resolved,
	);
	assert.deepEqual(filled.cost, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });

	// Hand-edited price (the gateway's real rates): preserved untouched.
	const custom = { input: 7.5, output: 30, cacheRead: 0, cacheWrite: 0 };
	const kept = repairedDef(
		{ id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 32000, reasoning: false, input: ["text"], cost: custom },
		resolved,
	);
	assert.deepEqual(kept.cost, custom, "a hand-edited price survives the audit");

	// And the audit must not report a cost "deviation" either way: pricing is not
	// an audited field, so the diff never mentions it.
	const drifted = { id: "claude-opus-4-6", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: custom };
	assert.ok(!diffModel(drifted, resolved).some((d) => /cost/i.test(d)), `cost must not be audited: ${diffModel(drifted, resolved).join(", ")}`);
});

test("reasoning adds compat and a thinking map", () => {
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	assert.equal(r.def.reasoning, true);
	assert.deepEqual(r.def.compat, { supportsReasoningEffort: true });
	assert.equal(r.def.thinkingLevelMap.high, "high");
	assert.equal(r.def.thinkingLevelMap.max, null);
});

test("compat is only added for the OpenAI-compatible dialect", () => {
	const anthropic = resolveModelMeta("claude-opus-4-6", "anthropic-messages", { id: "x" }, official);
	assert.equal(anthropic.def.compat, undefined);
	// reasoning itself is still recorded.
	assert.equal(anthropic.def.reasoning, true);
});

test("a non-reasoning model gets neither compat nor a thinking map", () => {
	const r = resolveModelMeta("gpt-4o-mini", "openai-completions", { id: "x", reasoning: false, vision: false }, {});
	assert.equal(r.def.reasoning, false);
	assert.equal(r.def.compat, undefined);
	assert.equal(r.def.thinkingLevelMap, undefined);
});

test("trusted(): a guess may only fill a missing field", () => {
	assert.equal(trusted("guess", undefined), true);
	assert.equal(trusted("guess", 123), false);
	assert.equal(trusted("endpoint", 123), true);
	assert.equal(trusted("models.dev", 123), true);
});

test("diffModel reports nothing when the entry already matches", () => {
	const existing = { id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 32000, reasoning: true, input: ["text", "image"], compat: { supportsReasoningEffort: true }, thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } };
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x", contextWindow: 1000000, maxTokens: 32000, reasoning: true, vision: true, efforts: ["low", "medium", "high"] }, official);
	assert.deepEqual(diffModel(existing, r), []);
});

test("diffModel reports each deviation with its source", () => {
	const existing = { id: "x", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] };
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	const diffs = diffModel(existing, r);
	// Four capability fields plus the two reasoning extras that follow from
	// reasoning becoming true: the compat flag and the thinking map.
	assert.equal(diffs.length, 6);
	assert.match(diffs[0], /ctx 200000 -> 1000000 \(models\.dev\)/);
	assert.match(diffs[1], /max 8192 -> 32000/);
	assert.match(diffs[2], /reasoning false -> true/);
	assert.match(diffs[3], /image input off -> on/);
	assert.match(diffs[4], /^\+reasoning_effort support/);
	assert.match(diffs[5], /^thinking levels -> low\/medium\/high/);
});

test("diffModel will not let a guess overwrite an existing value", () => {
	const existing = { id: "mystery", contextWindow: 200000 };
	const r = resolveModelMeta("mystery", "openai-completions", { id: "mystery" }, {});
	// The heuristic would say 128000, but 200000 was written by hand, so ctx is not
	// reported. A field that was missing (maxTokens) may still be filled by a guess.
	const diffs = diffModel(existing, r);
	assert.ok(!diffs.some((d) => d.startsWith("ctx ")), diffs.join(" | "));
	assert.deepEqual(diffs, ["max ? -> 16384 (guessed)"]);
});

test("diffModel reports a newly available thinking map", () => {
	const existing = { id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 32000, reasoning: true, input: ["text", "image"] };
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x", contextWindow: 1000000, maxTokens: 32000, reasoning: true, vision: true, efforts: ["low", "high"] }, official);
	const diffs = diffModel(existing, r);
	assert.ok(diffs.some((d) => d.startsWith("+reasoning_effort support")));
	assert.ok(diffs.some((d) => d.startsWith("thinking levels -> low/high")));
});

test("sameThinkingMap treats a missing key and null as equal", () => {
	assert.equal(sameThinkingMap({ low: "low" }, { low: "low", high: null }), true);
	assert.equal(sameThinkingMap({ low: "low" }, { low: "high" }), false);
	assert.equal(sameThinkingMap(undefined, undefined), true);
	assert.equal(sameThinkingMap(undefined, { low: "low" }), false);
});

test("repairedDef keeps fields the audit did not resolve", () => {
	const existing = {
		id: "claude-opus-4-6",
		name: "My Opus",
		contextWindow: 200000,
		maxTokens: 8192,
		reasoning: true,
		input: ["text"],
		compat: { supportsReasoningEffort: true, customFlag: "keep-me" },
		customField: 42,
	};
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	const next = repairedDef(existing, r);
	assert.equal(next.name, "My Opus", "a hand-written name must survive");
	assert.equal(next.customField, 42, "unknown fields must survive");
	assert.equal(next.compat.customFlag, "keep-me", "other compat keys must survive");
	assert.equal(next.contextWindow, 1000000);
	assert.equal(next.maxTokens, 32000);
	assert.deepEqual(next.input, ["text", "image"]);
});

test("repairedDef fills a missing cost and name", () => {
	const next = repairedDef({ id: "x" }, resolveModelMeta("x", "openai-completions", { id: "x" }, {}));
	assert.deepEqual(next.cost, ZERO_COST);
	assert.equal(next.name, "x");
});

test("repairedDef removes reasoning leftovers when the model is not reasoning-capable", () => {
	const existing = {
		id: "x",
		reasoning: true,
		thinkingLevelMap: { low: "low" },
		compat: { supportsReasoningEffort: true },
	};
	const r = resolveModelMeta("x", "openai-completions", { id: "x", reasoning: false, vision: false }, {});
	const next = repairedDef(existing, r);
	assert.equal(next.reasoning, false);
	assert.equal(next.thinkingLevelMap, undefined);
	// compat existed only for the reasoning flag, so it goes away entirely.
	assert.equal(next.compat, undefined);
});

test("repairedDef keeps other compat keys when it drops the reasoning flag", () => {
	const existing = { id: "x", reasoning: true, compat: { supportsReasoningEffort: true, customFlag: 1 } };
	const r = resolveModelMeta("x", "openai-completions", { id: "x", reasoning: false }, {});
	const next = repairedDef(existing, r);
	assert.deepEqual(next.compat, { customFlag: 1 });
});

test("repairedDef is idempotent", () => {
	// Running the audit twice must not keep reporting the same deviation.
	const existing = { id: "claude-opus-4-6", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] };
	const r = resolveModelMeta("claude-opus-4-6", "openai-completions", { id: "x" }, official);
	const once = repairedDef(existing, r);
	assert.deepEqual(diffModel(once, r), []);
	const twice = repairedDef(once, r);
	assert.deepEqual(twice, once);
});
