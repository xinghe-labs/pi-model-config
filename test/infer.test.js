import assert from "node:assert/strict";
import test from "node:test";
import { API_VALUES, PI_LEVELS } from "../src/const.js";
import {
	inferApi,
	inferContextWindow,
	maskKey,
	modelAliasKey,
	modelAliasKeys,
	shortModelName,
	suggestProviderId,
	thinkingMapFromEfforts,
} from "../src/infer.js";

test("inferApi picks the dialect from the URL", () => {
	assert.equal(inferApi("https://api.anthropic.com/v1"), "anthropic-messages");
	assert.equal(inferApi("https://gateway.example.com/v1/messages"), "anthropic-messages");
	assert.equal(inferApi("https://generativelanguage.googleapis.com/v1beta"), "google-generative-ai");
	assert.equal(inferApi("https://api.openai.com/v1/responses"), "openai-responses");
	assert.equal(inferApi("https://api.openai.com/v1"), "openai-completions");
	assert.equal(inferApi("http://127.0.0.1:11434/v1"), "openai-completions");
});

test("inferApi survives a value that is not a URL", () => {
	assert.equal(inferApi(""), "openai-completions");
	assert.equal(inferApi("not a url"), "openai-completions");
	assert.ok(API_VALUES.includes(inferApi(":::")));
});

test("inferContextWindow reads a size marker in the name", () => {
	assert.equal(inferContextWindow("gpt-4o-128k"), 128000);
	assert.equal(inferContextWindow("something-1m"), 1000000);
	assert.equal(inferContextWindow("model-32k-instruct"), 32000);
	// A bare number with a non-size suffix must not be read as tokens.
	assert.equal(inferContextWindow("llama-3.1-8b"), 128000);
});

test("inferContextWindow falls back to family defaults", () => {
	assert.equal(inferContextWindow("claude-sonnet-5"), 200000);
	assert.equal(inferContextWindow("gemini-3-pro"), 1000000);
	assert.equal(inferContextWindow("o3-mini"), 200000);
	assert.equal(inferContextWindow("some-unknown-model"), 128000);
});

test("thinkingMapFromEfforts closes every level it was not given", () => {
	const map = thinkingMapFromEfforts(["low", "high"]);
	assert.deepEqual(Object.keys(map).sort(), [...PI_LEVELS].sort());
	assert.equal(map.low, "low");
	assert.equal(map.high, "high");
	// Explicit null is what stops pi from offering a level the endpoint rejects.
	assert.equal(map.medium, null);
	assert.equal(map.max, null);
});

test("thinkingMapFromEfforts drops values pi does not understand", () => {
	// models.dev reports "none" and "default" as efforts; writing them into
	// thinkingLevelMap would put an unusable level in the picker.
	const map = thinkingMapFromEfforts(["none", "default", "high"]);
	assert.equal(map.high, "high");
	assert.equal(map.low, null);
	assert.equal(Object.values(map).filter(Boolean).length, 1);
});

test("thinkingMapFromEfforts returns nothing for an empty or invalid list", () => {
	assert.equal(thinkingMapFromEfforts([]), undefined);
	assert.equal(thinkingMapFromEfforts(undefined), undefined);
	assert.equal(thinkingMapFromEfforts("high"), undefined);
});

test("suggestProviderId turns a host into a config key", () => {
	assert.equal(suggestProviderId("https://api.example.com/v1"), "api-example-com");
	assert.equal(suggestProviderId("http://127.0.0.1:11434/v1"), "127-0-0-1");
	assert.equal(suggestProviderId("https://Sub.Example-Gateway.COM/v1"), "sub-example-gateway-com");
	assert.equal(suggestProviderId("nonsense"), "custom");
	// A host of only punctuation must not produce an empty key.
	assert.equal(suggestProviderId("https://.../v1"), "custom");
});

test("suggestProviderId always yields a valid models.json key", () => {
	for (const url of ["https://a-b.example.com", "http://localhost:8080", "https://xn--fiqs8s.cn/v1"]) {
		assert.match(suggestProviderId(url), /^[A-Za-z0-9_-]*$/);
	}
});

test("maskKey never reveals a whole key, or most of one", () => {
	assert.equal(maskKey(""), "(not set)");
	assert.equal(maskKey(undefined), "(not set)");
	assert.equal(maskKey("none"), "none (no key)");
	// A 13-character key shown as "first 6 + last 4" is 11 of its 13 characters.
	assert.equal(maskKey("sk-1234"), "(set, 7 chars)");
	assert.equal(maskKey("sk-1234567890"), "(set, 13 chars)");
	assert.equal(maskKey("sk-abcdefghijklmnop"), "(set, 19 chars)");
	assert.equal(maskKey("a".repeat(23)), "(set, 23 chars)");
	assert.equal(maskKey("a".repeat(24)), "aaaaaa…aaaa");
	// A real key is long enough to mask, and the mask hides most of it.
	const real = "sk-" + "0123456789abcdef".repeat(2);
	const masked = maskKey(real);
	assert.equal(masked, `sk-012…cdef`);
	assert.ok(masked.length < real.length / 2);
});

test("shortModelName strips gateway and vendor prefixes", () => {
	assert.equal(shortModelName("global:glm-5.3"), "glm-5.3");
	assert.equal(shortModelName("moonshotai/kimi-k3"), "kimi-k3");
	assert.equal(shortModelName("vendor/global:model-x"), "model-x");
	assert.equal(shortModelName("Claude-Opus-4-6"), "claude-opus-4-6");
});

test("modelAliasKey folds cosmetic version spelling differences", () => {
	const expected = modelAliasKey("deepseek-v4.1-flash");
	assert.equal(modelAliasKey("deepseek-4.1-flash"), expected);
	assert.equal(modelAliasKey("deepseek-v4p1-flash"), expected);
	assert.equal(modelAliasKey("deepseek-v4-1-flash"), expected);
	assert.equal(modelAliasKey("deepseek-v4.1-flash-background"), expected);
	assert.notEqual(modelAliasKey("deepseek-v4-flash"), expected);
});

test("modelAliasKeys accepts an undated gateway id for a dated snapshot", () => {
	assert.ok(modelAliasKeys("deepseek-v4.1-flash-1017").includes(modelAliasKey("deepseek-v4.1-flash")));
	assert.ok(modelAliasKeys("glm-5.3-flash-260828").includes(modelAliasKey("glm-5.3-flash")));
});
