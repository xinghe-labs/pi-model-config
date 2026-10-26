import assert from "node:assert/strict";
import test from "node:test";
import { fetchModelMeta, normalizeListedModel, probeHeaders, probeKey, probeUrl, uniqueById } from "../src/probe.js";

test("probeUrl appends /models to a plain base URL", () => {
	assert.equal(probeUrl("https://api.example.com/v1", "k", "openai-completions"), "https://api.example.com/v1/models");
	assert.equal(probeUrl("https://api.example.com/v1///", "k", "openai-completions"), "https://api.example.com/v1/models");
});

test("probeUrl puts a Gemini key in the query string, not a header", () => {
	// A Bearer request to the Gemini REST API is a guaranteed 401.
	const url = probeUrl("https://generativelanguage.googleapis.com/v1beta", "AIza key", "google-generative-ai");
	assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models?key=AIza%20key");
});

test("probeUrl adds the version segment Gemini needs", () => {
	assert.equal(
		probeUrl("https://generativelanguage.googleapis.com", "k", "google-generative-ai"),
		"https://generativelanguage.googleapis.com/v1beta/models?key=k",
	);
	assert.equal(
		probeUrl("https://generativelanguage.googleapis.com/v1", "k", "google-generative-ai"),
		"https://generativelanguage.googleapis.com/v1/models?key=k",
	);
});

test("probeUrl omits the key parameter when there is no key", () => {
	assert.equal(
		probeUrl("https://generativelanguage.googleapis.com/v1beta", "", "google-generative-ai"),
		"https://generativelanguage.googleapis.com/v1beta/models",
	);
});

test("probeHeaders uses the dialect's own auth", () => {
	const openai = probeHeaders("sk-1", "openai-completions");
	assert.equal(openai.Authorization, "Bearer sk-1");
	assert.ok(openai["User-Agent"]);

	const anthropic = probeHeaders("sk-2", "anthropic-messages");
	assert.equal(anthropic["x-api-key"], "sk-2");
	assert.equal(anthropic["anthropic-version"], "2023-06-01");
	assert.equal(anthropic.Authorization, undefined);

	const google = probeHeaders("sk-3", "google-generative-ai");
	assert.equal(google.Authorization, undefined);
	assert.equal(google["x-api-key"], undefined);

	// No key: no Authorization header at all, rather than "Bearer ".
	assert.equal(probeHeaders("", "openai-completions").Authorization, undefined);
	assert.equal(probeHeaders("", "anthropic-messages")["x-api-key"], undefined);
});

test("probeKey never sends the literal none", () => {
	assert.equal(probeKey({ apiKey: "none" }), "");
	assert.equal(probeKey({ apiKey: "" }), "");
	assert.equal(probeKey({}), "");
	assert.equal(probeKey(undefined), "");
	assert.equal(probeKey({ apiKey: "sk-real" }), "sk-real");
});

test("normalizeListedModel accepts a bare string id", () => {
	assert.deepEqual(normalizeListedModel("gpt-4o"), { id: "gpt-4o" });
	assert.equal(normalizeListedModel(""), undefined);
});

test("normalizeListedModel reads OpenAI-style metadata", () => {
	const got = normalizeListedModel({
		id: "gpt-5",
		context_length: 400000,
		max_completion_tokens: 128000,
		architecture: { input_modalities: ["text", "image"] },
		supported_parameters: ["reasoning", "temperature"],
	});
	assert.deepEqual(got, { id: "gpt-5", contextWindow: 400000, maxTokens: 128000, vision: true, reasoning: true });
});

test("normalizeListedModel reads the Gemini response shape", () => {
	const got = normalizeListedModel({
		name: "models/gemini-3-pro",
		inputTokenLimit: 1048576,
		outputTokenLimit: 65536,
		supportedGenerationMethods: ["generateContent", "countTokens"],
	});
	assert.deepEqual(got, { id: "gemini-3-pro", contextWindow: 1048576, maxTokens: 65536 });
});

test("normalizeListedModel drops non-generative Gemini models", () => {
	assert.equal(
		normalizeListedModel({ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }),
		undefined,
	);
});

test("normalizeListedModel collects efforts from both shapes", () => {
	const fromOptions = normalizeListedModel({
		id: "a",
		reasoning_options: [{ type: "effort", values: ["low", "high"] }],
	});
	assert.deepEqual(fromOptions.efforts, ["low", "high"]);
	assert.equal(fromOptions.reasoning, true);

	const flat = normalizeListedModel({ id: "b", reasoning_supported_efforts: ["minimal", "high"] });
	assert.deepEqual(flat.efforts, ["minimal", "high"]);

	// Duplicates collapse so the thinking map stays stable between runs.
	assert.deepEqual(normalizeListedModel({ id: "c", reasoning_supported_efforts: ["high", "high"] }).efforts, ["high"]);
});

test("normalizeListedModel ignores zero and negative limits", () => {
	const got = normalizeListedModel({ id: "x", context_length: 0, max_completion_tokens: -5 });
	assert.equal(got.contextWindow, undefined);
	assert.equal(got.maxTokens, undefined);
});

test("normalizeListedModel keeps a model with no metadata", () => {
	assert.deepEqual(normalizeListedModel({ id: "bare" }), { id: "bare" });
	assert.deepEqual(normalizeListedModel({ name: "models/bare" }), { id: "bare" });
});

test("uniqueById keeps the first entry and drops repeats", () => {
	const list = [{ id: "a" }, { id: "b" }, { id: "a" }, { id: undefined }, { id: "b" }];
	assert.deepEqual(uniqueById(list), [{ id: "a" }, { id: "b" }]);
});

test("fetchModelMeta deduplicates an endpoint that lists an id twice", async () => {
	const fetchImpl = async () => ({
		ok: true,
		json: async () => ({ data: [{ id: "dup", context_length: 4096 }, { id: "dup" }, { id: "solo" }] }),
	});
	const got = await fetchModelMeta("https://gw.example.com/v1", "k", "openai-completions", { fetchImpl });
	assert.deepEqual(got.map((m) => m.id), ["dup", "solo"]);
});
