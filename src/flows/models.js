// `/model-setup models` — manage one provider's model list by hand: remove
// models you do not want, regardless of what the endpoint still serves.
//
// The catch: `sync` reconciles against the endpoint, so a model deleted here
// would come right back on the next `sync --all`. Deletions are therefore
// recorded in model-config.json as `hiddenModels`, and sync skips them —
// deleting a model is a decision, not something an audit undoes.
//
// Forms:
//   /model-setup models              pick a provider, then pick models to remove
//   /model-setup models <pid>        same, straight into that provider
//   /model-setup models <pid> --only a,b   remove exactly those, no dialogs
//
// Restoring a hidden model: delete its id from `hiddenModels` in
// model-config.json (or the whole key), then run sync --all.
import { parseOptions, onlyIds } from "../args.js";
import { backupFile, readModelsConfig, writeJson } from "../json-file.js";
import { errorMessage, notify, requireUI } from "../output.js";
import { modelsJsonPath, userConfigPath } from "../paths.js";
import { maskKey } from "../infer.js";
import { readUserConfig } from "../user-config.js";

// Hidden-model bookkeeping lives in model-config.json next to runtimeProviders.
function readHidden() {
	const config = readUserConfig();
	if (config.error) notify(config.error, "warning");
	return config.hiddenModels && typeof config.hiddenModels === "object" ? config.hiddenModels : {};
}

function writeHidden(hidden) {
	// Read fresh and merge: runtimeProviders may have been edited while the
	// dialogs were open, and this file belongs to the whole extension.
	const path = userConfigPath();
	let parsed = {};
	try {
		parsed = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
	} catch {
		parsed = {};
	}
	const next = { ...parsed, hiddenModels: hidden };
	backupFile(path);
	writeJson(path, next);
}

function pickProvider(ctx, ids) {
	return ctx.ui.select("管理哪个供应商的模型？", ids);
}

// One round of picking; returns the ids chosen this round (may be empty).
// `ids` is a list of id strings, not model objects.
async function pickModels(ctx, ids) {
	const remove = [];
	for (;;) {
		const remaining = ids.filter((id) => !remove.includes(id));
		if (!remaining.length) {
			notify(ctx, "该供应商的模型已经删完了。");
			break;
		}
		const title = `删除哪个模型？（剩 ${remaining.length} 个，选“— 完成 —”结束）`;
		const pick = await ctx.ui.select(title, [...remaining, "— 完成 —"]);
		if (pick === undefined || pick === "— 完成 —") break;
		remove.push(pick);
	}
	return remove;
}

function applyRemoval(models, remove) {
	const doomed = new Set(remove);
	return models.filter((m) => !doomed.has(m?.id));
}

async function commit(ctx, pid, remove, hidden) {
	// Re-read: the file may have changed while the dialogs were open.
	let fresh;
	try {
		fresh = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const provider = fresh.providers?.[pid];
	if (!provider) return notify(ctx, `${pid} 已不存在，什么都没写。`, "error");

	provider.models = applyRemoval(Array.isArray(provider.models) ? provider.models : [], remove);
	hidden[pid] = [...new Set([...(hidden[pid] ?? []), ...remove])];

	backupFile(modelsJsonPath());
	try {
		writeJson(modelsJsonPath(), fresh);
	} catch (err) {
		return notify(ctx, `写入 models.json 失败：${errorMessage(err)}`, "error");
	}
	try {
		writeHidden(hidden);
	} catch (err) {
		// models.json is already updated; the hidden list is a preference, not a
		// prerequisite, so report rather than undo.
		notify(ctx, `模型已删除，但记录忽略名单失败（sync 可能会补回它们）：${errorMessage(err)}`, "warning");
	}
	try {
		await ctx.modelRegistry.refresh({ providers: [pid] });
	} catch (err) {
		notify(ctx, `已写入，但注册表刷新失败（重启后会加载）：${errorMessage(err)}`, "warning");
	}
	notify(
		ctx,
		`已从 ${pid} 删除 ${remove.length} 个模型（原文件已备份）：\n${remove.join("、")}\n` +
			"它们已记入忽略名单，sync 不会再补回来。要恢复，从 model-config.json 的 hiddenModels 里删掉对应 id，再跑 sync --all。",
	);
	return remove;
}

export async function modelsFlow(ctx, { argv, fetchImpl } = {}) {
	void fetchImpl; // no network here; kept for signature symmetry
	const options = argv ? parseOptions(argv) : { flags: new Set(), values: {}, positional: [] };
	if (options.flags.has("help")) {
		notify(
			ctx,
			[
				"用法：",
				"  /model-setup models                选供应商，再挑要删除的模型",
				"  /model-setup models <pid>          直接进入该供应商",
				"  /model-setup models <pid> --only a,b   无对话框，直接删除这些",
				"",
				"删除的模型会记入忽略名单（model-config.json 的 hiddenModels），",
				"sync 不会再把它们补回来。",
			].join("\n"),
		);
		return;
	}

	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const providers = config.providers ?? {};
	const ids = Object.keys(providers);
	if (!ids.length) return notify(ctx, "models.json 里还没有任何供应商");

	const pidArg = options.positional[0];
	if (pidArg && !providers[pidArg]) return notify(ctx, `models.json 里没有这个供应商：${pidArg}`, "error");

	const hidden = readHidden();
	let pid = pidArg;
	let remove = [];

	if (options.values.only !== undefined) {
		// Scripted form: the ids to remove are the consent. Validate them.
		if (!pid) return notify(ctx, "--only 需要先指定供应商：/model-setup models <pid> --only a,b", "error");
		const existing = new Set((providers[pid].models ?? []).map((m) => m?.id));
		remove = onlyIds(options).filter((id) => existing.has(id));
		const missing = onlyIds(options).filter((id) => !existing.has(id));
		if (missing.length) notify(ctx, `这些 id 不在 ${pid} 里，已跳过：${missing.join("、")}`, "warning");
		if (!remove.length) return notify(ctx, "没有可删除的模型。");
	} else {
		if (!requireUI(ctx, "models")) return;
		if (!pid) {
			pid = await pickProvider(ctx, ids);
			if (pid === undefined) return notify(ctx, "已取消");
		}
		const current = (providers[pid].models ?? []).map((m) => m?.id).filter(Boolean);
		if (!current.length) return notify(ctx, `${pid} 没有静态模型列表可管理。`);
		notify(ctx, `${pid}：${current.length} 个模型，key=${maskKey(providers[pid].apiKey)}`);
		remove = await pickModels(ctx, current);
		if (!remove.length) return notify(ctx, "已取消，什么都没写入。");
		const ok = await ctx.ui.confirm(
			"删除模型",
			`从 ${pid} 删除以下 ${remove.length} 个模型？\n${remove.join("、")}\n\n（会先备份；它们会被记入忽略名单，sync 不会再补回）`,
		);
		if (!ok) return notify(ctx, "已取消，什么都没写入。");
	}

	return commit(ctx, pid, remove, hidden);
}
