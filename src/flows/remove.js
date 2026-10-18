// `/model-setup remove` — delete a provider from models.json.
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
	if (!ids.length) return notify(ctx, "models.json has no provider entries to remove");

	const target = await ctx.ui.select("Remove which provider?", ids);
	if (!target) return notify(ctx, "Cancelled");
	const provider = config.providers[target] ?? {};

	if (isRuntimeProvider(target)) {
		const ok = await ctx.ui.confirm(
			"Removing a runtime provider",
			`${target} is managed by another extension, which reads apiKey / baseUrl from this entry. ` +
				"Removing it takes that credential away and its refresh will fail (it falls back to its static list). Continue?",
		);
		if (!ok) return notify(ctx, "Cancelled");
	}
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${target} (${provider.baseUrl ?? "no baseUrl"}) from models.json? The file is backed up first.`,
	);
	if (!confirmed) return notify(ctx, "Cancelled");

	backupFile(modelsJsonPath());
	delete config.providers[target];
	try {
		writeJson(modelsJsonPath(), config);
	} catch (err) {
		return notify(ctx, `Not removed: writing models.json failed (${errorMessage(err)})`, "error");
	}
	try {
		await ctx.modelRegistry.refresh({ providers: [target] });
	} catch (err) {
		notify(ctx, `Removed, but the registry refresh failed (a restart will apply it): ${errorMessage(err)}`, "warning");
	}
	notify(ctx, `Removed ${target}; models.json was backed up.`);

	const stale = scopedEntriesFor(readSettings(), target);
	if (stale.length) {
		notify(
			ctx,
			`Note: the /model list is a snapshot taken at session start, so ${target} models may still appear there. ` +
				"They disappear in a new session or after restarting pi (/reload does not re-resolve the snapshot).",
			"warning",
		);
		if (await ctx.ui.confirm("Clean up the list", `Also remove the enabledModels entries for ${target}?`)) {
			removeScopeUpdate(ctx, target);
		}
	}
	if (ctx.model?.provider === target) {
		notify(ctx, "Warning: this session's model belongs to the provider just removed. Pick another with /model.", "warning");
	}
}
