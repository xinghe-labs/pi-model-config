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
import { readFileIfExists } from "./json-file.js";
import { userConfigPath } from "./paths.js";

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
