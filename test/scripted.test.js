// The scripted forms: `/model-setup add <url> <key>` and `/model-setup sync`.
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
			confirm: async () => confirm,
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

// ---- add ------------------------------------------------------------------

test("add without a write flag prints the plan and writes nothing", async (t) => {
	const dir = withAgentDir(t);
	const ctx = printCtx(t);
	await addFlow(ctx, { argv: ["https://gw.example.com/v1", "sk-1"], fetchImpl: fakeFetch(["a-model"]) });

	assert.equal(fs.existsSync(path.join(dir, "models.json")), false, "a plan must not touch disk");
	assert.match(text(ctx), /Probed 1 model\(s\)/);
	assert.match(text(ctx), /Nothing was written/);
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
	assert.match(text(ctx), /does not list: nope/);
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
	assert.match(text(url), /Not a URL: not-a-url/);

	const api = scriptCtx();
	await addFlow(api, { argv: ["https://x/v1", "--api", "nonsense", "--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(api), /Unknown API type: nonsense/);

	const pid = scriptCtx();
	await addFlow(pid, { argv: ["https://x/v1", "--id", "bad id!", "--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(pid), /Provider id may only contain/);

	const none = scriptCtx();
	await addFlow(none, { argv: ["--all"], fetchImpl: fakeFetch(["m"]) });
	assert.match(text(none), /No endpoint URL given/);
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
	assert.match(text(ctx), /Pass the key as the second argument or with --key/);
});

test("add keeps the interactive path when no arguments are given", async (t) => {
	withAgentDir(t);
	const ctx = printCtx(t);
	await addFlow(ctx, {});
	// No argv means the five-question flow, which needs dialogs.
	assert.match(text(ctx), /add needs an interactive session/);
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
	assert.match(text(ctx), /Usage:/);
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

test("sync writes nothing without --all or --only", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "old-model" }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx();
	await syncFlow(ctx, { fetchImpl: fakeFetch(["new-model"]) });

	assert.match(text(ctx), /1 new model\(s\)/);
	assert.match(text(ctx), /the endpoint no longer lists/);
	assert.match(text(ctx), /Nothing was written/);
	assert.equal(fs.readFileSync(path.join(dir, "models.json"), "utf8"), before, "the plan must not rewrite the file");
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
	assert.match(text(ctx), /Wrote models\.json/);
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
	assert.match(text(ctx), /endpoint unreadable: ECONNREFUSED/);
	assert.match(text(ctx), /skipped: sync will not guess/);
	assert.match(text(ctx), /could not be read/);
	// "Already in sync" would be a lie: nothing could be checked.
	assert.ok(!/already in sync/.test(text(ctx)));
});

test("sync --no-prune keeps models the endpoint stopped listing", async (t) => {
	const dir = withAgentDir(t);
	seed(dir, { gw: provider([{ id: "gone-model", cost: ZERO }]) });
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all", "--no-prune"], fetchImpl: fakeFetch(["fresh-model"]) });

	const models = written(dir).providers.gw.models;
	assert.deepEqual(models.map((m) => m.id).sort(), ["fresh-model", "gone-model"]);
	assert.match(text(ctx), /kept \(--no-prune\)/);
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
	assert.match(text(unknownProvider), /No such provider in models\.json: nope/);

	const unknownModel = scriptCtx();
	await syncFlow(unknownModel, { argv: ["--only", "typo-model"], fetchImpl: fakeFetch(["a"]) });
	assert.match(text(unknownModel), /Not offered by any endpoint: typo-model/);

	seed(dir, {});
	const empty = scriptCtx();
	await syncFlow(empty, { argv: ["--all"], fetchImpl: fakeFetch([]) });
	assert.match(text(empty), /no provider entries yet/);
});

test("sync skips a runtime provider and leaves its static fallback alone", async (t) => {
	const dir = withAgentDir(t);
	fs.writeFileSync(path.join(dir, "model-config.json"), JSON.stringify({ runtimeProviders: ["me"] }));
	assert.ok(runtimeProviders().has("me"), "the fake config is in effect");
	seed(dir, { me: provider([{ id: "static-fallback", cost: ZERO }]) });
	const before = fs.readFileSync(path.join(dir, "models.json"), "utf8");
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--all"], fetchImpl: fakeFetch(["something-else"]) });

	assert.match(text(ctx), /runtime provider; another extension owns its model list/);
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
	assert.match(text(ctx), /already in sync/);
});

test("sync --help prints the usage", async (t) => {
	withAgentDir(t);
	const ctx = scriptCtx();
	await syncFlow(ctx, { argv: ["--help"] });
	assert.match(text(ctx), /Usage:/);
	assert.match(text(ctx), /\/model-setup sync/);
});
