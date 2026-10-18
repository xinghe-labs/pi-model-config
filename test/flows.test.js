import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkFlow, planProvider, renderPlan } from "../src/flows/check.js";
import { renderProviderList } from "../src/flows/list.js";
import { canPrompt, notify, requireUI } from "../src/output.js";
import { scopedEntriesFor } from "../src/scope.js";
import { isRuntimeProvider, readUserConfig, runtimeProviders } from "../src/user-config.js";

function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-flows-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

const official = { "glm-5.3": { context: 200000, output: 131072, reasoning: true, image: false, efforts: ["high"] } };

// A fake endpoint that answers with the given model list.
const endpoint = (models) => async () => ({ ok: true, json: async () => ({ data: models }) });

test("the endpoint probe is not queued behind the models.dev download", async (t) => {
	// They are independent, and the endpoint is the authoritative source. Awaiting
	// models.dev first would leave the probe unissued for as long as a 400 kB
	// catalog download takes, which is long enough for a short-lived session to end
	// before the audit has done anything at all.
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({
			providers: {
				p: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					models: [{ id: "m", contextWindow: 1, maxTokens: 1 }],
				},
			},
		}),
	);

	let releaseModelsDev;
	const modelsDevGate = new Promise((resolve) => {
		releaseModelsDev = resolve;
	});
	const requested = [];
	const fetchImpl = async (url) => {
		const u = String(url);
		requested.push(u);
		if (u.includes("models.dev")) {
			await modelsDevGate;
			return { ok: true, json: async () => ({}) };
		}
		return { ok: true, json: async () => ({ data: [{ id: "m", context_length: 250000, max_completion_tokens: 64000 }] }) };
	};

	const ctx = { hasUI: true, ui: { notify: () => {} } };
	const running = checkFlow(ctx, { auto: true, fetchImpl });
	// Give the probe a chance to be issued while models.dev is still pending.
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(
		requested.some((u) => u.includes("/models") && !u.includes("models.dev")),
		`the endpoint probe was not issued while models.dev was pending: ${requested.join(", ")}`,
	);

	releaseModelsDev();
	await running;
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")).providers.p.models[0].contextWindow, 250000);
});

test("planProvider reports nothing when the entry already matches", async () => {
	const provider = {
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		models: [
			{
				id: "glm-5.3",
				contextWindow: 200000,
				maxTokens: 131072,
				reasoning: true,
				input: ["text"],
				compat: { supportsReasoningEffort: true },
				thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
			},
		],
	};
	const plan = await planProvider({ pid: "p", provider, official, fetchImpl: endpoint([]) });
	assert.deepEqual(plan.changes, []);
	// No endpoint list means "cannot tell", so nothing is reported as vanished.
	assert.deepEqual(plan.vanished, []);
	assert.match(renderPlan(plan), /✓ 1 个模型参数一致/);
});

test("planProvider proposes a repair from models.dev when the probe fails", async () => {
	const provider = {
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		models: [{ id: "glm-5.3", contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] }],
	};
	const plan = await planProvider({
		pid: "p",
		provider,
		official,
		fetchImpl: async () => {
			throw new Error("offline");
		},
	});
	assert.ok(plan.endpointErr);
	assert.equal(plan.changes.length, 1);
	assert.equal(plan.changes[0].id, "glm-5.3");
	assert.deepEqual(plan.newModels[0].contextWindow, 200000);
	// The original array is untouched: the plan is computed, not applied.
	assert.equal(provider.models[0].contextWindow, 128000);
	assert.match(renderPlan(plan), /端点探测失败（offline）/);
});

test("planProvider never deletes a model the endpoint stopped listing", async () => {
	const provider = {
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		models: [
			{ id: "glm-5.3", contextWindow: 200000, maxTokens: 131072, reasoning: true, input: ["text"] },
			{ id: "retired-model", contextWindow: 8000, maxTokens: 1000 },
		],
	};
	const plan = await planProvider({ pid: "p", provider, official, fetchImpl: endpoint([{ id: "glm-5.3" }]) });
	assert.deepEqual(plan.vanished, ["retired-model"]);
	assert.equal(plan.newModels.length, 2, "a vanished model is reported, never dropped");
	assert.match(renderPlan(plan), /端点已不再提供：retired-model（保留，未删除）/);
});

test("planProvider skips what it cannot inspect", async () => {
	const skipped = async (provider) => (await planProvider({ pid: "p", provider, official, fetchImpl: endpoint([]) })).skipped;
	assert.equal(await skipped(undefined), "provider 缺失");
	assert.equal(await skipped({ api: "openai-completions" }), "没有 baseUrl");
	assert.equal(await skipped({ baseUrl: "https://x/v1", models: [] }), "没有静态模型列表（由刷新或其他扩展生成）");
	assert.equal(await skipped({ baseUrl: "https://x/v1" }), "没有静态模型列表（由刷新或其他扩展生成）");
});

