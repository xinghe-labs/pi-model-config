// The scripted forms: `/model-config add <url> <key>` and `/model-config sync`.
//
// These are the paths an agent or a shell drives, so the guarantees they carry
// are different from the interactive ones: nothing is written without --all or
// --only, a key is never echoed, and a removal can only happen after a probe
// that actually succeeded.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onlyIds, parseOptions, wantsAll, wantsWrite } from "../src/args.js";
import { checkFlow } from "../src/flows/check.js";
import { modelsFlow } from "../src/flows/models.js";
import { editFlow } from "../src/flows/edit.js";
import { removeFlow } from "../src/flows/remove.js";
import { addFlow, planAdd } from "../src/flows/add.js";
import { applySync, planSync, renderSyncPlan, syncFlow } from "../src/flows/sync.js";
import { runtimeProviders } from "../src/user-config.js";

function withAgentDir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-script-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return dir;
}

// A ctx that *has* a UI, so notify() lands in the log, but whose dialogs throw:
// the scripted forms must never open one. `confirm` is the exception — sync does
// ask before deleting, so it is recorded and answered.
function scriptCtx({ confirm = true } = {}) {
	const log = [];
	const boom = async (kind) => {
		throw new Error(`unexpected ${kind} dialog in a scripted run`);
	};
	return {
		log,
		cwd: process.cwd(),
		hasUI: true,
		model: {},
		modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => log.push({ text, level }),
			confirm: async (title, body) => {
				log.push({ text: `[confirm] ${title}: ${body}` });
				return confirm;
			},
			select: () => boom("select"),
			input: () => boom("input"),
		},
	};
}

// print/JSON/RPC mode: no UI at all, so notify() writes to the streams.
function printCtx(t) {
	const log = [];
	const out = process.stdout.write;
	const err = process.stderr.write;
	const sink = (chunk) => {
		log.push(String(chunk));
		return true;
	};
	process.stdout.write = sink;
	process.stderr.write = sink;
	t.after(() => {
		process.stdout.write = out;
		process.stderr.write = err;
	});
	return { log, cwd: process.cwd(), hasUI: false, model: {}, modelRegistry: { refresh: async () => {} }, ui: {} };
}

const text = (ctx) => ctx.log.map((e) => (typeof e === "string" ? e : e.text)).join("\n");
const written = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));

// The endpoint serves `ids`; models.dev has nothing to say about them.
function fakeFetch(ids, { meta = {} } = {}) {
	return async (url) => {
		if (String(url).includes("models.dev")) return { ok: true, json: async () => ({}) };
		return {
			ok: true,
			json: async () => ({
				data: (typeof ids === "function" ? ids() : ids).map((id) => ({
					id,
					context_length: 131072,
					max_completion_tokens: 8192,
					supported_parameters: ["reasoning"],
					...meta,
				})),
			}),
		};
	};
}

const unreachable = async (url) => {
	if (String(url).includes("models.dev")) return { ok: true, json: async () => ({}) };
	throw new Error("ECONNREFUSED");
};
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---- option parsing -------------------------------------------------------

test("parseOptions reads flags, values and positionals", () => {
	const o = parseOptions(["https://x/v1", "sk-1", "--all", "--id", "gw", "--only=a,b"]);
	assert.deepEqual(o.positional, ["https://x/v1", "sk-1"]);
	assert.ok(o.flags.has("all"));
	assert.equal(o.values.id, "gw");
	assert.deepEqual(onlyIds(o), ["a", "b"]);
	assert.equal(wantsAll(o), true);
	assert.equal(wantsWrite(o), true);
});

test("parseOptions refuses an unknown option instead of ignoring it", () => {
	// A dropped --only would add a gateway's whole catalogue instead of three models.
	assert.throws(() => parseOptions(["--onlyy", "a"]), /Unknown option: --onlyy/);
	assert.throws(() => parseOptions(["--only"]), /--only needs a value/);
	assert.throws(() => parseOptions(["--all=1"]), /does not take a value/);
});

test("parseOptions stops at --", () => {
	const o = parseOptions(["--all", "--", "--not-a-flag"]);
	assert.ok(o.flags.has("all"));
	assert.deepEqual(o.positional, ["--not-a-flag"]);
});

test("writers are opt-in and --dry-run overrides them", () => {
	assert.equal(wantsWrite(parseOptions(["https://x/v1"])), false);
	assert.equal(wantsWrite(parseOptions(["--all"])), true);
	assert.equal(wantsWrite(parseOptions(["--yes"])), true, "--yes is accepted as a synonym");
	assert.equal(wantsWrite(parseOptions(["--all", "--dry-run"])), false);
	assert.equal(wantsWrite(parseOptions(["--only", "a", "--dry-run"])), false);
});

test("an empty --only is an error, not an unfiltered write", () => {
	// H1: `--only=` used to parse as a present-but-empty filter, and the flows'
	// `if (only && only.length)` guard turned that into "add everything and prune
	// the rest" — one slipped keystroke away from wiping the configuration.
	for (const argv of [["--only="], ["--only", ""]]) {
		assert.throws(() => parseOptions(argv), /--only needs a value/);
	}
});

test("planAdd and planSync refuse an empty only list defensively", async (t) => {
	// The CLI cannot produce this anymore, but a programmatic caller can.
	await assert.rejects(() => planAdd({ baseUrl: "https://x/v1", only: [], fetchImpl: fakeFetch(["m"]) }), /--only 需要至少一个模型 id/);
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a", cost: ZERO }]) });
	await assert.rejects(() => planSync({ only: [], fetchImpl: fakeFetch(["m"]) }), /--only 需要至少一个模型 id/);
});

