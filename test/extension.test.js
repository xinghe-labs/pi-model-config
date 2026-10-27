import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addFlow } from "../src/flows/add.js";
import { checkFlow } from "../src/flows/check.js";
import { removeFlow } from "../src/flows/remove.js";
import modelConfigExtension, { parseArgs } from "../src/index.js";

function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-ext-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

// A ctx whose dialogs answer from a script, so a whole flow can run headless.
function fakeCtx(answers, { ui = true } = {}) {
	const log = [];
	const queue = [...answers];
	const next = (kind) => {
		if (!queue.length) throw new Error(`no scripted answer left for ${kind}`);
		// A scripted `undefined` is a legitimate answer: it means "the user dismissed
		// this dialog".
		return queue.shift();
	};
	return {
		log,
		cwd: process.cwd(),
		hasUI: ui,
		model: { provider: undefined },
		modelRegistry: { refresh: async () => {} },
		ui: {
			input: async () => next("input"),
			select: async () => next("select"),
			confirm: async () => next("confirm"),
			notify: (text, level) => log.push({ text, level }),
		},
	};
}

const notifies = (ctx) => ctx.log.map((e) => e.text).join("\n");

// Without a UI, notify() falls back to stdout/stderr, so those tests have to read
// the streams instead of the ctx log.
async function captureStreams(fn) {
	const written = [];
	const originalOut = process.stdout.write;
	const originalErr = process.stderr.write;
	const capture = (chunk) => {
		written.push(String(chunk));
		return true;
	};
	process.stdout.write = capture;
	process.stderr.write = capture;
	try {
		await fn();
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
	return written.join("");
}

// models.dev answers with official data; every other URL is the endpoint.
function fakeFetch(endpointModels) {
	return async (url) => {
		if (String(url).includes("models.dev")) {
			return {
				ok: true,
				json: async () => ({
					anthropic: {
						models: {
							"claude-opus-4-6": {
								limit: { context: 1000000, output: 32000 },
								reasoning: true,
								modalities: { input: ["text", "image"] },
								reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
							},
						},
					},
				}),
			};
		}
		return { ok: true, json: async () => ({ data: endpointModels }) };
	};
}

test("parseArgs only treats a known word as a subcommand", () => {
	assert.deepEqual(parseArgs("list").sub, "list");
	assert.deepEqual(parseArgs("  CHECK  ").sub, "check");
	assert.deepEqual(parseArgs("").sub, "");
	assert.deepEqual(parseArgs("https://x/v1").sub, "");
	assert.deepEqual(parseArgs("LIST").sub, "list");
});

test("the extension registers both command names and one startup hook", () => {
	const commands = [];
	const events = [];
	modelConfigExtension({
		registerCommand: (name, def) => commands.push({ name, def }),
		on: (event, handler) => events.push({ event, handler }),
	});
	assert.deepEqual(commands.map((c) => c.name), ["model-config", "model-setup"]);
	for (const { def } of commands) {
		assert.equal(typeof def.handler, "function");
		assert.ok(def.description.length > 10);
	}
	// Both names must run the same handler, or the alias silently diverges.
	assert.equal(commands[0].def.handler, commands[1].def.handler);
	assert.deepEqual(events.map((e) => e.event), ["session_start"]);
});

test("the startup audit runs once and only on real startup", async (t) => {
	withAgentDir(t);
	let calls = 0;
	const handlers = [];
	modelConfigExtension({ registerCommand: () => {}, on: (_e, h) => handlers.push(h) });
	const ctx = fakeCtx([], { ui: false });
	// No models.json entry, so the audit exits immediately; the point is that the
	// handler is guarded and cannot run twice or on /reload.
	for (const reason of ["startup", "reload", "startup"]) {
		await handlers[0]({ reason }, ctx);
		calls += 1;
	}
	assert.equal(calls, 3);
	assert.equal(handlers.length, 1);
});

test("addFlow writes a provider with inferred metadata, cost and a backup", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), '{"providers":{"keep":{"baseUrl":"https://k/v1"}}}');
	const ctx = fakeCtx([
		"https://api.anthropic.com/v1", // base URL
		"anthropic-messages", // API type (bare value, not the label)
		"sk-" + "a".repeat(40), // API key
		"全部添加", // how to add the probed models
		"", // provider id -> accept the suggestion
	]);
	await addFlow(ctx, { fetchImpl: fakeFetch([{ id: "claude-opus-4-6" }]) });

	const written = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
	// An existing provider is preserved, not replaced.
	assert.equal(written.providers.keep.baseUrl, "https://k/v1");
	const provider = written.providers["api-anthropic-com"];
	assert.equal(provider.api, "anthropic-messages");
	assert.equal(provider.baseUrl, "https://api.anthropic.com/v1");
	const model = provider.models[0];
	assert.equal(model.id, "claude-opus-4-6");
	assert.equal(model.contextWindow, 1000000);
	assert.equal(model.maxTokens, 32000);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	// pi-ai throws on a missing cost, so every written model must carry one.
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	// anthropic-messages does not use reasoning_effort, so no compat flag.
	assert.equal(model.compat, undefined);
	assert.equal(model.thinkingLevelMap.high, "high");

	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("models.json.bak-")), "a backup must be written");
	const text = notifies(ctx);
	assert.match(text, /已配置 api-anthropic-com：1 个模型/);
	assert.match(text, /ctx=1000000 \(models\.dev\)/);
	// The key must never be echoed in full.
	assert.ok(!text.includes("a".repeat(40)));
});

