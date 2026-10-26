// Keeping settings.json's enabledModels in step with models.json.
//
// When enabledModels is non-empty the /model picker shows only those entries, so
// a newly added provider is invisible until it is listed. Adding is automatic;
// removing is confirmed with the user, because silently shrinking a list someone
// curated by hand is destructive.
import { SCOPED_RELOAD_HINT } from "./const.js";
import { backupFile, readSettings, writeJson } from "./json-file.js";
import { notify, errorMessage } from "./output.js";
import { settingsPath } from "./paths.js";

const matchesProvider = (entry, providerId) =>
	typeof entry === "string" && entry.toLowerCase().startsWith(`${providerId.toLowerCase()}/`);

export function scopedEntriesFor(settings, providerId) {
	return Array.isArray(settings?.enabledModels) ? settings.enabledModels.filter((e) => matchesProvider(e, providerId)) : [];
}

export function applyScopeUpdate(ctx, providerId) {
	const settings = readSettings();
	const enabled = settings?.enabledModels;
	if (!Array.isArray(enabled) || enabled.length === 0) return false;
	if (enabled.some((p) => matchesProvider(p, providerId))) return false;
	const bakErr = backupFile(settingsPath());
	if (bakErr) notify(ctx, `${bakErr}，settings.json 将在没有备份的情况下写入。`, "warning");
	settings.enabledModels = [...enabled, `${providerId}/*`];
	try {
		writeJson(settingsPath(), settings);
		notify(
			ctx,
			`Added ${providerId}/* to enabledModels${bakErr ? "（备份失败）" : "（settings.json backed up)"}; ${SCOPED_RELOAD_HINT}`,
			"info",
		);
		return true;
	} catch (err) {
		notify(ctx, `enabledModels not updated (writing settings.json failed): ${errorMessage(err)}`, "error");
		return false;
	}
}

export function removeScopeUpdate(ctx, providerId) {
	const settings = readSettings();
	if (!Array.isArray(settings?.enabledModels)) return false;
	const rest = settings.enabledModels.filter((e) => !matchesProvider(e, providerId));
	if (rest.length === settings.enabledModels.length) return false;
	const bakErr = backupFile(settingsPath());
	if (bakErr) notify(ctx, `${bakErr}，settings.json 将在没有备份的情况下写入。`, "warning");
	settings.enabledModels = rest;
	try {
		writeJson(settingsPath(), settings);
		notify(
			ctx,
			`enabledModels cleaned up${bakErr ? "（备份失败）" : "（settings.json backed up)"}; ${SCOPED_RELOAD_HINT}`,
			"info",
		);
		return true;
	} catch (err) {
		notify(ctx, `enabledModels not persisted (writing settings.json failed): ${errorMessage(err)}`, "error");
		return false;
	}
}