test("each flow rejects options it does not understand", async () => {
	// The rejection happens in restrictOptions before anything touches disk.
	const syncBad = scriptCtx();
	await assert.rejects(() => syncFlow(syncBad, { argv: ["--key", "x"] }), /sync 不支持选项：--key/);
	const checkBad = scriptCtx();
	await assert.rejects(() => checkFlow(checkBad, { argv: ["--all"] }), /check 不支持选项：--all/);
	const addBad = scriptCtx();
	await assert.rejects(() => addFlow(addBad, { argv: ["https://x/v1", "--no-prune"] }), /add 不支持选项：--no-prune/);
	const modelsBad = scriptCtx();
	await assert.rejects(() => modelsFlow(modelsBad, { argv: ["gw", "--all"] }), /models 不支持选项：--all/);
});

test("add refuses extra positionals instead of reading them as a key", async (t) => {
	const dir = withAgentDir(t);
	const ctx = printCtx(t);
	// `add <url> key1 key2` used to silently ignore key2; anything beyond URL +
	// key is a typo worth stopping on. (Trailing words after --only are consumed
	// as ids now, so this is the remaining way to get surplus positionals.)
	await addFlow(ctx, {
		argv: ["https://gw.example.com/v1", "sk-1", "sk-2"],
		fetchImpl: fakeFetch(["m"]),
	});
	assert.match(text(ctx), /参数过多/);
	assert.ok(!fs.existsSync(path.join(dir, "models.json")));
});

test("--only accepts several space-separated ids without eating them as a key", async (t) => {
	// The old single-word parse read m2 as the API key and silently dropped it
	// from the filter; space-separated ids are now consumed by --only itself.
	const dir = withAgentDir(t);
	const ctx = scriptCtx();
	await addFlow(ctx, {
		argv: ["https://gw.example.com/v1", "--only", "m1", "m2", "--all"],
		fetchImpl: fakeFetch(["m1", "m2", "m3"]),
	});
	assert.deepEqual(written(dir).providers["gw-example-com"].models.map((m) => m.id), ["m1", "m2"]);
	assert.equal(written(dir).providers["gw-example-com"].apiKey, "none", "m2 must not become the API key");
});

// ---- add ------------------------------------------------------------------

test("add without a write flag prints the plan and writes nothing", async (t) => {
	const dir = withAgentDir(t);
	const ctx = printCtx(t);
	await addFlow(ctx, { argv: ["https://gw.example.com/v1", "sk-1"], fetchImpl: fakeFetch(["a-model"]) });

	assert.equal(fs.existsSync(path.join(dir, "models.json")), false, "a plan must not touch disk");
	assert.match(text(ctx), /探测到 1 个模型/);
	assert.match(text(ctx), /什么都没写入/);
	assert.match(text(ctx), /--all/);
});

test("add --all writes every probed model in one shot, with no dialogs", async (t) => {
	const dir = withAgentDir(t);
	const ctx = scriptCtx();
	await addFlow(ctx, { argv: ["https://gw.example.com/v1", "sk-" + "k".repeat(40), "--all"], fetchImpl: fakeFetch(["a-model", "b-model"]) });

	const provider = written(dir).providers["gw-example-com"];
	assert.deepEqual(provider.models.map((m) => m.id), ["a-model", "b-model"]);
	assert.equal(provider.api, "openai-completions");
	assert.equal(provider.apiKey, "sk-" + "k".repeat(40));
	const model = provider.models[0];
	assert.equal(model.contextWindow, 131072, "context window comes from the endpoint");
	assert.equal(model.maxTokens, 8192);
	assert.equal(model.reasoning, true);
	// pi-ai's calculateCost dereferences cost, so a missing one fails the turn.
	assert.deepEqual(model.cost, ZERO);
	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("models.json.bak-")) === false, "nothing existed to back up");
	// The key must never be echoed in full.
	assert.ok(!text(ctx).includes("k".repeat(40)));
});

test("add --only writes exactly the listed models", async (t) => {
	const dir = withAgentDir(t);
	const ctx = scriptCtx();
	await addFlow(ctx, {
		argv: ["https://gw.example.com/v1", "sk-1", "--only", "b-model"],
		fetchImpl: fakeFetch(["a-model", "b-model", "c-model"]),
	});
	assert.deepEqual(written(dir).providers["gw-example-com"].models.map((m) => m.id), ["b-model"]);
});

test("add --only refuses ids the endpoint never offered", async (t) => {
	withAgentDir(t);
	const ctx = scriptCtx();
	await addFlow(ctx, { argv: ["https://gw.example.com/v1", "sk-1", "--only", "nope"], fetchImpl: fakeFetch(["a-model"]) });
	assert.match(text(ctx), /端点未提供这些模型：nope/);
});

test("add takes the key from --key and from PI_MODEL_CONFIG_API_KEY", async (t) => {
	const dir = withAgentDir(t);
	await addFlow(scriptCtx(), {
		argv: ["https://gw.example.com/v1", "--key", "from-flag", "--all"],
		fetchImpl: fakeFetch(["m"]),
	});
	assert.equal(written(dir).providers["gw-example-com"].apiKey, "from-flag");

	process.env.PI_MODEL_CONFIG_API_KEY = "from-env";
	t.after(() => {
		delete process.env.PI_MODEL_CONFIG_API_KEY;
	});
	await addFlow(scriptCtx(), {
		argv: ["https://two.example.com/v1", "--only", "m", "--id", "two"],
		fetchImpl: fakeFetch(["m"]),
	});
	assert.equal(written(dir).providers.two.apiKey, "from-env");
});