test("addFlow probes, then falls back to typed IDs when the probe fails", async (t) => {
	const dir = withAgentDir(t);
	const ctx = fakeCtx([
		"http://127.0.0.1:8080/v1", // loopback http: no plaintext confirmation
		"openai-completions",
		"", // no key -> stored as "none"
		"my-model, other-model", // typed IDs
		"local",
	]);
	const failing = async (url) =>
		String(url).includes("models.dev") ? { ok: true, json: async () => ({}) } : { ok: false, status: 500, json: async () => ({}) };
	await addFlow(ctx, { fetchImpl: failing });

	const provider = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers.local;
	assert.equal(provider.apiKey, "none", 'the literal "none" is how models.json spells "no key"');
	assert.deepEqual(provider.models.map((m) => m.id), ["my-model", "other-model"]);
	assert.match(notifies(ctx), /探测失败（HTTP 500）/);
});

test("addFlow refuses an invalid URL and a bad provider id", async (t) => {
	withAgentDir(t);
	const badUrl = fakeCtx(["not-a-url"]);
	await addFlow(badUrl, { fetchImpl: fakeFetch([]) });
	assert.match(notifies(badUrl), /不是有效的 URL：not-a-url/);

	const badId = fakeCtx(["https://api.example.com/v1", "openai-completions", "", "全部添加", "bad id!"]);
	await addFlow(badId, { fetchImpl: fakeFetch([{ id: "m" }]) });
	assert.match(notifies(badId), /供应商 id 只能包含/);
});

test("addFlow stops before writing when models.json is unparseable", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), "{ broken");
	const ctx = fakeCtx(["https://api.example.com/v1", "openai-completions", "k", "全部添加", "p"]);
	await addFlow(ctx, { fetchImpl: fakeFetch([{ id: "m" }]) });
	assert.match(notifies(ctx), /could not be parsed/);
	// The unreadable file must be left exactly as it was.
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), "{ broken");
});

test("addFlow needs a UI", async (t) => {
	withAgentDir(t);
	const ctx = fakeCtx([], { ui: false });
	const output = await captureStreams(() => addFlow(ctx));
	assert.match(output, /add 需要交互式会话/);
});

test("addFlow warns when the id is a configured runtime provider", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["runtime-one"] }));
	const ctx = fakeCtx([
		"https://api.example.com/v1",
		"openai-completions",
		"k",
		"全部添加",
		"runtime-one",
	]);
	await addFlow(ctx, { fetchImpl: fakeFetch([{ id: "m" }]) });
	assert.match(notifies(ctx), /是运行时供应商/);
	// Still written: the warning is advice, not a veto.
	assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers["runtime-one"]);
});

test("addFlow adds the provider to a non-empty enabledModels", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: ["other/*"] }));
	const ctx = fakeCtx(["https://api.example.com/v1", "openai-completions", "k", "全部添加", "fresh"]);
	await addFlow(ctx, { fetchImpl: fakeFetch([{ id: "m" }]) });
	const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
	assert.deepEqual(settings.enabledModels, ["other/*", "fresh/*"]);
	// /reload does not re-resolve the snapshot, so the message must not claim it does.
	assert.match(notifies(ctx), /new session or after restarting pi/);
	assert.ok(!/reload 后生效/.test(notifies(ctx)));
});