test("planProvider ignores malformed model entries", async () => {
	const provider = { baseUrl: "https://x/v1", api: "openai-completions", models: [null, "string", { noId: 1 }] };
	const plan = await planProvider({ pid: "p", provider, official, fetchImpl: endpoint([]) });
	assert.deepEqual(plan.changes, []);
	assert.deepEqual(plan.newModels, [null, "string", { noId: 1 }]);
});

test("renderPlan flags a runtime provider", () => {
	const plan = {
		pid: "p",
		provider: { baseUrl: "https://x/v1", models: [1] },
		changes: [],
		vanished: [],
		endpointErr: undefined,
	};
	assert.match(renderPlan(plan, { runtime: true }), /运行时供应商：models\.json 里只是静态兜底/);
});

test("renderProviderList masks keys and labels runtime providers", () => {
	const text = renderProviderList(
		{
			a: { baseUrl: "https://a/v1", api: "openai-completions", apiKey: "sk-" + "0".repeat(40), models: [1, 2] },
			b: { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "none" },
		},
		{ runtime: new Set(["b"]) },
	);
	assert.match(text, /models\.json 里的供应商（共 2 个）/);
	assert.match(text, /a\n {4}https:\/\/a\/v1 {2}\| {2}api=openai-completions {2}\| {2}key=sk-000…0000 {2}\| {2}2 个模型/);
	assert.match(text, /b（运行时供应商；无 Key）/);
	assert.match(text, /继承 \/ 覆盖已有模型/);
	assert.equal(renderProviderList({}), "models.json 里还没有任何供应商。");
});

test("readUserConfig defaults to no runtime providers", (t) => {
	withAgentDir(t);
	assert.deepEqual(readUserConfig(), { runtimeProviders: [] });
});

test("readUserConfig reads the list and filters junk", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["me", 5, "", "tx"] }));
	assert.deepEqual(readUserConfig().runtimeProviders, ["me", "tx"]);
});

test("a corrupt model-config.json degrades instead of throwing", (t) => {
	// The file is optional, so it must not be able to disable the command.
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), "{ broken");
	const cfg = readUserConfig();
	assert.deepEqual(cfg.runtimeProviders, []);
	assert.match(cfg.error, /could not be parsed/);
	assert.equal(runtimeProviders().size, 0);
});

test("runtime providers are matched case-insensitively and merge the env var", (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["Me"] }));
	const previous = process.env.PI_MODEL_CONFIG_RUNTIME_PROVIDERS;
	process.env.PI_MODEL_CONFIG_RUNTIME_PROVIDERS = "tx, other";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_MODEL_CONFIG_RUNTIME_PROVIDERS;
		else process.env.PI_MODEL_CONFIG_RUNTIME_PROVIDERS = previous;
	});
	const set = runtimeProviders();
	assert.equal(isRuntimeProvider("me", set), true);
	assert.equal(isRuntimeProvider("ME", set), true);
	assert.equal(isRuntimeProvider("tx", set), true);
	assert.equal(isRuntimeProvider("other", set), true);
	assert.equal(isRuntimeProvider("nope", set), false);
});

test("scopedEntriesFor finds the entries for one provider only", () => {
	const settings = { enabledModels: ["a/*", "b/gpt-5", "A/claude", "c/*"] };
	assert.deepEqual(scopedEntriesFor(settings, "a"), ["a/*", "A/claude"]);
	assert.deepEqual(scopedEntriesFor(settings, "zzz"), []);
	assert.deepEqual(scopedEntriesFor({}, "a"), []);
	assert.deepEqual(scopedEntriesFor(undefined, "a"), []);
});

test("notify writes to stdout when there is no UI", (t) => {
	// A read-only report must still reach the user in print / JSON mode, where
	// ctx.ui does not exist.
	const writes = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	t.after(() => {
		process.stdout.write = original;
	});
	notify(undefined, "hello");
	notify({ hasUI: false }, "world");
	assert.deepEqual(writes, ["hello\n", "world\n"]);
});

test("notify prefers the UI", () => {
	const seen = [];
	notify({ hasUI: true, ui: { notify: (text, level) => seen.push([text, level]) } }, "hi", "warning");
	assert.deepEqual(seen, [["hi", "warning"]]);
});

test("canPrompt and requireUI gate dialog-only flows", (t) => {
	assert.equal(canPrompt(undefined), false);
	assert.equal(canPrompt({ hasUI: false, ui: {} }), false);
	assert.equal(canPrompt({ hasUI: true, ui: { select: () => {} } }), true);

	const writes = [];
	const originalOut = process.stdout.write;
	const originalErr = process.stderr.write;
	// notify sends errors to stderr, so both streams have to be captured.
	const capture = (chunk) => {
		writes.push(String(chunk));
		return true;
	};
	process.stdout.write = capture;
	process.stderr.write = capture;
	t.after(() => {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	});
	assert.equal(requireUI({ hasUI: false }, "add"), false);
	assert.match(writes.join(""), /add 需要交互式会话/);
	assert.equal(requireUI({ hasUI: true, ui: { select: () => {} } }, "add"), true);
});