test("add refuses a bad URL, an unknown API type and a bad provider id", async (t) => {
	withAgentDir(t);
	const url = scriptCtx();
	await addFlow(url, { argv: ["not-a-url", "--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(url), /不是有效的 URL：not-a-url/);

	const api = scriptCtx();
	await addFlow(api, { argv: ["https://x/v1", "--api", "nonsense", "--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(api), /未知的 API 类型：nonsense/);

	const pid = scriptCtx();
	await addFlow(pid, { argv: ["https://x/v1", "--id", "bad id!", "--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(pid), /供应商 id 只能包含/);

	const none = scriptCtx();
	await addFlow(none, { argv: ["--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(none), /没有给出端点 URL/);
});

test("add explains a 401 instead of just reporting HTTP 401", async (t) => {
	withAgentDir(t);
	const ctx = printCtx(t);
	const denied = async (url) => {
		if (String(url).includes("models.dev")) return { ok: true, json: async () => ({}) };
		return { ok: false, status: 401, json: async () => ({}) };
	};
	await addFlow(ctx, { argv: ["https://gw.example.com/v1"], fetchImpl: denied });
	assert.match(text(ctx), /HTTP 401/);
	assert.match(text(ctx), /请把 Key 作为第二个参数传入，或用 --key/);
});

test("add keeps the interactive path when no arguments are given", async (t) => {
	withAgentDir(t);
	const ctx = printCtx(t);
	await addFlow(ctx, {});
	// No argv means the five-question flow, which needs dialogs.
	assert.match(text(ctx), /add 需要交互式会话/);
});

test("add --help prints the usage without touching the network", async (t) => {
	withAgentDir(t);
	const ctx = printCtx(t);
	let called = 0;
	await addFlow(ctx, {
		argv: ["--help"],
		fetchImpl: async () => {
			called += 1;
			return { ok: true, json: async () => ({}) };
		},
	});
	assert.match(text(ctx), /用法：/);
	assert.match(text(ctx), /--no-prune/);
	assert.equal(called, 0);
});

test("planAdd reports whether the provider already exists", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { keep: { baseUrl: "https://k/v1" } } }));
	const fresh = await planAdd({ baseUrl: "https://new/v1", pid: "new", fetchImpl: fakeFetch(["m"]) });
	assert.equal(fresh.replaces, false);
	const replaced = await planAdd({ baseUrl: "https://k/v1", pid: "keep", fetchImpl: fakeFetch(["m"]) });
	assert.equal(replaced.replaces, true);
});

test("--force is rejected instead of being silently ignored", () => {
	// It used to be accepted and do nothing, which is the same trap as a dropped
	// --only: the user believes something was forced.
	assert.throws(() => parseOptions(["--force"]), /Unknown option: --force/);
});

test("models: interactive removal writes models.json and the hidden list", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "keep" }, { id: "drop-me" }, { id: "also-drop" }]) });
	const answers = ["gw", "drop-me", "also-drop", "— 完成 —", true];
	const dialogs = [];
	const ctx = {
		log: [], cwd: dir, hasUI: true, model: {}, modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => dialogs.push({ text, level }),
			select: async (title, items) => {
				dialogs.push({ text: `[select] ${title}: ${items.join("|")}` });
				// 找到答案里第一个还在列表里的项
				for (const a of answers) {
					if (typeof a === "string" && items.includes(a)) { answers.splice(answers.indexOf(a), 1); return a; }
				}
				return items[items.length - 1];
			},
			confirm: async (title, body) => { dialogs.push({ text: `[confirm] ${title}: ${body}` }); return answers.shift() ?? answers[answers.length - 1]; },
			input: async () => { throw new Error("unexpected input"); },
		},
	};

	await modelsFlow(ctx, {});

	const models = written(dir).providers.gw.models.map((m) => m.id);
	assert.deepEqual(models, ["keep"]);
	const userConfig = JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8"));
	assert.deepEqual(userConfig.hiddenModels.gw.sort(), ["also-drop", "drop-me"]);
	const all = dialogs.map((d) => d.text).join("\n");
	assert.match(all, /\[confirm\] 删除模型/);
	assert.match(all, /drop-me、also-drop/);
	assert.match(all, /sync 不会再补回来/);
	assert.match(all, /快照/, "提醒 /model 列表是会话启动时的快照");
});

test("models: declining the confirmation writes nothing", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a" }, { id: "b" }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx({ confirm: false });
	// select 需要可用：临时替换为返回第一个模型再"完成"
	ctx.ui.select = async (_title, items) => (items[0] === "a" ? "a" : "— 完成 —");

	await modelsFlow(ctx, { argv: ["gw"] });

	assert.match(text(ctx), /已取消，什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("models: --only removes exactly those ids without dialogs", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a" }, { id: "b" }, { id: "c" }]) });
	const ctx = scriptCtx({ confirm: false });
	ctx.ui.select = async () => { throw new Error("no dialogs expected"); };

	await modelsFlow(ctx, { argv: ["gw", "--only", "a,c"] });

	assert.deepEqual(written(dir).providers.gw.models.map((m) => m.id), ["b"]);
	const userConfig = JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8"));
	assert.deepEqual(userConfig.hiddenModels.gw.sort(), ["a", "c"]);
});

test("models: unknown provider and unknown ids are refused or skipped", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a" }]) });

	const bad = scriptCtx();
	await modelsFlow(bad, { argv: ["nope", "--only", "a"] });
	assert.match(text(bad), /models\.json 里没有这个供应商：nope/);

	const partial = scriptCtx();
	await modelsFlow(partial, { argv: ["gw", "--only", "a,ghost"] });
	assert.match(text(partial), /已跳过：ghost/);
	assert.deepEqual(written(dir).providers.gw.models.map((m) => m.id), []);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8")).hiddenModels.gw, ["a"]);
});

test("sync does not re-add models the user deleted by hand", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(
		path.join(dir, "model-config.json"),
		JSON.stringify({ hiddenModels: { gw: ["removed-by-hand"] } }),
	);
	seed(dir, { gw: provider([{ id: "kept", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const ctx = scriptCtx({ confirm: true });
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["kept", "fresh", "removed-by-hand"]) });

	const ids = written(dir).providers.gw.models.map((m) => m.id);
	assert.ok(ids.includes("fresh"), "普通新模型照常补入");
	assert.ok(!ids.includes("removed-by-hand"), "忽略名单里的模型不被补回");
	assert.notEqual(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("sync --only restores a hidden model and clears it from the ignore list", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "kept", cost: ZERO }]) });
	fs.writeFileSync(
		path.join(dir, "model-config.json"),
		JSON.stringify({ hiddenModels: { gw: ["removed-by-hand"] } }),
	);

	const ctx = scriptCtx({ confirm: true });
	await syncFlow(ctx, { argv: ["--only", "removed-by-hand"], fetchImpl: fakeFetch(["kept", "removed-by-hand"]) });

	assert.ok(
		written(dir).providers.gw.models.some((m) => m.id === "removed-by-hand"),
		"--only 点名忽略名单里的 id 是明确的恢复意图",
	);
	const userConfig = JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8"));
	assert.ok(!userConfig.hiddenModels?.gw?.includes("removed-by-hand"), "同时从忽略名单移除");
	assert.match(text(ctx), /已从忽略名单恢复：removed-by-hand/);
});