test("addFlow leaves an empty enabledModels alone", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: [] }));
	const ctx = fakeCtx(["https://api.example.com/v1", "openai-completions", "k", "全部添加", "fresh"]);
	await addFlow(ctx, { fetchImpl: fakeFetch([{ id: "m" }]) });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).enabledModels, []);
});

test("checkFlow repairs a deviating entry and re-runs clean afterwards", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({
			providers: {
				p: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					models: [{ id: "claude-opus-4-6", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] }],
				},
			},
		}),
	);
	const ctx = fakeCtx(["全部端点", true]);
	await checkFlow(ctx, { fetchImpl: fakeFetch([]) });

	const model = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers.p.models[0];
	assert.equal(model.contextWindow, 1000000);
	assert.equal(model.maxTokens, 32000);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("models.json.bak-")));

	// The audit must converge: a second pass finds nothing to repair.
	const second = fakeCtx(["全部端点"]);
	await checkFlow(second, { fetchImpl: fakeFetch([]) });
	assert.match(notifies(second), /✓ 1 个模型参数一致/);
});

test("checkFlow never repairs a configured runtime provider", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["p"] }));
	const original = {
		providers: {
			p: {
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				models: [{ id: "claude-opus-4-6", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] }],
			},
		},
	};
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(original));
	const ctx = fakeCtx(["全部端点"]);
	await checkFlow(ctx, { fetchImpl: fakeFetch([]) });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")), original);
	assert.match(notifies(ctx), /只报告、绝不改写/);
});

test("the startup audit stays silent when nothing deviates", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({
			providers: {
				p: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					models: [
						{
							id: "claude-opus-4-6",
							contextWindow: 1000000,
							maxTokens: 32000,
							reasoning: true,
							input: ["text", "image"],
							compat: { supportsReasoningEffort: true },
							thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
						},
					],
				},
			},
		}),
	);
	const ctx = fakeCtx([], { ui: false });
	await checkFlow(ctx, { auto: true, fetchImpl: fakeFetch([{ id: "claude-opus-4-6" }]) });
	assert.deepEqual(ctx.log, [], "an empty audit must produce no notification at all");
});

test("the startup audit does repair a real deviation and says so", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({
			providers: {
				p: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					models: [{ id: "claude-opus-4-6", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] }],
				},
			},
		}),
	);
	const ctx = fakeCtx([], { ui: false });
	const output = await captureStreams(() => checkFlow(ctx, { auto: true, fetchImpl: fakeFetch([]) }));
	assert.match(output, /模型参数对账/);
	const model = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers.p.models[0];
	assert.equal(model.contextWindow, 1000000);
});

test("checkFlow reports a corrupt models.json without writing", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), "{ broken");
	const ctx = fakeCtx([]);
	await checkFlow(ctx, { fetchImpl: fakeFetch([]) });
	assert.match(notifies(ctx), /could not be parsed/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), "{ broken");
});

test("removeFlow deletes the provider, keeps a backup and offers the list cleanup", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({ providers: { gone: { baseUrl: "https://g/v1" }, kept: { baseUrl: "https://k/v1" } } }),
	);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ enabledModels: ["gone/*", "kept/*"] }));
	const ctx = fakeCtx(["gone", true, true]);
	await removeFlow(ctx);

	const config = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
	assert.deepEqual(Object.keys(config.providers), ["kept"]);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).enabledModels, ["kept/*"]);
	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("models.json.bak-")));
	// The stale-snapshot warning must be shown: the picker keeps the old entry.
	assert.match(notifies(ctx), /可能还显示在那里/);
	assert.match(notifies(ctx), /不会重新解析快照/);
});

test("removeFlow needs a UI and does nothing when cancelled", async (t) => {
	const dir = withAgentDir(t);
	const original = JSON.stringify({ providers: { gone: { baseUrl: "https://g/v1" } } });
	fs.writeFileSync(path.join(dir, "models.json"), original);

	await removeFlow(fakeCtx([], { ui: false }));
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), original);

	// Dismissing the selection is a cancel, not a crash.
	await removeFlow(fakeCtx([undefined]));
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), original);

	// Declining the confirmation must not delete either.
	await removeFlow(fakeCtx(["gone", false]));
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), original);
});
