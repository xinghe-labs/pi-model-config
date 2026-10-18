// `/model-setup list` — read-only summary of every configured provider.
import { maskKey } from "../infer.js";
import { readModelsConfig } from "../json-file.js";
import { errorMessage, notify } from "../output.js";
import { isRuntimeProvider, runtimeProviders } from "../user-config.js";

export function renderProviderList(providers, { runtime = new Set() } = {}) {
	const ids = Object.keys(providers);
	if (!ids.length) return "models.json has no provider entries yet.";
	const lines = ids.map((id) => {
		const p = providers[id] ?? {};
		const models = Array.isArray(p.models) ? `${p.models.length} model(s)` : "inherits / overrides existing models";
		const flags = [];
		if (isRuntimeProvider(id, runtime)) flags.push("runtime provider");
		if (p.apiKey === "none") flags.push("no key");
		return (
			`- ${id}${flags.length ? ` (${flags.join("; ")})` : ""}\n` +
			`    ${p.baseUrl ?? "(no baseUrl)"}  |  api=${p.api ?? "(default)"}  |  key=${maskKey(p.apiKey)}  |  ${models}`
		);
	});
	return `models.json providers (${ids.length}):\n${lines.join("\n")}`;
}

export async function listFlow(ctx) {
	let config;
	try {
		config = readModelsConfig();
	} catch (err) {
		return notify(ctx, errorMessage(err), "error");
	}
	notify(ctx, renderProviderList(config.providers ?? {}, { runtime: runtimeProviders() }));
}