test("sync --all reports hidden candidates without restoring them", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "kept", cost: ZERO }]) });
	fs.writeFileSync(
		path.join(dir, "model-config.json"),
		JSON.stringify({ hiddenModels: { gw: ["removed-by-hand"] } }),
	);
	const ignoreBefore = fs.readFileSync(path.join(dir, "model-config.json"), "utf8");

	const ctx = scriptCtx({ confirm: true });
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["kept", "removed-by-hand"]) });

	assert.ok(
		!written(dir).providers.gw.models.some((m) => m.id === "removed-by-hand"),
		"脚本化 --all 不许悄悄恢复",
	);
	assert.match(text(ctx), /忽略名单里，未添加：removed-by-hand/);
	assert.equal(fs.readFileSync(path.join(dir, "model-config.json"), "utf8"), ignoreBefore);
});

test("the menu path asks before restoring hidden models", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "kept", cost: ZERO }]) });
	fs.writeFileSync(
		path.join(dir, "model-config.json"),
		JSON.stringify({ hiddenModels: { gw: ["removed-by-hand"] } }),
	);

	// Accepted: the model is added and the ignore list loses the id.
	const yes = scriptCtx({ confirm: true });
	await syncFlow(yes, { fetchImpl: fakeFetch(["kept", "removed-by-hand"]), argv: undefined });
	assert.match(text(yes), /\[confirm\] 忽略名单里的模型/);
	assert.ok(written(dir).providers.gw.models.some((m) => m.id === "removed-by-hand"));
	assert.ok(
		!JSON.parse(fs.readFileSync(path.join(dir, "model-config.json"), "utf8")).hiddenModels?.gw?.includes("removed-by-hand"),
		"清空后整个键被删除",
	);

	// Declined twice: neither the restore nor the write happens.
	const dir2 = withAgentDir(t);
	seed(dir2, { gw: provider([{ id: "kept", cost: ZERO }]) });
	fs.writeFileSync(
		path.join(dir2, "model-config.json"),
		JSON.stringify({ hiddenModels: { gw: ["removed-by-hand"] } }),
	);
	const before = fs.readFileSync(path.join(dir2, "models.json"), "utf8");
	const no = scriptCtx({ confirm: false });
	await syncFlow(no, { fetchImpl: fakeFetch(["kept", "removed-by-hand"]), argv: undefined });
	assert.match(text(no), /已取消，什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir2, "models.json"), "utf8"), before);
	assert.ok(
		JSON.parse(fs.readFileSync(path.join(dir2, "model-config.json"), "utf8")).hiddenModels.gw.includes("removed-by-hand"),
		"拒绝恢复时忽略名单保持原样",
	);
});

// ---- check in a session with no UI ----------------------------------------

test("check reports in print mode instead of crashing on a missing dialog", async (t) => {
	// ctx.ui.confirm used to be called unconditionally off the startup path, so
	// `pi -p "/model-config check"` threw a TypeError right after printing the report.
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO }]),
	});
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const ctx = printCtx(t);
	await assert.doesNotReject(() => checkFlow(ctx, { fetchImpl: fakeFetch(["m"]) }));

	assert.match(text(ctx), /ctx 4096 -> 131072/);
	assert.match(text(ctx), /不写入任何内容/);
	assert.match(text(ctx), /sync --all/, "指出有明确同意的路径");
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before, "an unconfirmed repair must not be written");
});

