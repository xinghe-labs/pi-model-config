// Optional per-user settings, all with a neutral default so a fresh install
// behaves like a plain models.json writer.
//
//   ~/.pi/agent/model-config.json
//   { "runtimeProviders": ["my-provider"] }
//
// PI_MODEL_CONFIG_RUNTIME_PROVIDERS="a,b" is merged on top.
//
// A "runtime provider" is a provider id whose `models` array is replaced at
// runtime by another extension, i.e. models.json only holds a static fallback
// used when that extension's own refresh fails. Writing model parameters into a
// file the extension overwrites would be silently ineffective, and rewriting
// them during an audit would fight the extension, so such ids are reported but
// never repaired.
//
// A broken config file degrades to "no options" and reports the error through
// the `error` field rather than throwing: this file is optional, so it must not
// be able to disable the command.
import { backupFile, readFileIfExists, writeJson } from "./json-file.js";
import { userConfigPath } from "./paths.js";
import { errorMessage, notify } from "./output.js";

export function readUserConfig() {
	const raw = readFileIfExists(userConfigPath());
	if (raw === undefined) return { runtimeProviders: [] };
	try {
		const parsed = JSON.parse(raw);
		const list = Array.isArray(parsed?.runtimeProviders)
			? parsed.runtimeProviders.filter((p) => typeof p === "string" && p.trim())
			: [];
		return { ...parsed, runtimeProviders: list };
	} catch (err) {
		return {
			runtimeProviders: [],
			error: `model-config.json could not be parsed (${err instanceof Error ? err.message : String(err)}); ignoring it.`,
		};
	}
}

export function envRuntimeProviders() {
	const raw = process.env.PI_MODEL_CONFIG_RUNTIME_PROVIDERS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);
}

// Case-insensitive: provider ids pass through several layers, and models.json
// keys are not guaranteed to keep the case they were written with.
export function runtimeProviders() {
	const all = [...readUserConfig().runtimeProviders, ...envRuntimeProviders()];
	return new Set(all.map((p) => p.toLowerCase()));
}

export function isRuntimeProvider(id, set = runtimeProviders()) {
	return set.has(String(id).toLowerCase());
}

// Single read-modify-write primitive for model-config.json.
//
// A parse failure or a non-object payload must abort the write: falling back to
// {} and writing it back would silently discard runtimeProviders and
// hiddenModels — the file belongs to the whole extension, not to the caller.
// A missing file is the one acceptable "empty" case.
//
// mutator receives the parsed object and returns the next one, or undefined to
// mean "nothing to change". Returns { ok: true } on success (write or no-op),
// { ok: false } when the write was refused; callers that need to report a
// downstream consequence (e.g. sync may re-add hidden models) do so themselves.
export function updateUserConfig(ctx, mutator, what) {
	const path = userConfigPath();
	let parsed;
	try {
		const raw = readFileIfExists(path);
		parsed = raw === undefined ? {} : JSON.parse(raw);
	} catch (err) {
		notify(ctx, `model-config.json 无法读取或解析（${errorMessage(err)}），${what}未写入。请先修复该文件。`, "error");
		return { ok: false };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		notify(ctx, `model-config.json 不是 JSON 对象，${what}未写入。请先修复该文件。`, "error");
		return { ok: false };
	}
	const next = mutator(parsed);
	if (next === undefined) return { ok: true };
	if (JSON.stringify(next) === JSON.stringify(parsed)) return { ok: true };
	const bakErr = backupFile(path);
	if (bakErr) notify(ctx, `${bakErr}，model-config.json 将在没有备份的情况下写入。`, "warning");
	try {
		writeJson(path, next);
		return { ok: true };
	} catch (err) {
		notify(ctx, `${what}写入失败：${errorMessage(err)}`, "warning");
		return { ok: false };
	}
}

function mutateHiddenModels(parsed, changes) {
	const hidden = parsed.hiddenModels && typeof parsed.hiddenModels === "object" ? { ...parsed.hiddenModels } : {};
	let changed = false;
	for (const { pid, ids } of changes) {
		if (!Array.isArray(ids) || ids.length === 0) continue;
		const list = Array.isArray(hidden[pid]) ? hidden[pid] : [];
		const next = [...new Set([...list, ...ids])];
		if (next.length === list.length) continue;
		hidden[pid] = next;
		changed = true;
	}
	if (!changed) return undefined;
	return { ...parsed, hiddenModels: hidden };
}

// Record ids the user deleted by hand so sync will not re-add them. Reads the
// file fresh and merges per provider: a stale whole-map snapshot would undo
// concurrent edits to other providers' entries.
export function addToHiddenModels(ctx, additions) {
	if (!Array.isArray(additions) || additions.length === 0) return { ok: true };
	return updateUserConfig(ctx, (parsed) => mutateHiddenModels(parsed, additions), "忽略名单更新");
}

// Remove ids from hiddenModels after a sync restore. Best-effort with its own
// reporting: models.json is already written at that point, so a failed ignore
// list update must not undo it — sync would simply keep skipping those ids.
// An emptied provider key is deleted rather than left as [].
export function removeFromHiddenModels(ctx, removals) {
	if (!Array.isArray(removals) || removals.length === 0) return { ok: true };
	const result = updateUserConfig(
		ctx,
		(parsed) => {
			const hidden = parsed.hiddenModels && typeof parsed.hiddenModels === "object" ? { ...parsed.hiddenModels } : {};
			let changed = false;
			for (const { pid, ids } of removals) {
				if (!Array.isArray(ids) || ids.length === 0) continue;
				const list = Array.isArray(hidden[pid]) ? hidden[pid] : [];
				const drop = new Set(ids);
				const rest = list.filter((id) => !drop.has(id));
				if (rest.length === list.length) continue;
				if (rest.length) hidden[pid] = rest;
				else delete hidden[pid];
				changed = true;
			}
			if (!changed) return undefined;
			return { ...parsed, hiddenModels: hidden };
		},
		"从忽略名单移除",
	);
	if (result.ok === false) {
		notify(ctx, "这些模型下次 sync 仍会被忽略名单跳过；要恢复请手工编辑 model-config.json。", "warning");
	}
	return result;
}
