// `/model-config remove` — delete a provider from models.json.
//
// Two things make this more than an object delete:
//   - a runtime provider's extension reads apiKey / baseUrl from this entry, so
//     removing it takes that extension's credentials away;
//   - a deleted provider whose models are still in enabledModels stays visible in
//     the /model picker until the session restarts, because that list is a
//     snapshot. Saying so is the difference between "it is gone" and "it looks
//     like nothing happened".
import { backupFile, readModelsConfig, readSettings, writeJson } from "../json-file.js";
import { errorMessage, notify, requireUI } from "../output.js";
import { modelsJsonPath } from "../paths.js";
import { removeScopeUpdate, scopedEntriesFor } from "../scope.js";
import { isRuntimeProvider } from "../user-config.js";

export async function removeFlow(ctx) {
	if (!requireUI(ctx, "remove")) return;

	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	const ids = Object.keys(config?.providers ?? {});
	if (!ids.length) return notify(ctx, "models.json 里没有可删除的供应商");

	const target = await ctx.ui.select("删除哪个供应商？", ids);
	if (!target) return notify(ctx, "已取消");
	const provider = config.providers[target] ?? {};

	if (isRuntimeProvider(target)) {
		const ok = await ctx.ui.confirm(
			"正在删除运行时供应商",
			`${target} 由另一个扩展管理，该扩展从这个条目读取 apiKey / baseUrl。` +
				"删除后它的凭证就没了，刷新会失败（会退回静态列表）。继续吗？",
		);
		if (!ok) return notify(ctx, "已取消");
	}
	const confirmed = await ctx.ui.confirm(
		"确认删除",
		`从 models.json 删除 ${target}（${provider.baseUrl ?? "无 baseUrl"}）？会先备份原文件。`,
	);
	if (!confirmed) return notify(ctx, "已取消");

	// Re-read after the dialogs: the file may have changed while they were open,
	// and writing the startup snapshot would silently restore any concurrent edit.
	let fresh;
	try {
		fresh = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	if (!fresh.providers?.[target]) {
		return notify(ctx, `${target} 已不存在（可能同时被别的会话删除了），什么都没写。`, "warning");
	}

	const bakErr = backupFile(modelsJsonPath());
	if (bakErr) notify(ctx, `${bakErr}，models.json 将在没有备份的情况下写入。`, "warning");
	delete fresh.providers[target];
	try {
		writeJson(modelsJsonPath(), fresh);
	} catch (err) {
		return notify(ctx, `未删除：写入 models.json 失败（${errorMessage(err)}）`, "error");
	}
	try {
		await ctx.modelRegistry.refresh({ providers: [target] });
	} catch (err) {
		notify(ctx, `已删除，但注册表刷新失败（重启后生效）：${errorMessage(err)}`, "warning");
	}
	notify(ctx, `已删除 ${target}，models.json 已备份。`);

	const stale = scopedEntriesFor(readSettings(), target);
	if (stale.length) {
		notify(
			ctx,
			`注意：/model 列表是会话启动时的快照，所以 ${target} 的模型可能还显示在那里。` +
				"新开会话或重启 pi 后就会消失（/reload 不会重新解析快照）。",
			"warning",
		);
		if (await ctx.ui.confirm("清理列表", `同时删除 ${target} 的 enabledModels 条目吗？`)) {
			removeScopeUpdate(ctx, target);
		}
	}
	if (ctx.model?.provider === target) {
		notify(ctx, "警告：当前会话用的模型属于刚删除的供应商，请用 /model 换一个。", "warning");
	}
}