test("check does not ask for the made-up `--select` flag", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", contextWindow: 131072, maxTokens: 8192, reasoning: true, input: ["text"], cost: ZERO }]),
	});
	const ctx = printCtx(t);
	await checkFlow(ctx, { fetchImpl: fakeFetch(["m"]) });
	const report = text(ctx);
	assert.ok(!/--select/.test(report), "no such flag is documented:" + report);
	assert.match(report, /只报告所有端点/);
});

test("check --fix repairs every deviation without a dialog in print mode", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO }]),
	});
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const ctx = printCtx(t);
	await checkFlow(ctx, { argv: ["--fix"], fetchImpl: fakeFetch(["m"]) });

	const model = written(dir).providers.gw.models[0];
	assert.equal(model.contextWindow, 131072, "the endpoint metadata was applied");
	assert.notEqual(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
	assert.match(text(ctx), /已写入 models\.json/);
});

test("check refuses an unknown flag instead of ignoring it", async (t) => {
	withAgentDir(t);
	const ctx = printCtx(t);
	await assert.rejects(
		() => checkFlow(ctx, { argv: ["--fixx"], fetchImpl: fakeFetch(["m"]) }),
		/Unknown option: --fixx/,
	);
});

// ---- sync -----------------------------------------------------------------

function seed(dir, providers) {
	fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers }));
}

const provider = (models, extra = {}) => ({
	baseUrl: "https://gw.example.com/v1",
	api: "openai-completions",
	apiKey: "sk-test",
	models,
	...extra,
});

test("sync in print mode writes nothing without --all or --only", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "old-model" }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = printCtx(t);
	await syncFlow(ctx, { fetchImpl: fakeFetch(["new-model"]) });

	assert.match(text(ctx), /1 个新模型/);
	assert.match(text(ctx), /端点已不再提供/);
	assert.match(text(ctx), /什么都没写入/);
	assert.match(text(ctx), /--all/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before, "the plan must not rewrite the file");
});

test("the menu path asks for consent and then writes", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "old-model" }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	// Declined: byte-identical.
	const no = scriptCtx({ confirm: false });
	await syncFlow(no, { fetchImpl: fakeFetch(["new-model"]), argv: undefined });
	assert.match(text(no), /应用同步/);
	assert.match(text(no), /新增 1、删除 1、修复 0/);
	assert.match(text(no), /将删除以下模型/);
	assert.match(text(no), /已取消，什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);

	// Accepted: written, and the deletion consent was already part of the dialog
	// (no second confirm — exactly one dialog was recorded).
	const yes = scriptCtx({ confirm: true });
	await syncFlow(yes, { fetchImpl: fakeFetch(["new-model"]), argv: undefined });
	assert.match(text(yes), /已写入 models\.json（保留备份）/);
	assert.equal(yes.log.filter((e) => e.text.startsWith("[confirm]")).length, 1, "删除同意已含在应用确认里，不再二次弹窗");
	assert.deepEqual(written(dir).providers.gw.models.map((m) => m.id), ["new-model"]);
});

test("typing /model-config sync with no arguments also asks for consent", async (t) => {
	// argv arrives as an empty array when the user types the subcommand with no
	// arguments — that is a menu-like request, not a scripted one, so the consent
	// dialog is the writer flag here too.
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "old-model" }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const no = scriptCtx({ confirm: false });
	await syncFlow(no, { argv: [], fetchImpl: fakeFetch(["new-model"]) });
	assert.match(text(no), /\[confirm\] 应用同步/);
	assert.match(text(no), /已取消，什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);

	const yes = scriptCtx({ confirm: true });
	await syncFlow(yes, { argv: [], fetchImpl: fakeFetch(["new-model"]) });
	assert.match(text(yes), /已写入 models\.json（保留备份）/);
	assert.deepEqual(written(dir).providers.gw.models.map((m) => m.id), ["new-model"]);
});

test("the menu path skips the dialog when there is nothing to change", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m" }]) });
	// First converge via the flag path so the entry exactly matches the endpoint.
	await syncFlow(scriptCtx({ confirm: true }), { argv: ["--all"], fetchImpl: fakeFetch(["m"]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const ctx = scriptCtx({ confirm: true });
	await syncFlow(ctx, { fetchImpl: fakeFetch(["m"]), argv: undefined });
	assert.equal(ctx.log.filter((e) => e.text.startsWith("[confirm]")).length, 0, "已同步时不应弹确认");
	assert.match(text(ctx), /已同步/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("sync --all adds new models, removes gone ones and keeps the rest", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([
			{ id: "keep-model", contextWindow: 131072, maxTokens: 8192, reasoning: true, input: ["text"], cost: ZERO },
			{ id: "gone-model", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO },
		]),
	});
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["keep-model", "fresh-model"]) });

	const models = written(dir).providers.gw.models;
	assert.deepEqual(models.map((m) => m.id), ["keep-model", "fresh-model"]);
	const fresh = models.find((m) => m.id === "fresh-model");
	assert.equal(fresh.contextWindow, 131072, "a new model is inferred from the endpoint");
	assert.deepEqual(fresh.cost, ZERO);
	assert.match(text(ctx), /已写入 models\.json/);
	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("models.json.bak-")), "a delete must be preceded by a backup");
});

test("a model that is being removed is not also reported as a repair", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "gone-model" }]) });
	const plan = await planSync({ fetchImpl: fakeFetch(["other-model"]) });
	const report = renderSyncPlan(plan);
	assert.match(report, /gone-model/);
	assert.ok(!/to repair/.test(report), `a doomed model must not be listed twice:\n${report}`);
	const row = plan.rows[0];
	assert.deepEqual(row.removed, ["gone-model"]);
	assert.deepEqual(row.changed, []);
});

test("sync never removes anything when the endpoint cannot be read", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a-model", cost: ZERO }, { id: "b-model", cost: ZERO }]) });
	const before = written(dir).providers.gw.models.map((m) => m.id);
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: unreachable });

	const after = written(dir).providers.gw.models.map((m) => m.id);
	assert.deepEqual(after, before, "an unreachable gateway must not wipe the configuration");
	assert.match(text(ctx), /端点无法读取：ECONNREFUSED/);
	assert.match(text(ctx), /sync 不做猜测/);
	assert.match(text(ctx), /无法读取/);
	// "Already in sync" would be a lie: nothing could be checked.
	assert.ok(!/已经同步/.test(text(ctx)));
});

test("--yes does not skip the delete confirmation when a UI exists", async (t) => {
	// Deleting models is the only irreversible thing here, so it asks once even
	// for --yes. Cancelling must leave the file byte-identical.
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "gone-model", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const asked = [];
	const ctx = scriptCtx({ confirm: false });
	const realConfirm = ctx.ui.confirm;
	ctx.ui.confirm = async (title, body) => {
		asked.push(`${title}: ${body}`);
		return realConfirm();
	};

	await syncFlow(ctx, { argv: ["--all", "--yes"], fetchImpl: fakeFetch(["fresh-model"]) });

	assert.equal(asked.length, 1, "--yes must still ask exactly once");
	assert.match(asked[0], /删除模型/);
	assert.match(asked[0], /gone-model/);
	assert.match(text(ctx), /已取消，什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("sync --no-prune keeps models the endpoint stopped listing", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "gone-model", cost: ZERO }]) });
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all", "--no-prune"], fetchImpl: fakeFetch(["fresh-model"]) });

	const models = written(dir).providers.gw.models;
	assert.deepEqual(models.map((m) => m.id).sort(), ["fresh-model", "gone-model"]);
	assert.match(text(ctx), /被保留（--no-prune）/);
});

test("sync --only limits additions but still prunes", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "gone-model", cost: ZERO }]) });
	await syncFlow(scriptCtx(), { argv: ["--only", "b-model"], fetchImpl: fakeFetch(["a-model", "b-model"]) });

	const models = written(dir).providers.gw.models.map((m) => m.id);
	assert.deepEqual(models, ["b-model"], "--only chose b, and gone-model was pruned");
});

test("sync refuses an unknown provider, an unknown --only id and an empty config", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "a", cost: ZERO }]) });

	const unknownProvider = scriptCtx();
	await syncFlow(unknownProvider, { argv: ["nope", "--all"], fetchImpl: fakeFetch(["a"]) });
	assert.match(text(unknownProvider), /models\.json 里没有这个供应商：nope/);

	const unknownModel = scriptCtx();
	await syncFlow(unknownModel, { argv: ["--only", "typo-model"], fetchImpl: fakeFetch(["a"]) });
	assert.match(text(unknownModel), /所有端点都不提供这些模型：typo-model/);

	seed(dir, {});
	const empty = scriptCtx();
	await syncFlow(empty, { argv: ["--all"], fetchImpl: fakeFetch([]) });
	assert.match(text(empty), /还没有任何供应商/);
});

test("sync skips a runtime provider and leaves its static fallback alone", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["me"] }));
	assert.ok(runtimeProviders().has("me"), "the fake config is in effect");
	seed(dir, { me: provider([{ id: "static-fallback", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["something-else"]) });

	assert.match(text(ctx), /运行时供应商，模型列表由另一个扩展管理/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("sync repairs drifting parameters without touching the model list", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", contextWindow: 999, maxTokens: 100, reasoning: false, input: ["text"], cost: ZERO }]),
	});
	await syncFlow(scriptCtx(), { argv: ["--all"], fetchImpl: fakeFetch(["m"]) });

	const model = written(dir).providers.gw.models[0];
	assert.equal(model.id, "m");
	assert.equal(model.contextWindow, 131072);
	assert.equal(model.maxTokens, 8192);
	assert.equal(model.reasoning, true);
});

test("sync writes one entry per model even when the endpoint repeats an id", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([]) });
	await syncFlow(scriptCtx(), { argv: ["--all"], fetchImpl: fakeFetch(["dup", "dup", "other"]) });

	const ids = written(dir).providers.gw.models.map((m) => m.id);
	assert.deepEqual(ids, ["dup", "other"], "a repeated id must not become two identical entries");
});

test("sync fills a provider that has no model list at all", async (t) => {
	// Hand-writing { baseUrl, api, apiKey } and asking sync to populate it is the
	// obvious use of the command; `check` skips such a provider by design.
	const dir = withAgentDir(t);
	seed(dir, {
		blank: { baseUrl: "https://gw.example.com/v1", api: "openai-completions", apiKey: "sk-test", models: [] },
		absent: { baseUrl: "https://gw.example.com/v1", api: "openai-completions", apiKey: "sk-test" },
	});
	await syncFlow(scriptCtx(), { argv: ["--all"], fetchImpl: fakeFetch(["m1", "m2"]) });

	for (const pid of ["blank", "absent"]) {
		const models = written(dir).providers[pid].models;
		assert.deepEqual(models.map((m) => m.id), ["m1", "m2"], `${pid} was not filled`);
		assert.deepEqual(models[0].cost, ZERO, "a filled model still carries cost");
	}
});

test("sync still refuses to fill a provider another extension owns", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["me"] }));
	seed(dir, { me: { baseUrl: "https://gw.example.com/v1", api: "openai-completions", apiKey: "k", models: [] } });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["live-model"]) });

	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
	assert.match(text(ctx), /运行时供应商/);
});

test("applySync reports when there is genuinely nothing to do", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", contextWindow: 131072, maxTokens: 8192, reasoning: true, input: ["text"], cost: ZERO }]),
	});
	const ctx = scriptCtx();
	const plan = await planSync({ fetchImpl: fakeFetch(["m"], { meta: { supported_parameters: ["reasoning"] } }) });
	// force any residual drift out of the picture, then apply
	for (const row of plan.rows) {
		row.added = [];
		row.changed = [];
		row.removed = [];
	}
	const touched = await applySync(ctx, plan, { prune: true });
	assert.deepEqual(touched, []);
	assert.match(text(ctx), /已经同步/);
});

test("sync --help prints the usage", async (t) => {
	withAgentDir(t);
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--help"] });
	assert.match(text(ctx), /用法：/);
	assert.match(text(ctx), /\/model-config sync/);
});

// ---- edit ------------------------------------------------------------------

const EDIT_BASE = "https://new-gw.example.com/v1";

function editFetch({ ok = true, status = 200, ids = ["m"] } = {}) {
	return async (url) => {
		if (String(url).includes("models.dev")) return { ok: true, json: async () => ({}) };
		if (!ok) return { ok: false, status };
		return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) };
	};
}

test("edit --all updates only the given fields and keeps the model list", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "keep-me", contextWindow: 131072, maxTokens: 8192, reasoning: true, input: ["text"], cost: ZERO }]) });
	const ctx = scriptCtx();

	await editFlow(ctx, { argv: ["gw", "--url", EDIT_BASE, "--key", "sk-new", "--all"], fetchImpl: editFetch() });

	const p = written(dir).providers.gw;
	assert.equal(p.baseUrl, EDIT_BASE);
	assert.equal(p.apiKey, "sk-new");
	assert.equal(p.api, "openai-completions", "api untouched");
	assert.deepEqual(p.models.map((m) => m.id), ["keep-me"], "the model list is not replaced");
	assert.match(text(ctx), /已修改 gw/);
	assert.match(text(ctx), /模型列表未动/);
});

test("edit without --all prints the plan and writes nothing", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = printCtx(t);

	await editFlow(ctx, { argv: ["gw", "--url", EDIT_BASE], fetchImpl: editFetch() });

	assert.match(text(ctx), /baseUrl: https:\/\/gw\.example\.com\/v1 ->/);
	assert.match(text(ctx), /什么都没写入/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("edit refuses a dead endpoint and writes nothing", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx();

	await editFlow(ctx, { argv: ["gw", "--url", "https://dead.example.com/v1", "--all"], fetchImpl: editFetch({ ok: false, status: 503 }) });

	assert.match(text(ctx), /新端点无法访问（HTTP 503）：什么都没改/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);
});

test("edit of key only does not probe and applies immediately", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });
	const ctx = scriptCtx();
	let probed = 0;
	const fetchImpl = async (url) => {
		if (!String(url).includes("models.dev")) probed += 1;
		return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
	};

	await editFlow(ctx, { argv: ["gw", "--key", "sk-rotated", "--all"], fetchImpl });

	assert.equal(written(dir).providers.gw.apiKey, "sk-rotated");
	assert.equal(probed, 0, "a key-only edit has nothing to verify at the endpoint");
});

test("edit --id renames the provider and refuses occupied ids", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "m", cost: ZERO }]),
		other: provider([{ id: "n", cost: ZERO }]),
	});
	const ctx = scriptCtx();

	await editFlow(ctx, { argv: ["gw", "--id", "renamed", "--all"], fetchImpl: editFetch() });

	const providers = written(dir).providers;
	assert.equal(providers.gw, undefined);
	assert.equal(providers.renamed.baseUrl, "https://gw.example.com/v1");
	assert.ok(providers.other, "the other provider survived");

	const dir2 = withAgentDir(t);
	seed(dir2, {
		gw: provider([{ id: "m", cost: ZERO }]),
		other: provider([{ id: "n", cost: ZERO }]),
	});
	const busy = scriptCtx();
	await editFlow(busy, { argv: ["gw", "--id", "other", "--all"], fetchImpl: editFetch() });
	assert.match(text(busy), /供应商 id 已被占用：other/);
});

test("edit refuses unknown provider, unknown flag and no-op edits", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });

	const nope = scriptCtx();
	await editFlow(nope, { argv: ["nope", "--url", EDIT_BASE, "--all"], fetchImpl: editFetch() });
	assert.match(text(nope), /models\.json 里没有这个供应商：nope/);

	const flag = scriptCtx();
	await assert.rejects(() => editFlow(flag, { argv: ["gw", "--only", "x"] }), /edit 不支持选项：--only/);

	const noop = scriptCtx();
	await editFlow(noop, { argv: ["gw", "--api", "openai-completions", "--all"], fetchImpl: editFetch() });
	assert.match(text(noop), /没有要修改的字段/);
});

test("scripted edit refuses a plaintext endpoint and interactive edit asks", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");

	const scripted = scriptCtx();
	await editFlow(scripted, { argv: ["gw", "--url", "http://plain.example.com/v1", "--all"], fetchImpl: editFetch() });
	assert.match(text(scripted), /脚本化 edit 拒绝执行/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before);

	const interactive = {
		log: [], cwd: dir, hasUI: true, model: {}, modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => interactive.log.push({ text, level }),
			select: async (_title, items) => (items.includes("端点地址") ? "端点地址" : items.find((i) => i.startsWith("— 完成")) ?? items[0]),
			input: async () => "http://plain.example.com/v1",
			confirm: async (title) => {
				interactive.log.push({ text: `[confirm] ${title}` });
				return true;
			},
		},
	};
	await editFlow(interactive, { fetchImpl: editFetch() });
	assert.match(text(interactive), /\[confirm\] 明文传输警告/);
	assert.equal(written(dir).providers.gw.baseUrl, "http://plain.example.com/v1", "the user accepted the risk");
});

// ---- concurrent edits between plan and apply -----------------------------

test("applySync aligns repairs by model id, not by index", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", contextWindow: 999, maxTokens: 100, reasoning: false, input: ["text"], cost: ZERO }]) });
	const plan = await planSync({ fetchImpl: fakeFetch(["m"]) });

	// While the plan's confirm dialogs were "open", another writer prepends a
	// model. Index alignment would write m's repaired metadata onto added-later.
	seed(dir, {
		gw: provider([
			{ id: "added-later", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO },
			{ id: "m", contextWindow: 999, maxTokens: 100, reasoning: false, input: ["text"], cost: ZERO },
		]),
	});

	await applySync(scriptCtx(), plan, { prune: true });
	const models = written(dir).providers.gw.models;
	const repaired = models.find((m) => m.id === "m");
	assert.equal(repaired.contextWindow, 131072, "m was repaired by id");
	const added = models.find((m) => m.id === "added-later");
	assert.equal(added.contextWindow, 4096, "the concurrent addition survived untouched");
});

test("remove re-reads after the confirm and preserves concurrent edits", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, {
		gw: provider([{ id: "a", cost: ZERO }]),
		other: provider([{ id: "b", cost: ZERO }]),
	});
	const dialogs = [];
	const ctx = {
		log: [], cwd: dir, hasUI: true, model: {}, modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => dialogs.push({ text, level }),
			select: async (_title, items) => items[0],
			// The other session adds a model to `other` while the user reads the
			// confirm dialog; deleting from the startup snapshot would erase it.
			confirm: async (title) => {
				dialogs.push({ text: `[confirm] ${title}` });
				seed(dir, {
					gw: provider([{ id: "a", cost: ZERO }]),
					other: provider([{ id: "b", cost: ZERO }, { id: "added-while-confirming", cost: ZERO }]),
				});
				return true;
			},
			input: async () => { throw new Error("unexpected input"); },
		},
	};

	await removeFlow(ctx, {});

	const providers = written(dir).providers;
	assert.equal(providers.gw, undefined, "gw was deleted");
	assert.ok(
		providers.other.models.some((m) => m.id === "added-while-confirming"),
		"the concurrent edit to another provider survived",
	);
});

test("check re-reads after the confirm and repairs by id", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO }]) });
	const dialogs = [];
	const ctx = {
		log: [], cwd: dir, hasUI: true, model: {}, modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => dialogs.push({ text, level }),
			select: async (_title, items) => (items.includes("全部端点") ? "全部端点" : items[0]),
			confirm: async (title) => {
				dialogs.push({ text: `[confirm] ${title}` });
				// Another writer adds a model while the user reads the dialog.
				seed(dir, {
					gw: provider([
						{ id: "added-while-confirming", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO },
						{ id: "m", contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ["text"], cost: ZERO },
					]),
				});
				return true;
			},
			input: async () => { throw new Error("unexpected input"); },
		},
	};

	await checkFlow(ctx, { fetchImpl: fakeFetch(["m"]) });

	const models = written(dir).providers.gw.models;
	const repaired = models.find((m) => m.id === "m");
	assert.equal(repaired.contextWindow, 131072, "m was repaired from the endpoint metadata");
	assert.ok(
		models.some((m) => m.id === "added-while-confirming"),
		"the concurrent addition survived the repair write",
	);
});

test("a corrupt model-config.json is never clobbered by a write path", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "keep" }, { id: "drop-me" }]) });
	fs.writeFileSync(path.join(dir, "model-config.json"), "{ not json");
	const corrupt = fs.readFileSync(path.join(dir, "model-config.json"), "utf8");
	const ctx = {
		log: [], cwd: dir, hasUI: true, model: {}, modelRegistry: { refresh: async () => {} },
		ui: {
			notify: (text, level) => ctx.log.push({ text, level }),
			select: async (_title, items) => {
				if (items.includes("gw")) return "gw";
				return items[0];
			},
			confirm: async () => true,
			input: async () => { throw new Error("unexpected input"); },
		},
	};

	await modelsFlow(ctx, { argv: ["gw", "--only", "drop-me"] });

	assert.deepEqual(written(dir).providers.gw.models.map((m) => m.id), ["keep"], "the removal itself still applied");
	assert.equal(
		fs.readFileSync(path.join(dir, "model-config.json"), "utf8"),
		corrupt,
		"the corrupt file must not be overwritten with {}",
	);
	assert.match(text(ctx), /无法读取或解析/);
	assert.match(text(ctx), /忽略名单没有更新/);
});

test("sync refuses to run when model-config.json is unparseable", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "m", cost: ZERO }]) });
	fs.writeFileSync(path.join(dir, "model-config.json"), "{ not json");
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx({ confirm: true });

	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["m"]) });

	assert.match(text(ctx), /sync 失败：model-config\.json could not be parsed/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before, "sync must not act without the ignore list");
});
